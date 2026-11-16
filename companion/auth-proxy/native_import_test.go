package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// G0: native claude and codex logins become saved records that reload with their refresh token and
// identity, and the SDK refresh path hands that refresh token to the executor.
func TestNativeImportRecordRoundTrip(t *testing.T) {
	for _, p := range []provider{claude, codex} {
		dir := t.TempDir()
		expires := time.Now().Add(beyondRefreshLead(t, p))
		var wantRefresh string
		if p == claude {
			writeNativeClaude(t, dir, "native-a", expires, claudeIdentity())
			wantRefresh = "native-claude-refresh"
		} else {
			writeNativeCodex(t, dir, "native-a", expires)
			wantRefresh = "native-codex-refresh"
		}
		staged := readNativeLogin(dir, "native-a", p)
		if staged == nil {
			t.Fatalf("%s: complete native login not read", p)
		}
		store := tokenStore(dir)
		manager := coreauth.NewManager(store, nil, nil)
		executor := &fakeExecutor{provider: string(p)}
		manager.RegisterExecutor(executor)
		if _, err := store.Save(coreauth.WithAuthCreationIntent(context.Background()), staged); err != nil {
			t.Fatal(err)
		}
		listed, err := store.List(context.Background())
		if err != nil || len(listed) != 1 {
			t.Fatalf("%s: reload: %v %d", p, err, len(listed))
		}
		got := listed[0]
		identity, err := validatedIdentity(got)
		if got.Provider != string(p) || got.Metadata["refresh_token"] != wantRefresh || err != nil || !usableAuth(got) {
			t.Fatalf("%s: reloaded record %v %v %v", p, got.Provider, identity, err)
		}
		if p == claude && (identity.OrganizationID != "org-native" || identity.AccountID != "acct-native") || p == codex && identity.AccountID != "workspace-native" {
			t.Fatalf("%s: identity %+v", p, identity)
		}
		if _, err = manager.Register(coreauth.WithSkipPersist(context.Background()), got); err != nil {
			t.Fatal(err)
		}
		if _, err = manager.ForceRefreshAuth(context.Background(), got.ID); err != nil {
			t.Fatalf("%s: refresh: %v", p, err)
		}
		if len(executor.refresh) != 1 || executor.refresh[0] != wantRefresh {
			t.Fatalf("%s: executor refreshed with %v", p, executor.refresh)
		}
	}
}

func TestImportNativeLoginAbsentIsSideEffectFree(t *testing.T) {
	f := newLoginFixture(t)
	status, err := f.l.importNative(context.Background(), "account-a", claude)
	if err != nil || status.Status != "sign-in-required" {
		t.Fatalf("absent: %+v %v", status, err)
	}
	if f.l.active != "" || len(f.l.attempts) != 0 || f.executor[claude].probes() != 0 {
		t.Fatal("absent login changed the companion")
	}
	if entries, _ := os.ReadDir(filepath.Join(f.dir, "auth-proxy-credentials")); len(entries) != 0 {
		t.Fatal("absent login wrote credentials")
	}
}

func TestImportNativeLoginIncompleteClaudeIdentity(t *testing.T) {
	f := newLoginFixture(t)
	for name, identity := range map[string]map[string]string{
		"no organization": {"accountUuid": "acct-native", "emailAddress": "native@example.invalid"},
		"no account":      {"organizationUuid": "org-native"},
	} {
		writeNativeClaude(t, f.dir, "account-a", time.Now().Add(beyondRefreshLead(t, claude)), identity)
		status, err := f.l.importNative(context.Background(), "account-a", claude)
		if err != nil || status.Status != "sign-in-required" || len(f.l.attempts) != 0 {
			t.Fatalf("%s: %+v %v", name, status, err)
		}
	}
	// Only the credential file: still nothing to import.
	if err := os.Remove(filepath.Join(f.dir, "auth-terminal", "account-a", ".claude.json")); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.l.importNative(context.Background(), "account-a", claude); status.Status != "sign-in-required" {
		t.Fatalf("credentials without profile: %+v", status)
	}
}

