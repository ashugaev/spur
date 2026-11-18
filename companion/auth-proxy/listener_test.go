package main

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// processListeners lists the local address of every TCP socket in LISTEN state owned by this
// process: fd inodes joined with /proc/net/tcp and /proc/net/tcp6 (state 0A).
func processListeners(t *testing.T) []string {
	t.Helper()
	fds, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Skip("procfs unavailable")
	}
	inodes := map[string]bool{}
	for _, fd := range fds {
		if link, err := os.Readlink(filepath.Join("/proc/self/fd", fd.Name())); err == nil {
			if inode, ok := strings.CutPrefix(link, "socket:["); ok {
				inodes[strings.TrimSuffix(inode, "]")] = true
			}
		}
	}
	var listeners []string
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		raw, err := os.ReadFile(table)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(raw), "\n")[1:] {
			fields := strings.Fields(line)
			if len(fields) > 9 && fields[3] == "0A" && inodes[fields[9]] {
				listeners = append(listeners, table+" "+fields[1])
			}
		}
	}
	slices.Sort(listeners)
	return listeners
}

// childProcesses lists this process's direct children. The SDK login worker is a child process,
// so a socket snapshot of this process alone would not see its callback listener.
func childProcesses(t *testing.T) string {
	t.Helper()
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		t.Skip("procfs unavailable")
	}
	var children []string
	for _, task := range tasks {
		raw, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "children"))
		if err != nil {
			t.Skip("child process list unavailable")
		}
		children = append(children, strings.Fields(string(raw))...)
	}
	slices.Sort(children)
	return strings.Join(children, " ")
}

// TestLoginMethodsOpenNoListener runs every in-process sign-in method (Claude account, Codex browser,
// API key, native import) against the in-memory provider network and asserts the process opened no
// listening socket and started no child process. The device method runs in the SDK worker, whose
// flow has no listener; a started worker would show as a child process.
func TestLoginMethodsOpenNoListener(t *testing.T) {
	fake := &providerFake{}
	dir := t.TempDir()
	// Fixture tokens inside the SDK refresh lead would be refreshed against the real provider.
	for p, lifetime := range map[provider]time.Duration{claude: 28800 * time.Second, codex: 720000 * time.Second} {
		if lifetime <= *coreauth.ProviderRefreshLead(string(p), nil) {
			t.Fatalf("%s fixture token is refresh-due; the SDK scheduler would call the real token endpoint", p)
		}
	}
	f := startCompanionFixtureWith(t, dir, fake)
	endpoint, err := url.Parse(f.endpoint)
	if err != nil || endpoint.Hostname() != "127.0.0.1" {
		t.Fatalf("companion endpoint is not loopback: %s", f.endpoint)
	}
	if result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"acct-oauth","provider":"claude","createdAt":"2026-01-01T00:00:00Z"},{"id":"acct-browser","provider":"codex","createdAt":"2026-01-02T00:00:00Z"},{"id":"acct-key","provider":"claude","createdAt":"2026-01-03T00:00:00Z"},{"id":"acct-import","provider":"codex","createdAt":"2026-01-04T00:00:00Z"}],"pools":[{"provider":"claude","defaultAccountId":null,"autoRotate":false,"defaultGeneration":1},{"provider":"codex","defaultAccountId":null,"autoRotate":false,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`); !result.OK {
		t.Fatalf("configure failed: %+v", result.Error)
	}
	before := processListeners(t)
	if len(before) == 0 {
		t.Fatal("snapshot missed the companion endpoint listener")
	}
	children := childProcesses(t)
	assertSame := func(stage string) {
		t.Helper()
		if got := childProcesses(t); got != children {
			t.Fatalf("%s spawned a process: before=%q after=%q", stage, children, got)
		}
		if after := processListeners(t); !slices.Equal(before, after) {
			t.Fatalf("%s changed LISTEN sockets: before=%v after=%v", stage, before, after)
		}
	}
	next := 10
	call := func(method string, params map[string]string) loginStatus {
		t.Helper()
		next++
		line, _ := json.Marshal(map[string]any{"id": next, "method": method, "params": params})
		result := f.request(t, string(line))
		if !result.OK {
			t.Fatalf("%s failed: %+v", method, result.Error)
		}
		var status loginStatus
		if err := json.Unmarshal(result.Result, &status); err != nil {
			t.Fatal(err)
		}
		assertSame(method)
		return status
	}
	settle := func(id string) loginStatus {
		t.Helper()
		var final loginStatus
		for i := 0; i < 200 && final.Status != "ready" && final.Status != "failed"; i++ {
			time.Sleep(100 * time.Millisecond)
			final = call("loginStatus", map[string]string{"accountId": id})
		}
		if final.Status != "ready" {
			t.Fatalf("%s ended %+v", id, final)
		}
		return final
	}
	paste := func(id, authorizeURL string) {
		t.Helper()
		parsed, err := url.Parse(authorizeURL)
		if err != nil {
			t.Fatal(err)
		}
		call("loginInput", map[string]string{"accountId": id, "input": "?code=CODE&state=" + parsed.Query().Get("state")})
	}

	oauth := call("login", map[string]string{"accountId": "acct-oauth", "provider": "claude", "method": "oauth"})
	if oauth.Status != "pending" || oauth.Prompt == "" {
		t.Fatalf("oauth start: %+v", oauth)
	}
	paste("acct-oauth", oauth.URL)
	settle("acct-oauth")

	browser := call("login", map[string]string{"accountId": "acct-browser", "provider": "codex", "method": "browser"})
	if browser.Status != "pending" || !strings.HasPrefix(browser.URL, "https://auth.openai.com/oauth/authorize?") {
		t.Fatalf("browser start: %+v", browser)
	}
	paste("acct-browser", browser.URL)
	settle("acct-browser")

	if started := call("setApiKey", map[string]string{"accountId": "acct-key", "provider": "claude", "apiKey": strings.Repeat("key", 8)}); started.Status != "pending" {
		t.Fatalf("api key start: %+v", started)
	}
	settle("acct-key")

	writeNativeCodex(t, dir, "acct-import", time.Now().Add(beyondRefreshLead(t, codex)))
	if started := call("importNativeLogin", map[string]string{"accountId": "acct-import", "provider": "codex"}); started.Status != "pending" {
		t.Fatalf("import start: %+v", started)
	}
	settle("acct-import")

	// Every request went to the fake network: the token endpoints, lookups and probes it knows.
	if fake.calls() != 1 || fake.count(codexTokenURL) != 1 {
		t.Fatalf("token exchanges: claude=%d codex=%d", fake.calls(), fake.count(codexTokenURL))
	}
	for _, target := range []string{claudeUsageURL, claudeModelsURL} {
		if fake.count(target) != 1 {
			t.Fatalf("probe %s sent %d times", target, fake.count(target))
		}
	}
	if fake.count(codexUsageURL) != 2 {
		t.Fatalf("codex usage probes: browser and import should each probe once, saw %d", fake.count(codexUsageURL))
	}
}
