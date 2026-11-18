package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

const maxNativeFile = 1 << 20

// importNative turns the credential a native CLI login left in <dir>/auth-terminal/<id> into a
// verified account. Nothing is read into an attempt, and no fence is taken, until the files are complete.
// busy: another account's attempt is pending.
func (l *loginManager) importNative(parent context.Context, id string, p provider) (loginStatus, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active == id {
		if a := l.attempts[id]; a != nil && a.status.Status == "pending" {
			return a.status, nil
		}
	}
	if l.active != "" {
		return loginStatus{AccountID: id, Status: "busy"}, nil
	}
	staged := readNativeLogin(l.dir, id, p)
	if staged == nil {
		return loginStatus{AccountID: id, Status: "sign-in-required"}, nil
	}
	ctx, a := l.claim(parent, id, methodImport, loginStatus{Stage: stageVerifying})
	go func() { l.finish(id, a, l.commit(ctx, id, p, a, staged)) }()
	return a.status, nil
}

// readNativeFile reads a regular, non-symlink file of at most maxNativeFile bytes; any problem reads as absent.
func readNativeFile(home, name string) []byte {
	f, err := os.OpenFile(filepath.Join(home, name), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxNativeFile {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxNativeFile))
	if err != nil {
		return nil
	}
	return raw
}

func isPlainDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

// readNativeLogin returns the staged record for a complete native login, or nil when there is nothing
// complete to import.
func readNativeLogin(dir, id string, p provider) *coreauth.Auth {
	root := filepath.Join(dir, "auth-terminal")
	home := filepath.Join(root, id)
	if !safeID.MatchString(id) || !isPlainDir(root) || !isPlainDir(home) {
		return nil
	}
	if p == claude {
		return readNativeClaude(home, id)
	}
	return readNativeCodex(home, id)
}

func readNativeClaude(home, id string) *coreauth.Auth {
	var credentials struct {
		OAuth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresAt    int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	var profile struct {
		Account struct {
			AccountUUID      string `json:"accountUuid"`
			OrganizationUUID string `json:"organizationUuid"`
			OrganizationName string `json:"organizationName"`
			EmailAddress     string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(readNativeFile(home, ".credentials.json"), &credentials) != nil || json.Unmarshal(readNativeFile(home, ".claude.json"), &profile) != nil {
		return nil
	}
	o, a := credentials.OAuth, profile.Account
	if o.AccessToken == "" || o.RefreshToken == "" || a.AccountUUID == "" || a.OrganizationUUID == "" {
		return nil
	}
	tokens := &claudeTokens{AccessToken: o.AccessToken, RefreshToken: o.RefreshToken, ExpiresIn: int(time.Until(time.UnixMilli(o.ExpiresAt)).Seconds())}
	tokens.Account.UUID, tokens.Account.EmailAddress = a.AccountUUID, a.EmailAddress
	tokens.Organization.UUID, tokens.Organization.Name = a.OrganizationUUID, a.OrganizationName
	auth, err := buildClaudeOAuthRecord(id, tokens, time.Now())
	if err != nil {
		return nil
	}
	return auth
}

func readNativeCodex(home, id string) *coreauth.Auth {
	var file struct {
		APIKey *string `json:"OPENAI_API_KEY"`
		Tokens struct {
			IDToken      string `json:"id_token"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			AccountID    string `json:"account_id"`
		} `json:"tokens"`
	}
	if json.Unmarshal(readNativeFile(home, "auth.json"), &file) != nil {
		return nil
	}
	t := file.Tokens
	if t.AccessToken == "" || t.RefreshToken == "" {
		if file.APIKey != nil && validAPIKey(*file.APIKey) {
			return buildAPIKeyRecord(id, codex, *file.APIKey)
		}
		return nil
	}
	claims := readIDTokenClaims(t.IDToken)
	tokens := &codexTokens{IDToken: t.IDToken, AccessToken: t.AccessToken, RefreshToken: t.RefreshToken, Email: claims.Email, PlanType: claims.Auth.PlanType}
	tokens.AccountID = strings.TrimSpace(firstNonEmpty(t.AccountID, claims.Auth.AccountID))
	if tokens.AccountID == "" {
		return nil
	}
	// The native file carries no expiry; the access token's own exp claim is the best source.
	var expiry struct {
		Exp int64 `json:"exp"`
	}
	if payload := jwtPayload(t.AccessToken); payload != nil && json.Unmarshal(payload, &expiry) == nil && expiry.Exp > 0 {
		tokens.ExpiresIn = int(time.Until(time.Unix(expiry.Exp, 0)).Seconds())
	}
	return buildCodexOAuthRecord(id, tokens, time.Now())
}
