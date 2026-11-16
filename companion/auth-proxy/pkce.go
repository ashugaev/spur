package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

// Spur-owned Claude PKCE. Same client, redirect and scope as the SDK authenticator, but nothing
// listens for the redirect: the user pastes the returned address and the companion exchanges it.
const (
	claudeAuthURL     = "https://claude.ai/oauth/authorize"
	claudeTokenURL    = "https://platform.claude.com/v1/oauth/token"
	claudeClientID    = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeRedirectURI = "http://localhost:54545/callback"
	claudeScope       = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
	loginPrompt       = "Paste the callback URL from the authorization page"
)

type claudeFlow struct{ verifier, challenge, state string }

func newClaudeFlow() (*claudeFlow, error) {
	verifier := make([]byte, 96)
	state := make([]byte, 16)
	if _, err := rand.Read(verifier); err != nil {
		return nil, err
	}
	if _, err := rand.Read(state); err != nil {
		return nil, err
	}
	v := base64.RawURLEncoding.EncodeToString(verifier)
	sum := sha256.Sum256([]byte(v))
	return &claudeFlow{verifier: v, challenge: base64.RawURLEncoding.EncodeToString(sum[:]), state: hex.EncodeToString(state)}, nil
}

func (f *claudeFlow) authorizeURL() string {
	return claudeAuthURL + "?" + url.Values{
		"code":                  {"true"},
		"client_id":             {claudeClientID},
		"response_type":         {"code"},
		"redirect_uri":          {claudeRedirectURI},
		"scope":                 {claudeScope},
		"code_challenge":        {f.challenge},
		"code_challenge_method": {"S256"},
		"state":                 {f.state},
	}.Encode()
}

type oauthCallback struct{ code, state, errCode string }

// parseClaudeCallback accepts exactly the forms the SDK accepts (internal/misc ParseOAuthCallback).
// A nil result with no error means blank input: keep waiting.
func parseClaudeCallback(input string) (*oauthCallback, error) {
	candidate := strings.TrimSpace(input)
	if candidate == "" {
		return nil, nil
	}
	if !strings.Contains(candidate, "://") {
		switch {
		case strings.HasPrefix(candidate, "?"):
			candidate = "http://localhost" + candidate
		case strings.ContainsAny(candidate, "/?#") || strings.Contains(candidate, ":"):
			candidate = "http://" + candidate
		case strings.Contains(candidate, "="):
			candidate = "http://localhost/?" + candidate
		default:
			return nil, errors.New("invalid callback URL")
		}
	}
	parsed, err := url.Parse(candidate)
	if err != nil {
		return nil, err
	}
	query := parsed.Query()
	code, state := strings.TrimSpace(query.Get("code")), strings.TrimSpace(query.Get("state"))
	errCode, errDesc := strings.TrimSpace(query.Get("error")), strings.TrimSpace(query.Get("error_description"))
	if parsed.Fragment != "" {
		if fragment, err := url.ParseQuery(parsed.Fragment); err == nil {
			code = firstNonEmpty(code, strings.TrimSpace(fragment.Get("code")))
			state = firstNonEmpty(state, strings.TrimSpace(fragment.Get("state")))
			errCode = firstNonEmpty(errCode, strings.TrimSpace(fragment.Get("error")))
			errDesc = firstNonEmpty(errDesc, strings.TrimSpace(fragment.Get("error_description")))
		}
	}
	if code != "" && state == "" && strings.Contains(code, "#") {
		code, state, _ = strings.Cut(code, "#")
	}
	if errCode == "" {
		errCode = errDesc
	}
	if code == "" && errCode == "" {
		return nil, errors.New("callback URL missing code")
	}
	return &oauthCallback{code: code, state: state, errCode: errCode}, nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// accept validates a pasted callback against this attempt. Returns the code and state to exchange.
func (f *claudeFlow) accept(input string) (code, state string, wait bool, err error) {
	parsed, err := parseClaudeCallback(input)
	if err != nil {
		return "", "", false, err
	}
	if parsed == nil {
		return "", "", true, nil
	}
	if parsed.errCode != "" {
		return "", "", false, errors.New("authorization was not granted")
	}
	if subtle.ConstantTimeCompare([]byte(parsed.state), []byte(f.state)) != 1 {
		return "", "", false, errors.New("state mismatch")
	}
	return parsed.code, f.state, false, nil
}

type claudeTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Organization struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	} `json:"organization"`
	Account struct {
		UUID         string `json:"uuid"`
		EmailAddress string `json:"email_address"`
	} `json:"account"`
}

// Field order mirrors the native client body; a map would be re-sorted.
type claudeExchangeBody struct {
	GrantType    string `json:"grant_type"`
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	ClientID     string `json:"client_id"`
	CodeVerifier string `json:"code_verifier"`
	State        string `json:"state"`
}

func (f *claudeFlow) exchange(ctx context.Context, client *http.Client, code, state string) (*claudeTokens, error) {
	// Same quirk as the SDK: a "#state" suffix left on the code overrides the state.
	if head, tail, found := strings.Cut(code, "#"); found {
		code = head
		if tail != "" {
			state = strings.SplitN(tail, "#", 2)[0]
		}
	}
	body, err := json.Marshal(claudeExchangeBody{"authorization_code", code, claudeRedirectURI, claudeClientID, f.verifier, state})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, claudeTokenURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "axios/1.15.2")
	req.Header.Set("Accept-Encoding", "gzip, compress, deflate, br")
	req.Header.Set("Connection", "close")
	req.Close = true
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("token exchange request failed")
	}
	defer resp.Body.Close()
	raw, err := readOAuthBody(resp)
	if err != nil {
		return nil, errors.New("token exchange response unreadable")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token exchange failed with status %d", resp.StatusCode)
	}
	var tokens claudeTokens
	if err = json.Unmarshal(raw, &tokens); err != nil || tokens.AccessToken == "" {
		return nil, errors.New("token exchange response invalid")
	}
	return &tokens, nil
}

func readOAuthBody(resp *http.Response) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	encodings := strings.Split(strings.Join(resp.Header.Values("Content-Encoding"), ","), ",")
	for i := len(encodings) - 1; i >= 0; i-- {
		var reader io.Reader
		switch strings.ToLower(strings.TrimSpace(encodings[i])) {
		case "", "identity":
			continue
		case "gzip":
			if reader, err = gzip.NewReader(bytes.NewReader(data)); err != nil {
				return nil, err
			}
		case "deflate":
			if reader, err = zlib.NewReader(bytes.NewReader(data)); err != nil {
				reader = flate.NewReader(bytes.NewReader(data))
			}
		case "br":
			reader = brotli.NewReader(bytes.NewReader(data))
		default:
			return nil, errors.New("unsupported content encoding")
		}
		if data, err = io.ReadAll(io.LimitReader(reader, 1<<20)); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func oauthHTTPClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}
}
