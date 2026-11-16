package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

func TestOldRequestKeepsSnapshotAfterManualSwitch(t *testing.T) {
	r := testRouter(t)
	a, b := "account-a", "account-b"
	if _, err := r.register("session-a", codex, &a, false); err != nil {
		t.Fatal(err)
	}
	old := testAdmission(t, r, "session-a")
	if _, err := r.register("session-a", codex, &b, true); err != nil {
		t.Fatal(err)
	}
	if got := pickForTest(t, r, old, a, b).ID; got != authFileID(a) {
		t.Fatalf("in-flight selection changed: %s", got)
	}
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID(a), Options: old, Error: &coreauth.Error{HTTPStatus: 429}})
	saved := r.state.Sessions["session-a"]
	if saved.Session.EffectiveAccountID != b || saved.Episode.Open {
		t.Fatal("old quota mutated new binding")
	}
	next := testAdmission(t, r, "session-a")
	if got := pickForTest(t, r, next, a, b).ID; got != authFileID(b) {
		t.Fatalf("next admission did not switch: %s", got)
	}
}

func TestQuotaEpisodeLateSuccess(t *testing.T) {
	r := testRouter(t)
	if _, err := r.register("session-a", codex, nil, false); err != nil {
		t.Fatal(err)
	}
	opts := testAdmission(t, r, "session-a")
	pickForTest(t, r, opts, "account-a", "account-b")
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Error: &coreauth.Error{HTTPStatus: 429}})
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Success: true, CompletedResponse: true})
	if !r.state.Sessions["session-a"].Episode.Open {
		t.Fatal("pre-episode success cleared newer quota")
	}
	pickForTest(t, r, opts, "account-b")
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Success: true, CompletedResponse: true})
	if !r.state.Sessions["session-a"].Episode.Open {
		t.Fatal("late previous-account result cleared the active quota episode")
	}
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-b"), Options: opts, Success: true, CompletedResponse: false})
	if !r.state.Sessions["session-a"].Episode.Open {
		t.Fatal("partial HTTP 200 stream cleared quota")
	}
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-b"), Options: opts, Success: true, CompletedResponse: true})
	if r.state.Sessions["session-a"].Episode.Open {
		t.Fatal("completed post-episode generation did not clear quota")
	}
}

func TestExplicitDefaultGenerationChangesNextAdmission(t *testing.T) {
	r := testRouter(t)
	if _, err := r.register("session-a", codex, nil, false); err != nil {
		t.Fatal(err)
	}
	old := testAdmission(t, r, "session-a")
	pool := r.pools[codex]
	nextID := "account-b"
	pool.DefaultAccountID = &nextID
	pool.DefaultGeneration++
	if err := r.configure([]accountInput{r.accounts["account-a"], r.accounts["account-b"]}, []poolInput{pool}, r.policy); err != nil {
		t.Fatal(err)
	}
	if got := pickForTest(t, r, old, "account-a", "account-b").ID; got != authFileID("account-a") {
		t.Fatal("default change altered an admitted request")
	}
	reg, err := r.register("session-a", codex, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if reg.EffectiveAccountID != "account-b" {
		t.Fatal("new admission did not resolve explicit default generation")
	}
	oldPin := "account-a"
	if _, err := r.register("pinned", codex, &oldPin, false); err != nil {
		t.Fatal(err)
	}
	if r.state.Sessions["pinned"].Session.EffectiveAccountID != "account-a" {
		t.Fatal("provider default changed explicit pin")
	}
}

func TestAccountRemovalKeepsAdmittedSnapshotCredential(t *testing.T) {
	r := testRouter(t)
	a, b := "account-a", "account-b"
	if _, err := r.register("session-a", codex, &a, false); err != nil {
		t.Fatal(err)
	}
	admitted := testAdmission(t, r, "session-a")
	pickForTest(t, r, admitted, a, b)
	if _, err := r.register("session-a", codex, &b, true); err != nil {
		t.Fatal(err)
	}
	c := &control{router: r}
	if err := c.removeAccount(context.Background(), a); err == nil {
		t.Fatal("account removed while old admission retained it")
	}
	if got := pickForTest(t, r, admitted, a, b).ID; got != authFileID(a) {
		t.Fatal("rejected removal changed admitted account")
	}
}

func TestStateReportsActiveCooldownOnly(t *testing.T) {
	r := testRouter(t)
	until := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	r.state.Cooldowns["account-a"] = until
	r.state.Cooldowns["account-b"] = time.Now().Add(-time.Minute)
	store := tokenStore(r.dir)
	var out strings.Builder
	c := &control{out: &out, router: r, logins: &loginManager{manager: coreauth.NewManager(store, nil, nil), store: store, attempts: map[string]*loginAttempt{}}}
	c.handle(context.Background(), controlRequest{ID: 1, Method: "getState", Params: json.RawMessage("{}")})
	var response struct {
		Result stateSummary `json:"result"`
	}
	if err := json.Unmarshal([]byte(out.String()), &response); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range response.Result.Accounts {
		got[a.ID] = a.CooldownUntil
	}
	if got["account-a"] != until.Format(time.RFC3339) || got["account-b"] != "" || got["account-c"] != "" {
		t.Fatalf("cooldowns: %+v", got)
	}
}

func TestAccountRemovalBlocksRacingAdmission(t *testing.T) {
	r := testRouter(t)
	store := tokenStore(r.dir)
	manager := coreauth.NewManager(store, nil, nil)
	started := make(chan struct{})
	done := make(chan struct{})
	l := &loginManager{manager: manager, store: store, active: "account-a", attempts: map[string]*loginAttempt{"account-a": {status: loginStatus{AccountID: "account-a", Status: "pending"}, cancel: func() { close(started) }, done: done}}}
	c := &control{router: r, logins: l}
	removed := make(chan error, 1)
	go func() { removed <- c.removeAccount(context.Background(), "account-a") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("removal did not reach cancellation barrier")
	}
	id := "account-a"
	if _, err := r.register("racing", codex, &id, false); err == nil {
		t.Fatal("new admission raced credential deletion")
	}
	close(done)
	select {
	case err := <-removed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("removal stalled")
	}
}

type companionFixture struct {
	endpoint string
	input    *io.PipeWriter
	output   *io.PipeWriter
	messages <-chan json.RawMessage
	done     <-chan error
}

func startCompanionFixture(t *testing.T, dir string) *companionFixture {
	t.Helper()
	return startCompanionFixtureWith(t, dir, nil)
}

func startCompanionFixtureWith(t *testing.T, dir string, transport http.RoundTripper) *companionFixture {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	gin.DefaultWriter, gin.DefaultErrorWriter = io.Discard, io.Discard
	log.SetOutput(io.Discard)
	in, input := io.Pipe()
	out, output := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	messages := make(chan json.RawMessage, 16)
	go func() {
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			messages <- append(json.RawMessage{}, scanner.Bytes()...)
		}
		close(messages)
	}()
	go func() { done <- run(ctx, cancel, dir, in, output, transport) }()
	var ready struct {
		Event    string `json:"event"`
		Endpoint string `json:"endpoint"`
	}
	select {
	case raw := <-messages:
		if err := json.Unmarshal(raw, &ready); err != nil {
			t.Fatal(err)
		}
	case err := <-done:
		t.Fatalf("startup: %v", err)
	case <-time.After(15 * time.Second):
		cancel()
		t.Fatal("startup timeout")
	}
	if ready.Event != "ready" {
		t.Fatalf("unexpected startup: %+v", ready)
	}
	f := &companionFixture{endpoint: ready.Endpoint, input: input, output: output, messages: messages, done: done}
	t.Cleanup(func() { _ = input.Close(); cancel(); _ = output.Close(); _ = in.Close(); _ = out.Close() })
	return f
}

