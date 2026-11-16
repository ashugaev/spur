package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/lzw"
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
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
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

// claudeCallbackWait bounds the wait for a paste, as the SDK callback server did. Var so tests shorten it.
var claudeCallbackWait = 5 * time.Minute

// browserFlow is one listener-free browser sign-in: the user opens authorizeURL, signs in, and pastes
// the address the provider redirected to. redeem exchanges the accepted code for a staged credential.
type browserFlow interface {
	authorizeURL() string
	accept(input string) (code, state string, err error)
	redeem(ctx context.Context, client *http.Client, id, code, state string) (*coreauth.Auth, error)
}

// pkceSecrets are the per-attempt verifier and state shared by every provider flow.
type pkceSecrets struct{ verifier, challenge, state string }

func newPKCESecrets() (pkceSecrets, error) {
	verifier := make([]byte, 96)
	state := make([]byte, 16)
	if _, err := rand.Read(verifier); err != nil {
		return pkceSecrets{}, err
	}
	if _, err := rand.Read(state); err != nil {
		return pkceSecrets{}, err
	}
	v := base64.RawURLEncoding.EncodeToString(verifier)
	sum := sha256.Sum256([]byte(v))
	return pkceSecrets{verifier: v, challenge: base64.RawURLEncoding.EncodeToString(sum[:]), state: hex.EncodeToString(state)}, nil
}

type claudeFlow struct{ pkceSecrets }

