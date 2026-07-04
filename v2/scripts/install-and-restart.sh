#!/usr/bin/env bash
# install-and-restart.sh — install a specific Spur npm version and restart the
# spur daemon and web services. Invoked detached by the daemon's
# POST /deploy/switch endpoint. Logs are appended to a single log file so the
# operator can inspect them after the daemon has restarted.
#
# Spur ships as user-level systemd units (see docs/install-from-npm.md), so the
# restart goes through `systemctl --user` and needs no root.
#
# Usage: install-and-restart.sh <version>
# Env overrides:
#   NPM, SYSTEMCTL — substitute the npm/systemctl commands (used by tests)
#   SPUR_INSTALL_LOG_DIR — override the log directory

set -u

PACKAGE="@ashugaev/spur"
VERSION="${1:-}"

LOG_DIR="${SPUR_INSTALL_LOG_DIR:-$HOME/.spur/logs}"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/install-and-restart.log" 2>&1

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "$(date -u +%FT%TZ) install-and-restart invalid version: $VERSION"
  exit 2
fi

echo "$(date -u +%FT%TZ) install-and-restart $VERSION"

NPM="${NPM:-npm}"
"$NPM" install -g "$PACKAGE@$VERSION"
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) install-and-restart npm install failed rc=$install_rc"
  exit "$install_rc"
fi

SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"
read -r -a systemctl_cmd <<<"$SYSTEMCTL"
if command -v "${systemctl_cmd[0]}" >/dev/null 2>&1; then
  "${systemctl_cmd[@]}" restart spur-daemon.service spur-web.service
  restart_rc=$?
  echo "$(date -u +%FT%TZ) install-and-restart systemctl restart rc=$restart_rc"
  exit "$restart_rc"
fi

echo "$(date -u +%FT%TZ) install-and-restart systemctl not available, manual restart required"
exit 0