func (f *companionFixture) request(t *testing.T, line string) controlResponse {
	t.Helper()
	if _, err := io.WriteString(f.input, line+"\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case raw := <-f.messages:
		var result controlResponse
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("control timeout")
		return controlResponse{}
	}
}

func (f *companionFixture) stop(t *testing.T) {
	t.Helper()
	_ = f.input.Close()
	select {
	case err := <-f.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("companion did not stop after parent EOF")
	}
	_ = f.output.Close()
}

func TestCompanionControlLifecycleAndEndpointHydration(t *testing.T) {
	r := testRouter(t)
	reg, err := r.register("session-a", codex, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	dir := r.dir
	r.close()
	for range 2 {
		f := startCompanionFixture(t, dir)
		if f.endpoint != reg.Endpoint {
			t.Fatal("companion restart changed endpoint")
		}
		result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"account-a","provider":"codex","createdAt":"2026-01-01T00:00:00Z"}],"pools":[{"provider":"codex","defaultAccountId":"account-a","autoRotate":true,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`)
		if !result.OK {
			t.Fatalf("configure failed: %+v", result.Error)
		}
		state := f.request(t, `{"id":2,"method":"getState","params":{}}`)
		if strings.Contains(string(state.Result), reg.Token) {
			t.Fatal("routing key leaked into public summaries")
		}
		var summary stateSummary
		if err := json.Unmarshal(state.Result, &summary); err != nil {
			t.Fatal(err)
		}
		if len(summary.Sessions) != 1 || summary.Sessions[0].SessionID != "session-a" {
			t.Fatal("saved binding not hydrated")
		}
		if result := f.request(t, `{"id":3,"method":"registerSession","params":{"sessionId":"another","provider":"codex","accountId":null}}`); result.OK {
			t.Fatal("unready account launched")
		}
		if result := f.request(t, `{"id":4,"method":"getState","params":{"unexpected":true}}`); result.OK {
			t.Fatal("unknown payload field accepted")
		}
		client := &http.Client{Timeout: 2 * time.Second}
		for _, test := range []struct {
			path, token string
			want        int
		}{{"/v1/models", "forged", 401}, {"/v1/models", reg.Token, 503}, {"/v0/management/auth-files", reg.Token, 404}} {
			req, _ := http.NewRequest(http.MethodGet, f.endpoint+test.path, nil)
			req.Header.Set("Authorization", "Bearer "+test.token)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != test.want {
				t.Fatalf("%s status=%d want=%d", test.path, resp.StatusCode, test.want)
			}
		}
		f.stop(t)
		if resp, err := client.Get(f.endpoint + "/_spur/readiness"); err == nil {
			_ = resp.Body.Close()
			t.Fatal("companion endpoint remained open after stop")
		}
	}
}

// getState reads login status and the manager while attempts commit; neither may wait on the other.
func TestGetStateConcurrentWithVerify(t *testing.T) {
	f := newLoginFixture(t)
	c, out := f.control()
	_ = out
	stop := make(chan struct{})
	polled := make(chan int, 1)
	go func() {
		n := 0
		defer func() { polled <- n }()
		reader, readerOut := f.control()
		for {
			select {
			case <-stop:
				return
			default:
			}
			reader.handle(context.Background(), controlRequest{ID: uint64(n + 1), Method: "getState", Params: json.RawMessage("{}")})
			readerOut.Reset()
			n++
		}
	}()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := range 20 {
			key := strings.Repeat("k", 7) + string(rune('a'+i))
			if response := call(t, c, out, "setApiKey", apiKeyParams{AccountID: "account-a", Provider: claude, APIKey: key}); !response.OK {
				t.Errorf("attempt %d: %+v", i, response.Error)
				return
			}
			if final := f.await(t, "account-a"); final.Status != "ready" {
				t.Errorf("attempt %d: %+v", i, final)
				return
			}
		}
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("sign-in attempts and getState deadlocked")
	}
	close(stop)
	select {
	case n := <-polled:
		if n == 0 {
			t.Fatal("getState never ran")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("getState did not return")
	}
}

func TestStateReportsCredentialAndBrokenAt(t *testing.T) {
	f := newLoginFixture(t)
	saveFixtureCredential(t, f, "account-a", "access-one", "refresh-one")
	if _, err := f.l.store.Save(context.Background(), buildAPIKeyRecord("account-b", claude, strings.Repeat("key", 8))); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "credentials registered", func() bool { return f.l.ready("account-a", claude) && f.l.ready("account-b", claude) })
	c, out := f.control()
	got := states(t, c, out)
	if got["account-a"].Credential != "oauth" || got["account-b"].Credential != "api_key" || got["account-x"].Credential != "" {
		t.Fatalf("credentials: %+v", got)
	}
	if got["account-a"].BrokenAt != "" || got["account-b"].BrokenAt != "" {
		t.Fatalf("breakage reported without a mark: %+v", got)
	}
	if strings.Contains(out.String(), strings.Repeat("key", 8)) {
		t.Fatal("state leaked the API key")
	}
	f.r.mu.Lock()
	at := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	f.r.state.Broken["account-a"] = at
	f.r.mu.Unlock()
	if got = states(t, c, out); got["account-a"].BrokenAt != "2026-03-04T05:06:07Z" || got["account-b"].BrokenAt != "" {
		t.Fatalf("brokenAt: %+v", got)
	}
}

func TestControlRejectsMethodForWrongProvider(t *testing.T) {
	f := newLoginFixture(t)
	c, out := f.control()
	for name, params := range map[string]loginParams{
		"claude device":  {AccountID: "account-a", Provider: claude, Method: methodDevice},
		"claude browser": {AccountID: "account-a", Provider: claude, Method: methodBrowser},
		"codex oauth":    {AccountID: "account-x", Provider: codex, Method: methodOAuth},
		"missing method": {AccountID: "account-a", Provider: claude},
		"unknown method": {AccountID: "account-a", Provider: claude, Method: "password"},
		"wrong provider": {AccountID: "account-a", Provider: codex, Method: methodDevice},
		"unknown":        {AccountID: "nobody", Provider: claude, Method: methodOAuth},
	} {
		if response := call(t, c, out, "login", params); response.OK {
			t.Fatalf("%s: accepted", name)
		}
		if f.l.active != "" || len(f.l.attempts) != 0 {
			t.Fatalf("%s: started an attempt", name)
		}
	}
	for name, raw := range map[string]string{
		"unknown field in login":  `{"accountId":"account-a","provider":"claude","method":"oauth","extra":1}`,
		"unknown field in import": `{"accountId":"account-a","provider":"claude","extra":1}`,
	} {
		method := "login"
		if name == "unknown field in import" {
			method = "importNativeLogin"
		}
		out.Reset()
		c.handle(context.Background(), controlRequest{ID: 1, Method: method, Params: json.RawMessage(raw)})
		if strings.Contains(out.String(), `"ok":true`) {
			t.Fatalf("%s: accepted", name)
		}
	}
	for name, key := range map[string]string{"short": "1234567", "spaces": "abcd efgh", "newline": "abcdefgh\n", "long": strings.Repeat("k", 513), "empty": ""} {
		if response := call(t, c, out, "setApiKey", apiKeyParams{AccountID: "account-a", Provider: claude, APIKey: key}); response.OK {
			t.Fatalf("%s key accepted", name)
		}
	}
	if f.l.active != "" || len(f.l.attempts) != 0 {
		t.Fatal("rejected requests started an attempt")
	}
}
