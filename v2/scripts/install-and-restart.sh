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

# Derive the npm prefix from where this script (shipped inside the package at
# <prefix>/lib/node_modules/@shugaev/spur/scripts/) already lives, so the install
# lands in the SAME place regardless of npm's configured/default prefix. On prod
# the daemon's npm prefix resolves to /usr (unwritable -> EACCES); pinning the
# derived prefix keeps the update in-place. Empty for a non-install layout
# (repo/dev), where the bare install below is correct.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
INSTALL_PREFIX=""
case "$SCRIPT_DIR" in
  */lib/node_modules/$PACKAGE/scripts)
    INSTALL_PREFIX="${SCRIPT_DIR%/lib/node_modules/$PACKAGE/scripts}"
    ;;
esac

# Pin the npm prefix for this whole run so both the install below and the
# `spur reinit` chain (npm-init.sh requires `npm config get prefix == ~/.local`)
# resolve the existing install location, not the daemon env's default /usr.
if [ -n "$INSTALL_PREFIX" ]; then
  export npm_config_prefix="$INSTALL_PREFIX"
fi

echo "$(date -u +%FT%TZ) install-and-restart $VERSION${INSTALL_PREFIX:+ prefix=$INSTALL_PREFIX}"

NPM="${NPM:-npm}"
npm_install_args=(install -g)
if [ -n "$INSTALL_PREFIX" ]; then
  npm_install_args+=(--prefix "$INSTALL_PREFIX")
fi
npm_install_args+=("$PACKAGE@$VERSION")

PREVIOUS_VERSION=""
if [ -n "$INSTALL_PREFIX" ]; then
  _prev_pkg="$INSTALL_PREFIX/lib/node_modules/$PACKAGE/package.json"
  PREVIOUS_VERSION="$(node -e 'try{console.log(require(process.argv[1]).version)}catch(_){}' "$_prev_pkg" 2>/dev/null || true)"
fi

"$NPM" "${npm_install_args[@]}"
install_rc=$?
if [ "$install_rc" -ne 0 ]; then
  echo "$(date -u +%FT%TZ) install-and-restart npm install failed rc=$install_rc"
  exit "$install_rc"
fi

if [ -n "$INSTALL_PREFIX" ]; then
  PKG_ROOT="$INSTALL_PREFIX/lib/node_modules/$PACKAGE"
  if ! bash "$PKG_ROOT/scripts/verify-package-files.sh" "$PKG_ROOT"; then
    echo "$(date -u +%FT%TZ) install-and-restart package validation failed"
    if [[ "$PREVIOUS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      _rollback_args=(install -g --prefix "$INSTALL_PREFIX" "$PACKAGE@$PREVIOUS_VERSION")
      "$NPM" "${_rollback_args[@]}"
      _rollback_rc=$?
      echo "$(date -u +%FT%TZ) install-and-restart rollback install rc=$_rollback_rc"
    fi
    exit 1
  fi
fi

# node-pty ships a prebuilt linux binary inside the published tarball's
# web/node_modules/node-pty/prebuilds/ (release.yml bundles it there); no
# on-host build is needed. If a prebuild is genuinely unavailable for this
# host, web-server.ts degrades gracefully (UI stays up, /ws terminal
# disabled) — do not gate this restart on building node-pty.
SYSTEMCTL_RAW="${SYSTEMCTL:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"

# Prefer the binary we just installed under the derived prefix; `npm config get
# prefix` yields the wrong /usr on prod and would resolve a stale/absent binary.
if [ -n "$INSTALL_PREFIX" ] && [ -x "$INSTALL_PREFIX/bin/spur" ]; then
  spur_bin="$INSTALL_PREFIX/bin/spur"
else
  spur_bin="$("$NPM" config get prefix 2>/dev/null)/bin/spur"
  if [ ! -x "$spur_bin" ]; then
    spur_bin="$(command -v spur 2>/dev/null || true)"
  fi
fi

if { [ -z "$SYSTEMCTL_RAW" ] || [ "$SYSTEMCTL_RAW" = "systemctl --user" ]; } && [ -n "$spur_bin" ] && [ -x "$spur_bin" ]; then
  "$spur_bin" reinit
  reinit_rc=$?
  echo "$(date -u +%FT%TZ) install-and-restart spur reinit rc=$reinit_rc"
  if [ "$reinit_rc" -ne 0 ] && [ -n "$INSTALL_PREFIX" ] && [[ "$PREVIOUS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    _rollback_args=(install -g --prefix "$INSTALL_PREFIX" "$PACKAGE@$PREVIOUS_VERSION")
    "$NPM" "${_rollback_args[@]}"
    _rollback_rc=$?
    echo "$(date -u +%FT%TZ) install-and-restart rollback install rc=$_rollback_rc"
    "$spur_bin" reinit
    _rollback_reinit_rc=$?
    echo "$(date -u +%FT%TZ) install-and-restart spur reinit rc=$_rollback_reinit_rc"
  fi
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
