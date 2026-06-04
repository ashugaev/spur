#!/usr/bin/env bash
# Smoke test for scripts/install-and-restart.sh. Runs the helper with NPM=echo
# and SYSTEMCTL=echo so it cannot mutate the host, then asserts the log output.
#
# Run directly: bash v2/test/install-and-restart.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/../scripts/install-and-restart.sh"
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

LOG_FILE="$LOG_DIR/install-and-restart.log"

run_helper() {
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo SYSTEMCTL=echo bash "$HELPER" "$@"
}

# Case 1: valid version writes the expected install and restart lines.
rm -f "$LOG_FILE"
if ! run_helper 1.2.3; then
  echo "FAIL: helper exited non-zero on valid version" >&2
  exit 1
fi

if ! grep -q "install-and-restart 1.2.3" "$LOG_FILE"; then
  echo "FAIL: log missing install-and-restart 1.2.3 line" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "install -g spur@1.2.3" "$LOG_FILE"; then
  echo "FAIL: log missing npm install argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: log missing systemctl restart argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 2: invalid version exits 2 and logs the rejection.
rm -f "$LOG_FILE"
set +e
run_helper bogus
rc=$?
set -e
if [ "$rc" -ne 2 ]; then
  echo "FAIL: expected exit 2 for invalid version, got $rc" >&2
  exit 1
fi
if ! grep -q "invalid version: bogus" "$LOG_FILE"; then
  echo "FAIL: log missing invalid-version rejection" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 3: missing systemctl falls back to manual-restart hint.
rm -f "$LOG_FILE"
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo SYSTEMCTL=/nonexistent/spur-test-systemctl \
  bash "$HELPER" 1.2.3
if ! grep -q "systemctl not available, manual restart required" "$LOG_FILE"; then
  echo "FAIL: log missing manual-restart hint" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "install-and-restart.test.sh: OK"
