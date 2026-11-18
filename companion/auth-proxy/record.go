package main

import (
	"crypto/rand"
	"encoding/hex"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// buildClaudeOAuthRecord builds the saved Claude credential from a token exchange, with the same
// file fields the SDK token storage writes.
func buildClaudeOAuthRecord(id string, tokens *claudeTokens, now time.Time) (*coreauth.Auth, error) {
	device := make([]byte, 32)
	if _, err := rand.Read(device); err != nil {
		return nil, err
	}
	metadata := map[string]any{
		"type":              "claude",
		"id_token":          "",
		"access_token":      tokens.AccessToken,
		"refresh_token":     tokens.RefreshToken,
		"last_refresh":      now.Format(time.RFC3339),
		"email":             tokens.Account.EmailAddress,
		"expired":           now.Add(time.Duration(tokens.ExpiresIn) * time.Second).Format(time.RFC3339),
		"claude_device_ids": []string{hex.EncodeToString(device)},
	}
	for key, value := range map[string]string{
		"account_uuid":      tokens.Account.UUID,
		"organization_uuid": tokens.Organization.UUID,
		"organization_name": tokens.Organization.Name,
	} {
		if value != "" {
			metadata[key] = value
		}
	}
	return &coreauth.Auth{ID: authFileID(id), FileName: authFileID(id), Provider: string(claude), Metadata: metadata}, nil
}

const (
	credentialAPIKey = "api_key"
	codexAPIBaseURL  = "https://api.openai.com/v1"
)

// buildAPIKeyRecord builds an API-key credential. The key sits in Metadata so the saved file carries it;
// projectAPIKey copies it to the Attributes the executors read.
func buildAPIKeyRecord(id string, p provider, key string) *coreauth.Auth {
	metadata := map[string]any{
		"type":            string(p),
		"auth_kind":       credentialAPIKey,
		"api_key":         key,
		"spur_credential": credentialAPIKey,
		// A key does not expire. The SDK refresh scheduler treats a credential with no expiry as
		// refresh-due and would run an OAuth refresh against it while the service registers its models.
		"expired": time.Now().AddDate(100, 0, 0).Format(time.RFC3339),
	}
	if p == codex {
		metadata["base_url"] = codexAPIBaseURL
	}
	auth := &coreauth.Auth{ID: authFileID(id), FileName: authFileID(id), Provider: string(p), Metadata: metadata}
	projectAPIKey(auth)
	return auth
}

// isAPIKey reports whether the record is a Spur API-key credential.
func isAPIKey(auth *coreauth.Auth) bool {
	kind, _ := auth.Metadata["spur_credential"].(string)
	return kind == credentialAPIKey
}

// projectAPIKey copies Metadata api_key and base_url into Attributes, where the SDK executors read them
// (the file watcher projects neither for claude or codex). Reports whether the record changed.
func projectAPIKey(auth *coreauth.Auth) bool {
	if auth == nil || !isAPIKey(auth) {
		return false
	}
	changed := false
	// The watcher labels every file credential auth_kind oauth. Leave it: an apikey-kind Codex auth
	// registers models only from a config entry, while both executors read the api_key attribute.
	for _, field := range []string{"api_key", "base_url"} {
		value, _ := auth.Metadata[field].(string)
		if value == "" || auth.Attributes[field] == value {
			continue
		}
		if auth.Attributes == nil {
			auth.Attributes = map[string]string{}
		}
		auth.Attributes[field] = value
		changed = true
	}
	return changed
}

// buildCodexOAuthRecord builds the saved Codex credential with the file fields the SDK token storage writes.
func buildCodexOAuthRecord(id string, tokens *codexTokens, now time.Time) *coreauth.Auth {
	metadata := map[string]any{
		"type":          "codex",
		"id_token":      tokens.IDToken,
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
		"account_id":    tokens.AccountID,
		"last_refresh":  now.Format(time.RFC3339),
		"email":         tokens.Email,
		"expired":       now.Add(time.Duration(tokens.ExpiresIn) * time.Second).Format(time.RFC3339),
	}
	if tokens.PlanType != "" {
		metadata["plan_type"] = tokens.PlanType
	}
	return &coreauth.Auth{ID: authFileID(id), FileName: authFileID(id), Provider: string(codex), Metadata: metadata}
}
