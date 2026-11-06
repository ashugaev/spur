package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"sync"
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
}
type stateSummary struct {
	Accounts []accountStatus  `json:"accounts"`
	Sessions []sessionSummary `json:"sessions"`
}
type resultValue interface {
	emptyResult | registration | stateSummary | loginStatus
}
type inputValue interface {
	*runtimeState | *controlRequest | *configureParams | *registerParams | *switchParams | *sessionParams | *loginParams | *accountParams | *loginInputParams | *emptyResult
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
}

func (c *control) write(response controlResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = json.NewEncoder(c.out).Encode(response)
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
			r.mu.Lock()
			for _, a := range r.accounts {
				status := c.logins.status(a.ID)
				if status.Status != "pending" && c.logins.ready(a.ID, a.Provider) {
					status.Status = "ready"
				}
				result.Accounts = append(result.Accounts, accountStatus{ID: a.ID, Provider: a.Provider, Status: status.Status, Error: status.Error})
			}
			for _, b := range r.state.Sessions {
				result.Sessions = append(result.Sessions, b.Session)
			}
			r.mu.Unlock()
			sort.Slice(result.Accounts, func(i, j int) bool { return result.Accounts[i].ID < result.Accounts[j].ID })
			sort.Slice(result.Sessions, func(i, j int) bool { return result.Sessions[i].SessionID < result.Sessions[j].SessionID })
		}
		reply(c, req.ID, result, err)
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
			r.mu.Lock()
			a, exists := r.accounts[p.AccountID]
			r.mu.Unlock()
			if !exists || a.Provider != p.Provider {
				err = errors.New("unknown provider account")
			} else {
				result, err = c.logins.start(ctx, p.AccountID, p.Provider)
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
					result = c.logins.status(p.AccountID)
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
	return r.persistLocked()
}
