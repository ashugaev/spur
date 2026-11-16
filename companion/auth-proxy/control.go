package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type controlRequest struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type controlError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type controlResponse struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *controlError   `json:"error,omitempty"`
}

const maxUsageAccounts = 4

type emptyResult struct{}
type configureParams struct {
	Accounts []accountInput `json:"accounts"`
	Pools    []poolInput    `json:"pools"`
	Policy   policy         `json:"policy"`
}
type registerParams struct {
	SessionID string   `json:"sessionId"`
	Provider  provider `json:"provider"`
	AccountID *string  `json:"accountId"`
}
type switchParams struct {
	SessionID string  `json:"sessionId"`
	AccountID *string `json:"accountId"`
}
type sessionParams struct {
	SessionID string `json:"sessionId"`
}
type loginParams struct {
	AccountID string   `json:"accountId"`
	Provider  provider `json:"provider"`
	Method    string   `json:"method"`
}
type apiKeyParams struct {
	AccountID string   `json:"accountId"`
	Provider  provider `json:"provider"`
	APIKey    string   `json:"apiKey"`
}
type importParams struct {
	AccountID string   `json:"accountId"`
	Provider  provider `json:"provider"`
}
type accountParams struct {
	AccountID string `json:"accountId"`
}
type loginInputParams struct {
	AccountID string `json:"accountId"`
	Input     string `json:"input"`
}
type accountStatus struct {
	ID       string   `json:"id"`
	Provider provider `json:"provider"`
	Status   string   `json:"status"`
	Error    string   `json:"error,omitempty"`
	// CooldownUntil is set while a shared quota cooldown is active.
	CooldownUntil string `json:"cooldownUntil,omitempty"`
	// Credential is the kind of the registered credential: oauth or api_key.
	Credential string `json:"credential,omitempty"`
	// BrokenAt is set from the first loss of sign-in after a verified sign-in until the next verified sign-in.
	BrokenAt string `json:"brokenAt,omitempty"`
	// Identity is the provider identity of the registered credential; it never carries a secret.
	Identity *accountIdentity `json:"identity,omitempty"`
}
type accountIdentity struct {
	Email            string `json:"email,omitempty"`
	OrganizationName string `json:"organizationName,omitempty"`
	OrganizationID   string `json:"organizationId,omitempty"`
	Plan             string `json:"plan,omitempty"`
	// KeyHint is the last 4 characters of an API key.
	KeyHint string `json:"keyHint,omitempty"`
}
type usageParams struct {
	AccountIDs []string `json:"accountIds"`
}
type usageResult struct {
	Usage []usageEntry `json:"usage"`
}

// registeredCredential is what the manager holds for one account: the kind and its identity.
type registeredCredential struct {
	kind     string
	identity *accountIdentity
}
type stateSummary struct {
	Accounts []accountStatus  `json:"accounts"`
	Sessions []sessionSummary `json:"sessions"`
}
type resultValue interface {
	emptyResult | registration | stateSummary | loginStatus | usageResult
}
type inputValue interface {
	*runtimeState | *controlRequest | *configureParams | *registerParams | *switchParams | *sessionParams | *loginParams | *apiKeyParams | *importParams | *accountParams | *loginInputParams | *usageParams | *emptyResult
}

func decode[T inputValue](raw []byte, target T) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return errors.New("invalid control payload")
	}
	var trailing json.RawMessage
	if err := d.Decode(&trailing); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

type control struct {
	out    io.Writer
	mu     sync.Mutex
	router *router
	logins *loginManager
	// usageBusy is set while a getUsage read runs; a second one is rejected.
	usageBusy atomic.Bool
}

func (c *control) write(response controlResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = json.NewEncoder(c.out).Encode(response)
}

// forwardRotations writes queued rotation events until ctx ends.
func (c *control) forwardRotations(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-c.router.rotations:
			c.mu.Lock()
			_ = json.NewEncoder(c.out).Encode(event)
			c.mu.Unlock()
		}
	}
}

func reply[T resultValue](c *control, id uint64, value T, err error) {
	if err != nil {
		c.write(controlResponse{ID: id, Error: &controlError{Code: "auth_unavailable", Message: err.Error()}})
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		c.write(controlResponse{ID: id, Error: &controlError{Code: "internal_error", Message: "could not encode auth response"}})
		return
	}
	c.write(controlResponse{ID: id, OK: true, Result: raw})
}

func (c *control) serve(ctx context.Context, input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var req controlRequest
		if decode(scanner.Bytes(), &req) != nil || req.ID == 0 {
			c.write(controlResponse{Error: &controlError{Code: "invalid_request", Message: "invalid auth control request"}})
			continue
		}
		c.handle(ctx, req)
	}
	return scanner.Err()
}

