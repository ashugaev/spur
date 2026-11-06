package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
)

type provider string

const (
	claude provider = "claude"
	codex  provider = "codex"
)

func (p provider) valid() bool { return p == claude || p == codex }

var safeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)

type accountInput struct {
	ID        string   `json:"id"`
	Provider  provider `json:"provider"`
	CreatedAt string   `json:"createdAt"`
}

type poolInput struct {
	Provider          provider `json:"provider"`
	DefaultAccountID  *string  `json:"defaultAccountId"`
	AutoRotate        bool     `json:"autoRotate"`
	DefaultGeneration uint64   `json:"defaultGeneration"`
}

type policy struct {
	CooldownMinutes        int `json:"cooldownMinutes"`
	MaxRotationsPerEpisode int `json:"maxRotationsPerEpisode"`
}

type episode struct {
	Open      bool   `json:"open"`
	Rotations int    `json:"rotations"`
	Epoch     uint64 `json:"epoch"`
}

type sessionSummary struct {
	SessionID          string   `json:"sessionId"`
	Provider           provider `json:"provider"`
	Mode               string   `json:"mode"`
	AccountID          *string  `json:"accountId"`
	EffectiveAccountID string   `json:"effectiveAccountId"`
	Generation         uint64   `json:"generation"`
}

type binding struct {
	Session           sessionSummary `json:"session"`
	Token             string         `json:"token"`
	DefaultGeneration uint64         `json:"defaultGeneration"`
	Episode           episode        `json:"episode"`
}

type runtimeState struct {
	Schema    int                  `json:"schema"`
	DataDir   string               `json:"dataDir"`
	Endpoint  string               `json:"endpoint"`
	Sessions  map[string]binding   `json:"sessions"`
	Cooldowns map[string]time.Time `json:"cooldowns"`
}

type registration struct {
	sessionSummary
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

type router struct {
	mu           sync.Mutex
	state        runtimeState
	dir          string
	lock         *os.File
	accounts     map[string]accountInput
	pools        map[provider]poolInput
	policy       policy
	configured   bool
	requests     map[string]*admission
	sessionLocks map[string]*sync.Mutex
	readyAccount func(string, provider) bool
	fatal        error
}

func openRouter(dir string) (*router, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "auth-proxy.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, errors.New("another auth proxy owns this data directory")
	}
	r := &router{dir: dir, lock: lock, accounts: map[string]accountInput{}, pools: map[provider]poolInput{}, requests: map[string]*admission{}, sessionLocks: map[string]*sync.Mutex{}}
	r.state = runtimeState{Schema: 1, DataDir: dir, Sessions: map[string]binding{}, Cooldowns: map[string]time.Time{}}
	path := filepath.Join(dir, "auth-proxy-state.json")
	raw, err := os.ReadFile(path)
	if err == nil {
		info, statErr := os.Stat(path)
		if statErr != nil || info.Mode().Perm()&0o077 != 0 {
			err = errors.New("auth proxy state requires owner-only permissions")
		} else {
			err = decode(raw, &r.state)
		}
		if err == nil {
			err = r.validateState()
		}
	} else if os.IsNotExist(err) {
		listener, listenErr := net.Listen("tcp4", "127.0.0.1:0")
		if listenErr != nil {
			err = listenErr
		} else {
			r.state.Endpoint = "http://" + listener.Addr().String()
			err = listener.Close()
			if err == nil {
				err = r.persistLocked()
			}
		}
	}
	if err != nil {
		r.close()
		return nil, fmt.Errorf("auth proxy state unavailable: %w", err)
	}
	return r, nil
}

func (r *router) validateState() error {
	if r.state.Schema != 1 || r.state.DataDir != r.dir || r.state.Sessions == nil || r.state.Cooldowns == nil {
		return errors.New("invalid auth proxy state identity or schema")
	}
	if _, err := endpointPort(r.state.Endpoint); err != nil {
		return err
	}
	tokens := map[string]bool{}
	for id, b := range r.state.Sessions {
		if !safeID.MatchString(id) || b.Session.SessionID != id || !b.Session.Provider.valid() || (b.Session.Mode != "auto" && b.Session.Mode != "pinned") || !safeID.MatchString(b.Session.EffectiveAccountID) || len(b.Token) != 64 || b.Session.Generation == 0 || b.Episode.Rotations < 0 || tokens[b.Token] || (b.Session.Mode == "pinned") != (b.Session.AccountID != nil) {
			return errors.New("invalid saved auth binding")
		}
		if b.Session.AccountID != nil && (*b.Session.AccountID != b.Session.EffectiveAccountID || !safeID.MatchString(*b.Session.AccountID)) {
			return errors.New("invalid saved pinned account")
		}
		if _, err := hex.DecodeString(b.Token); err != nil {
			return errors.New("invalid saved routing key")
		}
		tokens[b.Token] = true
	}
	return nil
}

