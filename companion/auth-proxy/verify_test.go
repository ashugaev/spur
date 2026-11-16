package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
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

func newRunDriver(t *testing.T, fake http.RoundTripper, accounts string) *runDriver {
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

// usageFake wraps the provider fake: while armed, usage and model probes go to handler instead.
type usageFake struct {
	inner   *providerFake
	mu      sync.Mutex
	armed   bool
	handler func(*http.Request) (*http.Response, error)
	probes  []*http.Request
}

func (u *usageFake) arm(handler func(*http.Request) (*http.Response, error)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.armed, u.handler, u.probes = true, handler, nil
}

func (u *usageFake) seen() []*http.Request {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]*http.Request(nil), u.probes...)
}

func (u *usageFake) RoundTrip(r *http.Request) (*http.Response, error) {
	switch r.URL.String() {
	case claudeUsageURL, codexUsageURL, claudeModelsURL, codexModelsURL:
		u.mu.Lock()
		armed, handler := u.armed, u.handler
		if armed {
			u.probes = append(u.probes, r)
		}
		u.mu.Unlock()
		if armed {
			return handler(r)
		}
	}
	return u.inner.RoundTrip(r)
}

func usageReply(status int, header http.Header, body string) func(*http.Request) (*http.Response, error) {
	return func(r *http.Request) (*http.Response, error) {
		if header == nil {
			header = http.Header{}
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	}
}

const usageAccounts = `{"id":"oauth-claude","provider":"claude","createdAt":"2026-01-01T00:00:00Z"},{"id":"oauth-codex","provider":"codex","createdAt":"2026-01-02T00:00:00Z"},{"id":"key-claude","provider":"claude","createdAt":"2026-01-03T00:00:00Z"}`

// signedInUsageDriver signs in a Claude OAuth, a Codex OAuth and a Claude API-key account.
func signedInUsageDriver(t *testing.T) (*runDriver, *usageFake) {
	t.Helper()
	fake := &usageFake{inner: &providerFake{}}
	d := newRunDriver(t, fake, usageAccounts)
	started := d.call("login", map[string]string{"accountId": "oauth-claude", "provider": "claude", "method": "oauth"})
	d.paste("oauth-claude", started)
	if final := d.settle("oauth-claude"); final.Status != "ready" {
		t.Fatalf("oauth-claude: %+v", final)
	}
	started = d.call("login", map[string]string{"accountId": "oauth-codex", "provider": "codex", "method": "browser"})
	d.paste("oauth-codex", started)
	if final := d.settle("oauth-codex"); final.Status != "ready" {
		t.Fatalf("oauth-codex: %+v", final)
	}
	d.call("setApiKey", map[string]string{"accountId": "key-claude", "provider": "claude", "apiKey": strings.Repeat("key", 8)})
	if final := d.settle("key-claude"); final.Status != "ready" {
		t.Fatalf("key-claude: %+v", final)
	}
	return d, fake
}

func (d *runDriver) usage(ids ...string) (usageResult, controlResponse) {
	d.t.Helper()
	d.next++
	line, _ := json.Marshal(map[string]any{"id": d.next, "method": "getUsage", "params": map[string]any{"accountIds": ids}})
	response := d.f.request(d.t, string(line))
	var result usageResult
	if response.OK {
		if err := json.Unmarshal(response.Result, &result); err != nil {
			d.t.Fatal(err)
		}
	}
	return result, response
}

func TestGetUsage(t *testing.T) {
	d, fake := signedInUsageDriver(t)
	secrets := []string{"fixture-access", "fixture-codex-access", strings.Repeat("key", 8), "Authorization", "Bearer"}
	noSecrets := func(response controlResponse) {
		t.Helper()
		for _, secret := range secrets {
			if strings.Contains(string(response.Result), secret) {
				t.Fatalf("usage reply contains %q: %s", secret, response.Result)
			}
		}
	}

	fake.arm(usageReply(200, nil, `{"five_hour":{"utilization":10}}`))
	result, response := d.usage("oauth-claude")
	if len(result.Usage) != 1 || result.Usage[0] != (usageEntry{AccountID: "oauth-claude", Status: "ok", HTTPStatus: 200, Body: `{"five_hour":{"utilization":10}}`}) {
		t.Fatalf("200: %+v", result)
	}
	noSecrets(response)
	if req := fake.seen()[0]; req.URL.String() != claudeUsageURL || req.Header.Get("Anthropic-Beta") != "oauth-2025-04-20" {
		t.Fatalf("claude request %s %v", req.URL, req.Header)
	}

	fake.arm(usageReply(200, nil, `{}`))
	if result, _ = d.usage("oauth-codex"); result.Usage[0].Status != "ok" {
		t.Fatalf("codex: %+v", result)
	}
	if req := fake.seen()[0]; req.URL.String() != codexUsageURL || req.Header.Get("ChatGPT-Account-Id") != "workspace-1" {
		t.Fatalf("codex request %s %v", req.URL, req.Header)
	}

	fake.arm(usageReply(429, http.Header{"Retry-After": {"120"}}, `{"rate":"limited"}`))
	result, response = d.usage("oauth-claude")
	if want := (usageEntry{AccountID: "oauth-claude", Status: "error", HTTPStatus: 429, RetryAfterSeconds: 120}); result.Usage[0] != want {
		t.Fatalf("429: %+v", result)
	}
	noSecrets(response)

	fake.arm(usageReply(429, http.Header{"Retry-After": {"Wed, 21 Oct 2026 07:28:00 GMT"}}, ``))
	if result, _ = d.usage("oauth-claude"); result.Usage[0].RetryAfterSeconds != 0 || result.Usage[0].HTTPStatus != 429 {
		t.Fatalf("429 date Retry-After: %+v", result)
	}

	fake.arm(usageReply(401, nil, `{"error":"nope"}`))
	if result, _ = d.usage("oauth-claude"); result.Usage[0] != (usageEntry{AccountID: "oauth-claude", Status: "error", HTTPStatus: 401}) {
		t.Fatalf("401: %+v", result)
	}

	fake.arm(usageReply(200, nil, strings.Repeat("x", 70<<10)))
	if result, _ = d.usage("oauth-claude"); result.Usage[0] != (usageEntry{AccountID: "oauth-claude", Status: "error", HTTPStatus: 200}) {
		t.Fatalf("70 KiB: %+v", result)
	}

	fake.arm(usageReply(200, nil, `{}`))
	if result, _ = d.usage("key-claude"); result.Usage[0] != (usageEntry{AccountID: "key-claude", Status: "error"}) || len(fake.seen()) != 0 {
		t.Fatalf("api key: %+v, %d transport calls", result, len(fake.seen()))
	}
}

// usageBodyExecutor answers HttpRequest with a body that errors once the request context is done.
type usageBodyExecutor struct{ *fakeExecutor }

type ctxBody struct{ ctx context.Context }

func (b ctxBody) Read([]byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}
func (ctxBody) Close() error { return nil }

func (usageBodyExecutor) HttpRequest(_ context.Context, _ *coreauth.Auth, req *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: ctxBody{req.Context()}, Request: req}, nil
}

