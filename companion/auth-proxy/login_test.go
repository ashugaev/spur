package main

import (
	"bytes"
	"compress/gzip"
	"compress/lzw"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type refreshFixture struct {
	active   atomic.Int32
	maximum  atomic.Int32
	sequence atomic.Int32
}

func (*refreshFixture) Identifier() string { return "claude" }
func (*refreshFixture) Execute(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (*refreshFixture) ExecuteStream(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (*coreexecutor.StreamResult, error) {
	return nil, errors.New("not used")
}
func (*refreshFixture) CountTokens(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (*refreshFixture) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("not used")
}
func (e *refreshFixture) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	active := e.active.Add(1)
	defer e.active.Add(-1)
	for {
		previous := e.maximum.Load()
		if active <= previous || e.maximum.CompareAndSwap(previous, active) {
			break
		}
	}
	time.Sleep(20 * time.Millisecond)
	updated := auth.Clone()
	updated.Metadata = maps.Clone(auth.Metadata)
	sequence := e.sequence.Add(1)
	updated.Metadata["access_token"] = fmt.Sprintf("fixture-access-%d", sequence)
	updated.Metadata["refresh_token"] = fmt.Sprintf("fixture-refresh-%d", sequence)
	return updated, nil
}

func TestRefreshSerializedAndDurable(t *testing.T) {
	dir := t.TempDir()
	store := tokenStore(dir)
	manager := coreauth.NewManager(store, nil, nil)
	executor := &refreshFixture{}
	manager.RegisterExecutor(executor)
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"id":"account-a.json","provider":"claude","metadata":{"type":"claude","email":"fixture@example.invalid","access_token":"fixture-access","refresh_token":"fixture-refresh"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	auth.FileName = auth.ID
	if _, err := manager.Register(context.Background(), &auth); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := manager.ForceRefreshAuth(context.Background(), auth.ID)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal("refresh failed")
		}
	}
	if executor.maximum.Load() != 1 {
		t.Fatal("refresh grants mutated concurrently")
	}
	current, ok := manager.GetByID(auth.ID)
	if !ok {
		t.Fatal("refreshed account missing")
	}
	restored, err := tokenStore(dir).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(restored) != 1 || restored[0].Metadata["access_token"] != current.Metadata["access_token"] || restored[0].Metadata["refresh_token"] != current.Metadata["refresh_token"] {
		t.Fatal("latest refreshed credential did not survive store reload")
	}
	info, err := os.Stat(filepath.Join(dir, "auth-proxy-credentials", auth.ID))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatal("credentials are readable outside owner")
	}
}