func TestImportNativeLoginClaudeAndCodex(t *testing.T) {
	f := newLoginFixture(t)
	for id, p := range map[string]provider{"account-a": claude, "account-x": codex} {
		if p == claude {
			writeNativeClaude(t, f.dir, id, time.Now().Add(beyondRefreshLead(t, p)), claudeIdentity())
		} else {
			writeNativeCodex(t, f.dir, id, time.Now().Add(beyondRefreshLead(t, p)))
		}
		status, err := f.l.importNative(context.Background(), id, p)
		if err != nil || status.Status != "pending" || status.Stage != stageVerifying || status.Method != methodImport {
			t.Fatalf("%s start: %+v %v", id, status, err)
		}
		if final := f.await(t, id); final.Status != "ready" {
			t.Fatalf("%s: %+v", id, final)
		}
		if verified, broken := f.marks(id); !verified || broken {
			t.Fatalf("%s: marks verified=%v broken=%v", id, verified, broken)
		}
		if f.executor[p].probes() != 1 {
			t.Fatalf("%s: probes %d", id, f.executor[p].probes())
		}
	}
}

func TestImportNativeLoginRejectsSymlink(t *testing.T) {
	f := newLoginFixture(t)
	writeNativeClaude(t, f.dir, "account-a", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
	home := filepath.Join(f.dir, "auth-terminal", "account-a")
	target := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.Rename(filepath.Join(home, ".credentials.json"), target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(home, ".credentials.json")); err != nil {
		t.Fatal(err)
	}
	if status, err := f.l.importNative(context.Background(), "account-a", claude); err != nil || status.Status != "sign-in-required" {
		t.Fatalf("symlinked credential imported: %+v %v", status, err)
	}
	// A symlinked home directory is refused too.
	if err := os.RemoveAll(home); err != nil {
		t.Fatal(err)
	}
	elsewhere := t.TempDir()
	writeNativeClaude(t, elsewhere, "real", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
	if err := os.Symlink(filepath.Join(elsewhere, "auth-terminal", "real"), home); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.l.importNative(context.Background(), "account-a", claude); status.Status != "sign-in-required" {
		t.Fatalf("symlinked home imported: %+v", status)
	}
	if len(f.l.attempts) != 0 || f.executor[claude].probes() != 0 {
		t.Fatal("refused login had side effects")
	}
}

func TestImportNativeLoginDuplicateIdentity(t *testing.T) {
	f := newLoginFixture(t)
	writeNativeClaude(t, f.dir, "account-a", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
	if _, err := f.l.importNative(context.Background(), "account-a", claude); err != nil {
		t.Fatal(err)
	}
	if final := f.await(t, "account-a"); final.Status != "ready" {
		t.Fatalf("first import: %+v", final)
	}
	writeNativeClaude(t, f.dir, "account-b", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
	if _, err := f.l.importNative(context.Background(), "account-b", claude); err != nil {
		t.Fatal(err)
	}
	final := f.await(t, "account-b")
	if final.Status != "failed" || final.ErrorCode != errIdentity || final.Error != "This account is already saved; select its existing profile" {
		t.Fatalf("duplicate identity: %+v", final)
	}
	if verified, _ := f.marks("account-b"); verified {
		t.Fatal("duplicate identity was marked verified")
	}
	if _, err := os.Stat(filepath.Join(f.dir, "auth-proxy-credentials", "account-b.json")); err == nil {
		t.Fatal("duplicate identity was saved")
	}
}

func TestImportNativeLoginBusyWhileOtherAttempt(t *testing.T) {
	f := newLoginFixture(t)
	if _, err := f.l.start(context.Background(), "account-b", claude, methodOAuth); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = f.l.cancel("account-b") })
	writeNativeClaude(t, f.dir, "account-a", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
	status, err := f.l.importNative(context.Background(), "account-a", claude)
	if err != nil || status.Status != "busy" {
		t.Fatalf("busy: %+v %v", status, err)
	}
	if _, ok := f.l.attempts["account-a"]; ok || f.executor[claude].probes() != 0 {
		t.Fatal("busy import had side effects")
	}
	if _, err := os.Stat(filepath.Join(f.dir, "auth-terminal", "account-a", ".credentials.json")); err != nil {
		t.Fatal("busy import consumed the native files")
	}
}
