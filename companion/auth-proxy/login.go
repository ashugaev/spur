package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

type loginStatus struct {
	AccountID string `json:"accountId"`
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	UserCode  string `json:"userCode,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type loginAttempt struct {
	status loginStatus
	cancel context.CancelFunc
	stdin  io.WriteCloser
	done   chan struct{}
}
type loginManager struct {
	mu       sync.Mutex
	active   string
	attempts map[string]*loginAttempt
	dir      string
	manager  *coreauth.Manager
	store    *durableTokenStore
}

func (l *loginManager) ready(id string, p provider) bool {
	l.mu.Lock()
	a := l.attempts[id]
	pending := a != nil && a.status.Status == "pending"
	l.mu.Unlock()
	if pending {
		return false
	}
	auth, ok := l.manager.GetByID(authFileID(id))
	return ok && auth.Provider == string(p) && usableAuth(auth)
}

func usableAuth(auth *coreauth.Auth) bool {
	if auth == nil || auth.Disabled || auth.RequiresSignIn {
		return false
	}
	accessToken, _ := auth.Metadata["access_token"].(string)
	return accessToken != ""
}

func (l *loginManager) status(id string) loginStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a := l.attempts[id]; a != nil && a.status.Status != "ready" {
		return a.status
	}
	auth, ok := l.manager.GetByID(authFileID(id))
	if ok && usableAuth(auth) {
		return loginStatus{AccountID: id, Status: "ready"}
	}
	return loginStatus{AccountID: id, Status: "sign-in-required"}
}

func (l *loginManager) start(parent context.Context, id string, p provider) (loginStatus, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active != "" {
		return loginStatus{}, errors.New("another account sign-in is pending")
	}
	executable, err := os.Executable()
	if err != nil {
		return loginStatus{}, errors.New("could not start account sign-in")
	}
	ctx, cancel := context.WithTimeout(parent, 16*time.Minute)
	cmd := exec.CommandContext(ctx, executable, "--data-dir", l.dir, "--login-worker", id, "--provider", string(p))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return loginStatus{}, errors.New("could not open account sign-in output")
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return loginStatus{}, errors.New("could not open account sign-in input")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		cancel()
		return loginStatus{}, errors.New("could not start account sign-in")
	}
	a := &loginAttempt{status: loginStatus{AccountID: id, Status: "pending"}, cancel: cancel, stdin: stdin, done: make(chan struct{})}
	l.attempts[id], l.active = a, id
	// Fence refresh mutations before the worker persists a replacement grant.
	l.manager.Remove(parent, authFileID(id))
	go l.observe(ctx, id, a, stdout, cmd)
	return a.status, nil
}

func (l *loginManager) observe(ctx context.Context, id string, a *loginAttempt, output io.Reader, cmd *exec.Cmd) {
	failureMessage := "Sign-in failed; retry authentication"
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch line {
		case missingIdentity:
			failureMessage = "Provider account identity is incomplete; sign in again"
		case duplicateIdentity:
			failureMessage = "This account is already saved; select its existing profile"
		case changedIdentity:
			failureMessage = "Different account selected; create a separate profile"
		}
		l.mu.Lock()
		if strings.HasPrefix(line, "https://") {
			if parsed, err := url.Parse(line); err == nil && parsed.Scheme == "https" && parsed.Hostname() == "claude.ai" && parsed.Path == "/oauth/authorize" {
				a.status.URL = line
			}
		}
		if value, ok := strings.CutPrefix(line, "Codex device URL: "); ok && value == "https://auth.openai.com/codex/device" {
			a.status.URL = value
		}
		if value, ok := strings.CutPrefix(line, "Codex device code: "); ok && len(value) <= 64 {
			a.status.UserCode = value
		}
		if line == "SPUR_LOGIN_INPUT" {
			a.status.Prompt = "Paste the callback URL from the authorization page"
		}
		l.mu.Unlock()
	}
	err := cmd.Wait()
	if err == nil {
		err = l.waitRegistered(ctx, id)
	}
	if err != nil {
		l.restoreSavedAccount(id)
	}
	l.mu.Lock()
	if a.status.Status == "pending" {
		if err == nil {
			a.status = loginStatus{AccountID: id, Status: "ready"}
		} else {
			a.status = loginStatus{AccountID: id, Status: "failed", Error: failureMessage}
		}
	}
	if l.active == id {
		l.active = ""
	}
	_ = a.stdin.Close()
	a.cancel()
	close(a.done)
	l.mu.Unlock()
}

func (l *loginManager) restoreSavedAccount(id string) {
	stored, err := l.store.List(context.Background())
	if err != nil {
		return
	}
	for _, auth := range stored {
		if auth.ID == authFileID(id) && usableAuth(auth) {
			_, _ = l.manager.Register(coreauth.WithSkipPersist(context.Background()), auth)
			return
		}
	}
}

func (l *loginManager) waitRegistered(ctx context.Context, id string) error {
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if auth, ok := l.manager.GetByID(authFileID(id)); ok && usableAuth(auth) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("account registration timed out")
		case <-ticker.C:
		}
	}
}

func (l *loginManager) input(id, input string) (loginStatus, error) {
	if len(input) == 0 || len(input) > 8192 || strings.ContainsAny(input, "\r\n") {
		return loginStatus{}, errors.New("invalid sign-in input")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	a := l.attempts[id]
	if a == nil || l.active != id || a.status.Status != "pending" {
		return loginStatus{}, errors.New("account sign-in is not pending")
	}
	if _, err := io.WriteString(a.stdin, input+"\n"); err != nil {
		return loginStatus{}, errors.New("could not submit sign-in input")
	}
	a.status.Prompt = ""
	return a.status, nil
}

func (l *loginManager) cancel(id string) (loginStatus, error) {
	l.mu.Lock()
	a := l.attempts[id]
	if a == nil || l.active != id {
		l.mu.Unlock()
		return loginStatus{AccountID: id, Status: "sign-in-required"}, nil
	}
	a.status = loginStatus{AccountID: id, Status: "sign-in-required"}
	a.cancel()
	done := a.done
	l.mu.Unlock()
	select {
	case <-done:
		return loginStatus{AccountID: id, Status: "sign-in-required"}, nil
	case <-time.After(3 * time.Second):
		return loginStatus{}, errors.New("sign-in cancellation is still pending")
	}
}

type durableTokenStore struct{ *sdkauth.FileTokenStore }

func (s *durableTokenStore) Save(ctx context.Context, auth *coreauth.Auth) (string, error) {
	path, err := s.FileTokenStore.Save(ctx, auth)
	if err != nil || path == "" {
		return path, err
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return "", err
	}
	if err = f.Chmod(0o600); err == nil {
		err = f.Sync()
	}
	_ = f.Close()
	if err != nil {
		return "", err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	defer dir.Close()
	return path, dir.Sync()
}

func tokenStore(dir string) *durableTokenStore {
	store := sdkauth.NewFileTokenStore()
	store.SetBaseDir(filepath.Join(dir, "auth-proxy-credentials"))
	return &durableTokenStore{store}
}

func loginWorker(ctx context.Context, dir, id string, p provider) error {
	if !safeID.MatchString(id) || !p.valid() {
		return errors.New("invalid sign-in worker request")
	}
	cfg := &config.Config{AuthDir: filepath.Join(dir, "auth-proxy-credentials")}
	if err := os.MkdirAll(cfg.AuthDir, 0o700); err != nil {
		return err
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 8192)
	opts := &sdkauth.LoginOptions{NoBrowser: true, Prompt: func(string) (string, error) {
		fmt.Println("SPUR_LOGIN_INPUT")
		if !scanner.Scan() {
			return "", errors.New("sign-in input closed")
		}
		return scanner.Text(), nil
	}}
	var authenticator sdkauth.Authenticator
	if p == claude {
		authenticator = sdkauth.NewClaudeAuthenticator()
	} else {
		authenticator = sdkauth.NewCodexAuthenticator()
		opts.Metadata = map[string]string{"codex_login_mode": "device"}
	}
	auth, err := authenticator.Login(ctx, cfg, opts)
	if err != nil {
		return errors.New("account authentication failed")
	}
	if auth == nil || auth.Metadata == nil || auth.Provider != string(p) {
		return errors.New("account identity missing")
	}
	if email, ok := auth.Metadata["email"].(string); !ok || email == "" {
		return errors.New("account identity missing")
	}
	if err := hydrateCodexIdentity(auth); err != nil {
		return err
	}
	if err := validateProfileIdentity(ctx, tokenStore(dir), auth, id); err != nil {
		return err
	}
	auth.ID, auth.FileName = authFileID(id), authFileID(id)
	auth.Metadata["spur_profile_id"] = id
	_, err = tokenStore(dir).Save(coreauth.WithAuthCreationIntent(ctx), auth)
	return err
}