func TestSuccessfulLoginStatusDoesNotHideRenewalFailure(t *testing.T) {
	store := tokenStore(t.TempDir())
	manager := coreauth.NewManager(store, nil, nil)
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"id":"account-a.json","provider":"claude","metadata":{"type":"claude","access_token":"fixture-access"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	auth.FileName = auth.ID
	if _, err := manager.Register(context.Background(), &auth); err != nil {
		t.Fatal(err)
	}
	l := &loginManager{manager: manager, store: store, attempts: map[string]*loginAttempt{"account-a": {status: loginStatus{AccountID: "account-a", Status: "ready"}}}}
	if l.status("account-a").Status != "ready" {
		t.Fatal("valid signed-in status unavailable")
	}
	manager.Remove(context.Background(), auth.ID)
	if l.status("account-a").Status != "sign-in-required" {
		t.Fatal("cached login success hid missing credentials")
	}
}

func TestRepeatedLoginReusesSamePendingWorker(t *testing.T) {
	attempt := &loginAttempt{status: loginStatus{AccountID: "account-a", Status: "pending", URL: "https://claude.ai/oauth/authorize"}}
	l := &loginManager{active: "account-a", attempts: map[string]*loginAttempt{"account-a": attempt}}
	for range 2 {
		status, err := l.start(context.Background(), "account-a", claude)
		if err != nil || status.Status != "pending" || l.attempts["account-a"] != attempt {
			t.Fatal("repeated login did not reuse pending worker")
		}
	}
	if _, err := l.start(context.Background(), "account-b", claude); err == nil {
		t.Fatal("different profile started a concurrent login")
	}
}

func TestLoginWaitsForRuntimeModelRegistration(t *testing.T) {
	store := tokenStore(t.TempDir())
	manager := coreauth.NewManager(store, nil, nil)
	auth := identityFixture(t, "login-ready", "org-one", "user-one")
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	l := &loginManager{manager: manager, store: store}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := l.waitRegistered(ctx, "login-ready"); err == nil {
		t.Fatal("credentials alone counted as runtime-ready login")
	}
	registry := cliproxy.GlobalModelRegistry()
	registry.RegisterClient(auth.ID, "claude", []*cliproxy.ModelInfo{{ID: "fixture-model"}})
	t.Cleanup(func() { registry.UnregisterClient(auth.ID) })
	if err := l.waitRegistered(context.Background(), "login-ready"); err != nil {
		t.Fatal(err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// claudeTokenFake answers the Claude token, profile and roles endpoints and records each request.
// Profile and roles answer 500 unless profile / rolesOK is set; any other URL is a transport error.
type claudeTokenFake struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
	status   int
	encoding string
	token    string // token response override
	profile  string // profile response body; empty answers 500
	rolesOK  bool
}

const claudeFakeToken = `{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600,"account":{"uuid":"acct-1","email_address":"fixture@example.invalid"},"organization":{"uuid":"org-1","name":"Org"}}`

func encodeFixtureBody(t string, payload []byte) ([]byte, http.Header) {
	var buf bytes.Buffer
	switch t {
	case "gzip":
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(payload)
		_ = zw.Close()
	case "compress":
		zw := lzw.NewWriter(&buf, lzw.MSB, 8)
		_, _ = zw.Write(payload)
		_ = zw.Close()
	default:
		return payload, http.Header{}
	}
	return buf.Bytes(), http.Header{"Content-Encoding": {t}}
}

func (f *claudeTokenFake) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}
	f.mu.Lock()
	f.requests, f.bodies = append(f.requests, r), append(f.bodies, string(body))
	f.mu.Unlock()
	status, payload := f.status, []byte(nil)
	switch r.URL.String() {
	case claudeTokenURL:
		payload = []byte(firstNonEmpty(f.token, claudeFakeToken))
	case claudeProfileURL:
		status, payload = http.StatusInternalServerError, []byte(`{}`)
		if f.profile != "" {
			status, payload = http.StatusOK, []byte(f.profile)
		}
	case claudeRolesURL:
		status, payload = http.StatusInternalServerError, []byte(`{}`)
		if f.rolesOK {
			status, payload = http.StatusOK, []byte(`{"roles":[]}`)
		}
	default:
		return nil, errors.New("unexpected request " + r.URL.Host)
	}
	if status == 0 {
		status = http.StatusOK
	}
	payload, header := encodeFixtureBody(f.encoding, payload)
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(bytes.NewReader(payload)), Request: r}, nil
}

// calls counts token endpoint requests.
func (f *claudeTokenFake) calls() int { return f.count(claudeTokenURL) }

func (f *claudeTokenFake) count(target string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if r.URL.String() == target {
			n++
		}
	}
	return n
}

