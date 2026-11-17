package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	sdkauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

const (
	methodOAuth   = "oauth"
	methodDevice  = "device"
	methodBrowser = "browser"
	methodAPIKey  = "api_key"
	methodImport  = "import"

	stageAuthorize = "authorize"
	stageSubmitted = "submitted"
	stageVerifying = "verifying"

	errInputRejected   = "input_rejected"
	errExpired         = "expired"
	errKeyRejected     = "key_rejected"
	errCodeRejected    = "code_rejected"
	errProviderBlocked = "provider_blocked"
	errNotConfirmed    = "not_confirmed"
	errIdentity        = "identity"
	errDuplicate       = "duplicate"
	errFailed          = "failed"

	failedMessage = "Sign-in failed; retry authentication"
)

// loginMethodAllowed lists the sign-in methods per provider.
func loginMethodAllowed(p provider, method string) bool {
	switch p {
	case claude:
		return method == methodOAuth
	case codex:
		return method == methodDevice || method == methodBrowser
	}
	return false
}

type loginStatus struct {
	AccountID string `json:"accountId"`
	Status    string `json:"status"`
	Method    string `json:"method,omitempty"`
	Stage     string `json:"stage,omitempty"`
	URL       string `json:"url,omitempty"`
	UserCode  string `json:"userCode,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	Error     string `json:"error,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

// loginError ends an attempt with a stable code and a message that carries no credential material.
type loginError struct{ code, message string }

func (e *loginError) Error() string { return e.message }

func failure(code, message string) error { return &loginError{code, message} }

// failureOf maps an attempt error to its wire code and message.
func failureOf(err error) (code, message string) {
	var loginErr *loginError
	if errors.As(err, &loginErr) {
		return loginErr.code, loginErr.message
	}
	var identityErr *identityError
	if errors.As(err, &identityErr) {
		code = errIdentity
		if identityErr.marker == duplicateIdentity {
			code = errDuplicate
		}
		return code, identityMessage(identityErr.marker, failedMessage)
	}
	return errFailed, failedMessage
}

type loginAttempt struct {
	status    loginStatus
	cancel    context.CancelFunc
	stdin     io.WriteCloser // worker attempts only
	paste     chan string    // browser PKCE attempts only
	inputUsed bool           // worker attempts: input was written to the worker
	done      chan struct{}
}

// loginManager owns the sign-in attempts. Lock order is router.mu then loginManager.mu; router
// callbacks (setVerified, clearVerified) are never called with mu held.
type loginManager struct {
	mu        sync.Mutex
	active    string
	attempts  map[string]*loginAttempt
	dir       string
	manager   *coreauth.Manager
	store     *durableTokenStore
	client    *http.Client      // OAuth token exchange; nil means a default client
	transport http.RoundTripper // replaces executor transport for the verification probe; nil in production
	router    *router           // verification marks; nil leaves marks untouched
	// command builds the device sign-in worker process; nil runs this executable.
	command func(ctx context.Context, args []string) *exec.Cmd
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
	if isAPIKey(auth) {
		return auth.Attributes[coreauth.AttributeAPIKey] != ""
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

func (l *loginManager) start(parent context.Context, id string, p provider, method string) (loginStatus, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active == id {
		if attempt := l.attempts[id]; attempt != nil && attempt.status.Status == "pending" {
			return attempt.status, nil
		}
	}
	if l.active != "" {
		return loginStatus{}, errors.New("another account sign-in is pending")
	}
	if method == methodDevice {
		return l.startDevice(parent, id)
	}
	return l.startBrowser(parent, id, p, method)
}

// claim registers the pending attempt and fences refresh before any credential is replaced.
// Caller holds l.mu.
func (l *loginManager) claim(parent context.Context, id, method string, status loginStatus) (context.Context, *loginAttempt) {
	ctx, cancel := context.WithTimeout(parent, 16*time.Minute)
	status.AccountID, status.Status, status.Method = id, "pending", method
	a := &loginAttempt{status: status, cancel: cancel, done: make(chan struct{})}
	l.attempts[id], l.active = a, id
	l.manager.Remove(parent, authFileID(id))
	return ctx, a
}

// abandon drops an attempt that never started. Caller holds l.mu.
func (l *loginManager) abandon(id string, a *loginAttempt) {
	delete(l.attempts, id)
	l.active = ""
	a.cancel()
	l.restoreSavedAccount(id)
}

// startBrowser begins a Spur-owned PKCE sign-in with no worker and no listener. Caller holds l.mu.
func (l *loginManager) startBrowser(parent context.Context, id string, p provider, method string) (loginStatus, error) {
	var flow browserFlow
	var err error
	if p == claude {
		flow, err = newClaudeFlow()
	} else {
		flow, err = newCodexFlow()
	}
	if err != nil {
		return loginStatus{}, errors.New("could not start account sign-in")
	}
	ctx, a := l.claim(parent, id, method, loginStatus{Stage: stageAuthorize, URL: flow.authorizeURL(), Prompt: loginPrompt})
	a.paste = make(chan string, 1)
	go func() { l.finish(id, a, l.browserLogin(ctx, id, p, a, flow)) }()
	return a.status, nil
}

// startDevice runs the SDK device flow in a worker process; the device flow opens no listener.
// Caller holds l.mu.
func (l *loginManager) startDevice(parent context.Context, id string) (loginStatus, error) {
	// A leftover staged file from an earlier attempt must never be adopted.
	_ = stagingStore(l.dir).Delete(parent, authFileID(id))
	ctx, a := l.claim(parent, id, methodDevice, loginStatus{Stage: stageAuthorize})
	cmd := l.workerCommand(ctx, []string{"--data-dir", l.dir, "--login-worker", id, "--provider", string(codex)})
	if cmd == nil {
		l.abandon(id, a)
		return loginStatus{}, errors.New("could not start account sign-in")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		l.abandon(id, a)
		return loginStatus{}, errors.New("could not open account sign-in output")
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		l.abandon(id, a)
		return loginStatus{}, errors.New("could not open account sign-in input")
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		l.abandon(id, a)
		return loginStatus{}, errors.New("could not start account sign-in")
	}
	a.stdin = stdin
	go l.observe(ctx, id, a, stdout, cmd)
	return a.status, nil
}

func (l *loginManager) workerCommand(ctx context.Context, args []string) *exec.Cmd {
	if l.command != nil {
		return l.command(ctx, args)
	}
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	return exec.CommandContext(ctx, executable, args...)
}

func identityMessage(marker, fallback string) string {
	switch marker {
	case missingIdentity:
		return "Provider account identity is incomplete; sign in again"
	case duplicateIdentity:
		return "This account is already saved; select its existing profile"
	case changedIdentity:
		return "Different account selected; create a separate profile"
	}
	return fallback
}

func (l *loginManager) httpClient() *http.Client {
	if l.client == nil {
		return oauthHTTPClient(nil)
	}
	return l.client
}

func (l *loginManager) browserLogin(ctx context.Context, id string, p provider, a *loginAttempt, flow browserFlow) error {
	// The SDK callback wait ended the attempt after five minutes without a result; keep that.
	timeout := time.NewTimer(claudeCallbackWait)
	defer timeout.Stop()
	var input string
	select {
	case input = <-a.paste:
	case <-timeout.C:
		return failure(errExpired, "Sign-in timed out; retry authentication")
	case <-ctx.Done():
		return ctx.Err()
	}
	code, state, err := flow.accept(input)
	if err != nil {
		return failure(errInputRejected, failedMessage)
	}
	staged, err := flow.redeem(ctx, l.httpClient(), id, code, state)
	if err != nil {
		return err
	}
	return l.commit(ctx, id, p, a, staged)
}

func (l *loginManager) setStage(a *loginAttempt, stage string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a.status.Status == "pending" {
		a.status.Stage = stage
	}
}

// commit stages, verifies, saves and marks one credential: identity check, probe, clear the old
// mark, save, wait for registration, set the mark. The refresh fence was taken when the attempt
// began. Nothing reaches the auth directory before the probe passes.
func (l *loginManager) commit(ctx context.Context, id string, p provider, a *loginAttempt, staged *coreauth.Auth) error {
	if staged == nil || staged.Metadata == nil || staged.Provider != string(p) {
		return &identityError{missingIdentity}
	}
	staged.ID, staged.FileName, staged.Attributes = authFileID(id), authFileID(id), nil
	staged.Metadata["spur_profile_id"] = id
	if !isAPIKey(staged) {
		if err := validateProfileIdentity(ctx, l.store, staged, id); err != nil {
			return err
		}
	}
	projectAPIKey(staged)
	l.setStage(a, stageVerifying)
	if probe := verifyCredential(ctx, l.manager, l.transport, staged); probe.outcome != probeVerified {
		if probe.outcome == probeRejected && isAPIKey(staged) {
			return failure(errKeyRejected, "The provider rejected this API key")
		}
		return failure(errNotConfirmed, "Sign-in could not be confirmed with the provider")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if l.router != nil {
		if err := l.router.clearVerified(id); err != nil {
			return err
		}
	}
	// A save that leaves the file byte-identical raises no watcher event, and the fenced account would
	// never register again; the save time keeps every sign-in distinct.
	staged.Metadata["spur_saved_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := l.store.Save(coreauth.WithAuthCreationIntent(ctx), staged); err != nil {
		return err
	}
	if err := l.waitRegistered(ctx, id); err != nil {
		l.manager.Remove(context.Background(), authFileID(id))
		_ = l.store.Delete(context.Background(), authFileID(id))
		return failure(errNotConfirmed, "Sign-in could not be confirmed with the provider")
	}
	if l.router != nil {
		return l.router.setVerifiedUnlessDone(ctx, id)
	}
	return nil
}

func (l *loginManager) observe(ctx context.Context, id string, a *loginAttempt, output io.Reader, cmd *exec.Cmd) {
	marker := ""
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if identityMessage(line, "") != "" {
			marker = line
		}
		l.mu.Lock()
		if value, ok := strings.CutPrefix(line, "Codex device URL: "); ok && value == "https://auth.openai.com/codex/device" {
			a.status.URL = value
		}
		if value, ok := strings.CutPrefix(line, "Codex device code: "); ok && len(value) <= 64 {
			a.status.UserCode = value
		}
		if line == "SPUR_LOGIN_INPUT" {
			a.status.Prompt = loginPrompt
		}
		l.mu.Unlock()
	}
	waitErr := cmd.Wait()
	staged, takeErr := l.takeStaged(ctx, id)
	var err error
	switch {
	case waitErr != nil && marker != "":
		err = &identityError{marker}
	case waitErr != nil:
		l.mu.Lock()
		inputUsed := a.inputUsed
		l.mu.Unlock()
		if inputUsed {
			err = failure(errFailed, failedMessage)
		} else {
			err = failure(errExpired, "Sign-in timed out; retry authentication")
		}
	case takeErr != nil:
		err = takeErr
	default:
		err = l.commit(ctx, id, codex, a, staged)
	}
	l.finish(id, a, err)
}

// takeStaged reads the worker's staged credential and deletes it, whatever the outcome.
func (l *loginManager) takeStaged(ctx context.Context, id string) (*coreauth.Auth, error) {
	staging := stagingStore(l.dir)
	stored, listErr := staging.List(ctx)
	_ = staging.Delete(context.Background(), authFileID(id))
	// The Codex save leaves its lock file beside the credential.
	_ = os.Remove(filepath.Join(l.dir, "auth-proxy-staging", authFileID(id)+".lock"))
	for _, auth := range stored {
		if auth.ID == authFileID(id) {
			return auth, nil
		}
	}
	if listErr != nil {
		return nil, listErr
	}
	return nil, errors.New("sign-in produced no credential")
}

func (l *loginManager) finish(id string, a *loginAttempt, err error) {
	if err != nil {
		l.restoreSavedAccount(id)
	}
	code, message := failureOf(err)
	l.mu.Lock()
	defer l.mu.Unlock()
	if a.status.Status == "pending" {
		if err == nil {
			a.status = loginStatus{AccountID: id, Status: "ready", Method: a.status.Method}
		} else {
			a.status = loginStatus{AccountID: id, Status: "failed", Method: a.status.Method, Error: message, ErrorCode: code}
		}
	}
	if l.active == id {
		l.active = ""
	}
	if a.stdin != nil {
		_ = a.stdin.Close()
	}
	a.cancel()
	close(a.done)
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

// registrationWait bounds the wait for the service to register a saved credential. Var so tests shorten it.
var registrationWait = 15 * time.Second

func (l *loginManager) waitRegistered(ctx context.Context, id string) error {
	deadline := time.NewTimer(registrationWait)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if auth, ok := l.manager.GetByID(authFileID(id)); ok && usableAuth(auth) && len(cliproxy.GlobalModelRegistry().GetModelsForClient(auth.ID)) > 0 {
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
	if a.paste != nil {
		// Blank input keeps waiting; one submission per prompt.
		if strings.TrimSpace(input) != "" && a.status.Prompt != "" {
			a.paste <- input
			a.status.Prompt, a.status.Stage = "", stageSubmitted
		}
		return a.status, nil
	}
	if a.stdin == nil {
		return loginStatus{}, errors.New("account sign-in takes no input")
	}
	if _, err := io.WriteString(a.stdin, input+"\n"); err != nil {
		return loginStatus{}, errors.New("could not submit sign-in input")
	}
	a.inputUsed = true
	a.status.Prompt = ""
	return a.status, nil
}

func (l *loginManager) cancel(id string) (loginStatus, error) {
	l.mu.Lock()
	a := l.attempts[id]
	if a == nil || l.active != id {
		// A finished failed attempt is dismissed here so the account reads sign-in-required, not failed.
		if a != nil && a.status.Status == "failed" {
			delete(l.attempts, id)
		}
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

// List projects API-key attributes so a reloaded credential carries what the executors read.
func (s *durableTokenStore) List(ctx context.Context) ([]*coreauth.Auth, error) {
	stored, err := s.FileTokenStore.List(ctx)
	for _, auth := range stored {
		projectAPIKey(auth)
	}
	return stored, err
}

func tokenStore(dir string) *durableTokenStore {
	store := sdkauth.NewFileTokenStore()
	store.SetBaseDir(filepath.Join(dir, "auth-proxy-credentials"))
	return &durableTokenStore{store}
}

// stagingStore holds a device worker's credential outside the auth directory, so the file watcher
// never registers it before it is verified.
func stagingStore(dir string) *durableTokenStore {
	store := sdkauth.NewFileTokenStore()
	store.SetBaseDir(filepath.Join(dir, "auth-proxy-staging"))
	return &durableTokenStore{store}
}

func loginWorker(ctx context.Context, dir, id string, p provider) error {
	// Claude and browser sign-in are Spur-owned PKCE inside the companion; the SDK login would bind a callback port.
	if !safeID.MatchString(id) || p != codex {
		return errors.New("invalid sign-in worker request")
	}
	cfg := &config.Config{AuthDir: filepath.Join(dir, "auth-proxy-staging")}
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
	opts.Metadata = map[string]string{"codex_login_mode": "device"}
	auth, err := sdkauth.NewCodexAuthenticator().Login(ctx, cfg, opts)
	if err != nil {
		return errors.New("account authentication failed")
	}
	return stageLogin(ctx, stagingStore(dir), auth, id)
}

// stageLogin checks the signed-in record carries an identity and saves it to the staging store.
func stageLogin(ctx context.Context, store *durableTokenStore, auth *coreauth.Auth, id string) error {
	if auth == nil || auth.Metadata == nil || auth.Provider != string(codex) {
		return errors.New("account identity missing")
	}
	if email, ok := auth.Metadata["email"].(string); !ok || email == "" {
		return errors.New("account identity missing")
	}
	if err := hydrateCodexIdentity(auth); err != nil {
		return err
	}
	auth.ID, auth.FileName = authFileID(id), authFileID(id)
	_, err := store.Save(coreauth.WithAuthCreationIntent(ctx), auth)
	return err
}
