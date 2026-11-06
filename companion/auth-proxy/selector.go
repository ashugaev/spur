package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

const requestHeader = "X-Spur-Auth-Request"
const requestMetadata = "spur_auth_request"

type admission struct {
	SessionID        string
	Binding          binding
	DispatchedEpoch  uint64
	LastAccount      string
	SelectedAccounts map[string]bool
}

func authFileID(id string) string    { return id + ".json" }
func profileID(authID string) string { return strings.TrimSuffix(authID, ".json") }

func (r *router) rotateLocked(b *binding, candidates map[string]bool) error {
	current := b.Session.EffectiveAccountID
	p := b.Session.Provider
	if r.removing[current] || r.accounts[current].Provider != p || r.readyAccount == nil || !r.readyAccount(current, p) {
		return errors.New("selected account requires sign in")
	}
	if !r.state.Cooldowns[current].After(time.Now()) {
		if candidates == nil || candidates[current] {
			return nil
		}
		return errors.New("selected account is unavailable for this request")
	}
	if b.Session.Mode == "pinned" || !r.pools[p].AutoRotate || b.Episode.Rotations >= r.policy.MaxRotationsPerEpisode {
		return errors.New("account quota exhausted; rotation unavailable")
	}
	accounts := make([]accountInput, 0, len(r.accounts))
	for id, a := range r.accounts {
		if id != current && r.eligibleLocked(id, p) && (candidates == nil || candidates[id]) {
			accounts = append(accounts, a)
		}
	}
	sort.Slice(accounts, func(i, j int) bool {
		if accounts[i].CreatedAt == accounts[j].CreatedAt {
			return accounts[i].ID < accounts[j].ID
		}
		return accounts[i].CreatedAt < accounts[j].CreatedAt
	})
	if len(accounts) == 0 {
		return errors.New("no account is ready outside the shared cooldown")
	}
	if !b.Episode.Open {
		b.Episode.Open = true
		b.Episode.Epoch++
	}
	b.Episode.Rotations++
	b.Session.EffectiveAccountID = accounts[0].ID
	return nil
}

func (r *router) rebaseDefaultLocked(b *binding) error {
	pool, exists := r.pools[b.Session.Provider]
	if !exists {
		return errors.New("managed provider pool does not exist")
	}
	if b.Session.Mode == "auto" && b.DefaultGeneration != pool.DefaultGeneration {
		if pool.DefaultAccountID == nil {
			return errors.New("provider default account is not set")
		}
		b.Session.EffectiveAccountID = *pool.DefaultAccountID
		b.DefaultGeneration = pool.DefaultGeneration
	}
	return nil
}

func (r *router) Pick(_ context.Context, requestedProvider, _ string, opts coreexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	requestID := opts.Headers.Get(requestHeader)
	if requestID != "" {
		// Execution metadata stays inside SDK; HTTP headers can reach upstream.
		opts.Metadata[requestMetadata] = requestID
		opts.Headers.Del(requestHeader)
	} else {
		requestID, _ = opts.Metadata[requestMetadata].(string)
	}
	a := r.requests[requestID]
	if a == nil || !r.configured || r.fatal != nil || string(a.Binding.Session.Provider) != requestedProvider {
		return nil, errors.New("unknown authorization scope")
	}
	available := make(map[string]bool, len(auths))
	for _, auth := range auths {
		if auth.Provider == requestedProvider {
			available[profileID(auth.ID)] = true
		}
	}
	before := a.Binding.Session.EffectiveAccountID
	if err := r.rotateLocked(&a.Binding, available); err != nil {
		return nil, err
	}
	if before != a.Binding.Session.EffectiveAccountID {
		current, exists := r.state.Sessions[a.SessionID]
		if exists && current.Session.Generation == a.Binding.Session.Generation {
			r.state.Sessions[a.SessionID] = a.Binding
		}
		if err := r.persistLocked(); err != nil {
			return nil, errors.New("could not persist rotation")
		}
	}
	a.LastAccount = a.Binding.Session.EffectiveAccountID
	if a.SelectedAccounts == nil {
		a.SelectedAccounts = map[string]bool{}
	}
	a.SelectedAccounts[a.LastAccount] = true
	a.DispatchedEpoch = a.Binding.Episode.Epoch
	for _, auth := range auths {
		if auth.ID == authFileID(a.LastAccount) {
			return auth, nil
		}
	}
	return nil, errors.New("selected account unavailable")
}

func (r *router) OnAuthRegistered(context.Context, *coreauth.Auth) {}
func (r *router) OnAuthUpdated(context.Context, *coreauth.Auth)    {}

