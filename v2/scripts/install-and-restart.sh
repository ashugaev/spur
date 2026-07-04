#!/usr/bin/env bash
# install-and-restart.sh — install a specific spur npm version and restart the
# spur daemon and web services. Invoked detached by the daemon's
# POST /deploy/switch endpoint. Logs are appended to a single log file so the
# operator can inspect them after the daemon has restarted.
#
# Usage: install-and-restart.sh <version>
# Env overrides:
#   NPM, SYSTEMCTL — substitute the npm/systemctl binaries (used by tests)
#   SPUR_INSTALL_LOG_DIR — override the log directory

set -u

VERSION="${1:-}"

LOG_DIR="${SPUR_INSTALL_LOG_DIR:-}"
if [ -z "$LOG_DIR" ]; then
  if [ -w "/var/log" ]; then
    LOG_DIR="/var/log/spur"
  else
    LOG_DIR="$HOME/.spur/logs"
  fi
fi
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/install-and-restart.log" 2>&1

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "$(date -u +%FT%TZ) install-and-restart invalid version: $VERSION"
  exit 2
fi

echo "$(date -u +%FT%TZ) install-and-restart $VERSION"

NPM="${NPM:-npm}"
"$NPM" install -g "spur@$VERSION"
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) install-and-restart npm install failed rc=$install_rc"
  exit "$install_rc"
fi

SYSTEMCTL="${SYSTEMCTL:-systemctl}"
if command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  "$SYSTEMCTL" restart spur-daemon.service spur-web.service
  restart_rc=$?
  echo "$(date -u +%FT%TZ) install-and-restart systemctl restart rc=$restart_rc"
else
  echo "$(date -u +%FT%TZ) install-and-restart systemctl not available, manual restart required"
fi

exit 0
