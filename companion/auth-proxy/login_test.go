package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
)

type refreshFixture struct {
	active   atomic.Int32
	maximum  atomic.Int32
	sequence atomic.Int32
}

func (*refreshFixture) Identifier() string { return "claude" }
func (*refreshFixture) Execute(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (*refreshFixture) ExecuteStream(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (*coreexecutor.StreamResult, error) {
	return nil, errors.New("not used")
}
func (*refreshFixture) CountTokens(context.Context, *coreauth.Auth, coreexecutor.Request, coreexecutor.Options) (coreexecutor.Response, error) {
	return coreexecutor.Response{}, errors.New("not used")
}
func (*refreshFixture) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, errors.New("not used")
}
func (e *refreshFixture) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	active := e.active.Add(1)
	defer e.active.Add(-1)
	for {
		previous := e.maximum.Load()
		if active <= previous || e.maximum.CompareAndSwap(previous, active) {
			break
		}
	}
	time.Sleep(20 * time.Millisecond)
	updated := auth.Clone()
	updated.Metadata = maps.Clone(auth.Metadata)
	sequence := e.sequence.Add(1)
	updated.Metadata["access_token"] = fmt.Sprintf("fixture-access-%d", sequence)
	updated.Metadata["refresh_token"] = fmt.Sprintf("fixture-refresh-%d", sequence)
	return updated, nil
}

func TestRefreshSerializedAndDurable(t *testing.T) {
	dir := t.TempDir()
	store := tokenStore(dir)
	manager := coreauth.NewManager(store, nil, nil)
	executor := &refreshFixture{}
	manager.RegisterExecutor(executor)
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"id":"account-a.json","provider":"claude","metadata":{"type":"claude","email":"fixture@example.invalid","access_token":"fixture-access","refresh_token":"fixture-refresh"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	auth.FileName = auth.ID
	if _, err := manager.Register(context.Background(), &auth); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := manager.ForceRefreshAuth(context.Background(), auth.ID)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal("refresh failed")
		}
	}
	if executor.maximum.Load() != 1 {
		t.Fatal("refresh grants mutated concurrently")
	}
	current, ok := manager.GetByID(auth.ID)
	if !ok {
		t.Fatal("refreshed account missing")
	}
	restored, err := tokenStore(dir).List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(restored) != 1 || restored[0].Metadata["access_token"] != current.Metadata["access_token"] || restored[0].Metadata["refresh_token"] != current.Metadata["refresh_token"] {
		t.Fatal("latest refreshed credential did not survive store reload")
	}
	info, err := os.Stat(filepath.Join(dir, "auth-proxy-credentials", auth.ID))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatal("credentials are readable outside owner")
	}
}

func TestSuccessfulLoginStatusDoesNotHideRenewalFailure(t *testing.T) {
	store := tokenStore(t.TempDir())
	manager := coreauth.NewManager(store, nil, nil)
	var auth coreauth.Auth
	if err := json.Unmarshal([]byte(`{"id":"account-a.json","provider":"claude","metadata":{"type":"claude","access_token":"fixture-access"}}`), &auth); err != nil {
		t.Fatal(err)
	}
	auth.FileName = auth.ID
	if _, err := manager.Register(context.Background(), &auth); err != nil {
		t.Fatal(err)
	}
	l := &loginManager{manager: manager, store: store, attempts: map[string]*loginAttempt{"account-a": {status: loginStatus{AccountID: "account-a", Status: "ready"}}}}
	if l.status("account-a").Status != "ready" {
		t.Fatal("valid signed-in status unavailable")
	}
	manager.Remove(context.Background(), auth.ID)
	if l.status("account-a").Status != "sign-in-required" {
		t.Fatal("cached login success hid missing credentials")
	}
}
