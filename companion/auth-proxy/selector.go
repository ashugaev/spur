package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
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

// refreshAdmissionLocked adopts the saved binding while the admission still tracks it, so parallel
// requests of one session share rotation and episode state. A switch (new session generation)
// keeps the admitted snapshot. Reports whether the admission tracks saved state.
func (r *router) refreshAdmissionLocked(a *admission) bool {
	saved, exists := r.state.Sessions[a.SessionID]
	if !exists || saved.Session.Generation != a.Binding.Session.Generation {
		return false
	}
	a.Binding = saved
	return true
}

// nextEligibleLocked returns the eligible account least used by other sessions, oldest first on ties.
func (r *router) nextEligibleLocked(p provider, sessionID, exclude string, candidates map[string]bool) string {
	load := map[string]int{}
	for id, s := range r.state.Sessions {
		if id != sessionID {
			load[s.Session.EffectiveAccountID]++
		}
	}
	accounts := make([]accountInput, 0, len(r.accounts))
	for id, a := range r.accounts {
		if id != exclude && r.eligibleLocked(id, p) && (candidates == nil || candidates[id]) {
			accounts = append(accounts, a)
		}
	}
	if len(accounts) == 0 {
		return ""
	}
	sort.Slice(accounts, func(i, j int) bool {
		if li, lj := load[accounts[i].ID], load[accounts[j].ID]; li != lj {
			return li < lj
		}
		if accounts[i].CreatedAt == accounts[j].CreatedAt {
			return accounts[i].ID < accounts[j].ID
		}
		return accounts[i].CreatedAt < accounts[j].CreatedAt
	})
	return accounts[0].ID
}

