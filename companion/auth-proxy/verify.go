package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const (
	probeVerified    = "verified"
	probeRejected    = "rejected"
	probeUnavailable = "unavailable"
)

// probe targets: one authenticated GET per provider and credential kind. OAuth targets are the usage
// endpoints the daemon already reads; API-key targets are the public model lists.
const (
	claudeUsageURL  = "https://api.anthropic.com/api/oauth/usage"
	codexUsageURL   = "https://chatgpt.com/backend-api/wham/usage"
	claudeModelsURL = "https://api.anthropic.com/v1/models"
	codexModelsURL  = codexAPIBaseURL + "/models"
)

type probeResult struct {
	outcome string
	status  int
}

// roundTripperKey is the context key the SDK executors read to replace their HTTP transport.
const roundTripperKey = "cliproxy.roundtripper"

// verifyCredential sends one authenticated request through the provider executor and classifies the
// answer: 2xx or 429 verified, 401/403 rejected, anything else unavailable. transport, when set,
// replaces the executor's network transport.
func verifyCredential(ctx context.Context, manager *coreauth.Manager, transport http.RoundTripper, auth *coreauth.Auth) probeResult {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	resp, err := sendProbe(ctx, manager, transport, auth)
	if err != nil {
		return probeResult{outcome: probeUnavailable}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300, resp.StatusCode == http.StatusTooManyRequests:
		return probeResult{probeVerified, resp.StatusCode}
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return probeResult{probeRejected, resp.StatusCode}
	}
	return probeResult{probeUnavailable, resp.StatusCode}
}

const (
	probeTimeout     = 15 * time.Second
	usageBodyCap     = 1 << 16
	usageStatusOK    = "ok"
	usageStatusError = "error"
)

// usageEntry is one account's usage read. Body is the provider answer on 2xx only; no request
// header or credential ever enters it.
type usageEntry struct {
	AccountID         string `json:"accountId"`
	Status            string `json:"status"`
	HTTPStatus        int    `json:"httpStatus,omitempty"`
	RetryAfterSeconds int    `json:"retryAfterSeconds,omitempty"`
	Body              string `json:"body,omitempty"`
}

// sendProbe sends the provider probe request for auth through its executor. The caller owns ctx
// (timeout and cancel) and the response body. transport, when set, replaces the network transport.
func sendProbe(ctx context.Context, manager *coreauth.Manager, transport http.RoundTripper, auth *coreauth.Auth) (*http.Response, error) {
	executor, ok := manager.Executor(auth.Provider)
	if !ok {
		return nil, errors.New("no executor for provider")
	}
	if transport != nil {
		ctx = context.WithValue(ctx, roundTripperKey, transport)
	}
	req, err := probeRequest(ctx, auth)
	if err != nil {
		return nil, err
	}
	return executor.HttpRequest(ctx, auth, req)
}

// fetchUsage reads the OAuth usage endpoint for auth. API-key and missing credentials make no request.
// The reply is an error entry unless the provider answered 2xx with a body within usageBodyCap.
func fetchUsage(ctx context.Context, manager *coreauth.Manager, transport http.RoundTripper, auth *coreauth.Auth) usageEntry {
	failed := usageEntry{Status: usageStatusError}
	if auth == nil || isAPIKey(auth) {
		return failed
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	resp, err := sendProbe(ctx, manager, transport, auth)
	if err != nil {
		return failed
	}
	defer resp.Body.Close()
	failed.HTTPStatus = resp.StatusCode
	if resp.StatusCode == http.StatusTooManyRequests {
		if seconds, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && seconds > 0 {
			failed.RetryAfterSeconds = seconds
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return failed
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, usageBodyCap+1))
	if err != nil || len(body) > usageBodyCap {
		return failed
	}
	return usageEntry{Status: usageStatusOK, HTTPStatus: resp.StatusCode, Body: string(body)}
}

func probeRequest(ctx context.Context, auth *coreauth.Auth) (*http.Request, error) {
	var target string
	header := http.Header{}
	switch {
	case provider(auth.Provider) == claude && isAPIKey(auth):
		target = claudeModelsURL
		header.Set("anthropic-version", "2023-06-01")
	case provider(auth.Provider) == claude:
		target = claudeUsageURL
		header.Set("anthropic-beta", "oauth-2025-04-20")
	case isAPIKey(auth):
		target = codexModelsURL
	default:
		target = codexUsageURL
		if accountID, _ := auth.Metadata["account_id"].(string); accountID != "" {
			header.Set("ChatGPT-Account-Id", accountID)
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	for key, values := range header {
		req.Header[key] = values
	}
	return req, nil
}
