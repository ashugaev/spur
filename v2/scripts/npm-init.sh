#!/usr/bin/env bash
# Install Spur user systemd units and start services after `npm install -g`.
# npm does not register or start systemd services — run once per host:
#   spur init
# or:
#   npm-init.sh [--no-start] [--expose-web] [--web-port <port>]

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NO_START=0
EXPOSE_WEB=0
WEB_PORT=""

usage() {
  sed -n '3,8p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) NO_START=1; shift ;;
    --expose-web) EXPOSE_WEB=1; shift ;;
    --web-port)
      WEB_PORT="${2:-}"
      [[ -n "$WEB_PORT" ]] || {
        echo "npm-init: --web-port requires a value" >&2
        exit 2
      }
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "npm-init: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

die() {
  echo "npm-init: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

require_cmd node
require_cmd npm
require_cmd systemctl
require_cmd loginctl

npm_prefix="$(npm config get prefix)"
if [[ "$npm_prefix" != "$HOME/.local" ]]; then
  die "npm prefix must be ~/.local (got: $npm_prefix). Run: npm config set prefix ~/.local"
fi

for f in deploy/spur-daemon.npm.service deploy/spur-web.npm.service dist/cli.js web/dist-server/web-server.js; do
  [[ -f "$PKG_ROOT/$f" ]] || die "package file missing: $PKG_ROOT/$f (reinstall @shugaev/spur)"
done

if ! systemctl --user status >/dev/null 2>&1; then
  die "user systemd is unavailable (systemctl --user status failed)"
fi

mkdir -p "$UNIT_DIR"
install -m 644 "$PKG_ROOT/deploy/spur-daemon.npm.service" "$UNIT_DIR/spur-daemon.service"
install -m 644 "$PKG_ROOT/deploy/spur-web.npm.service" "$UNIT_DIR/spur-web.service"

if [[ "$EXPOSE_WEB" -eq 1 ]]; then
  sed -i 's/Environment=WEB_HOST=127.0.0.1/Environment=WEB_HOST=0.0.0.0/' "$UNIT_DIR/spur-web.service"
fi

if [[ -n "$WEB_PORT" ]]; then
  if grep -q '^Environment=PORT=' "$UNIT_DIR/spur-web.service"; then
    sed -i "s/^Environment=PORT=.*/Environment=PORT=$WEB_PORT/" "$UNIT_DIR/spur-web.service"
  else
    sed -i "/^\\[Service\\]/a Environment=PORT=$WEB_PORT" "$UNIT_DIR/spur-web.service"
  fi
fi

loginctl enable-linger "$USER" >/dev/null

systemctl --user daemon-reload

if [[ "$NO_START" -eq 0 ]]; then
  systemctl --user enable spur-daemon.service spur-web.service
  systemctl --user stop spur-web.service 2>/dev/null || true
  systemctl --user restart spur-daemon.service
  sleep 2
  systemctl --user start spur-web.service
fi

echo "npm-init: units installed in $UNIT_DIR"
loginctl show-user "$USER" -p Linger

if [[ "$NO_START" -eq 1 ]]; then
  echo "npm-init: skipped start (--no-start). Run:"
  echo "  systemctl --user enable --now spur-daemon.service spur-web.service"
  exit 0
fi

active_daemon=0
active_web=0
systemctl --user is-active --quiet spur-daemon.service && active_daemon=1
systemctl --user is-active --quiet spur-web.service && active_web=1

web_port="$(grep -E '^Environment=PORT=' "$UNIT_DIR/spur-web.service" | tail -1 | cut -d= -f3-)"
[[ -n "$web_port" ]] || web_port=3012

echo "npm-init: spur-daemon active=$active_daemon spur-web active=$active_web"
echo "npm-init: verify:"
echo "  curl -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:4310/sessions"
echo "  curl -fsS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${web_port}/"

if [[ "$active_daemon" -ne 1 || "$active_web" -ne 1 ]]; then
  die "one or more units failed to start — check: journalctl --user -u spur-daemon -u spur-web -n 40 --no-pager"
fi
