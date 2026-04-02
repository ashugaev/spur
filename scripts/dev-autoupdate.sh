#!/usr/bin/env bash
set -euo pipefail

# Web UI dev server with automatic git pull and rebuild every 5 minutes.
# Usage: bash scripts/dev-autoupdate.sh

POLL_INTERVAL=300 # seconds (5 minutes)
DEV_PID=""

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

start_dev_server() {
  log "Starting dev server..."
  (cd packages/web && pnpm dev) &
  DEV_PID=$!
  log "Dev server started (PID: $DEV_PID)"
}

stop_dev_server() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    log "Stopping dev server (PID: $DEV_PID)..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
    DEV_PID=""
    log "Dev server stopped"
  fi
}

cleanup() {
  log "Shutting down..."
  stop_dev_server
  exit 0
}

trap cleanup SIGINT SIGTERM

# Initial build and start
log "Running initial build..."
pnpm build
start_dev_server

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
  stop_dev_server

  log "Merging origin/main (fast-forward only)..."
  if ! git merge --ff-only origin/main; then
    log "Fast-forward merge failed, skipping update"
    start_dev_server
    continue
  fi

  log "Installing dependencies..."
  pnpm install --frozen-lockfile

  log "Building packages..."
  pnpm build

  start_dev_server
  log "Update complete"
done
