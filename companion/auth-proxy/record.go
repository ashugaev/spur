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