func (c *control) handle(ctx context.Context, req controlRequest) {
	r := c.router
	switch req.Method {
	case "configure":
		var p configureParams
		err := decode(req.Params, &p)
		if err == nil {
			err = r.configure(p.Accounts, p.Pools, p.Policy)
		}
		reply(c, req.ID, emptyResult{}, err)
	case "getState":
		var p emptyResult
		err := decode(req.Params, &p)
		result := stateSummary{Accounts: []accountStatus{}, Sessions: []sessionSummary{}}
		if err == nil {
			// Registered credentials are read before r.mu: the manager must not be entered under it.
			registered := c.registeredCredentials()
			r.mu.Lock()
			for _, a := range r.accounts {
				status := c.logins.status(a.ID)
				if status.Status != "pending" {
					if r.readyAccount != nil && r.readyAccount(a.ID, a.Provider) {
						status.Status = "ready"
					} else if status.Status == "ready" {
						status.Status = "sign-in-required"
					}
				}
				entry := accountStatus{ID: a.ID, Provider: a.Provider, Status: status.Status, Error: status.Error, Credential: registered[a.ID].kind, Identity: registered[a.ID].identity}
				if at, broken := r.state.Broken[a.ID]; broken {
					entry.BrokenAt = at.UTC().Format(time.RFC3339)
				}
				if until := r.state.Cooldowns[a.ID]; until.After(time.Now()) {
					entry.CooldownUntil = until.UTC().Format(time.RFC3339)
				}
				result.Accounts = append(result.Accounts, entry)
			}
			for _, b := range r.state.Sessions {
				result.Sessions = append(result.Sessions, b.Session)
			}
			r.mu.Unlock()
			sort.Slice(result.Accounts, func(i, j int) bool { return result.Accounts[i].ID < result.Accounts[j].ID })
			sort.Slice(result.Sessions, func(i, j int) bool { return result.Sessions[i].SessionID < result.Sessions[j].SessionID })
		}
		reply(c, req.ID, result, err)
	case "getUsage":
		var p usageParams
		err := decode(req.Params, &p)
		if err == nil && (len(p.AccountIDs) < 1 || len(p.AccountIDs) > maxUsageAccounts) {
			err = errors.New("getUsage takes 1 to 4 account ids")
		}
		if err == nil && !c.usageBusy.CompareAndSwap(false, true) {
			err = errors.New("usage read already pending")
		}
		if err != nil {
			reply(c, req.ID, usageResult{}, err)
			return
		}
		// Provider HTTP runs off the serve loop so other control traffic is not stalled.
		go func() {
			defer c.usageBusy.Store(false)
			reply(c, req.ID, c.readUsage(ctx, p.AccountIDs), nil)
		}()
	case "registerSession":
		var p registerParams
		err := decode(req.Params, &p)
		var result registration
		if err == nil {
			result, err = r.register(p.SessionID, p.Provider, p.AccountID, false)
		}
		reply(c, req.ID, result, err)
	case "switchSession":
		var p switchParams
		err := decode(req.Params, &p)
		var result registration
		if err == nil {
			r.mu.Lock()
			b, exists := r.state.Sessions[p.SessionID]
			r.mu.Unlock()
			if !exists {
				err = errors.New("unknown managed session")
			} else {
				result, err = r.register(p.SessionID, b.Session.Provider, p.AccountID, true)
			}
		}
		reply(c, req.ID, result, err)
	case "revokeSession":
		var p sessionParams
		err := decode(req.Params, &p)
		if err == nil {
			err = r.revoke(p.SessionID)
		}
		reply(c, req.ID, emptyResult{}, err)
	case "login":
		var p loginParams
		err := decode(req.Params, &p)
		var result loginStatus
		if err == nil {
			if err = c.knownAccount(p.AccountID, p.Provider); err == nil && !loginMethodAllowed(p.Provider, p.Method) {
				err = errors.New("sign-in method is not available for this provider")
			}
		}
		if err == nil {
			result, err = c.logins.start(ctx, p.AccountID, p.Provider, p.Method)
		}
		reply(c, req.ID, result, err)
	case "setApiKey":
		var p apiKeyParams
		err := decode(req.Params, &p)
		var result loginStatus
		if err == nil {
			if err = c.knownAccount(p.AccountID, p.Provider); err == nil {
				result, err = c.logins.setAPIKey(ctx, p.AccountID, p.Provider, p.APIKey)
			}
		}
		reply(c, req.ID, result, err)
	case "importNativeLogin":
		var p importParams
		err := decode(req.Params, &p)
		var result loginStatus
		if err == nil {
			if err = c.knownAccount(p.AccountID, p.Provider); err == nil {
				result, err = c.logins.importNative(ctx, p.AccountID, p.Provider)
			}
		}
		reply(c, req.ID, result, err)
	case "loginInput":
		var p loginInputParams
		err := decode(req.Params, &p)
		var result loginStatus
		if err == nil {
			result, err = c.logins.input(p.AccountID, p.Input)
		}
		reply(c, req.ID, result, err)
	case "loginStatus", "cancelLogin", "removeAccount":
		var p accountParams
		err := decode(req.Params, &p)
		if err == nil {
			r.mu.Lock()
			_, ok := r.accounts[p.AccountID]
			r.mu.Unlock()
			if !ok {
				err = errors.New("unknown provider account")
			}
		}
		if req.Method == "removeAccount" {
			if err == nil {
				err = c.removeAccount(ctx, p.AccountID)
			}
			reply(c, req.ID, emptyResult{}, err)
		} else {
			var result loginStatus
			if err == nil {
				if req.Method == "cancelLogin" {
					result, err = c.logins.cancel(p.AccountID)
				} else {
					result = c.loginState(p.AccountID)
				}
			}
			reply(c, req.ID, result, err)
		}
	default:
		c.write(controlResponse{ID: req.ID, Error: &controlError{Code: "unknown_method", Message: "unknown auth control method"}})
	}
}