func (r *router) OnResult(_ context.Context, result coreauth.Result) {
	if result.SkipQuotaObservation {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	requestID, _ := result.Options.Metadata[requestMetadata].(string)
	if requestID == "" {
		requestID = result.Options.Headers.Get(requestHeader)
	}
	a := r.requests[requestID]
	quota := result.Error != nil && result.Error.HTTPStatus == http.StatusTooManyRequests && result.Error.Code != coreauth.ErrorCodeTransientRateLimit
	changed := false
	if quota {
		duration := time.Duration(r.policy.CooldownMinutes) * time.Minute
		if result.RetryAfter != nil && *result.RetryAfter > 0 {
			duration = *result.RetryAfter
		}
		until := time.Now().Add(duration)
		id := profileID(result.AuthID)
		if until.After(r.state.Cooldowns[id]) {
			r.state.Cooldowns[id] = until
			changed = true
		}
		if a != nil && a.LastAccount == id {
			if !a.Binding.Episode.Open {
				a.Binding.Episode.Open = true
				a.Binding.Episode.Epoch++
			}
			if current, exists := r.state.Sessions[a.SessionID]; exists && current.Session.Generation == a.Binding.Session.Generation {
				r.state.Sessions[a.SessionID] = a.Binding
				changed = true
			}
		}
	}
	if a != nil && profileID(result.AuthID) == a.LastAccount && result.Success && result.CompletedResponse {
		if current, exists := r.state.Sessions[a.SessionID]; exists && current.Session.Generation == a.Binding.Session.Generation && current.Episode.Open && current.Episode.Epoch == a.DispatchedEpoch {
			current.Episode.Open, current.Episode.Rotations = false, 0
			r.state.Sessions[a.SessionID] = current
			a.Binding = current
			changed = true
		}
	}
	if changed {
		_ = r.persistLocked()
	}
}

func (r *router) middleware(probeKey string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/_spur/readiness" {
			if subtle.ConstantTimeCompare([]byte(c.GetHeader("X-Spur-Readiness")), []byte(probeKey)) == 1 {
				c.AbortWithStatus(http.StatusNoContent)
			} else {
				c.AbortWithStatus(http.StatusNotFound)
			}
			return
		}
		if !allowedPath(c.Request.URL.Path) || c.Request.Header.Get("Upgrade") != "" {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
		if token == "" {
			token = c.GetHeader("X-Api-Key")
		}
		r.mu.Lock()
		var sessionID string
		for id, b := range r.state.Sessions {
			if subtle.ConstantTimeCompare([]byte(b.Token), []byte(token)) == 1 {
				sessionID = id
				break
			}
		}
		if sessionID == "" || !r.configured || r.fatal != nil {
			r.mu.Unlock()
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		lock := r.sessionLocks[sessionID]
		if lock == nil {
			lock = &sync.Mutex{}
			r.sessionLocks[sessionID] = lock
		}
		r.mu.Unlock()
		lock.Lock()
		defer lock.Unlock()
		if c.Request.Context().Err() != nil {
			c.AbortWithStatus(http.StatusRequestTimeout)
			return
		}
		r.mu.Lock()
		b, exists := r.state.Sessions[sessionID]
		if !exists || subtle.ConstantTimeCompare([]byte(b.Token), []byte(token)) != 1 || r.fatal != nil {
			r.mu.Unlock()
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		if err := r.rebaseDefaultLocked(&b); err != nil {
			r.mu.Unlock()
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		if err := r.rotateLocked(&b, nil); err != nil {
			until := r.state.Cooldowns[b.Session.EffectiveAccountID]
			r.mu.Unlock()
			if until.After(time.Now()) {
				c.Header("Retry-After", until.UTC().Format(http.TimeFormat))
				c.AbortWithStatus(http.StatusTooManyRequests)
			} else {
				c.AbortWithStatus(http.StatusServiceUnavailable)
			}
			return
		}
		r.state.Sessions[sessionID] = b
		if err := r.persistLocked(); err != nil {
			r.mu.Unlock()
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		requestID, err := randomKey()
		if err != nil {
			r.mu.Unlock()
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		r.requests[requestID] = &admission{SessionID: sessionID, Binding: b}
		r.mu.Unlock()
		defer func() { r.mu.Lock(); delete(r.requests, requestID); r.mu.Unlock() }()
		c.Request.Header.Del("Authorization")
		c.Request.Header.Del("X-Api-Key")
		c.Request.Header.Set(requestHeader, requestID)
		c.Next()
	}
}

func allowedPath(path string) bool {
	switch path {
	case "/v1/models", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/v1/responses/compact":
		return true
	default:
		return false
	}
}
