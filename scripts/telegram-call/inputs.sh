#!/usr/bin/env bash

# Shared private-input paths; credentials are parsed only by bridge.py.
export TELEGRAM_CALL_STATE_DIR="${TELEGRAM_CALL_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/spur/telegram-call}"
if [[ -n "${SPUR_SESSION_ARTIFACTS_DIR:-}" && \
      ( "$TELEGRAM_CALL_STATE_DIR" == "$SPUR_SESSION_ARTIFACTS_DIR" || \
        "$TELEGRAM_CALL_STATE_DIR" == "$SPUR_SESSION_ARTIFACTS_DIR/"* ) ]]; then
  echo "TELEGRAM_CALL_STATE_DIR must be outside served artifacts" >&2
  exit 1
fi
if [[ -z "${TELEGRAM_CALL_ENV_FILE:-}" && -f "$TELEGRAM_CALL_STATE_DIR/call.env" ]]; then
  export TELEGRAM_CALL_ENV_FILE="$TELEGRAM_CALL_STATE_DIR/call.env"
fi
export TELEGRAM_CALL_ALLOWLIST_FILE="${TELEGRAM_CALL_ALLOWLIST_FILE:-$REPO_ROOT/.env}"

check_voice_inputs() {
  local python="${TELEGRAM_CALL_PYTHON:-$TELEGRAM_CALL_STATE_DIR/venv/bin/python}"
  if [[ -z "${TELEGRAM_CALL_PYTHON:-}" && ! -x "$python" ]]; then
    python=python3
  fi
  "$python" "$SCRIPT_DIR/bridge.py" --check-inputs
}
