#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"
ensure_node_ready

RUNTIME_FILE="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}/isolated-env.sh"
if [[ -e "$RUNTIME_FILE" || -L "$RUNTIME_FILE" ]]; then
  echo "Stop the existing isolated stand before starting isolated" >&2
  exit 1
fi

DAEMON_PID=""
UI_PID=""
cleanup() {
  trap - EXIT
  for pid in "$UI_PID" "$DAEMON_PID"; do
    [[ -z "$pid" ]] || kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "$UI_PID" "$DAEMON_PID"; do
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

setsid bash "$SCRIPT_DIR/spur-isolated-daemon.sh" &
DAEMON_PID=$!
if ! wait_for_isolated_daemon 180 "$DAEMON_PID"; then
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    wait "$DAEMON_PID"
  fi
  exit 1
fi

setsid bash "$SCRIPT_DIR/spur-isolated-ui.sh" &
UI_PID=$!
wait -n "$DAEMON_PID" "$UI_PID"
