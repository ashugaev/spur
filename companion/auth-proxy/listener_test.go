package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
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

func TestClaudeLoginOpensNoListener(t *testing.T) {
	fake := &claudeTokenFake{}
	dir := t.TempDir()
	// A fixture token inside the SDK's 4h refresh lead would be refreshed against the real provider.
	var exchanged claudeTokens
	if err := json.Unmarshal([]byte(claudeFakeToken), &exchanged); err != nil || time.Duration(exchanged.ExpiresIn)*time.Second <= 5*time.Hour {
		t.Fatal("fixture token is refresh-due; the SDK scheduler would call the real token endpoint")
	}
	f := startCompanionFixtureWith(t, dir, fake)
	endpoint, err := url.Parse(f.endpoint)
	if err != nil || endpoint.Hostname() != "127.0.0.1" {
		t.Fatalf("companion endpoint is not loopback: %s", f.endpoint)
	}
	if result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"account-a","provider":"claude","createdAt":"2026-01-01T00:00:00Z"}],"pools":[{"provider":"claude","defaultAccountId":"account-a","autoRotate":true,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`); !result.OK {
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
	started := f.request(t, `{"id":2,"method":"login","params":{"accountId":"account-a","provider":"claude"}}`)
	if !started.OK {
		t.Fatalf("login failed: %+v", started.Error)
	}
	var login loginStatus
	if err := json.Unmarshal(started.Result, &login); err != nil || login.Status != "pending" || login.Prompt == "" {
		t.Fatalf("login status: %+v %v", login, err)
	}
	assertSame("login start")
	authorize, err := url.Parse(login.URL)
	if err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]any{"id": 3, "method": "loginInput", "params": map[string]string{"accountId": "account-a", "input": "?code=CODE&state=" + authorize.Query().Get("state")}})
	if result := f.request(t, string(input)); !result.OK {
		t.Fatalf("login input failed: %+v", result.Error)
	}
	assertSame("paste")
	var final loginStatus
	for i := 0; i < 200 && final.Status != "ready" && final.Status != "failed"; i++ {
		time.Sleep(100 * time.Millisecond)
		result := f.request(t, fmt.Sprintf(`{"id":%d,"method":"loginStatus","params":{"accountId":"account-a"}}`, 10+i))
		if err := json.Unmarshal(result.Result, &final); err != nil {
			t.Fatal(err)
		}
		assertSame("exchange")
	}
	if fake.calls() != 1 {
		t.Fatalf("token exchange calls: %d", fake.calls())
	}
	if final.Status != "ready" {
		t.Fatalf("sign-in ended %+v", final)
	}
	assertSame("ready")
}
