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

# Install systemd service files from deploy/templates, filling {{SPUR_ROOT}}
# with the deploy clone path.  Extracts existing secrets from installed units
# so the templates never contain real credentials.
# Sets SERVICES_CHANGED=true when any file was updated.
SERVICES_CHANGED=false

install_service_files() {
  local root="$1"
  local template_dir="$root/deploy"

  # Extract AZURE_OPENAI_API_KEY from the currently-installed daemon unit
  local azure_key=""
  if [[ -f /etc/systemd/system/spur-daemon.service ]]; then
    azure_key=$(sed -n 's/^Environment=AZURE_OPENAI_API_KEY=//p' /etc/systemd/system/spur-daemon.service || true)
  fi

  for template in "$template_dir"/*.service; do
    [[ -f "$template" ]] || continue
    local name
    name=$(basename "$template")
    local target="/etc/systemd/system/$name"
    local content
    content=$(<"$template")
    content="${content//\{\{SPUR_ROOT\}\}/$root}"
    content="${content//\{\{AZURE_OPENAI_API_KEY\}\}/$azure_key}"

    if [[ -f "$target" ]] && diff <(printf '%s\n' "$content") "$target" >/dev/null 2>&1; then
      continue
    fi

    printf '%s\n' "$content" | sudo tee "$target" > /dev/null
    SERVICES_CHANGED=true
  done

  if [[ "$SERVICES_CHANGED" == true ]]; then
    systemctl_cmd daemon-reload
  fi
}

ensure_deploy_clone

git -C "$deploy_root" fetch origin main

remote_head="$(git -C "$deploy_root" rev-parse origin/main)"
deployed_head=""

if [[ -f "$deployed_sha_file" ]]; then
  deployed_head="$(<"$deployed_sha_file")"
fi

if [[ "$deployed_head" == "$remote_head" ]] && services_are_active; then
  # Code is up to date, but service files may be stale (e.g. wrong paths).
  install_service_files "$deploy_root"
  if [[ "$SERVICES_CHANGED" == true ]]; then
    echo "Service files updated — restarting"
    systemctl_cmd restart spur-daemon.service spur-web.service
    services_are_active
  fi
  echo "Already deployed origin/main $remote_head"
  exit 0
fi

git -C "$deploy_root" checkout -B main origin/main
git -C "$deploy_root" reset --hard "$remote_head"
git -C "$deploy_root" clean -fd
pnpm -C "$deploy_root" install --frozen-lockfile
pnpm -C "$deploy_root" build
install_service_files "$deploy_root"
# Safe to restart: the systemd unit uses KillMode=process, so only the
# daemon's node process is stopped. Tmux sessions and agents survive.
# The daemon re-discovers living sessions on startup.
systemctl_cmd restart spur-daemon.service spur-web.service
services_are_active
printf '%s\n' "$remote_head" >"$deployed_sha_file"
echo "main deployed: $remote_head"
