#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_root="${MAIN_DEPLOY_ROOT:-$HOME/.spur/main-deploy/repo}"
deployed_sha_file="${MAIN_DEPLOY_STAMP_FILE:-$deploy_root/.git/main-deploy-last-successful}"
service_user="${MAIN_DEPLOY_SERVICE_USER:-$(id -un)}"
service_home="${MAIN_DEPLOY_SERVICE_HOME:-$HOME}"

ensure_deploy_clone() {
  if git -C "$deploy_root" rev-parse --git-dir >/dev/null 2>&1; then
    return
  fi

  local source_repo origin_url
  source_repo="$(cd "$script_dir/.." && pwd)"
  origin_url="$(git -C "$source_repo" remote get-url origin)"
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
  # `|| true` keeps a clean box (nothing on :4310) from tripping `set -o
  # pipefail`: `grep` returns 1 when there is no match, which propagates
  # through the pipeline and would otherwise abort the script.
  pid=$(sudo ss -tlnpH "sport = :$port" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | head -n1 | cut -d= -f2) || true
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

# Install deploy/*.service with deploy root and service account placeholders.
# Secrets stay in /etc/spur/daemon.env via EnvironmentFile=. Refuse install if missing.
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

    # Fail fast on unsubstituted placeholders. Writing a unit with literal
    # `{{...}}` would put systemd into a status=217/USER restart loop.
    if printf '%s' "$content" | grep -qF '{{'; then
      echo "main:deploy refusing to install $name: unsubstituted placeholders" >&2
      printf '%s\n' "$content" | grep -nF '{{' >&2
      exit 1
    fi

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
# Reset deploy_root to origin/main before anything else, including the re-exec
# below. Guarantees the script we run from there matches origin/main.
git -C "$deploy_root" checkout -B main origin/main
git -C "$deploy_root" reset --hard "$remote_head"
git -C "$deploy_root" clean -fd

# Re-exec from deploy_root so substitution logic and template format stay
# locked together. Without this, an old caller script can write half-substituted
# unit files and put systemd into a status=217/USER restart loop.
deploy_script="$deploy_root/scripts/main-deploy.sh"
if [[ "${MAIN_DEPLOY_REEXECED:-0}" != "1" && "$(realpath "${BASH_SOURCE[0]}")" != "$(realpath "$deploy_script")" ]]; then
  echo "main:deploy re-executing from $deploy_script"
  exec env \
    MAIN_DEPLOY_ROOT="$deploy_root" \
    MAIN_DEPLOY_STAMP_FILE="$deployed_sha_file" \
    MAIN_DEPLOY_SERVICE_USER="$service_user" \
    MAIN_DEPLOY_SERVICE_HOME="$service_home" \
    MAIN_DEPLOY_REEXECED=1 \
    bash "$deploy_script" "$@"
fi

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
