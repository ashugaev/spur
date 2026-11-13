package main

import (
	"context"
	"net/http"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

func testRouter(t *testing.T) *router {
	t.Helper()
	r, err := openRouter(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.close)
	r.readyAccount = func(id string, p provider) bool {
		return (id == "account-a" || id == "account-b" || id == "account-c") && p == codex
	}
	defaultID := "account-a"
	if err := r.configure([]accountInput{{ID: "account-a", Provider: codex, CreatedAt: "2026-01-01T00:00:00Z"}, {ID: "account-b", Provider: codex, CreatedAt: "2026-01-02T00:00:00Z"}, {ID: "account-c", Provider: codex, CreatedAt: "2026-01-03T00:00:00Z"}}, []poolInput{{Provider: codex, DefaultAccountID: &defaultID, AutoRotate: true, DefaultGeneration: 1}}, policy{CooldownMinutes: 60, MaxRotationsPerEpisode: 1}); err != nil {
		t.Fatal(err)
	}
	return r
}

func testAdmission(t *testing.T, r *router, session string) coreexecutor.Options {
	t.Helper()
	r.mu.Lock()
	b, ok := r.state.Sessions[session]
	if !ok {
		t.Fatal("missing session")
	}
	r.requests[session] = &admission{SessionID: session, Binding: b}
	r.mu.Unlock()
	opts := coreexecutor.Options{Headers: http.Header{requestHeader: []string{session}}}
	opts.EnsureMetadata()
	return opts
}

func pickForTest(t *testing.T, r *router, opts coreexecutor.Options, ids ...string) *coreauth.Auth {
	t.Helper()
	var auths []*coreauth.Auth
	for _, id := range ids {
		auths = append(auths, &coreauth.Auth{ID: authFileID(id), Provider: string(codex)})
	}
	a, err := r.Pick(context.Background(), string(codex), "fixture-model", opts, auths)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestStrictPinsAndUnknownScope(t *testing.T) {
	r := testRouter(t)
	aID, bID := "account-a", "account-b"
	if _, err := r.register("session-a", codex, &aID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := r.register("session-b", codex, &bID, false); err != nil {
		t.Fatal(err)
	}
	a, b := testAdmission(t, r, "session-a"), testAdmission(t, r, "session-b")
	if got := pickForTest(t, r, a, aID, bID).ID; got != authFileID(aID) {
		t.Fatalf("first pin: %s", got)
	}
	if got := pickForTest(t, r, b, aID, bID).ID; got != authFileID(bID) {
		t.Fatalf("second pin: %s", got)
	}
	if a.Headers.Get(requestHeader) != "" {
		t.Fatal("internal scope header can reach upstream")
	}
	unknown := coreexecutor.Options{Headers: http.Header{requestHeader: []string{"forged"}}}
	unknown.EnsureMetadata()
	if _, err := r.Pick(context.Background(), "codex", "fixture-model", unknown, []*coreauth.Auth{{ID: authFileID(aID), Provider: "codex"}}); err == nil {
		t.Fatal("unknown scope accepted")
	}
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID(aID), Options: a, Error: &coreauth.Error{HTTPStatus: 429}})
	if _, err := r.Pick(context.Background(), "codex", "fixture-model", a, []*coreauth.Auth{{ID: authFileID(bID), Provider: "codex"}}); err == nil {
		t.Fatal("pin failed over")
	}
}

func TestAutoStickyAcrossSuccessAndQuota(t *testing.T) {
	r := testRouter(t)
	if _, err := r.register("session-a", codex, nil, false); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		opts := testAdmission(t, r, "session-a")
		if got := pickForTest(t, r, opts, "account-a", "account-b").ID; got != authFileID("account-a") {
			t.Fatalf("success changed account: %s", got)
		}
		r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Success: true, CompletedResponse: true})
	}
	opts := testAdmission(t, r, "session-a")
	pickForTest(t, r, opts, "account-a", "account-b")
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Error: &coreauth.Error{HTTPStatus: 429}})
	if got := pickForTest(t, r, opts, "account-b").ID; got != authFileID("account-b") {
		t.Fatalf("quota did not rotate: %s", got)
	}
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-b"), Options: opts, Success: true, CompletedResponse: true})
	next := testAdmission(t, r, "session-a")
	if got := pickForTest(t, r, next, "account-a", "account-b").ID; got != authFileID("account-b") {
		t.Fatalf("rotation was not sticky: %s", got)
	}
}

func TestRegisterAutoUsesBackupDuringSharedCooldown(t *testing.T) {
	r := testRouter(t)
	r.state.Cooldowns["account-a"] = time.Now().Add(time.Hour)
	reg, err := r.register("session-a", codex, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if reg.EffectiveAccountID != "account-b" {
		t.Fatalf("backup not selected: %+v", reg.sessionSummary)
	}
	if r.state.Sessions["session-a"].Episode.Rotations != 1 {
		t.Fatal("shared cooldown bypassed episode budget")
	}
	aID := "account-a"
	if _, err := r.register("pinned", codex, &aID, false); err == nil {
		t.Fatal("cooling pin accepted")
	}
}

func TestQuotaEpisodeAcrossRequestsAndRestart(t *testing.T) {
	r := testRouter(t)
	reg, err := r.register("session-a", codex, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	opts := testAdmission(t, r, "session-a")
	pickForTest(t, r, opts, "account-a", "account-b", "account-c")
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-a"), Options: opts, Error: &coreauth.Error{HTTPStatus: 429}})
	pickForTest(t, r, opts, "account-b", "account-c")
	r.OnResult(context.Background(), coreauth.Result{AuthID: authFileID("account-b"), Options: opts, Error: &coreauth.Error{HTTPStatus: 429}})
	dir := r.dir
	r.close()
	restored, err := openRouter(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.close()
	restored.readyAccount = r.readyAccount
	if err = restored.configure([]accountInput{r.accounts["account-a"], r.accounts["account-b"], r.accounts["account-c"]}, []poolInput{r.pools[codex]}, r.policy); err != nil {
		t.Fatal(err)
	}
	saved := restored.state.Sessions["session-a"]
	if saved.Token != reg.Token || restored.state.Endpoint != reg.Endpoint || saved.Episode.Rotations != 1 {
		t.Fatal("restart changed durable routing/budget")
	}
	if _, err = restored.register("session-a", codex, nil, false); err == nil {
		t.Fatal("new request escaped quota episode cap")
	}
}

func TestManagedPoolZeroReadyAndExclusiveOwner(t *testing.T) {
	r := testRouter(t)
	r.readyAccount = func(string, provider) bool { return false }
	if _, err := r.register("session-a", codex, nil, false); err == nil {
		t.Fatal("zero-ready pool accepted")
	}
	if _, err := openRouter(r.dir); err == nil {
		t.Fatal("second process adopted owned state")
	}
}
