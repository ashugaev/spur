#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
deploy_root="${MAIN_DEPLOY_ROOT:-$HOME/.spur/main-deploy/repo}"
deployed_sha_file="${MAIN_DEPLOY_STAMP_FILE:-$deploy_root/.git/main-deploy-last-successful}"
service_user="${MAIN_DEPLOY_SERVICE_USER:-$(id -un)}"
service_home="${MAIN_DEPLOY_SERVICE_HOME:-$HOME}"
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

# Kill any process holding 127.0.0.1:4310 that is NOT under spur-daemon.service.
# Such a process is an orphan from a prior run and would block systemd's restart
# with EADDRINUSE, putting spur-daemon.service into a crash loop. Tmux sessions,
# agents, and the isolated dev daemon never bind 4310, so they are unaffected.
kill_rogue_daemon_on_port() {
  local port=4310
  local pid
  pid=$(sudo ss -tlnpH "sport = :$port" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2)
  [[ -z "$pid" ]] && return 0

  local cg
  cg=$(awk -F: '{print $3}' "/proc/$pid/cgroup" 2>/dev/null || true)
  [[ "$cg" == */spur-daemon.service ]] && return 0

  echo "main:deploy killing rogue daemon pid=$pid cgroup=${cg:-unknown} on :$port"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

services_are_active() {
  systemctl_cmd is-active --quiet spur-daemon.service
  systemctl_cmd is-active --quiet spur-web.service
}

# Install systemd service files from deploy/templates, filling {{SPUR_ROOT}}
# with the deploy clone path and service account placeholders from
# MAIN_DEPLOY_SERVICE_USER/MAIN_DEPLOY_SERVICE_HOME, defaulting to the account
# running this script. Secrets are provisioned out-of-band in /etc/spur/daemon.env
# (read via EnvironmentFile= in the unit); this function requires that file to
# exist and refuses to install otherwise.
# Sets SERVICES_CHANGED=true when any file was updated.
SERVICES_CHANGED=false

require_daemon_env_file() {
  if [[ ! -f /etc/spur/daemon.env ]]; then
    cat >&2 <<'EOF'
main:deploy aborting: /etc/spur/daemon.env is missing.

The spur-daemon unit reads its secrets via EnvironmentFile=/etc/spur/daemon.env.
Create it before running this script:

  sudo install -d -m 0755 /etc/spur
  printf 'AZURE_OPENAI_API_KEY=<your-key>\n' | sudo tee /etc/spur/daemon.env >/dev/null
  sudo chown root:root /etc/spur/daemon.env
  sudo chmod 0600 /etc/spur/daemon.env
EOF
    exit 1
  fi
}

install_service_files() {
  local root="$1"
  local template_dir="$root/deploy"

  require_daemon_env_file

  for template in "$template_dir"/*.service; do
    [[ -f "$template" ]] || continue
    local name
    name=$(basename "$template")
    local target="/etc/systemd/system/$name"
    local content
    content=$(<"$template")
    content="${content//\{\{SPUR_ROOT\}\}/$root}"
    content="${content//\{\{SPUR_SERVICE_USER\}\}/$service_user}"
    content="${content//\{\{SPUR_SERVICE_HOME\}\}/$service_home}"

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
    kill_rogue_daemon_on_port
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
# Build with managed-prod autostart disabled so the build-triggered daemon
# restart path cannot fork a rogue listener outside systemd during the
# service restart window.
SPUR_DISABLE_AUTOSTART=1 pnpm -C "$deploy_root" build
install_service_files "$deploy_root"
# Safe to restart: the systemd unit uses KillMode=process, so only the
# daemon's node process is stopped. Tmux sessions and agents survive.
# The daemon re-discovers living sessions on startup.
kill_rogue_daemon_on_port
systemctl_cmd restart spur-daemon.service spur-web.service
services_are_active
printf '%s\n' "$remote_head" >"$deployed_sha_file"
echo "main deployed: $remote_head"
