#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"
SLOT_COMMAND="${SPUR_SLOT_COMMAND:?SPUR_SLOT_COMMAND not set}"
PUBLIC_HOST="${SPUR_SIDECAR_PUBLIC_HOST:?SPUR_SIDECAR_PUBLIC_HOST not set}"
PUBLIC_SCHEME="${SPUR_SIDECAR_PUBLIC_SCHEME:-http}"
UI_PORT_START=${SPUR_SIDECAR_UI_PORT_START:-5600}
UI_PORT_END=${SPUR_SIDECAR_UI_PORT_END:-5699}
TERMINAL_PORT_START=${SPUR_SIDECAR_TERMINAL_PORT_START:-15600}
TERMINAL_PORT_END=${SPUR_SIDECAR_TERMINAL_PORT_END:-15699}
WEB_PID=""

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

UI_PORT=$(find_free_port "$UI_PORT_START" "$UI_PORT_END")
TERMINAL_PORT=$(find_free_port "$TERMINAL_PORT_START" "$TERMINAL_PORT_END")
PUBLIC_URL="${PUBLIC_SCHEME}://${PUBLIC_HOST}:${UI_PORT}"

cleanup() {
  "$SLOT_COMMAND" --unlink sidecar-ui >/dev/null 2>&1 || true
  if [[ -n "$WEB_PID" ]]; then
    kill -TERM "-$WEB_PID" >/dev/null 2>&1 || true
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

"$SLOT_COMMAND" --unlink sidecar-ui >/dev/null 2>&1 || true

setsid env \
  PORT="$UI_PORT" \
  WEB_HOST="0.0.0.0" \
  DIRECT_TERMINAL_BIND_PORT="$TERMINAL_PORT" \
  DIRECT_TERMINAL_PORT="$TERMINAL_PORT" \
  SPUR_CONFIG="$SPUR_ISOLATED_CONFIG" \
  SPUR_DAEMON_URL="$SPUR_ISOLATED_DAEMON_URL" \
  SPUR_TMUX_SOCKET_NAME="$SPUR_ISOLATED_TMUX_SOCKET_NAME" \
  pnpm --dir packages/web dev &
WEB_PID=$!

wait_for_http "http://127.0.0.1:$UI_PORT" 180
"$SLOT_COMMAND" --link sidecar-ui="$PUBLIC_URL"

wait "$WEB_PID"
