#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_root="${MAIN_DEPLOY_ROOT:-$HOME/.spur/main-deploy/repo}"
deployed_sha_file="${MAIN_DEPLOY_STAMP_FILE:-$deploy_root/.git/main-deploy-last-successful}"
service_user="${MAIN_DEPLOY_SERVICE_USER:-$(id -un)}"
service_home="${MAIN_DEPLOY_SERVICE_HOME:-$HOME}"

# Command seams. Defaults match prod behavior; tests override them with stubs.
CURL="${SPUR_DEPLOY_CURL:-curl}"
SS="${SPUR_DEPLOY_SS:-sudo ss}"
LOCKFILE="${SPUR_DEPLOY_LOCKFILE:-$HOME/.spur/main-deploy.lock}"
web_next_dir="${SPUR_DEPLOY_WEB_NEXT_DIR:-$deploy_root/packages/web/.next}"
daemon_env_file="${MAIN_DEPLOY_DAEMON_ENV_FILE:-/etc/spur/daemon.env}"
systemd_unit_dir="${MAIN_DEPLOY_SYSTEMD_DIR:-/etc/systemd/system}"

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
  # SYSTEMCTL may carry args (e.g. "sudo systemctl"); split on whitespace.
  local cmd=(${SYSTEMCTL:-sudo systemctl})
  "${cmd[@]}" "$@"
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

# Poll for the web terminal actually serving on :3012. Returns 0 when a listener
# exists AND an HTTP request returns 200, within the retry budget.
web_is_serving() {
  local port=3012
  local code
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -n "$($SS -tlnH "sport = :$port" 2>/dev/null)" ]]; then
      code=$($CURL -fsS -o /dev/null -w '%{http_code}' --max-time 3 \
        "http://127.0.0.1:$port/" 2>/dev/null) || code=""
      [[ "$code" == "200" ]] && return 0
    fi
    sleep 1
  done
  return 1
}

# Verify the HTML spur-web is serving references only chunks that still exist on
# disk. `next build` swaps BUILD_ID/chunk hashes under the live `next start`;
# until spur-web restarts onto the fresh .next, served HTML points at deleted
# chunks and the browser shows "Application error" (nginx still returns 200).
# Returns 0 when every referenced /_next/static asset is present (or the HTML
# references none), 1 on the first missing asset.
web_chunks_consistent() {
  local html refs ref
  html=$($CURL -fsS --max-time 3 "http://127.0.0.1:3012/" 2>/dev/null) || return 0
  # `grep` exits 1 with no matches; under `set -e`/pipefail that would abort the
  # script, so `|| true` turns "no refs" into an empty list (treated consistent).
  refs=$(printf '%s' "$html" | grep -oE '/_next/static/[^"'"'"' )]+' | sort -u) || true
  [[ -z "$refs" ]] && return 0
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    if [[ ! -f "$web_next_dir/${ref#/_next/}" ]]; then
      echo "main:deploy spur-web references missing chunk $ref" >&2
      return 1
    fi
  done <<<"$refs"
  return 0
}

# Post-restart verification with self-healing. Restart can leave a unit dead
# (crash on boot) or stopped (spur-web Requires= propagates the daemon's stop
# but not its start). Heal by starting, then hard-fail loudly if still broken.
verify_and_heal() {
  if ! systemctl_cmd is-active --quiet spur-daemon.service; then
    echo "main:deploy spur-daemon inactive after restart — starting" >&2
    systemctl_cmd start spur-daemon.service
    if ! systemctl_cmd is-active --quiet spur-daemon.service; then
      echo "main:deploy FATAL: spur-daemon not active after start" >&2
      exit 1
    fi
  fi

  if ! systemctl_cmd is-active --quiet spur-web.service; then
    echo "main:deploy spur-web inactive after restart — starting" >&2
    # start, NOT restart: Requires= propagates a stop, not a start, so the unit
    # can be cleanly inactive and only needs to be brought up.
    systemctl_cmd start spur-web.service
  fi

  if ! systemctl_cmd is-active --quiet spur-web.service || ! web_is_serving; then
    echo "main:deploy FATAL: spur-web not serving" >&2
    exit 1
  fi

  # spur-web is up, but it may still be serving the pre-build HTML that points at
  # chunks the new .next no longer has. One heal restart reloads it onto the
  # fresh build; if it is still stale after that, fail loudly.
  if ! web_chunks_consistent; then
    echo "main:deploy spur-web serving stale chunks — restarting" >&2
    systemctl_cmd restart spur-web.service
    web_is_serving
    if ! web_chunks_consistent; then
      echo "main:deploy FATAL: spur-web serving stale chunks" >&2
      exit 1
    fi
  fi
}