func newClaudeFlow() (*claudeFlow, error) {
	secrets, err := newPKCESecrets()
	if err != nil {
		return nil, err
	}
	return &claudeFlow{secrets}, nil
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

// parseCallback accepts the forms the SDK accepts (internal/misc ParseOAuthCallback) plus the bare
// code#state the Claude authorization page displays.
// Blank input never reaches here: loginManager.input keeps waiting on it.
func parseCallback(input string) (*oauthCallback, error) {
	candidate := strings.TrimSpace(input)
	if candidate == "" {
		return nil, errors.New("callback URL missing code")
	}
	if !strings.ContainsAny(candidate, "=?/:") && strings.Count(candidate, "#") == 1 {
		if code, state, _ := strings.Cut(candidate, "#"); code != "" && state != "" {
			return &oauthCallback{code: code, state: state}, nil
		}
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
func (f *pkceSecrets) accept(input string) (code, state string, err error) {
	parsed, err := parseCallback(input)
	if err != nil {
		return "", "", err
	}
	if parsed.errCode != "" {
		return "", "", errors.New("authorization was not granted")
	}
	if subtle.ConstantTimeCompare([]byte(parsed.state), []byte(f.state)) != 1 {
		return "", "", errors.New("state mismatch")
	}
	return parsed.code, f.state, nil
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
		return nil, exchangeTransportError(ctx)
	}
	defer resp.Body.Close()
	raw, err := readOAuthBody(resp)
	if err != nil {
		return nil, errors.New("token exchange response unreadable")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, exchangeStatusError(resp.StatusCode)
	}
	var tokens claudeTokens
	if err = json.Unmarshal(raw, &tokens); err != nil || tokens.AccessToken == "" {
		return nil, errors.New("token exchange response invalid")
	}
	return &tokens, nil
}

// redeem exchanges the code, replays the SDK's advisory account lookups and builds the credential record.
func (f *claudeFlow) redeem(ctx context.Context, client *http.Client, id, code, state string) (*coreauth.Auth, error) {
	tokens, err := f.exchange(ctx, client, code, state)
	if err != nil {
		return nil, err
	}
	inspectClaudeAccount(ctx, client, tokens)
	if strings.TrimSpace(tokens.Account.EmailAddress) == "" {
		return nil, errors.New("claude token storage missing account information")
	}
	return buildClaudeOAuthRecord(id, tokens, time.Now())
}

const (
	claudeProfileURL = "https://api.anthropic.com/api/oauth/profile"
	claudeRolesURL   = "https://api.anthropic.com/api/oauth/claude_cli/roles"
)

// inspectClaudeAccount replays the SDK's post-exchange lookups: the profile response overrides the
// token response identity where it carries a value, and the roles lookup is sent and ignored.
// Both are advisory; any failure leaves the token response identity in place, as in the SDK.
func inspectClaudeAccount(ctx context.Context, client *http.Client, tokens *claudeTokens) {
	var profile struct {
		Account struct {
			UUID  string `json:"uuid"`
			Email string `json:"email"`
		} `json:"account"`
		Organization struct {
			UUID string `json:"uuid"`
			Name string `json:"name"`
		} `json:"organization"`
	}
	if body, err := fetchClaudeControlPlane(ctx, client, claudeProfileURL, tokens.AccessToken); err == nil &&
		json.Unmarshal(body, &profile) == nil && strings.TrimSpace(profile.Account.UUID) != "" {
		for target, value := range map[*string]string{
			&tokens.Account.UUID:         profile.Account.UUID,
			&tokens.Account.EmailAddress: profile.Account.Email,
			&tokens.Organization.UUID:    profile.Organization.UUID,
			&tokens.Organization.Name:    profile.Organization.Name,
		} {
			if value = strings.TrimSpace(value); value != "" {
				*target = value
			}
		}
	}
	_, _ = fetchClaudeControlPlane(ctx, client, claudeRolesURL, tokens.AccessToken)
}

func fetchClaudeControlPlane(ctx context.Context, client *http.Client, endpoint, accessToken string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "axios/1.15.2")
	req.Header.Set("Accept-Encoding", "gzip, compress, deflate, br")
	req.Header.Set("Connection", "close")
	req.Close = true
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := readOAuthBody(resp)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return body, nil
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
		case "compress":
			reader = lzw.NewReader(bytes.NewReader(data), lzw.MSB, 8)
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

// Codex browser sign-in: same client, redirect and authorize parameters as the SDK authenticator.
const (
	codexAuthURL     = "https://auth.openai.com/oauth/authorize"
	codexTokenURL    = "https://auth.openai.com/oauth/token"
	codexClientID    = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexRedirectURI = "http://localhost:1455/auth/callback"
	codexScope       = "openid email profile offline_access"
)

type codexFlow struct{ pkceSecrets }

func newCodexFlow() (*codexFlow, error) {
	secrets, err := newPKCESecrets()
	if err != nil {
		return nil, err
	}
	return &codexFlow{secrets}, nil
}

func (f *codexFlow) authorizeURL() string {
	return codexAuthURL + "?" + url.Values{
		"client_id":                  {codexClientID},
		"response_type":              {"code"},
		"redirect_uri":               {codexRedirectURI},
		"scope":                      {codexScope},
		"state":                      {f.state},
		"code_challenge":             {f.challenge},
		"code_challenge_method":      {"S256"},
		"prompt":                     {"login"},
		"id_token_add_organizations": {"true"},
		"codex_cli_simplified_flow":  {"true"},
	}.Encode()
}

func (f *codexFlow) exchange(ctx context.Context, client *http.Client, code string) (*codexTokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {codexClientID},
		"code":          {code},
		"redirect_uri":  {codexRedirectURI},
		"code_verifier": {f.verifier},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, exchangeTransportError(ctx)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, errors.New("token exchange response unreadable")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, exchangeStatusError(resp.StatusCode)
	}
	var tokens codexTokens
	if err = json.Unmarshal(raw, &tokens); err != nil || tokens.AccessToken == "" {
		return nil, errors.New("token exchange response invalid")
	}
	return &tokens, nil
}

func (f *codexFlow) redeem(ctx context.Context, client *http.Client, id, code, _ string) (*coreauth.Auth, error) {
	tokens, err := f.exchange(ctx, client, code)
	if err != nil {
		return nil, err
	}
	// The id_token came from the token endpoint over TLS; only its payload is read.
	claims := readIDTokenClaims(tokens.IDToken)
	tokens.Email, tokens.AccountID, tokens.PlanType = claims.Email, claims.Auth.AccountID, claims.Auth.PlanType
	if strings.TrimSpace(tokens.Email) == "" || strings.TrimSpace(tokens.AccountID) == "" {
		return nil, &identityError{missingIdentity}
	}
	return buildCodexOAuthRecord(id, tokens, time.Now()), nil
}

type codexTokens struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Email        string `json:"-"`
	AccountID    string `json:"-"`
	PlanType     string `json:"-"`
}

type idTokenClaims struct {
	Email string `json:"email"`
	Auth  struct {
		AccountID string `json:"chatgpt_account_id"`
		PlanType  string `json:"chatgpt_plan_type"`
	} `json:"https://api.openai.com/auth"`
}

// readIDTokenClaims decodes the payload segment of a JWT without verifying it; unreadable tokens give no claims.
func readIDTokenClaims(token string) idTokenClaims {
	var claims idTokenClaims
	if payload := jwtPayload(token); payload != nil {
		_ = json.Unmarshal(payload, &claims)
	}
	return claims
}

func jwtPayload(token string) []byte {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	return payload
}

// exchangeStatusError classifies a non-200 token response by status class only; the body is never read into the message.
func exchangeStatusError(status int) error {
	switch {
	case status == http.StatusBadRequest || status == http.StatusUnauthorized:
		return failure(errCodeRejected, fmt.Sprintf("Provider rejected the sign-in code (HTTP %d)", status))
	case status == http.StatusForbidden || status == http.StatusTooManyRequests || status >= 500:
		return failure(errProviderBlocked, fmt.Sprintf("Provider blocked the sign-in request (HTTP %d)", status))
	}
	return failure(errFailed, failedMessage)
}

// exchangeTransportError classifies a failed token request: network and TLS errors read as a blocked provider.
func exchangeTransportError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return failure(errProviderBlocked, "Provider could not be reached")
}