func endpointPort(endpoint string) (int, error) {
	const prefix = "http://127.0.0.1:"
	if len(endpoint) <= len(prefix) || endpoint[:len(prefix)] != prefix {
		return 0, errors.New("invalid auth proxy loopback endpoint")
	}
	addr, err := net.ResolveTCPAddr("tcp4", endpoint[len("http://"):])
	if err != nil || addr.Port < 1 || addr.Port > 65535 {
		return 0, errors.New("invalid auth proxy port")
	}
	return addr.Port, nil
}

func (r *router) close() {
	if r.lock != nil {
		_ = syscall.Flock(int(r.lock.Fd()), syscall.LOCK_UN)
		_ = r.lock.Close()
		r.lock = nil
	}
}

func (r *router) persistLocked() error {
	raw, err := json.Marshal(r.state)
	if err != nil {
		return err
	}
	if err = atomicPrivateWrite(filepath.Join(r.dir, "auth-proxy-state.json"), raw); err != nil {
		r.fatal = err
	}
	return err
}

func atomicPrivateWrite(path string, raw []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".auth-write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0o600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), path)
	}
	if err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func randomKey() (string, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(key[:]), nil
}

func (r *router) configure(accounts []accountInput, pools []poolInput, p policy) error {
	if p.CooldownMinutes < 0 || p.MaxRotationsPerEpisode < 0 {
		return errors.New("invalid rotation policy")
	}
	nextAccounts := map[string]accountInput{}
	for _, a := range accounts {
		if !safeID.MatchString(a.ID) || !a.Provider.valid() || nextAccounts[a.ID].ID != "" {
			return errors.New("invalid account configuration")
		}
		if _, err := time.Parse(time.RFC3339Nano, a.CreatedAt); err != nil {
			return errors.New("invalid account creation time")
		}
		nextAccounts[a.ID] = a
	}
	nextPools := map[provider]poolInput{}
	for _, p := range pools {
		if !p.Provider.valid() || nextPools[p.Provider].Provider != "" {
			return errors.New("invalid provider pool")
		}
		if p.DefaultAccountID != nil && nextAccounts[*p.DefaultAccountID].Provider != p.Provider {
			return errors.New("invalid provider default account")
		}
		nextPools[p.Provider] = p
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fatal != nil {
		return errors.New("auth proxy persistence failed")
	}
	r.accounts, r.pools, r.policy, r.configured = nextAccounts, nextPools, p, true
	return nil
}

func (r *router) eligibleLocked(id string, p provider) bool {
	return r.accounts[id].Provider == p && r.readyAccount != nil && r.readyAccount(id, p) && !r.state.Cooldowns[id].After(time.Now())
}

func (r *router) register(sessionID string, p provider, accountID *string, change bool) (registration, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.configured || r.fatal != nil || !safeID.MatchString(sessionID) || !p.valid() {
		return registration{}, errors.New("auth proxy is not ready or session is invalid")
	}
	pool, exists := r.pools[p]
	if !exists {
		return registration{}, errors.New("managed provider pool does not exist")
	}
	b, exists := r.state.Sessions[sessionID]
	mode := "auto"
	if accountID != nil {
		mode = "pinned"
	}
	same := exists && b.Session.Provider == p && b.Session.Mode == mode && equalIDs(b.Session.AccountID, accountID)
	if exists && !change && !same {
		return registration{}, errors.New("saved authorization differs; switch it explicitly")
	}
	if !same || change {
		id := accountID
		if id == nil {
			id = pool.DefaultAccountID
		}
		if id == nil {
			return registration{}, errors.New("provider default account is not set")
		}
		if !exists {
			token, err := randomKey()
			if err != nil {
				return registration{}, err
			}
			b.Token = token
		}
		b.Session = sessionSummary{SessionID: sessionID, Provider: p, Mode: mode, AccountID: accountID, EffectiveAccountID: *id, Generation: b.Session.Generation + 1}
		b.DefaultGeneration, b.Episode = pool.DefaultGeneration, episode{}
	}
	if err := r.rebaseDefaultLocked(&b); err != nil {
		return registration{}, err
	}
	if err := r.rotateLocked(&b, nil); err != nil {
		return registration{}, err
	}
	r.state.Sessions[sessionID] = b
	if err := r.persistLocked(); err != nil {
		return registration{}, errors.New("could not persist authorization")
	}
	return registration{sessionSummary: b.Session, Endpoint: r.state.Endpoint, Token: b.Token}, nil
}

func equalIDs(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }

func (r *router) revoke(sessionID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.state.Sessions, sessionID)
	return r.persistLocked()
}