func (r *router) rotateLocked(b *binding, candidates map[string]bool) error {
	current := b.Session.EffectiveAccountID
	p := b.Session.Provider
	auto := b.Session.Mode == "auto"
	if current == "" || r.removing[current] || r.accounts[current].Provider != p || r.readyAccount == nil || !r.readyAccount(current, p) {
		if !auto {
			return errors.New("selected account requires sign in")
		}
		// Auto leaves an account that needs sign-in without spending quota budget.
		next := r.nextEligibleLocked(p, b.Session.SessionID, current, candidates)
		if next == "" {
			return errors.New("no account is ready; sign in to an account")
		}
		b.Session.EffectiveAccountID = next
		return nil
	}
	cooled := r.state.Cooldowns[current].After(time.Now())
	if !cooled && (candidates == nil || candidates[current]) {
		return nil
	}
	if !cooled && !auto {
		return errors.New("selected account is unavailable for this request")
	}
	// Auto treats an account the SDK withheld from candidates as cooling.
	if !auto || !r.pools[p].AutoRotate || b.Episode.Rotations >= r.policy.MaxRotationsPerEpisode {
		return errors.New("account quota exhausted; rotation unavailable")
	}
	next := r.nextEligibleLocked(p, b.Session.SessionID, current, candidates)
	if next == "" {
		return errors.New("no account is ready outside the shared cooldown")
	}
	if !b.Episode.Open {
		b.Episode.Open = true
		b.Episode.Epoch++
	}
	b.Episode.Rotations++
	b.Session.EffectiveAccountID = next
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
	// A parallel request may already have rotated this session; adopt that account when eligible.
	tracked := r.refreshAdmissionLocked(a)
	before := a.Binding.Session.EffectiveAccountID
	if err := r.rotateLocked(&a.Binding, available); err != nil {
		return nil, err
	}
	if before != a.Binding.Session.EffectiveAccountID {
		if tracked {
			r.state.Sessions[a.SessionID] = a.Binding
		}
		if err := r.persistLocked(); err != nil {
			return nil, errors.New("could not persist rotation")
		}
		if tracked {
			r.noteRotationLocked(a.Binding, before)
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

func (r *router) OnAuthRegistered(ctx context.Context, auth *coreauth.Auth) { r.observeAuth(ctx, auth) }
func (r *router) OnAuthUpdated(ctx context.Context, auth *coreauth.Auth)    { r.observeAuth(ctx, auth) }

// observeAuth runs after the manager commits an auth. It schedules the projection of an API-key
// record whose executor attributes are missing (the file watcher does not project them) and records
// the first loss of sign-in as a breakage.
func (r *router) observeAuth(_ context.Context, auth *coreauth.Auth) {
	if auth == nil {
		return
	}
	if r.manager != nil && projectAPIKey(auth.Clone()) {
		r.projectLater(auth.ID)
	}
	if auth.RequiresSignIn {
		r.markBroken(profileID(auth.ID))
	}
}

// projectLater re-registers the stored API-key auth with its executor attributes once the service
// has published its models. An update inside the registration hook races the service's publication
// fence and can leave the account without models, so the update waits for the publication.
func (r *router) projectLater(id string) {
	r.projectMu.Lock()
	if _, running := r.projecting[id]; running {
		r.projecting[id] = true // the running pass projects again before it ends
		r.projectMu.Unlock()
		return
	}
	r.projecting[id] = false
	r.projectMu.Unlock()
	go func() {
		for {
			timer := time.NewTimer(15 * time.Second)
			for len(cliproxy.GlobalModelRegistry().GetModelsForClient(id)) == 0 {
				select {
				case <-r.ctx.Done():
				case <-timer.C:
				case <-time.After(20 * time.Millisecond):
					continue
				}
				break
			}
			timer.Stop()
			// A credential removed meanwhile stays removed: only a registered auth is updated.
			if current, ok := r.manager.GetByID(id); ok && projectAPIKey(current) && r.ctx.Err() == nil {
				_, _ = r.manager.Update(coreauth.WithSkipPersist(r.ctx), current)
			}
			if !r.projectionDone(id) {
				return
			}
		}
	}()
}

// projectionDone ends a projection pass. It reports true, and keeps the entry, when a hook arrived
// during the pass and the run is still live, so that hook is projected too.
func (r *router) projectionDone(id string) bool {
	r.projectMu.Lock()
	defer r.projectMu.Unlock()
	if r.projecting[id] && r.ctx.Err() == nil {
		r.projecting[id] = false
		return true
	}
	delete(r.projecting, id)
	return false
}

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
		// Skip a quota on an account a parallel request already rotated away from.
		if a != nil && a.LastAccount == id && r.refreshAdmissionLocked(a) && a.Binding.Session.EffectiveAccountID == id && !a.Binding.Episode.Open {
			a.Binding.Episode.Open = true
			a.Binding.Episode.Epoch++
			r.state.Sessions[a.SessionID] = a.Binding
			changed = true
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
		// r.mu serializes admission; concurrent requests of one session proceed in parallel.
		b := r.state.Sessions[sessionID]
		before := b.Session.EffectiveAccountID
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
		r.noteRotationLocked(b, before)
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
		c.Writer = &strippingWriter{ResponseWriter: c.Writer}
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

// strippingWriter drops the headers the SDK strips from upstream responses, on every status. The SDK
// copies upstream headers into error responses without that filter.
type strippingWriter struct{ gin.ResponseWriter }

func (w *strippingWriter) strip() {
	if w.Written() {
		return
	}
	header := w.Header()
	kept := handlers.FilterUpstreamHeaders(header)
	for key := range header {
		// The SDK and server own these; the filter would drop them with the upstream headers.
		switch http.CanonicalHeaderKey(key) {
		case "Content-Length", "Content-Encoding":
			continue
		}
		if _, ok := kept[key]; !ok && !handlers.IsCPAReservedResponseHeader(key) {
			delete(header, key)
		}
	}
}

func (w *strippingWriter) WriteHeader(code int) { w.strip(); w.ResponseWriter.WriteHeader(code) }
func (w *strippingWriter) WriteHeaderNow()      { w.strip(); w.ResponseWriter.WriteHeaderNow() }
func (w *strippingWriter) Write(b []byte) (int, error) {
	w.strip()
	return w.ResponseWriter.Write(b)
}
func (w *strippingWriter) Flush() { w.strip(); w.ResponseWriter.Flush() }
func (w *strippingWriter) WriteString(s string) (int, error) {
	w.strip()
	return w.ResponseWriter.WriteString(s)
}
