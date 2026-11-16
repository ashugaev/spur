package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

// beyondRefreshLead returns a token lifetime past the SDK refresh lead of the provider. A shorter
// fixture token is refresh-due on arrival and the SDK scheduler would call the real provider.
func beyondRefreshLead(t *testing.T, p provider) time.Duration {
	t.Helper()
	lead := coreauth.ProviderRefreshLead(string(p), nil)
	if lead == nil {
		t.Fatalf("no SDK refresh lead for %s", p)
	}
	return *lead + 2*time.Hour
}

// fakeExecutor stands in for a provider executor: probes answer with status and refreshes are recorded.
type fakeExecutor struct {
	provider  string
	mu        sync.Mutex
	status    int
	err       error
	requests  []*http.Request
	auths     []*coreauth.Auth
	refresh   []string
	gate      chan struct{} // when set, Refresh blocks until closed
	probeGate chan struct{} // when set, HttpRequest blocks until closed
}

func (e *fakeExecutor) Identifier() string { return e.provider }
func (*fakeExecutor) Execute(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (*fakeExecutor) ExecuteStream(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (*coreexecutor.StreamResult, error) {
	return nil, errors.New("not used")
}
func (*fakeExecutor) CountTokens(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (e *fakeExecutor) HttpRequest(_ context.Context, auth *coreauth.Auth, req *http.Request) (*http.Response, error) {
	if e.probeGate != nil {
		<-e.probeGate
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.requests, e.auths = append(e.requests, req), append(e.auths, auth.Clone())
	if e.err != nil {
		return nil, e.err
	}
	status := e.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}")), Request: req}, nil
}
func (e *fakeExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	if e.gate != nil {
		<-e.gate
	}
	token, _ := auth.Metadata["refresh_token"].(string)
	e.mu.Lock()
	e.refresh = append(e.refresh, token)
	e.mu.Unlock()
	updated := auth.Clone()
	updated.Metadata = maps.Clone(auth.Metadata)
	return updated, nil
}
func (e *fakeExecutor) probes() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.requests)
}

// loginFixture is a loginManager over a temp data dir with fake executors for both providers and a
// router that records the verification marks.
type loginFixture struct {
	l        *loginManager
	r        *router
	dir      string
	net      *providerFake // token endpoints; verification probes go to the fake executors
	executor map[provider]*fakeExecutor
}

func newLoginFixture(t *testing.T) *loginFixture {
	t.Helper()
	r, err := openRouter(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.close)
	if err = os.MkdirAll(filepath.Join(r.dir, "auth-proxy-credentials"), 0o700); err != nil {
		t.Fatal(err)
	}
	store := tokenStore(r.dir)
	manager := coreauth.NewManager(store, nil, nil)
	f := &loginFixture{r: r, dir: r.dir, net: &providerFake{}, executor: map[provider]*fakeExecutor{claude: {provider: "claude"}, codex: {provider: "codex"}}}
	for _, e := range f.executor {
		manager.RegisterExecutor(e)
	}
	f.l = &loginManager{dir: r.dir, manager: manager, store: store, attempts: map[string]*loginAttempt{}, client: oauthHTTPClient(f.net), router: r}
	r.manager = manager
	r.readyAccount = func(id string, p provider) bool { return f.l.ready(id, p) && r.marksAllowLocked(id) }
	if err = r.configure([]accountInput{
		{ID: "account-a", Provider: claude, CreatedAt: "2026-01-01T00:00:00Z"},
		{ID: "account-b", Provider: claude, CreatedAt: "2026-01-02T00:00:00Z"},
		{ID: "account-x", Provider: codex, CreatedAt: "2026-01-03T00:00:00Z"},
	}, []poolInput{{Provider: claude}, {Provider: codex}}, policy{CooldownMinutes: 60, MaxRotationsPerEpisode: 1}); err != nil {
		t.Fatal(err)
	}
	f.watch(t)
	return f
}

// watch stands in for the service file watcher: a credential file whose size or mtime changed is
// registered with the manager and given models, as the service does.
func (f *loginFixture) watch(t *testing.T) {
	t.Helper()
	registry := cliproxy.GlobalModelRegistry()
	type stamp struct {
		mod  time.Time
		size int64
	}
	seen := map[string]stamp{}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			stored, err := f.l.store.List(context.Background())
			if err != nil {
				continue
			}
			for _, auth := range stored {
				info, err := os.Stat(auth.Attributes["path"])
				if err != nil || seen[auth.ID] == (stamp{info.ModTime(), info.Size()}) {
					continue
				}
				seen[auth.ID] = stamp{info.ModTime(), info.Size()}
				_, _ = f.l.manager.Register(coreauth.WithSkipPersist(context.Background()), auth)
				registry.RegisterClient(auth.ID, auth.Provider, []*cliproxy.ModelInfo{{ID: "fixture-model"}})
			}
		}
	}()
	t.Cleanup(func() {
		close(stop)
		wg.Wait()
		for id := range seen {
			registry.UnregisterClient(id)
		}
	})
}

// await waits for an attempt to finish and returns its status.
func (f *loginFixture) await(t *testing.T, id string) loginStatus {
	t.Helper()
	f.l.mu.Lock()
	a := f.l.attempts[id]
	f.l.mu.Unlock()
	if a == nil {
		t.Fatal("no attempt")
	}
	select {
	case <-a.done:
	case <-time.After(20 * time.Second):
		t.Fatal("attempt did not finish")
	}
	return f.l.status(id)
}

func (f *loginFixture) marks(id string) (verified, broken bool) {
	f.r.mu.Lock()
	defer f.r.mu.Unlock()
	_, verified = f.r.state.Verified[id]
	_, broken = f.r.state.Broken[id]
	return
}

func codexIDToken(email, account string) string {
	return makeJWT(map[string]any{"email": email, "https://api.openai.com/auth": map[string]any{"chatgpt_account_id": account, "chatgpt_plan_type": "plus"}})
}

// writeNativeClaude writes the files `claude auth login` leaves in its config dir.
func writeNativeClaude(t *testing.T, dir, id string, expires time.Time, identity map[string]string) {
	t.Helper()
	home := filepath.Join(dir, "auth-terminal", id)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	credentials, _ := json.Marshal(map[string]any{"claudeAiOauth": map[string]any{"accessToken": "native-claude-access", "refreshToken": "native-claude-refresh", "expiresAt": expires.UnixMilli()}})
	profile, _ := json.Marshal(map[string]any{"oauthAccount": identity})
	for name, raw := range map[string][]byte{".credentials.json": credentials, ".claude.json": profile} {
		if err := os.WriteFile(filepath.Join(home, name), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func claudeIdentity() map[string]string {
	return map[string]string{"accountUuid": "acct-native", "organizationUuid": "org-native", "emailAddress": "native@example.invalid"}
}

// writeNativeCodex writes the auth.json `codex login` leaves in CODEX_HOME.
func writeNativeCodex(t *testing.T, dir, id string, expires time.Time) {
	t.Helper()
	home := filepath.Join(dir, "auth-terminal", id)
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"OPENAI_API_KEY": nil, "tokens": map[string]any{
		"id_token":      codexIDToken("native@example.invalid", "workspace-native"),
		"access_token":  makeJWT(map[string]any{"exp": expires.Unix()}),
		"refresh_token": "native-codex-refresh",
		"account_id":    "workspace-native",
	}})
	if err := os.WriteFile(filepath.Join(home, "auth.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func makeJWT(claims map[string]any) string {
	payload, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(payload) + "." + enc([]byte("sig"))
}
