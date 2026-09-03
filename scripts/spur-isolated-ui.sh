#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

NVMRC_FILE="$SCRIPT_DIR/../.nvmrc"

# Only valid as an `if` condition: the trailing (( )) returns 1 on a false
# comparison, which `set -e` would treat as a failure anywhere else.
# Deliberately a floor, not exact-major equality: the pin sits on the root
# engines range's unbounded `>=` clause, so every major at or above it also
# satisfies engines (see the isolated-ui-node-pin.test.ts pin/engines tests).
node_major_at_least() {
  local want="$1"
  local version
  local major

  version="$(node -v 2>/dev/null || true)"
  major="${version#v}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major >= want ))
}

# The pane runs under a non-interactive login shell (env -u ... sh -lc, see
# buildCommandSessionShellCommand in v2/src/runtime-tmux.ts), which sources no
# nvm, so the sidecar otherwise lands on the system node — outside the root
# engines range, where next/font throws under tsx and every request 500s.
# docs/commands.md already makes nvm activation the sidecar command's own
# duty; this is that activation, pinned by .nvmrc. Runs before the node-pty
# probe and `pnpm install` below so one node both builds and runs the tree.
use_pinned_node() {
  local pinned
  local nvm_dir

  if [[ ! -f "$NVMRC_FILE" ]]; then
    echo "spur-isolated-ui: missing node version pin: $NVMRC_FILE" >&2
    exit 1
  fi
  pinned="$(tr -d '[:space:]' < "$NVMRC_FILE")"
  if [[ ! "$pinned" =~ ^[0-9]+$ ]]; then
    echo "spur-isolated-ui: $NVMRC_FILE must hold a bare node major, found: '$pinned'" >&2
    exit 1
  fi

  if node_major_at_least "$pinned"; then
    return 0
  fi

  nvm_dir="${NVM_DIR:-${SPUR_REAL_HOME:-$HOME}/.nvm}"
  if [[ -s "$nvm_dir/nvm.sh" ]]; then
    export NVM_DIR="$nvm_dir"
    # nvm reports its own refusals on stderr and `nvm use --silent` is mute on
    # both streams even when the version is missing (exit 3), so tolerate both
    # statuses here and let the single check below own the diagnostic.
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh" || true
    nvm use --silent "$pinned" || true
  fi

  if node_major_at_least "$pinned"; then
    return 0
  fi

  echo "spur-isolated-ui: node $(node -v 2>/dev/null || echo 'not found') does not satisfy the $NVMRC_FILE pin (node $pinned). Install it with: nvm install $pinned. If node $pinned is already installed, nvm refused to load — check NPM_CONFIG_PREFIX/PREFIX in this shell." >&2
  exit 1
}

use_pinned_node

TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"
UI_PORT_START=${SPUR_SIDECAR_UI_PORT_START:-5600}
UI_PORT_END=${SPUR_SIDECAR_UI_PORT_END:-5699}
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

cleanup() {
  restore_next_type_files
  rm -f "$NEXT_ENV_BACKUP" "$TSCONFIG_BACKUP"
  if [[ -n "$WEB_PID" ]]; then
    kill -TERM "-$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM HUP

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
  NEXT_DIST_DIR=".next-sidecars/${SPUR_SIDECAR_NAME:-isolated-ui}" \
  WATCHPACK_POLLING=true \
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
