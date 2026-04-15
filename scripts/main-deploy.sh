#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
deploy_root="${MAIN_DEPLOY_ROOT:-$HOME/.spur/main-deploy/repo}"
deployed_sha_file="${MAIN_DEPLOY_STAMP_FILE:-$deploy_root/.git/main-deploy-last-successful}"
origin_url="$(git -C "$repo_root" remote get-url origin)"

ensure_deploy_clone() {
  if git -C "$deploy_root" rev-parse --git-dir >/dev/null 2>&1; then
    local current_origin
    current_origin="$(git -C "$deploy_root" remote get-url origin)"
    if [[ "$current_origin" != "$origin_url" ]]; then
      echo "main:deploy origin mismatch: expected $origin_url, got $current_origin" >&2
      exit 1
    fi
    return
  fi

  mkdir -p "$(dirname "$deploy_root")"
  git clone --branch main --single-branch "$origin_url" "$deploy_root"
}

systemctl_cmd() {
  sudo systemctl "$@"
}

services_are_active() {
  systemctl_cmd is-active --quiet spur-daemon.service
  systemctl_cmd is-active --quiet spur-web.service
}

ensure_deploy_clone

git -C "$deploy_root" fetch origin main

remote_head="$(git -C "$deploy_root" rev-parse origin/main)"
deployed_head=""

if [[ -f "$deployed_sha_file" ]]; then
  deployed_head="$(<"$deployed_sha_file")"
fi

if [[ "$deployed_head" == "$remote_head" ]] && services_are_active; then
  echo "Already deployed origin/main $remote_head"
  exit 0
fi

git -C "$deploy_root" checkout -B main origin/main
git -C "$deploy_root" reset --hard "$remote_head"
git -C "$deploy_root" clean -fd
pnpm -C "$deploy_root" install --frozen-lockfile
pnpm -C "$deploy_root" build
# Safe to restart: the systemd unit uses KillMode=process, so only the
# daemon's node process is stopped. Tmux sessions and agents survive.
# The daemon re-discovers living sessions on startup.
systemctl_cmd restart spur-daemon.service spur-web.service
services_are_active
printf '%s\n' "$remote_head" >"$deployed_sha_file"
echo "main deployed: $remote_head"
