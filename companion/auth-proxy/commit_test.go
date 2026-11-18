package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
)

func saveFixtureCredential(t *testing.T, f *loginFixture, id, access, refresh string) {
	t.Helper()
	if _, err := f.l.store.Save(context.Background(), buildClaudeFixtureRecord(t, id, access, refresh)); err != nil {
		t.Fatal(err)
	}
}

// A credential saved but never marked (crash between save and mark) is not routable after a restart.
func TestUnverifiedCredentialNotReadyAfterRestart(t *testing.T) {
	first := newLoginFixture(t)
	saveFixtureCredential(t, first, "account-a", "saved-access", "saved-refresh")
	first.r.close()

	f := newLoginFixtureIn(t, first.dir, true)
	waitFor(t, "saved credential registered", func() bool { return f.l.ready("account-a", claude) })
	c, out := f.control()
	if got := states(t, c, out)["account-a"].Status; got != "sign-in-required" {
		t.Fatalf("unverified credential reads %q", got)
	}
	f.r.mu.Lock()
	eligible := f.r.eligibleLocked("account-a", claude)
	f.r.mu.Unlock()
	if eligible {
		t.Fatal("unverified credential is eligible for routing")
	}
	if status := call(t, c, out, "loginStatus", accountParams{"account-a"}); !strings.Contains(string(status.Result), `"sign-in-required"`) {
		t.Fatalf("loginStatus reports %s", status.Result)
	}
	if err := f.r.setVerified("account-a"); err != nil {
		t.Fatal(err)
	}
	f.r.mu.Lock()
	eligible = f.r.eligibleLocked("account-a", claude)
	f.r.mu.Unlock()
	if !eligible || states(t, c, out)["account-a"].Status != "ready" {
		t.Fatal("the mark alone should make a usable credential ready")
	}
}

func writeState(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "auth-proxy-state.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestStateSchemaOneRejected(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	body := `{"schema":1,"dataDir":"` + dir + `","endpoint":"http://127.0.0.1:41999","sessions":{},"cooldowns":{}}`
	path := writeState(t, dir, body)
	r, err := openRouter(dir)
	if err == nil {
		r.close()
		t.Fatal("schema 1 state opened")
	}
	if !strings.Contains(err.Error(), "auth proxy state unavailable") {
		t.Fatalf("error: %v", err)
	}
	if raw, _ := os.ReadFile(path); string(raw) != body {
		t.Fatal("rejected state file was rewritten")
	}
}

