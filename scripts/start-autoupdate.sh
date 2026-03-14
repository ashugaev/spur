#!/usr/bin/env bash
set -euo pipefail

# ao start with automatic git pull and rebuild every 5 minutes.
# Usage: bash scripts/start-autoupdate.sh
#
# STATUS: Active — referenced in package.json "start:auto-pull"
# PLAN: Keep; wraps ao start with auto-pull, no TS equivalent needed

POLL_INTERVAL=300 # seconds (5 minutes)
START_PID=""

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

start_ao() {
  log "Starting ao start..."
  (cd packages/cli && node dist/index.js start) &
  START_PID=$!
  log "ao start running (PID: $START_PID)"
}

stop_ao() {
  if [[ -n "$START_PID" ]] && kill -0 "$START_PID" 2>/dev/null; then
    log "Stopping ao start (PID: $START_PID)..."
    kill "$START_PID" 2>/dev/null || true
    wait "$START_PID" 2>/dev/null || true
    START_PID=""
    log "ao start stopped"
  fi
}

cleanup() {
  log "Shutting down..."
  stop_ao
  exit 0
}

trap cleanup SIGINT SIGTERM

# Initial build and start
log "Running initial build..."
pnpm build
start_ao

log "Polling for updates every ${POLL_INTERVAL}s on origin/main"

while true; do
  sleep "$POLL_INTERVAL"

  log "Fetching origin/main..."
  git fetch origin main 2>/dev/null || { log "Fetch failed, skipping"; continue; }

  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse origin/main)

  if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
    log "Already up to date"
    continue
  fi

  log "Changes detected (local: ${LOCAL_HEAD:0:8}, remote: ${REMOTE_HEAD:0:8})"
  stop_ao

  log "Merging origin/main (fast-forward only)..."
  if ! git merge --ff-only origin/main; then
    log "Fast-forward merge failed, skipping update"
    start_ao
    continue
  fi

  log "Installing dependencies..."
  pnpm install --frozen-lockfile

  log "Building packages..."
  pnpm build

  start_ao
  log "Update complete"
done
