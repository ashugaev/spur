package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runDriver drives the in-process companion (real SDK executors on the in-memory provider network).
type runDriver struct {
	t       *testing.T
	f       *companionFixture
	authDir string
	next    int
}

func (d *runDriver) call(method string, params map[string]string) loginStatus {
	d.t.Helper()
	d.next++
	line, _ := json.Marshal(map[string]any{"id": d.next, "method": method, "params": params})
	result := d.f.request(d.t, string(line))
	if !result.OK {
		d.t.Fatalf("%s failed: %+v", method, result.Error)
	}
	var status loginStatus
	if err := json.Unmarshal(result.Result, &status); err != nil {
		d.t.Fatal(err)
	}
	return status
}

// settle polls loginStatus until the attempt leaves pending.
func (d *runDriver) settle(id string) loginStatus {
	d.t.Helper()
	var status loginStatus
	for range 300 {
		status = d.call("loginStatus", map[string]string{"accountId": id})
		if status.Status != "pending" {
			return status
		}
		time.Sleep(50 * time.Millisecond)
	}
	d.t.Fatalf("%s still pending: %+v", id, status)
	return status
}

func (d *runDriver) paste(id string, started loginStatus) {
	d.t.Helper()
	parsed, err := url.Parse(started.URL)
	if err != nil {
		d.t.Fatal(err)
	}
	d.call("loginInput", map[string]string{"accountId": id, "input": "?code=CODE&state=" + parsed.Query().Get("state")})
}

func newRunDriver(t *testing.T, fake *providerFake, accounts string) *runDriver {
	t.Helper()
	dir := t.TempDir()
	f := startCompanionFixtureWith(t, dir, fake)
	if result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[`+accounts+`],"pools":[{"provider":"claude","defaultAccountId":null,"autoRotate":false,"defaultGeneration":1},{"provider":"codex","defaultAccountId":null,"autoRotate":false,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`); !result.OK {
		t.Fatalf("configure failed: %+v", result.Error)
	}
	return &runDriver{t: t, f: f, authDir: filepath.Join(dir, "auth-proxy-credentials"), next: 1}
}

// TestVerifyCredentialOutcomes sends each of the four probe targets through the real executors and
// classifies the answer: 2xx and 429 verify, 401 and 403 reject, anything else is unavailable.
func TestVerifyCredentialOutcomes(t *testing.T) {
	fake := &providerFake{}
	d := newRunDriver(t, fake, `{"id":"oauth-claude","provider":"claude","createdAt":"2026-01-01T00:00:00Z"},{"id":"oauth-codex","provider":"codex","createdAt":"2026-01-02T00:00:00Z"},{"id":"key-claude","provider":"claude","createdAt":"2026-01-03T00:00:00Z"},{"id":"key-codex","provider":"codex","createdAt":"2026-01-04T00:00:00Z"}`)
	key := strings.Repeat("key", 8)
	targets := []struct {
		id, provider, target string
		apiKey               bool
		rejected             string // errorCode when the provider answers 401 or 403
		headers              map[string]string
		absent               []string
	}{
		{"oauth-claude", "claude", claudeUsageURL, false, errNotConfirmed, map[string]string{"Authorization": "Bearer fixture-access", "Anthropic-Beta": "oauth-2025-04-20"}, []string{"X-Api-Key"}},
		{"oauth-codex", "codex", codexUsageURL, false, errNotConfirmed, map[string]string{"Authorization": "Bearer fixture-codex-access", "Chatgpt-Account-Id": "workspace-1"}, nil},
		{"key-claude", "claude", claudeModelsURL, true, errKeyRejected, map[string]string{"X-Api-Key": key, "Anthropic-Version": "2023-06-01"}, []string{"Authorization"}},
		{"key-codex", "codex", codexModelsURL, true, errKeyRejected, map[string]string{"Authorization": "Bearer " + key}, nil},
	}
	for _, tc := range targets {
		for _, answer := range []struct {
			status int
			want   string // ready, or the errorCode
		}{{200, "ready"}, {429, "ready"}, {401, tc.rejected}, {403, tc.rejected}, {500, errNotConfirmed}, {-1, errNotConfirmed}} {
			fake.setProbe(tc.target, answer.status)
			switch {
			case tc.apiKey:
				d.call("setApiKey", map[string]string{"accountId": tc.id, "provider": tc.provider, "apiKey": key})
			case tc.provider == "claude":
				started := d.call("login", map[string]string{"accountId": tc.id, "provider": "claude", "method": "oauth"})
				d.paste(tc.id, started)
			default:
				started := d.call("login", map[string]string{"accountId": tc.id, "provider": "codex", "method": "browser"})
				d.paste(tc.id, started)
			}
			final := d.settle(tc.id)
			got := final.ErrorCode
			if final.Status == "ready" {
				got = "ready"
			}
			if got != answer.want {
				t.Fatalf("%s answered %d: %+v, want %s", tc.id, answer.status, final, answer.want)
			}
			req := fake.lastRequest(tc.target)
			if req == nil || req.Method != http.MethodGet || req.URL.String() != tc.target {
				t.Fatalf("%s: probe request %v", tc.id, req)
			}
			for name, want := range tc.headers {
				if req.Header.Get(name) != want {
					t.Fatalf("%s: header %s = %q, want %q", tc.id, name, req.Header.Get(name), want)
				}
			}
			for _, name := range tc.absent {
				if req.Header.Get(name) != "" {
					t.Fatalf("%s: header %s must be absent", tc.id, name)
				}
			}
			if final.Status == "failed" && strings.Contains(final.Error, key) {
				t.Fatalf("%s: failure message carries the key", tc.id)
			}
		}
	}
}
