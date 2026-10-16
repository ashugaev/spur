#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(realpath "$SCRIPT_DIR/../..")
if [[ "$#" -gt 1 || ( "$#" == 1 && "$1" != --check-deps ) ]]; then
  echo "Usage: run-call.sh [--check-deps]" >&2
  exit 1
fi

export TELEGRAM_CALL_STATE_DIR="${TELEGRAM_CALL_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/spur/telegram-call}"
if [[ -n "${SPUR_SESSION_ARTIFACTS_DIR:-}" && \
      ( "$TELEGRAM_CALL_STATE_DIR" == "$SPUR_SESSION_ARTIFACTS_DIR" || \
        "$TELEGRAM_CALL_STATE_DIR" == "$SPUR_SESSION_ARTIFACTS_DIR/"* ) ]]; then
  echo "TELEGRAM_CALL_STATE_DIR must be outside served artifacts" >&2
  exit 1
fi
mkdir -p "$TELEGRAM_CALL_STATE_DIR"
chmod 700 "$TELEGRAM_CALL_STATE_DIR"
if [[ -z "${TELEGRAM_CALL_ENV_FILE:-}" && -f "$TELEGRAM_CALL_STATE_DIR/call.env" ]]; then
  export TELEGRAM_CALL_ENV_FILE="$TELEGRAM_CALL_STATE_DIR/call.env"
fi

if [[ -n "${TELEGRAM_CALL_PYTHON:-}" ]]; then
  PYTHON_BIN="$TELEGRAM_CALL_PYTHON"
else
  PYTHON_BIN="$TELEGRAM_CALL_STATE_DIR/venv/bin/python"
  if [[ ! -x "$PYTHON_BIN" ]]; then
    python3 -m venv "$TELEGRAM_CALL_STATE_DIR/venv"
    "$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$SCRIPT_DIR/requirements.txt"
  fi
fi
export TELEGRAM_CALL_ALLOWLIST_FILE="${TELEGRAM_CALL_ALLOWLIST_FILE:-$REPO_ROOT/.env}"
export TELEGRAM_CALL_ENDPOINT_HELPER="$REPO_ROOT/v2/bin/isolated-web-endpoint.mjs"
if [[ "${1:-}" != --check-deps ]]; then
  export TELEGRAM_CALL_RUNTIME_FILE="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}/voice-daemon/isolated-env.sh"
fi
exec "$PYTHON_BIN" "$SCRIPT_DIR/bridge.py" "$@"
