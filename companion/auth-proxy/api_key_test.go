package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
)

// seedVerified prepares a data directory whose accounts already carry verified marks.
func seedVerified(t *testing.T, dir string, ids ...string) string {
	t.Helper()
	r, err := openRouter(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if err = r.setVerified(id); err != nil {
			t.Fatal(err)
		}
	}
	root := r.dir
	r.close()
	return root
}

func configureAccounts(t *testing.T, f *companionFixture) {
	t.Helper()
	result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"key-claude","provider":"claude","createdAt":"2026-01-01T00:00:00Z"},{"id":"key-codex","provider":"codex","createdAt":"2026-01-02T00:00:00Z"}],"pools":[{"provider":"claude","defaultAccountId":"key-claude","autoRotate":false,"defaultGeneration":1},{"provider":"codex","defaultAccountId":"key-codex","autoRotate":false,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`)
	if !result.OK {
		t.Fatalf("configure failed: %+v", result.Error)
	}
}

func accountStatuses(t *testing.T, f *companionFixture, id int) map[string]accountStatus {
	t.Helper()
	result := f.request(t, fmt.Sprintf(`{"id":%d,"method":"getState","params":{}}`, id))
	var summary stateSummary
	if err := json.Unmarshal(result.Result, &summary); err != nil {
		t.Fatal(err)
	}
	statuses := map[string]accountStatus{}
	for _, a := range summary.Accounts {
		statuses[a.ID] = a
	}
	return statuses
}

// G0: an API-key record written after start is loaded by the real service file watcher, registered
// with models, and routed with its key and base URL.
func TestAPIKeyRecordLoadsThroughServiceWatcher(t *testing.T) {
	claudeKey, codexKey := strings.Repeat("claude", 4), strings.Repeat("codex", 5)
	var mu sync.Mutex
	authorizations := map[string]string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		authorizations[r.URL.Path] = r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()

	// The model registry is process-global: start and end clean.
	registry := cliproxy.GlobalModelRegistry()
	for _, id := range []string{"key-claude", "key-codex"} {
		registry.UnregisterClient(authFileID(id))
		t.Cleanup(func() { registry.UnregisterClient(authFileID(id)) })
	}
	dir := seedVerified(t, t.TempDir(), "key-claude", "key-codex")
	f := startCompanionFixture(t, dir)
	configureAccounts(t, f)
	store := tokenStore(dir)
	for id, key := range map[string]string{"key-claude": claudeKey, "key-codex": codexKey} {
		p := claude
		if id == "key-codex" {
			p = codex
		}
		record := buildAPIKeyRecord(id, p, key)
		record.Metadata["base_url"] = upstream.URL
		record.Attributes = nil
		if _, err := store.Save(context.Background(), record); err != nil {
			t.Fatal(err)
		}
	}
	// Both accounts become ready: registered with their projected key and given models.
	polls := 100
	waitFor(t, "API-key accounts ready", func() bool {
		polls++
		for _, status := range accountStatuses(t, f, polls) {
			if status.Status != "ready" || status.Credential != "api_key" {
				return false
			}
		}
		return true
	})
	models := map[string]string{}
	for _, id := range []string{"key-claude", "key-codex"} {
		list := registry.GetModelsForClient(authFileID(id))
		if len(list) == 0 {
			t.Fatalf("%s ready without models", id)
		}
		models[id] = list[0].ID
	}
	client := &http.Client{Timeout: 10 * time.Second}
	for _, test := range []struct {
		id, provider, path, body, upstreamPath, key string
	}{
		{"key-claude", "claude", "/v1/messages", `{"model":"%s","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`, "/v1/messages", claudeKey},
		{"key-codex", "codex", "/v1/responses", `{"model":"%s","input":"hi"}`, "/responses", codexKey},
	} {
		reg := f.request(t, fmt.Sprintf(`{"id":%d,"method":"registerSession","params":{"sessionId":"session-%s","provider":"%s","accountId":"%s"}}`, 10+len(test.id), test.id, test.provider, test.id))
		if !reg.OK {
			t.Fatalf("%s register: %+v", test.id, reg.Error)
		}
		var registration registration
		if err := json.Unmarshal(reg.Result, &registration); err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest(http.MethodPost, f.endpoint+test.path, bytes.NewReader([]byte(fmt.Sprintf(test.body, models[test.id]))))
		req.Header.Set("Authorization", "Bearer "+registration.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		mu.Lock()
		got, seen := authorizations[test.upstreamPath]
		mu.Unlock()
		if !seen || got != "Bearer "+test.key {
			t.Fatalf("%s upstream saw %v (status %d)", test.id, authorizations, resp.StatusCode)
		}
	}
}

// The probe carries the key before any file exists; a rejected key leaves nothing behind and the
// control surface never echoes the key.
func TestSetAPIKeyVerifiesBeforeSave(t *testing.T) {
	key := strings.Repeat("key", 8)
	fake := &providerFake{}
	d := newRunDriver(t, fake, `{"id":"key-claude","provider":"claude","createdAt":"2026-01-01T00:00:00Z"}`)
	var mu sync.Mutex
	var filesAtProbe []string
	var probedKey string
	fake.mu.Lock()
	fake.onProbe = func(r *http.Request) {
		entries, _ := os.ReadDir(d.authDir)
		mu.Lock()
		defer mu.Unlock()
		probedKey = r.Header.Get("X-Api-Key")
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".json") { // the SDK keeps its own kv.db here
				filesAtProbe = append(filesAtProbe, e.Name())
			}
		}
	}
	fake.mu.Unlock()
	fake.setProbe(claudeModelsURL, 401)
	d.call("setApiKey", map[string]string{"accountId": "key-claude", "provider": "claude", "apiKey": key})
	final := d.settle("key-claude")
	mu.Lock()
	defer mu.Unlock()
	if probedKey != key {
		t.Fatalf("probe carried %q", probedKey)
	}
	if len(filesAtProbe) != 0 {
		t.Fatalf("credential files existed during the probe: %v", filesAtProbe)
	}
	if final.Status != "failed" || final.ErrorCode != errKeyRejected {
		t.Fatalf("rejected key: %+v", final)
	}
	if saved, _ := filepath.Glob(filepath.Join(d.authDir, "*.json")); len(saved) != 0 {
		t.Fatalf("rejected key left files: %v", saved)
	}
}

