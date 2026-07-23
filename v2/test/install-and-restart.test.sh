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
if ! grep -q "install -g @shugaev/spur@1.2.3" "$LOG_FILE"; then
  echo "FAIL: log missing npm install argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: log missing systemctl restart argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
# The prebuilt node-pty binary ships inside the tarball (release.yml); this
# script must never gate the restart on an on-host node-pty build.
if grep -qi "node-pty" "$LOG_FILE"; then
  echo "FAIL: install-and-restart must not attempt an on-host node-pty build" >&2
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

# Case 4: multi-word SYSTEMCTL override (the real default is "systemctl --user")
# splits into command + args.
rm -f "$LOG_FILE"
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo SYSTEMCTL="echo --user" bash "$HELPER" 1.2.3
if ! grep -q -- "--user restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: log missing multi-word systemctl argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 5: a failing restart propagates its exit code instead of masking it.
rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo SYSTEMCTL=false bash "$HELPER" 1.2.3
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: expected non-zero exit when systemctl restart fails" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 6: default user scope (SYSTEMCTL unset) with a resolvable spur binary
# converges on `spur reinit` instead of the bare systemctl restart.
STUB_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR"' EXIT
cat >"$STUB_BIN_DIR/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$STUB_BIN_DIR/spur"

rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo PATH="$STUB_BIN_DIR:$PATH" \
  env -u SYSTEMCTL bash "$HELPER" 1.2.3
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FAIL: expected exit 0 from the stub spur reinit, got $rc" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "spur reinit rc=0" "$LOG_FILE"; then
  echo "FAIL: log missing spur reinit rc=0 line" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: default user scope must not fall through to bare systemctl restart" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 7: a non-default SYSTEMCTL override is an escape hatch that wins even
# when a spur binary is resolvable — bare restart, not reinit.
rm -f "$LOG_FILE"
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo PATH="$STUB_BIN_DIR:$PATH" SYSTEMCTL=echo \
  bash "$HELPER" 1.2.3
if ! grep -q "restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: log missing systemctl restart argv for the SYSTEMCTL escape hatch" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "spur reinit" "$LOG_FILE"; then
  echo "FAIL: SYSTEMCTL override must bypass spur reinit" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 8: when the script runs from a real @shugaev/spur install layout, it
# derives the prefix and pins `npm install -g --prefix <prefix>` so the update
# lands in-place (no relocation to npm's default /usr), and reinit resolves the
# freshly installed binary under that prefix.
PREFIX_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR"' EXIT
PKG_SCRIPTS_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/spur/scripts"
mkdir -p "$PKG_SCRIPTS_DIR" "$PREFIX_DIR/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR/install-and-restart.sh"
cat >"$PREFIX_DIR/bin/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$PREFIX_DIR/bin/spur"

rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=echo \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.3
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "FAIL: expected exit 0 for in-place prefixed install, got $rc" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "install-and-restart 1.2.3 prefix=$PREFIX_DIR" "$LOG_FILE"; then
  echo "FAIL: log missing derived prefix marker" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q -- "install -g --prefix $PREFIX_DIR @shugaev/spur@1.2.3" "$LOG_FILE"; then
  echo "FAIL: log missing prefixed npm install argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "spur reinit rc=0" "$LOG_FILE"; then
  echo "FAIL: log missing spur reinit rc=0 from the prefix-resolved binary" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

echo "install-and-restart.test.sh: OK"