func (c *control) removeAccount(ctx context.Context, id string) error {
	r := c.router
	r.mu.Lock()
	if r.removing[id] {
		r.mu.Unlock()
		return errors.New("account removal is already pending")
	}
	for _, b := range r.state.Sessions {
		if b.Session.EffectiveAccountID == id || b.Session.AccountID != nil && *b.Session.AccountID == id {
			r.mu.Unlock()
			return errors.New("account is referenced by a managed session")
		}
	}
	for _, request := range r.requests {
		if request.Binding.Session.EffectiveAccountID == id || request.LastAccount == id || request.SelectedAccounts[id] || request.Binding.Session.AccountID != nil && *request.Binding.Session.AccountID == id {
			r.mu.Unlock()
			return errors.New("account is referenced by an active request")
		}
	}
	r.removing[id] = true
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.removing, id); r.mu.Unlock() }()
	if _, err := c.logins.cancel(id); err != nil {
		return err
	}
	c.logins.manager.Remove(ctx, authFileID(id))
	if err := c.logins.store.Delete(ctx, authFileID(id)); err != nil {
		return errors.New("could not remove account credentials")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.state.Cooldowns, id)
	delete(r.state.Verified, id)
	delete(r.state.Broken, id)
	return r.persistLocked()
}

// knownAccount checks the account is configured under the stated provider.
func (c *control) knownAccount(id string, p provider) error {
	c.router.mu.Lock()
	defer c.router.mu.Unlock()
	if a, exists := c.router.accounts[id]; !exists || a.Provider != p {
		return errors.New("unknown provider account")
	}
	return nil
}

// loginState is the account's login status with readiness composed from the persisted marks: a usable
// credential without a verified mark, or with a breakage mark, is not signed in.
func (c *control) loginState(id string) loginStatus {
	status := c.logins.status(id)
	if status.Status != "ready" {
		return status
	}
	c.router.mu.Lock()
	allowed := c.router.marksAllowLocked(id)
	c.router.mu.Unlock()
	if !allowed {
		return loginStatus{AccountID: id, Status: "sign-in-required"}
	}
	return status
}

// registeredCredentials reports the kind and identity of each account's registered credential and
// records the breakage of any verified account whose sign-in the SDK rejected without running a hook.
func (c *control) registeredCredentials() map[string]registeredCredential {
	r := c.router
	r.mu.Lock()
	accounts := make([]accountInput, 0, len(r.accounts))
	for _, a := range r.accounts {
		accounts = append(accounts, a)
	}
	r.mu.Unlock()
	registered := make(map[string]registeredCredential, len(accounts))
	for _, a := range accounts {
		auth, ok := c.logins.manager.GetByID(authFileID(a.ID))
		if !ok || auth.Provider != string(a.Provider) {
			continue
		}
		if auth.RequiresSignIn {
			r.markBroken(a.ID)
		}
		kind := "oauth"
		if isAPIKey(auth) {
			kind = credentialAPIKey
		}
		registered[a.ID] = registeredCredential{kind: kind, identity: credentialIdentity(auth)}
	}
	return registered
}

// credentialIdentity reads the provider identity from credential metadata, or nil when it holds none.
func credentialIdentity(auth *coreauth.Auth) *accountIdentity {
	field := func(name string) string {
		value, _ := auth.Metadata[name].(string)
		return strings.TrimSpace(value)
	}
	var identity accountIdentity
	switch {
	case isAPIKey(auth):
		if key := field("api_key"); len(key) > 4 {
			identity.KeyHint = key[len(key)-4:]
		}
	case provider(auth.Provider) == claude:
		identity = accountIdentity{Email: field("email"), OrganizationName: field("organization_name"), OrganizationID: field("organization_uuid")}
	default:
		identity = accountIdentity{Email: field("email"), OrganizationID: field("account_id"), Plan: field("plan_type")}
	}
	if identity == (accountIdentity{}) {
		return nil
	}
	return &identity
}

// readUsage reads the usage endpoint of each requested OAuth account in parallel. An unknown or
// removed account yields an error entry for that id only.
func (c *control) readUsage(ctx context.Context, ids []string) usageResult {
	result := usageResult{Usage: make([]usageEntry, len(ids))}
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entry := usageEntry{Status: usageStatusError}
			c.router.mu.Lock()
			account, known := c.router.accounts[id]
			c.router.mu.Unlock()
			if known {
				if auth, ok := c.logins.manager.GetByID(authFileID(id)); ok && auth.Provider == string(account.Provider) {
					entry = fetchUsage(ctx, c.logins.manager, c.logins.transport, auth)
				}
			}
			entry.AccountID = id
			result.Usage[i] = entry
		}()
	}
	wg.Wait()
	return result
}
