#!/usr/bin/env bash
# install-and-restart.sh — switch the active Spur version atomically.
# Invoked detached by the daemon's POST /deploy/switch endpoint.
#
# Layout: each version installs into its own npm prefix under
# <data-dir>/versions/<version>/; <data-dir>/current is a symlink to the
# active package dir. Systemd units exec through the symlink, so a switch is:
# install new prefix (old version keeps serving) -> backup state -> atomic
# symlink flip -> restart units -> healthcheck /info -> on failure flip back
# and restart the previous version.
#
# Progress is recorded in <data-dir>/deploy/switch-state.json so the daemon
# can report the real outcome (done | rolled_back | failed) to the UI.
#
# Usage: install-and-restart.sh <version>
# Env (daemon sets the SPUR_* ones at spawn; defaults cover manual runs):
#   SPUR_DATA_DIR         data dir (default ~/.spur)
#   SPUR_DAEMON_URL       healthcheck base URL (default http://127.0.0.1:4310)
#   SPUR_CURRENT_VERSION  running version (default: derived from current symlink)
#   SPUR_INSTALL_LOG_DIR  log dir (default ~/.spur/logs)
#   SPUR_HEALTH_ATTEMPTS / SPUR_HEALTH_INTERVAL  healthcheck poll tuning
#   NPM, SYSTEMCTL, CURL  command substitutes (used by tests)
# Exit codes: 0 done, 2 invalid version, 3 lock held, 4 install failed,
#   5 rolled back after failed healthcheck, 6 failed without rollback.

set -u

PACKAGE="@shugaev/spur"
VERSION="${1:-}"

DATA_DIR="${SPUR_DATA_DIR:-$HOME/.spur}"
VERSIONS_DIR="$DATA_DIR/versions"
CURRENT_LINK="$DATA_DIR/current"
DEPLOY_DIR="$DATA_DIR/deploy"
STATE_FILE="$DEPLOY_DIR/switch-state.json"
DAEMON_URL="${SPUR_DAEMON_URL:-http://127.0.0.1:4310}"
LOG_DIR="${SPUR_INSTALL_LOG_DIR:-$HOME/.spur/logs}"
LOG_FILE="$LOG_DIR/install-and-restart.log"
NPM="${NPM:-npm}"
SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"
CURL="${CURL:-curl}"
HEALTH_ATTEMPTS="${SPUR_HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${SPUR_HEALTH_INTERVAL:-2}"

# Rotate the log before redirecting into it (truncate above 1 MB).
mkdir -p "$LOG_DIR"
if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE")" -gt 1048576 ]; then
  : >"$LOG_FILE"
fi
exec >>"$LOG_FILE" 2>&1

log() {
  echo "$(date -u +%FT%TZ) install-and-restart $*"
}

# Mirrors RELEASE version regex in v2/src/releases-cache.ts and
# packages/web/src/lib/semver.ts — keep in sync.
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-alpha\.[0-9]+)?$ ]]; then
  log "invalid version: $VERSION"
  exit 2
fi

FROM="${SPUR_CURRENT_VERSION:-}"
if [ -z "$FROM" ]; then
  FROM="$(readlink "$CURRENT_LINK" 2>/dev/null | sed -n 's|.*/versions/\([^/]*\)/.*|\1|p')"
  FROM="${FROM:-unknown}"
fi

mkdir -p "$DEPLOY_DIR" "$VERSIONS_DIR"

# Mutual exclusion between concurrent switches. flock releases the lock when
# the process dies, so a crashed run can never wedge switching.
exec 9>"$DEPLOY_DIR/switch.lock"
if ! flock -n 9; then
  log "switch already in progress, lock held"
  exit 3
fi

STARTED_AT="$(date -u +%FT%TZ)"

# write_state <phase> [error]. Values are fixed strings plus regex-validated
# versions, so printf-composed JSON is safe.
write_state() {
  local phase="$1"
  local error="${2:-}"
  local finished=""
  case "$phase" in
    done | rolled_back | failed) finished="$(date -u +%FT%TZ)" ;;
  esac
  {
    printf '{'
    printf '"phase":"%s","from":"%s","to":"%s","startedAt":"%s"' \
      "$phase" "$FROM" "$VERSION" "$STARTED_AT"
    [ -n "$finished" ] && printf ',"finishedAt":"%s"' "$finished"
    [ -n "$error" ] && printf ',"error":"%s"' "$error"
    printf ',"pid":%d}' "$$"
  } >"$STATE_FILE.tmp.$$"
  mv "$STATE_FILE.tmp.$$" "$STATE_FILE"
}