func TestStateRequiresMarkMaps(t *testing.T) {
	for name, maps := range map[string]string{
		"null verified": `"verified":null,"broken":{}`,
		"null broken":   `"verified":{},"broken":null`,
		"both null":     `"verified":null,"broken":null`,
	} {
		dir, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		writeState(t, dir, `{"schema":2,"dataDir":"`+dir+`","endpoint":"http://127.0.0.1:41999","sessions":{},"cooldowns":{},`+maps+`}`)
		if r, err := openRouter(dir); err == nil {
			r.close()
			t.Fatalf("%s: state opened", name)
		}
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	writeState(t, dir, `{"schema":2,"dataDir":"`+dir+`","endpoint":"http://127.0.0.1:41999","sessions":{},"cooldowns":{},"verified":{},"broken":{}}`)
	r, err := openRouter(dir)
	if err != nil {
		t.Fatalf("empty mark maps rejected: %v", err)
	}
	r.close()
}

// The main.go composition: a usable credential routes only with a verified mark and no breakage mark.
func TestReadyAccountComposesMarks(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seed, err := openRouter(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"marked", "broken"} {
		if err = seed.setVerified(id); err != nil {
			t.Fatal(err)
		}
	}
	seed.markBroken("broken")
	seed.close()

	fake := &providerFake{}
	f := startCompanionFixtureWith(t, dir, fake)
	if result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"marked","provider":"claude","createdAt":"2026-01-01T00:00:00Z"},{"id":"broken","provider":"claude","createdAt":"2026-01-02T00:00:00Z"},{"id":"unmarked","provider":"claude","createdAt":"2026-01-03T00:00:00Z"}],"pools":[{"provider":"claude","defaultAccountId":null,"autoRotate":false,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`); !result.OK {
		t.Fatalf("configure: %+v", result.Error)
	}
	store := tokenStore(dir)
	for _, id := range []string{"marked", "broken", "unmarked"} {
		record, err := buildClaudeFixtureRecordWith(id, "composed-access", "composed-refresh")
		if err != nil {
			t.Fatal(err)
		}
		record.Metadata["account_uuid"], record.Metadata["organization_uuid"] = "acct-"+id, "org-"+id
		if _, err := store.Save(context.Background(), record); err != nil {
			t.Fatal(err)
		}
	}
	want := map[string]string{"marked": "ready", "broken": "sign-in-required", "unmarked": "sign-in-required"}
	waitFor(t, "composed readiness", func() bool {
		got := accountStatuses(t, f, int(time.Now().UnixNano()%1_000_000)+100)
		for id, status := range want {
			if got[id].Status != status {
				return false
			}
		}
		return true
	})
	for id, ok := range map[string]bool{"marked": true, "broken": false, "unmarked": false} {
		reg := f.request(t, `{"id":7,"method":"registerSession","params":{"sessionId":"s-`+id+`","provider":"claude","accountId":"`+id+`"}}`)
		if reg.OK != ok {
			t.Fatalf("pinning %s: ok=%v, want %v", id, reg.OK, ok)
		}
	}
}

// A refresh in flight when a sign-in starts must not write its result over the new credential.
func TestSaveFencesRefreshForImportAndAPIKey(t *testing.T) {
	for _, method := range []string{methodImport, methodAPIKey} {
		f := newLoginFixture(t)
		old := buildClaudeFixtureRecord(t, "account-a", "old-access", "old-refresh")
		// Same identity as the native login, so the sign-in replaces this account instead of changing it.
		old.Metadata["account_uuid"], old.Metadata["organization_uuid"] = "acct-native", "org-native"
		if _, err := f.l.store.Save(context.Background(), old); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "old credential registered", func() bool { return f.l.ready("account-a", claude) })
		executor := f.executor[claude]
		executor.gate, executor.probeGate = make(chan struct{}), make(chan struct{})
		refreshed := make(chan error, 1)
		go func() {
			_, err := f.l.manager.ForceRefreshAuth(context.Background(), authFileID("account-a"))
			refreshed <- err
		}()
		waitFor(t, "refresh in flight", func() bool { return len(executor.refreshTokens()) == 1 })

		if method == methodImport {
			writeNativeClaude(t, f.dir, "account-a", time.Now().Add(beyondRefreshLead(t, claude)), claudeIdentity())
			if status, err := f.l.importNative(context.Background(), "account-a", claude); err != nil || status.Status != "pending" {
				t.Fatalf("import: %+v %v", status, err)
			}
		} else if status, err := f.l.setAPIKey(context.Background(), "account-a", claude, strings.Repeat("key", 8)); err != nil || status.Status != "pending" {
			t.Fatalf("api key: %+v %v", status, err)
		}
		if _, ok := f.l.manager.GetByID(authFileID("account-a")); ok {
			t.Fatalf("%s: the old registration survived the start of the sign-in", method)
		}
		close(executor.gate)
		select {
		case <-refreshed:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: refresh never returned", method)
		}
		close(executor.probeGate)
		if final := f.await(t, "account-a"); final.Status != "ready" {
			t.Fatalf("%s: %+v", method, final)
		}
		stored, err := f.l.store.List(context.Background())
		if err != nil || len(stored) != 1 {
			t.Fatalf("%s: store %v %d", method, err, len(stored))
		}
		access, _ := stored[0].Metadata["access_token"].(string)
		key, _ := stored[0].Metadata["api_key"].(string)
		if access == "old-access" || (method == methodImport && access != "native-claude-access") || (method == methodAPIKey && (key == "" || access != "")) {
			t.Fatalf("%s: refresh result overwrote the new credential (access=%q key set=%v)", method, access, key != "")
		}
	}
}

// The device worker writes outside the auth directory; nothing reaches it before the probe passes and
// the staged file is gone after every outcome.
func TestDeviceStagingNeverInAuthDir(t *testing.T) {
	entries := func(dir string) []string {
		list, _ := os.ReadDir(dir)
		var names []string
		for _, e := range list {
			if !strings.HasSuffix(e.Name(), ".lock") { // the Codex save leaves an empty lock file
				names = append(names, e.Name())
			}
		}
		return names
	}
	for _, outcome := range []string{"verified", "rejected", "worker failed"} {
		f := newLoginFixture(t)
		authDir, staging := filepath.Join(f.dir, "auth-proxy-credentials"), filepath.Join(f.dir, "auth-proxy-staging")
		executor := f.executor[codex]
		mode := "stage"
		switch outcome {
		case "rejected":
			executor.status = 401
		case "worker failed":
			mode = "expired"
		}
		gate := make(chan struct{})
		if outcome != "worker failed" {
			executor.probeGate = gate
		}
		f.l.command = helperCommand(mode)
		if _, err := f.l.start(context.Background(), "account-x", codex, methodDevice); err != nil {
			t.Fatal(err)
		}
		if outcome != "worker failed" {
			waitFor(t, "probe running", func() bool { return f.l.status("account-x").Stage == stageVerifying })
			if got := entries(authDir); len(got) != 0 {
				t.Fatalf("%s: auth dir holds %v before the probe passed", outcome, got)
			}
			if got := entries(staging); len(got) != 0 {
				t.Fatalf("%s: staged file outlived its read: %v", outcome, got)
			}
			close(gate)
		}
		final := f.await(t, "account-x")
		switch outcome {
		case "verified":
			if final.Status != "ready" || len(entries(authDir)) != 1 {
				t.Fatalf("verified: %+v %v", final, entries(authDir))
			}
		default:
			if final.Status != "failed" || len(entries(authDir)) != 0 {
				t.Fatalf("%s: %+v %v", outcome, final, entries(authDir))
			}
		}
		if got := entries(staging); len(got) != 0 {
			t.Fatalf("%s: staging not emptied: %v", outcome, got)
		}
	}
}

// A sign-in cancelled after the credential registered never gets its verified mark.
func TestCancelBeforeVerifiedMarkNeverBecomesReady(t *testing.T) {
	f := newLoginFixture(t)
	if _, err := f.l.setAPIKey(context.Background(), "account-a", claude, strings.Repeat("key", 8)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "credential saved", func() bool {
		stored, err := f.l.store.List(context.Background())
		return err == nil && len(stored) == 1
	})
	// Hold the router lock so the attempt, once registered, waits to write its mark; cancel meanwhile.
	f.r.mu.Lock()
	waitFor(t, "credential registered", func() bool {
		auth, ok := f.l.manager.GetByID("account-a.json")
		return ok && usableAuth(auth) && len(cliproxy.GlobalModelRegistry().GetModelsForClient(auth.ID)) > 0
	})
	time.Sleep(300 * time.Millisecond)
	f.l.mu.Lock()
	f.l.attempts["account-a"].cancel()
	f.l.mu.Unlock()
	f.r.mu.Unlock()
	final := f.await(t, "account-a")
	if final.Status == "ready" {
		t.Fatalf("cancelled sign-in finished ready: %+v", final)
	}
	if verified, _ := f.marks("account-a"); verified {
		t.Fatal("cancelled sign-in was marked verified")
	}
	f.r.mu.Lock()
	eligible := f.r.eligibleLocked("account-a", claude)
	f.r.mu.Unlock()
	if eligible {
		t.Fatal("cancelled sign-in is eligible for routing")
	}
}
