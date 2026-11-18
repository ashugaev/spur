package main

import (
	"context"
	"testing"
)

func projectionRunning(r *router, id string) bool {
	r.projectMu.Lock()
	defer r.projectMu.Unlock()
	_, running := r.projecting[id]
	return running
}

func TestProjectLaterStopsOnShutdown(t *testing.T) {
	f := newLoginFixtureIn(t, t.TempDir(), false)
	ctx, cancel := context.WithCancel(context.Background())
	f.r.ctx = ctx
	f.r.projectLater("key-never-registered.json")
	if !projectionRunning(f.r, "key-never-registered.json") {
		t.Fatal("projection did not start")
	}
	cancel()
	waitFor(t, "projection goroutine stops with the run context", func() bool {
		return !projectionRunning(f.r, "key-never-registered.json")
	})
}

func TestProjectionDoneRunsAgainForHookDuringPass(t *testing.T) {
	r := &router{ctx: context.Background(), projecting: map[string]bool{"id": false}}
	if r.projectionDone("id") || projectionRunning(r, "id") {
		t.Fatal("a pass with no new hook must end and clear its entry")
	}
	r.projecting["id"] = false
	// A hook arriving between the update and the clear marks the entry; the pass runs again.
	r.projectLater("id")
	if !r.projecting["id"] {
		t.Fatal("hook during a running pass was not recorded")
	}
	if !r.projectionDone("id") || r.projecting["id"] || !projectionRunning(r, "id") {
		t.Fatal("marked pass did not run again")
	}
	if r.projectionDone("id") || projectionRunning(r, "id") {
		t.Fatal("second pass did not end")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	r.ctx, r.projecting["id"] = cancelled, true
	if r.projectionDone("id") || projectionRunning(r, "id") {
		t.Fatal("shutdown must end the pass even with a pending hook")
	}
}