# Clear any orphan listener, restart both units, then verify/heal. Runs inside
# the deploy lock so two runs can never interleave a stop-after-start.
restart_and_verify() {
  kill_rogue_daemon_on_port
  systemctl_cmd restart spur-daemon.service spur-web.service
  verify_and_heal
}

# Install deploy/*.service with deploy root and service account placeholders.
# Secrets stay in /etc/spur/daemon.env via EnvironmentFile=. Refuse install if missing.
# Sets SERVICES_CHANGED=true when any file was updated.
SERVICES_CHANGED=false

require_daemon_env_file() {
  if [[ ! -f "$daemon_env_file" ]]; then
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
    local target="$systemd_unit_dir/$name"
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

print_cli_install_hint() {
  local sha="$1"
  local cli_path="$deploy_root/v2/dist/cli.js"
  printf '%s\n' \
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" \
    "Spur deployed: $sha" \
    "To use the spur CLI, add to your shell rc ($HOME/.zshrc or $HOME/.bashrc):" \
    "  alias spur=\"node $cli_path\"" \
    "Then: source $HOME/.zshrc" \
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

print_direct_terminal_port_hint() {
  local override=/etc/systemd/system/spur-web.service.d/override.conf
  local unit=/etc/systemd/system/spur-web.service
  local port=443
  if [[ -f "$override" ]]; then
    port=$(grep -E '^Environment=DIRECT_TERMINAL_PUBLIC_PORT=' "$override" \
      | tail -n1 | cut -d= -f3) || true
  elif [[ -f "$unit" ]]; then
    port=$(grep -E '^Environment=DIRECT_TERMINAL_PUBLIC_PORT=' "$unit" \
      | tail -n1 | cut -d= -f3) || true
  fi
  [[ -z "$port" ]] && port=443
  printf '%s\n' \
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" \
    "Web terminal external port: $port (assumes TLS terminator on :443)" \
    "If your nginx is plain-HTTP on a different port, override:" \
    "  sudo mkdir -p /etc/systemd/system/spur-web.service.d" \
    "  printf '[Service]\\nEnvironment=DIRECT_TERMINAL_PUBLIC_PORT=<your-port>\\n' | sudo tee /etc/systemd/system/spur-web.service.d/override.conf" \
    "  sudo systemctl daemon-reload && sudo systemctl restart spur-web.service" \
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Serialize the ENTIRE deploy across overlapping runs: git fetch/reset, build,
# restart, and verify/heal. The git mutation of the one shared deploy_root clone
# is itself a race (two runs collide on .git/index.lock), so the lock must be
# held from before the first git command through the final verify.
#
# Acquired once, only on the direct invocation (MAIN_DEPLOY_REEXECED unset). The
# re-exec below uses `exec`, which does NOT close FD 9 (no CLOEXEC), so the
# re-execed origin/main child inherits the very same open file description and
# keeps the lock held continuously. The child must NOT run `exec 9>` again: that
# would open a new file description and release the parent's lock — hence the
# guard skips re-acquisition when MAIN_DEPLOY_REEXECED=1.
if [[ "${MAIN_DEPLOY_REEXECED:-0}" != "1" ]]; then
  mkdir -p "$(dirname "$LOCKFILE")"
  exec 9>"$LOCKFILE"
  flock -w 600 9 || {
    echo "main:deploy FATAL: could not acquire deploy lock within 600s" >&2
    exit 1
  }
fi

ensure_deploy_clone

git -C "$deploy_root" fetch origin main
remote_head="$(git -C "$deploy_root" rev-parse origin/main)"
# Reset deploy_root to origin/main before anything else, including the re-exec
# below. Guarantees the script we run from there matches origin/main.
git -C "$deploy_root" reset --hard origin/main
git -C "$deploy_root" checkout -B main origin/main
git -C "$deploy_root" reset --hard "$remote_head"
git -C "$deploy_root" clean -fd

# Re-exec from deploy_root so substitution logic and template format stay
# locked together. Without this, an old caller script can write half-substituted
# unit files and put systemd into a status=217/USER restart loop. FD 9 (the held
# deploy lock) is inherited across this exec, so the child stays serialized.
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
    restart_and_verify
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
restart_and_verify
printf '%s\n' "$remote_head" >"$deployed_sha_file"
echo "main deployed: $remote_head"
print_cli_install_hint "$remote_head"
print_direct_terminal_port_hint
