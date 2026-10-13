#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

ensure_node_ready

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

ensure_workspace_deps

ENDPOINT_HELPER="$SCRIPT_DIR/../v2/bin/isolated-web-endpoint.mjs"
RUNTIME_DEADLINE=$((SECONDS + 30))
DAEMON_LIFECYCLE_ID=""
validate_daemon_generation() {
  node "$ENDPOINT_HELPER" --daemon-ready \
    "${SPUR_ISOLATED_CONFIG:-}" "${SPUR_ISOLATED_UI_ENDPOINT_FILE:-}" \
    "${SPUR_ISOLATED_DATA_DIR:-}" "${SPUR_ISOLATED_DAEMON_URL:-}" \
    "${SPUR_ISOLATED_TMUX_SOCKET_NAME:-}" "${SPUR_ISOLATED_DAEMON_PID:-}" \
    "${SPUR_ISOLATED_DAEMON_STARTTIME:-}" "$@"
}
for _ in $(seq 1 30); do
  (( SECONDS < RUNTIME_DEADLINE )) || break
  unset SPUR_ISOLATED_CONFIG SPUR_ISOLATED_UI_ENDPOINT_FILE SPUR_ISOLATED_DATA_DIR \
    SPUR_ISOLATED_DAEMON_URL SPUR_ISOLATED_TMUX_SOCKET_NAME SPUR_ISOLATED_DAEMON_PID \
    SPUR_ISOLATED_DAEMON_STARTTIME SPUR_ISOLATED_PROJECT_CONFIG SPUR_ISOLATED_SOURCE_WORKTREE
  if [[ -f "$RUNTIME_FILE" ]] && RUNTIME_SNAPSHOT="$(<"$RUNTIME_FILE")" 2>/dev/null; then
    # Source this one snapshot; do not re-read after validation.
    # shellcheck source=/dev/null
    if source /dev/stdin <<<"$RUNTIME_SNAPSHOT" 2>/dev/null && DAEMON_LIFECYCLE_ID="$(validate_daemon_generation 2>/dev/null)"; then
      break
    fi
  fi
  (( SECONDS < RUNTIME_DEADLINE )) || break
  sleep 1
done
if [[ -z "$DAEMON_LIFECYCLE_ID" ]]; then
  echo "Timed out waiting for current isolated daemon runtime" >&2
  exit 1
fi

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

setsid env -u npm_config_virtual_store_dir \
  PORT="$UI_PORT" \
  NEXT_DIST_DIR=".next-sidecars/${SPUR_SIDECAR_NAME:-isolated-ui}" \
  WATCHPACK_POLLING=true \
  SPUR_CONFIG="$SPUR_ISOLATED_CONFIG" \
  SPUR_DAEMON_URL="$SPUR_ISOLATED_DAEMON_URL" \
  SPUR_TMUX_SOCKET_NAME="$SPUR_ISOLATED_TMUX_SOCKET_NAME" \
  pnpm --dir packages/web dev &
WEB_PID=$!

wait_for_http "http://127.0.0.1:$UI_PORT" 180
if ! validate_daemon_generation "$DAEMON_LIFECYCLE_ID" >/dev/null; then
  echo "Isolated daemon generation changed during UI startup" >&2
  exit 1
fi
node "$SCRIPT_DIR/../v2/bin/isolated-web-endpoint.mjs" \
  "$SPUR_ISOLATED_CONFIG" "$SPUR_ISOLATED_UI_ENDPOINT_FILE" "$UI_PORT" "$$"
for _ in $(seq 1 5); do
  restore_next_type_files
  sleep 1
done

wait "$WEB_PID"
