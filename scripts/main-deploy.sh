#!/usr/bin/env bash
set -euo pipefail

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "main:deploy must run from main" >&2
  exit 1
fi

if [[ -n "$(git status --short)" ]]; then
  echo "main:deploy requires a clean worktree" >&2
  exit 1
fi

git fetch origin main

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"

if [[ "$local_head" == "$remote_head" ]]; then
  echo "Already up to date with origin/main"
  exit 0
fi

git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build
# Safe to restart: the systemd unit uses KillMode=process, so only the
# daemon's node process is stopped. Tmux sessions and agents survive.
# The daemon re-discovers living sessions on startup.
sudo systemctl restart spur-daemon.service spur-web.service
sudo systemctl is-active --quiet spur-daemon.service
sudo systemctl is-active --quiet spur-web.service
echo "main deployed"