func TestPKCEAuthorizeURLMatchesSDK(t *testing.T) {
	flow, err := newClaudeFlow()
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(flow.authorizeURL())
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || u.Host != "claude.ai" || u.Path != "/oauth/authorize" {
		t.Fatalf("authorize endpoint: %s", u.Redacted())
	}
	sum := sha256.Sum256([]byte(flow.verifier))
	want := url.Values{
		"code":                  {"true"},
		"client_id":             {"9d1c250a-e61b-44d9-88ed-5944d1962f5e"},
		"response_type":         {"code"},
		"redirect_uri":          {"http://localhost:54545/callback"},
		"scope":                 {"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"state":                 {flow.state},
	}
	if got := u.Query(); !maps.EqualFunc(got, want, func(a, b []string) bool { return len(a) == 1 && len(b) == 1 && a[0] == b[0] }) {
		t.Fatalf("authorize params differ: %v", got)
	}
	if len(flow.verifier) != 128 || len(flow.state) != 32 {
		t.Fatalf("verifier/state lengths %d/%d", len(flow.verifier), len(flow.state))
	}
	other, _ := newClaudeFlow()
	if other.verifier == flow.verifier || other.state == flow.state {
		t.Fatal("flows share secrets")
	}
}

func TestClaudePasteFormsMatchSDK(t *testing.T) {
	flow, _ := newClaudeFlow()
	s := flow.state
	accepted := map[string]string{
		"full URL":                "http://localhost:54545/callback?code=C&state=" + s,
		"URL without scheme":      "localhost:54545/callback?code=C&state=" + s,
		"query only":              "?code=C&state=" + s,
		"bare params":             "code=C&state=" + s,
		"fragment params":         "#code=C&state=" + s,
		"URL with fragment":       "http://localhost:54545/callback#code=C&state=" + s,
		"query code with %23":     "?code=C%23" + s,
		"full URL with %23":       "http://localhost:54545/callback?code=C%23" + s,
		"surrounding whitespace":  " \t?code=C&state=" + s + " ",
		"error ignored when code": "?code=C&state=" + s + "&error=",
	}
	for name, input := range accepted {
		code, state, err := flow.accept(input)
		if err != nil || code != "C" || state != s {
			t.Fatalf("%s: code=%q state=%q err=%v", name, code, state, err)
		}
	}
	rejected := map[string]string{
		"error alone":              "error=access_denied&state=" + s,
		"error description alone":  "error_description=denied",
		"error with code":          "?code=C&error=access_denied&state=" + s,
		"literal code=X#Y":         "code=C#" + s,
		"query code=X#Y":           "?code=C#" + s,
		"bare code#state":          "C#" + s,
		"wrong state":              "?code=C&state=other",
		"missing code":             "?state=" + s,
		"missing state":            "?code=C",
		"unrecognized":             "garbage",
		"URL with wrong state":     "http://localhost:54545/callback?code=C&state=" + s + "x",
		"state with wrong %23":     "?code=C%23other",
		"fragment error":           "#error=denied&state=" + s,
		"fragment error with code": "#code=C&state=" + s + "&error=denied",
	}
	for name, input := range rejected {
		if code, _, err := flow.accept(input); err == nil || code != "" {
			t.Fatalf("%s: accepted (code=%q)", name, code)
		}
	}
	if _, _, err := flow.accept("   "); err == nil {
		t.Fatal("blank paste accepted")
	}
}

func TestClaudeExchangeRequestShape(t *testing.T) {
	for _, encoding := range []string{"", "gzip", "compress"} {
		fake := &claudeTokenFake{encoding: encoding}
		flow, _ := newClaudeFlow()
		tokens, err := flow.exchange(context.Background(), oauthHTTPClient(fake), "CODE", flow.state)
		if err != nil {
			t.Fatal(err)
		}
		r := fake.requests[0]
		if r.Method != http.MethodPost || r.URL.String() != "https://platform.claude.com/v1/oauth/token" || !r.Close {
			t.Fatalf("request: %s %s", r.Method, r.URL)
		}
		wantBody := `{"grant_type":"authorization_code","code":"CODE","redirect_uri":"http://localhost:54545/callback","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code_verifier":"` + flow.verifier + `","state":"` + flow.state + `"}`
		if fake.bodies[0] != wantBody {
			t.Fatalf("body field order or content differs: %s", fake.bodies[0])
		}
		for key, want := range map[string]string{"Accept": "application/json, text/plain, */*", "Content-Type": "application/json", "User-Agent": "axios/1.15.2", "Accept-Encoding": "gzip, compress, deflate, br", "Connection": "close"} {
			if got := r.Header.Get(key); got != want {
				t.Fatalf("header %s=%q", key, got)
			}
		}
		auth, err := buildClaudeOAuthRecord("account-a", tokens, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		identity, err := validatedIdentity(auth)
		if err != nil || identity.OrganizationID != "org-1" || identity.AccountID != "acct-1" || auth.Metadata["email"] != "fixture@example.invalid" || auth.ID != "account-a.json" {
			t.Fatalf("identity from token response: %+v %v", identity, err)
		}
		if !usableAuth(auth) || auth.Metadata["refresh_token"] != "fixture-refresh" || auth.Metadata["type"] != "claude" {
			t.Fatal("record missing credential fields")
		}
	}
	// A "#state" left on the code overrides the state, like the SDK exchange.
	fake := &claudeTokenFake{}
	flow, _ := newClaudeFlow()
	if _, err := flow.exchange(context.Background(), oauthHTTPClient(fake), "CODE#OVERRIDE", flow.state); err != nil || !strings.Contains(fake.bodies[0], `"code":"CODE"`) || !strings.HasSuffix(fake.bodies[0], `"state":"OVERRIDE"}`) {
		t.Fatalf("code#state split: %v %s", err, fake.bodies)
	}
	failing := &claudeTokenFake{status: http.StatusBadRequest}
	if _, err := flow.exchange(context.Background(), oauthHTTPClient(failing), "CODE", flow.state); err == nil {
		t.Fatal("non-200 exchange accepted")
	}
}

func claudeLoginFixture(t *testing.T, fake http.RoundTripper) *loginManager {
	t.Helper()
	store := tokenStore(t.TempDir())
	return &loginManager{dir: t.TempDir(), manager: coreauth.NewManager(store, nil, nil), store: store, attempts: map[string]*loginAttempt{}, client: oauthHTTPClient(fake)}
}

func TestClaudeLoginKeepsPromptText(t *testing.T) {
	l := claudeLoginFixture(t, &claudeTokenFake{})
	status, err := l.start(context.Background(), "account-a", claude)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = l.cancel("account-a") })
	if status.Status != "pending" || status.Prompt != "Paste the callback URL from the authorization page" || !strings.HasPrefix(status.URL, "https://claude.ai/oauth/authorize?") || status.AccountID != "account-a" || status.UserCode != "" || status.Error != "" {
		t.Fatalf("first status: %+v", status)
	}
	// Repeat start reuses the attempt; a different account is refused.
	if again, err := l.start(context.Background(), "account-a", claude); err != nil || again.URL != status.URL {
		t.Fatal("repeat start changed the attempt")
	}
	if _, err := l.start(context.Background(), "account-b", claude); err == nil {
		t.Fatal("second account started concurrently")
	}
	for _, bad := range []string{"", "a\nb", "a\rb", strings.Repeat("x", 8193)} {
		if _, err := l.input("account-a", bad); err == nil {
			t.Fatalf("input %q accepted", bad[:min(len(bad), 8)])
		}
	}
	if blank, err := l.input("account-a", "   "); err != nil || blank.Prompt != status.Prompt || blank.Status != "pending" {
		t.Fatal("blank input did not keep the prompt")
	}
	if _, err := l.input("account-b", "x"); err == nil {
		t.Fatal("input accepted for a non-pending account")
	}
}

