package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
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
	registry := cliproxy.GlobalModelRegistry()
	models := map[string]string{}
	deadline := time.Now().Add(15 * time.Second)
	for len(models) < 2 && time.Now().Before(deadline) {
		for id := range map[string]bool{"key-claude": true, "key-codex": true} {
			if list := registry.GetModelsForClient(authFileID(id)); len(list) > 0 {
				models[id] = list[0].ID
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(models) != 2 {
		t.Fatalf("API-key records never registered models: %v", models)
	}
	statuses := accountStatuses(t, f, 2)
	for id, status := range statuses {
		if status.Status != "ready" || status.Credential != "api_key" {
			t.Fatalf("%s: %+v", id, status)
		}
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
