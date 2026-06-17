#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"
UI_PORT_START=${SPUR_SIDECAR_UI_PORT_START:-5600}
UI_PORT_END=${SPUR_SIDECAR_UI_PORT_END:-5699}
TERMINAL_PORT_START=${SPUR_SIDECAR_TERMINAL_PORT_START:-15600}
TERMINAL_PORT_END=${SPUR_SIDECAR_TERMINAL_PORT_END:-15699}
SIDECAR_CACHE_DIR="packages/web/.next-sidecars/${SPUR_SIDECAR_NAME:-isolated-ui}"
NEXT_ENV_FILE="packages/web/next-env.d.ts"
TSCONFIG_FILE="packages/web/tsconfig.json"
NEXT_ENV_BACKUP="$TOOL_DIR/next-env.d.ts.sidecar.bak"
TSCONFIG_BACKUP="$TOOL_DIR/tsconfig.json.sidecar.bak"
WEB_PID=""
ROOT_NODE_MODULES="node_modules"
WEB_NODE_MODULES="packages/web/node_modules"
V2_NODE_MODULES="v2/node_modules"

workspace_deps_ready() {
  if [[ ! -d "$ROOT_NODE_MODULES" ]] || [[ -L "$ROOT_NODE_MODULES" ]] || [[ ! -d "$ROOT_NODE_MODULES/.pnpm" ]]; then
    return 1
  fi

  (
    cd packages/web
    node <<'INNER'
const fs = require("fs");
const path = require("path");

const nextPackage = require.resolve("next/package.json");
const builtinErrorModule = path.join(
  path.dirname(nextPackage),
  "dist/server/route-modules/pages/builtin/_error.js",
);

if (!fs.existsSync(builtinErrorModule)) {
  process.exit(1);
}

try {
  require("node-pty");
} catch {
  process.exit(1);
}
INNER
  )
}

ensure_workspace_deps() {
  if workspace_deps_ready; then
    return 0
  fi

  rm -rf "$ROOT_NODE_MODULES" "$WEB_NODE_MODULES" "$V2_NODE_MODULES"
  env -u npm_config_virtual_store_dir HUSKY=0 pnpm install --frozen-lockfile
}

for _ in $(seq 1 30); do
  if [[ -f "$RUNTIME_FILE" ]]; then
    break
  fi
  sleep 1
done

if [[ ! -f "$RUNTIME_FILE" ]]; then
  echo "Missing isolated runtime file: $RUNTIME_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$RUNTIME_FILE"

UI_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_UI" "$UI_PORT_START" "$UI_PORT_END")
TERMINAL_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_TERMINAL" "$TERMINAL_PORT_START" "$TERMINAL_PORT_END")

cleanup() {
  restore_next_type_files
  rm -f "$NEXT_ENV_BACKUP" "$TSCONFIG_BACKUP"
  if [[ -n "$WEB_PID" ]]; then
    kill -TERM "-$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

restore_next_type_files() {
  if [[ -f "$NEXT_ENV_BACKUP" ]]; then
    cp "$NEXT_ENV_BACKUP" "$NEXT_ENV_FILE"
  fi
  if [[ -f "$TSCONFIG_BACKUP" ]]; then
    cp "$TSCONFIG_BACKUP" "$TSCONFIG_FILE"
  fi
}

rm -rf "$SIDECAR_CACHE_DIR"
cp "$NEXT_ENV_FILE" "$NEXT_ENV_BACKUP"
cp "$TSCONFIG_FILE" "$TSCONFIG_BACKUP"
ensure_workspace_deps

setsid env -u npm_config_virtual_store_dir \
  PORT="$UI_PORT" \
  WEB_HOST="0.0.0.0" \
  DIRECT_TERMINAL_BIND_HOST="0.0.0.0" \
  DIRECT_TERMINAL_BIND_PORT="$TERMINAL_PORT" \
  DIRECT_TERMINAL_PORT="$TERMINAL_PORT" \
  NEXT_DIST_DIR=".next-sidecars/${SPUR_SIDECAR_NAME:-isolated-ui}" \
  SPUR_CONFIG="$SPUR_ISOLATED_CONFIG" \
  SPUR_DAEMON_URL="$SPUR_ISOLATED_DAEMON_URL" \
  SPUR_TMUX_SOCKET_NAME="$SPUR_ISOLATED_TMUX_SOCKET_NAME" \
  pnpm --dir packages/web dev &
WEB_PID=$!

wait_for_http "http://127.0.0.1:$UI_PORT" 180
for _ in $(seq 1 5); do
  restore_next_type_files
  sleep 1
done

wait "$WEB_PID"