func TestClaudeLoginRejectedPasteMakesNoExchange(t *testing.T) {
	for _, input := range []string{"?code=C&state=wrong", "error=access_denied", "C#state", "garbage"} {
		fake := &claudeTokenFake{}
		l := claudeLoginFixture(t, fake)
		status, err := l.start(context.Background(), "account-a", claude)
		if err != nil {
			t.Fatal(err)
		}
		a := l.attempts["account-a"]
		after, err := l.input("account-a", input)
		if err != nil || after.Prompt != "" || after.Status != "pending" || after.URL != status.URL {
			t.Fatalf("input result: %+v %v", after, err)
		}
		select {
		case <-a.done:
		case <-time.After(5 * time.Second):
			t.Fatal("rejected paste did not end the attempt")
		}
		if got := l.status("account-a"); got.Status != "failed" || got.Error != "Sign-in failed; retry authentication" {
			t.Fatalf("status after %q: %+v", input, got)
		}
		if fake.calls() != 0 {
			t.Fatalf("%q reached the token endpoint", input)
		}
		if _, err := l.start(context.Background(), "account-b", claude); err != nil {
			t.Fatal("failed attempt kept the companion busy")
		}
		_, _ = l.cancel("account-b")
	}
}

func TestLoginWorkerRejectsClaude(t *testing.T) {
	dir := t.TempDir()
	if err := loginWorker(context.Background(), dir, "account-a", claude); err == nil {
		t.Fatal("login worker accepted Claude")
	}
	if err := loginWorker(context.Background(), dir, "account-a", provider("other")); err == nil {
		t.Fatal("login worker accepted an unknown provider")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal("rejected worker touched the data dir")
	}
}