log "switch $FROM -> $VERSION"
write_state installing

# Install into a per-version prefix; the running version keeps serving.
"$NPM" install -g --prefix "$VERSIONS_DIR/$VERSION" "$PACKAGE@$VERSION"
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
  log "npm install failed rc=$install_rc"
  write_state failed "npm install failed rc=$install_rc"
  exit 4
fi
PKG_DIR="$VERSIONS_DIR/$VERSION/lib/node_modules/$PACKAGE"
if [ ! -f "$PKG_DIR/dist/cli.js" ]; then
  log "install missing dist/cli.js"
  write_state failed "install missing dist/cli.js"
  exit 4
fi

# Backup root-level state (never sessions/) before the flip so a downgrade
# has something to restore from. Restore is manual: copy back, restart.
OLD_TARGET="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
BACKUP_DIR="$DEPLOY_DIR/backup-$FROM"
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
cp "$DATA_DIR/config.yaml" "$BACKUP_DIR/" 2>/dev/null || true
find "$DATA_DIR" -maxdepth 1 -type f -name '*.json' -exec cp {} "$BACKUP_DIR/" \;

# flip_link <target>: atomic replace of the current symlink (rename(2)).
flip_link() {
  ln -s "$1" "$CURRENT_LINK.new.$$" && mv -T "$CURRENT_LINK.new.$$" "$CURRENT_LINK"
}

if ! flip_link "$PKG_DIR"; then
  log "symlink flip failed"
  write_state failed "symlink flip failed"
  exit 6
fi

write_state restarting

read -r -a systemctl_cmd <<<"$SYSTEMCTL"
restart_services() {
  "${systemctl_cmd[@]}" restart spur-daemon.service spur-web.service
}

if ! command -v "${systemctl_cmd[0]}" >/dev/null 2>&1; then
  log "systemctl not available, manual restart required"
  # Symlink already points at the new version; the next manual start runs it.
  write_state done
  exit 0
fi

restart_services
restart_rc=$?
log "systemctl restart rc=$restart_rc"

# Healthcheck: the switch only counts when /info reports the target version.
healthy=""
attempt=0
while [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  sleep "$HEALTH_INTERVAL"
  body="$("$CURL" -fsS --max-time 2 "$DAEMON_URL/info" 2>/dev/null)" || continue
  # The daemon pretty-prints JSON; tolerate optional whitespace after the colon.
  got="$(printf '%s' "$body" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)"
  if [ "$got" = "$VERSION" ]; then
    healthy=1
    break
  fi
done

if [ -n "$healthy" ]; then
  write_state done
  log "healthy on $VERSION"
  # GC: keep the newest 3 version dirs (by mtime — sort -V misorders alpha
  # tags), never the target or the previous version.
  for dir in $(ls -1t "$VERSIONS_DIR" | tail -n +4); do
    [ "$dir" = "$VERSION" ] && continue
    [ "$dir" = "$FROM" ] && continue
    rm -rf "${VERSIONS_DIR:?}/$dir"
    log "gc removed $dir"
  done
  exit 0
fi

health_error="healthcheck timeout after $((HEALTH_ATTEMPTS * HEALTH_INTERVAL))s"
log "$health_error"

if [ -z "$OLD_TARGET" ] || [ ! -e "$OLD_TARGET" ]; then
  write_state failed "$health_error; no previous version to roll back to"
  exit 6
fi

if ! flip_link "$OLD_TARGET"; then
  log "rollback symlink flip failed"
  write_state failed "rollback symlink flip failed"
  exit 6
fi
restart_services
rollback_rc=$?
if [ "$rollback_rc" -ne 0 ]; then
  log "rollback restart failed rc=$rollback_rc"
  write_state failed "rollback restart failed rc=$rollback_rc"
  exit 6
fi
write_state rolled_back "$health_error"
log "rolled back to $FROM"
exit 5
