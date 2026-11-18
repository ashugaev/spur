package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// breakAccount verifies account-a, then lets the SDK reject its refresh token for good.
func breakAccount(t *testing.T, f *loginFixture) (*control, accountStatus) {
	t.Helper()
	saveFixtureCredential(t, f, "account-a", "access-one", "refresh-one")
	waitFor(t, "credential registered", func() bool { return f.l.ready("account-a", claude) })
	if err := f.r.setVerified("account-a"); err != nil {
		t.Fatal(err)
	}
	c, out := f.control()
	if got := states(t, c, out)["account-a"]; got.Status != "ready" || got.BrokenAt != "" {
		t.Fatalf("before breakage: %+v", got)
	}
	f.executor[claude].refreshErr = errors.New("refresh_token_reused: revoked")
	if _, err := f.l.manager.ForceRefreshAuth(context.Background(), authFileID("account-a")); err == nil {
		t.Fatal("terminal refresh error did not surface")
	}
	var got accountStatus
	waitFor(t, "breakage mark", func() bool { got = states(t, c, out)["account-a"]; return got.BrokenAt != "" })
	return c, got
}

func TestBrokenMarkSetOnRefreshRejection(t *testing.T) {
	f := newLoginFixture(t)
	_, got := breakAccount(t, f)
	if got.Status != "sign-in-required" {
		t.Fatalf("broken account reads %q", got.Status)
	}
	if verified, broken := f.marks("account-a"); !verified || !broken {
		t.Fatalf("marks verified=%v broken=%v", verified, broken)
	}
	// An account that never signed in with a verified mark is never reported broken.
	saveFixtureCredential(t, f, "account-b", "access-two", "refresh-two")
	waitFor(t, "second credential registered", func() bool { return f.l.ready("account-b", claude) })
	if _, err := f.l.manager.ForceRefreshAuth(context.Background(), authFileID("account-b")); err == nil {
		t.Fatal("terminal refresh error did not surface")
	}
	c, out := f.control()
	if b := states(t, c, out)["account-b"]; b.BrokenAt != "" {
		t.Fatalf("unverified account marked broken: %+v", b)
	}
}

func TestBrokenMarkSurvivesRestart(t *testing.T) {
	f := newLoginFixture(t)
	_, broken := breakAccount(t, f)
	f.r.close()

	again := newLoginFixtureIn(t, f.dir, true)
	// The reopened manager has no RequiresSignIn flag: the saved credential reads usable again.
	waitFor(t, "credential registered after restart", func() bool { return again.l.ready("account-a", claude) })
	c, out := again.control()
	got := states(t, c, out)["account-a"]
	if got.BrokenAt != broken.BrokenAt || got.Status != "sign-in-required" {
		t.Fatalf("after restart: %+v, before: %+v", got, broken)
	}
	again.r.mu.Lock()
	eligible := again.r.eligibleLocked("account-a", claude)
	again.r.mu.Unlock()
	if eligible {
		t.Fatal("broken account is eligible after restart")
	}
}

func TestBrokenMarkClearedOnVerifiedSignIn(t *testing.T) {
	f := newLoginFixture(t)
	c, out := f.control()
	breakAccount(t, f)
	f.executor[claude].refreshErr = nil
	status, err := f.l.start(context.Background(), "account-a", claude, methodOAuth)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.l.input("account-a", "?code=CODE&state="+firstQueryState(t, status.URL)); err != nil {
		t.Fatal(err)
	}
	if final := f.await(t, "account-a"); final.Status != "ready" {
		t.Fatalf("sign-in: %+v", final)
	}
	if verified, broken := f.marks("account-a"); !verified || broken {
		t.Fatalf("after verified sign-in: verified=%v broken=%v", verified, broken)
	}
	if got := states(t, c, out)["account-a"]; got.Status != "ready" || got.BrokenAt != "" {
		t.Fatalf("after verified sign-in: %+v", got)
	}
}

func TestRemoveAccountClearsMarks(t *testing.T) {
	f := newLoginFixture(t)
	c, _ := breakAccount(t, f)
	if err := c.removeAccount(context.Background(), "account-a"); err != nil {
		t.Fatal(err)
	}
	if verified, broken := f.marks("account-a"); verified || broken {
		t.Fatalf("marks survived removal: verified=%v broken=%v", verified, broken)
	}
	raw, err := os.ReadFile(filepath.Join(f.dir, "auth-proxy-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "account-a") {
		t.Fatalf("removed account still in persisted state: %s", raw)
	}
}
