#!/usr/bin/env bash
# install-and-restart.sh — install a specific Spur npm version and restart the
# spur daemon and web services. Invoked detached by the daemon's
# POST /deploy/switch endpoint. Logs are appended to a single log file so the
# operator can inspect them after the daemon has restarted.
#
# Default user scope (SYSTEMCTL unset or explicitly "systemctl --user")
# converges on `spur reinit`: it reinstalls the user systemd units (fixes a
# stale unit file left by an older npm-init.sh) preserving the live web
# port/exposure/Tailscale bind, then restarts and health-checks the services
# — the same path `spur update` uses. This keeps the UI/deploy-switch
# migration path and the CLI update path on one unit-reinstall implementation.
#
# Non-default SYSTEMCTL (e.g. SYSTEMCTL="sudo systemctl" for system-wide
# units) keeps the bare `systemctl restart` fallback below, since
# npm-init.sh only supports user-scope units.
#
# Usage: install-and-restart.sh <version>
# Env overrides:
#   NPM, SYSTEMCTL — substitute commands (used by tests)
#   SPUR_INSTALL_LOG_DIR — override the log directory

set -u

PACKAGE="@shugaev/spur"
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

# node-pty ships a prebuilt linux binary inside the published tarball's
# web/node_modules/node-pty/prebuilds/ (release.yml bundles it there); no
# on-host build is needed. If a prebuild is genuinely unavailable for this
# host, web-server.ts degrades gracefully (UI stays up, /ws terminal
# disabled) — do not gate this restart on building node-pty.
SYSTEMCTL_RAW="${SYSTEMCTL:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"

spur_bin="$("$NPM" config get prefix 2>/dev/null)/bin/spur"
if [ ! -x "$spur_bin" ]; then
  spur_bin="$(command -v spur 2>/dev/null || true)"
fi

if { [ -z "$SYSTEMCTL_RAW" ] || [ "$SYSTEMCTL_RAW" = "systemctl --user" ]; } && [ -n "$spur_bin" ] && [ -x "$spur_bin" ]; then
  "$spur_bin" reinit
  reinit_rc=$?
  echo "$(date -u +%FT%TZ) install-and-restart spur reinit rc=$reinit_rc"
  exit "$reinit_rc"
fi

read -r -a systemctl_cmd <<<"$SYSTEMCTL"
if command -v "${systemctl_cmd[0]}" >/dev/null 2>&1; then
  "${systemctl_cmd[@]}" restart spur-daemon.service spur-web.service
  restart_rc=$?
  echo "$(date -u +%FT%TZ) install-and-restart systemctl restart rc=$restart_rc"
  exit "$restart_rc"
fi

echo "$(date -u +%FT%TZ) install-and-restart systemctl not available, manual restart required"
exit 0