func TestClaudeProfileLookupMatchesSDK(t *testing.T) {
	headers := func(r *http.Request) {
		t.Helper()
		for key, want := range map[string]string{"Authorization": "Bearer fixture-access", "Cache-Control": "no-cache", "User-Agent": "axios/1.15.2", "Accept": "application/json, text/plain, */*"} {
			if got := r.Header.Get(key); got != want {
				t.Fatalf("%s header %s=%q", r.URL.Path, key, got)
			}
		}
		if r.Method != http.MethodGet {
			t.Fatalf("%s method %s", r.URL.Path, r.Method)
		}
	}
	tokens := func() *claudeTokens {
		var v claudeTokens
		if err := json.Unmarshal([]byte(claudeFakeToken), &v); err != nil {
			t.Fatal(err)
		}
		return &v
	}
	// Profile wins where it carries a value; blank profile fields keep the token response.
	fake := &claudeTokenFake{rolesOK: true, profile: `{"account":{"uuid":" acct-2 ","email":"profile@example.invalid"},"organization":{"uuid":"org-2","name":""}}`}
	got := tokens()
	inspectClaudeAccount(context.Background(), oauthHTTPClient(fake), got)
	if got.Account.UUID != "acct-2" || got.Account.EmailAddress != "profile@example.invalid" || got.Organization.UUID != "org-2" || got.Organization.Name != "Org" {
		t.Fatalf("profile merge: %+v", got)
	}
	if len(fake.requests) != 2 || fake.requests[0].URL.String() != claudeProfileURL || fake.requests[1].URL.String() != claudeRolesURL {
		t.Fatal("profile then roles not requested")
	}
	headers(fake.requests[0])
	headers(fake.requests[1])
	// Profile failure, profile without account uuid, or a transport error keep the token identity.
	for name, f := range map[string]*claudeTokenFake{
		"profile error":   {},
		"no account uuid": {profile: `{"account":{"uuid":"","email":"x@example.invalid"}}`},
		"gzip profile":    {encoding: "gzip", profile: `{"account":{"uuid":"acct-3"}}`},
	} {
		got = tokens()
		inspectClaudeAccount(context.Background(), oauthHTTPClient(f), got)
		want := "acct-1"
		if name == "gzip profile" {
			want = "acct-3"
		}
		if got.Account.UUID != want || got.Account.EmailAddress != "fixture@example.invalid" || got.Organization.UUID != "org-1" {
			t.Fatalf("%s: %+v", name, got)
		}
		if f.count(claudeRolesURL) != 1 {
			t.Fatalf("%s: roles lookup skipped", name)
		}
	}
	got = tokens()
	inspectClaudeAccount(context.Background(), oauthHTTPClient(roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("down") })), got)
	if got.Account.UUID != "acct-1" {
		t.Fatal("transport error changed identity")
	}
}

func TestClaudeLoginRefusesEmptyEmail(t *testing.T) {
	fake := &claudeTokenFake{token: `{"access_token":"fixture-access","refresh_token":"r","expires_in":3600,"account":{"uuid":"acct-1"},"organization":{"uuid":"org-1"}}`}
	l := claudeLoginFixture(t, fake)
	if _, err := l.start(context.Background(), "account-a", claude); err != nil {
		t.Fatal(err)
	}
	a := l.attempts["account-a"]
	if _, err := l.input("account-a", "?code=C&state="+firstQueryState(t, a.status.URL)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.done:
	case <-time.After(5 * time.Second):
		t.Fatal("attempt did not end")
	}
	if got := l.status("account-a"); got.Status != "failed" {
		t.Fatalf("status: %+v", got)
	}
	if stored, _ := l.store.List(context.Background()); len(stored) != 0 {
		t.Fatal("credential without email was saved")
	}
	if fake.calls() != 1 || fake.count(claudeProfileURL) != 1 {
		t.Fatal("exchange and profile lookup not both attempted")
	}
}

func firstQueryState(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
}

func TestClaudeLoginPasteWaitTimesOut(t *testing.T) {
	if claudeCallbackWait != 5*time.Minute {
		t.Fatalf("paste wait is %s, SDK callback wait was 5m", claudeCallbackWait)
	}
	saved := claudeCallbackWait
	claudeCallbackWait = 50 * time.Millisecond
	t.Cleanup(func() { claudeCallbackWait = saved })
	fake := &claudeTokenFake{}
	l := claudeLoginFixture(t, fake)
	if _, err := l.start(context.Background(), "account-a", claude); err != nil {
		t.Fatal(err)
	}
	select {
	case <-l.attempts["account-a"].done:
	case <-time.After(5 * time.Second):
		t.Fatal("unanswered prompt never timed out")
	}
	if got := l.status("account-a"); got.Status != "failed" || fake.calls() != 0 {
		t.Fatalf("status after timeout: %+v", got)
	}
	if _, err := l.start(context.Background(), "account-b", claude); err != nil {
		t.Fatal("timed-out attempt kept the companion busy")
	}
	_, _ = l.cancel("account-b")
}