func TestGetUsageBodyReadAfterCancel(t *testing.T) {
	f := newLoginFixture(t)
	f.l.manager.RegisterExecutor(usageBodyExecutor{f.executor[claude]})
	auth := identityFixture(t, "account-a", "org-1", "user-1")
	if _, err := f.l.manager.Register(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	if got := fetchUsage(ctx, f.l.manager, nil, auth); got != (usageEntry{Status: "error", HTTPStatus: 200}) {
		t.Fatalf("cancelled mid-body: %+v", got)
	}
	expired, stop := context.WithTimeout(context.Background(), time.Nanosecond)
	defer stop()
	<-expired.Done()
	if got := fetchUsage(expired, f.l.manager, nil, auth); got.Status != "error" || got.Body != "" {
		t.Fatalf("expired: %+v", got)
	}
}

// TestGetUsageSequentialChunks sends the next getUsage the moment the previous reply is read: the
// busy flag is already free, so none is rejected as overlapping.
func TestGetUsageSequentialChunks(t *testing.T) {
	d, fake := signedInUsageDriver(t)
	fake.arm(usageReply(200, nil, `{}`))
	for i := range 40 {
		result, response := d.usage("oauth-claude")
		if !response.OK || len(result.Usage) != 1 || result.Usage[0].Status != "ok" {
			t.Fatalf("chunk %d: %+v %+v", i, response.Error, result)
		}
	}
}