func TestSetAPIKeyNeverEchoesKey(t *testing.T) {
	key := strings.Repeat("key", 8)
	for _, probe := range []int{200, 401} {
		f := newLoginFixture(t)
		f.executor[claude].status = probe
		c, out := f.control()
		var all strings.Builder
		response := call(t, c, out, "setApiKey", apiKeyParams{AccountID: "account-a", Provider: claude, APIKey: key})
		all.WriteString(out.String())
		if !response.OK {
			t.Fatalf("setApiKey: %+v", response.Error)
		}
		f.await(t, "account-a")
		for _, method := range []string{"loginStatus", "getState"} {
			var params any = accountParams{"account-a"}
			if method == "getState" {
				params = map[string]any{}
			}
			call(t, c, out, method, params)
			all.WriteString(out.String())
		}
		// A bad key is refused with a message that does not echo it either.
		call(t, c, out, "setApiKey", apiKeyParams{AccountID: "account-a", Provider: claude, APIKey: key + " "})
		all.WriteString(out.String())
		if strings.Contains(all.String(), key) {
			t.Fatalf("probe %d: control output contains the key", probe)
		}
		raw, err := os.ReadFile(filepath.Join(f.dir, "auth-proxy-state.json"))
		if err != nil || strings.Contains(string(raw), key) {
			t.Fatalf("probe %d: persisted state contains the key (%v)", probe, err)
		}
	}
}

// Without the service publishing models the account never becomes ready, and nothing stays saved.
func TestAPIKeyReadinessWaitsForRegistration(t *testing.T) {
	saved := registrationWait
	registrationWait = 400 * time.Millisecond
	t.Cleanup(func() { registrationWait = saved })
	f := newLoginFixtureIn(t, t.TempDir(), false)
	if _, err := f.l.setAPIKey(context.Background(), "account-a", claude, strings.Repeat("key", 8)); err != nil {
		t.Fatal(err)
	}
	final := f.await(t, "account-a")
	if final.Status != "failed" || final.ErrorCode != errNotConfirmed {
		t.Fatalf("unregistered key: %+v", final)
	}
	if entries, _ := os.ReadDir(filepath.Join(f.dir, "auth-proxy-credentials")); len(entries) != 0 {
		t.Fatalf("credential file kept after failed registration: %v", entries)
	}
	if verified, _ := f.marks("account-a"); verified {
		t.Fatal("unregistered key was marked verified")
	}
	if _, ok := f.l.manager.GetByID("account-a.json"); ok {
		t.Fatal("unregistered key left a registered auth")
	}
}
