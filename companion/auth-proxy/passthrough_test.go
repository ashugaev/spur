package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// headerUpstream wraps the provider fake and answers inference requests with rate-limit headers plus
// headers the SDK must strip.
type headerUpstream struct {
	*providerFake
	mu   sync.Mutex
	seen []string
}

func (h *headerUpstream) RoundTrip(r *http.Request) (*http.Response, error) {
	if !strings.Contains(r.URL.Path, "/responses") {
		return h.providerFake.RoundTrip(r)
	}
	h.mu.Lock()
	h.seen = append(h.seen, r.URL.String())
	h.mu.Unlock()
	_, _ = io.Copy(io.Discard, r.Body)
	sse := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"output\":[]}}\n\n"
	header := http.Header{
		"Content-Type":                   {"text/event-stream"},
		"X-Codex-Primary-Used-Percent":   {"42"},
		"X-Codex-Secondary-Used-Percent": {"7"},
		"X-Codex-Primary-Reset-At":       {"1893456000"},
		"Set-Cookie":                     {"__cf_bm=secret; Path=/"},
		"Keep-Alive":                     {"timeout=5"},
		"Proxy-Authenticate":             {"Basic"},
		"X-Litellm-Version":              {"gateway"},
	}
	return &http.Response{StatusCode: http.StatusOK, Header: header, Body: io.NopCloser(bytes.NewReader([]byte(sse))), Request: r}, nil
}

// The account proxy forwards upstream rate-limit headers to the requesting session and still drops
// cookies, hop-by-hop headers and gateway-prefixed headers.
func TestUpstreamRateLimitHeadersPassThrough(t *testing.T) {
	up := &headerUpstream{providerFake: &providerFake{}}
	dir := t.TempDir()
	f := startCompanionFixtureWith(t, dir, up)
	if result := f.request(t, `{"id":1,"method":"configure","params":{"accounts":[{"id":"acct-import","provider":"codex","createdAt":"2026-01-01T00:00:00Z"}],"pools":[{"provider":"codex","defaultAccountId":"acct-import","autoRotate":false,"defaultGeneration":1}],"policy":{"cooldownMinutes":60,"maxRotationsPerEpisode":1}}}`); !result.OK {
		t.Fatalf("configure: %+v", result.Error)
	}
	writeNativeCodex(t, dir, "acct-import", time.Now().Add(beyondRefreshLead(t, codex)))
	if result := f.request(t, `{"id":2,"method":"importNativeLogin","params":{"accountId":"acct-import","provider":"codex"}}`); !result.OK {
		t.Fatalf("import: %+v", result.Error)
	}
	waitFor(t, "account ready", func() bool {
		return accountStatuses(t, f, int(time.Now().UnixNano()%1_000_000)+100)["acct-import"].Status == "ready"
	})
	reg := f.request(t, `{"id":3,"method":"registerSession","params":{"sessionId":"s-1","provider":"codex","accountId":"acct-import"}}`)
	if !reg.OK {
		t.Fatalf("register: %+v", reg.Error)
	}
	var registered registration
	if err := json.Unmarshal(reg.Result, &registered); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, registered.Endpoint+"/v1/responses", strings.NewReader(`{"model":"gpt-5.6-luna","input":"hi","stream":false}`))
	req.Header.Set("Authorization", "Bearer "+registered.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s (upstream saw %v)", resp.StatusCode, body, up.seen)
	}
	for name, want := range map[string]string{"X-Codex-Primary-Used-Percent": "42", "X-Codex-Secondary-Used-Percent": "7", "X-Codex-Primary-Reset-At": "1893456000"} {
		if got := resp.Header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	for _, name := range []string{"Set-Cookie", "Keep-Alive", "Proxy-Authenticate", "X-Litellm-Version"} {
		if got := resp.Header.Values(name); len(got) != 0 {
			t.Errorf("%s leaked downstream: %v", name, got)
		}
	}
}
