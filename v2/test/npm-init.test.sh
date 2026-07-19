#!/usr/bin/env bash
# Smoke test for scripts/npm-init.sh. Runs the helper against a stub bin dir
# (fake node/npm/systemctl/loginctl) and a fake PKG_ROOT so it cannot mutate
# the host, then asserts it installs only the two npm-path units and never
# references the removed spur-direct-terminal unit or its :14801 port.
#
# Guards F2 (npm-init.sh unbound-variable crash) and the removed-unit
# contract (F4): the required web-file check must be
# web/dist-server/web-server.js, and no spur-direct-terminal / 14801
# reference may appear in output or installed units.
#
# Run directly: bash v2/test/npm-init.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NPM_INIT_SRC="$HERE/../scripts/npm-init.sh"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FAKE_HOME="$WORK_DIR/home"
FAKE_BIN="$WORK_DIR/bin"
PKG_ROOT="$WORK_DIR/pkg"
mkdir -p "$FAKE_HOME" "$FAKE_BIN" "$PKG_ROOT/scripts" "$PKG_ROOT/deploy" "$PKG_ROOT/dist" \
  "$PKG_ROOT/web/dist-server"

cp "$NPM_INIT_SRC" "$PKG_ROOT/scripts/npm-init.sh"
chmod +x "$PKG_ROOT/scripts/npm-init.sh"

# Required package files: empty placeholders are enough for npm-init.sh's
# existence checks.
: >"$PKG_ROOT/deploy/spur-daemon.npm.service"
: >"$PKG_ROOT/deploy/spur-web.npm.service"
: >"$PKG_ROOT/dist/cli.js"
: >"$PKG_ROOT/web/dist-server/web-server.js"

# Fake node: only needs to exist for `require_cmd node`.
cat >"$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# Fake npm: only `npm config get prefix` is used by npm-init.sh.
cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "config" ] && [ "\$2" = "get" ] && [ "\$3" = "prefix" ]; then
  echo "$FAKE_HOME/.local"
  exit 0
fi
exit 0
EOF

# Fake systemctl: accepts --user status/daemon-reload/enable/start/etc.
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# Fake loginctl: accepts enable-linger and show-user.
cat >"$FAKE_BIN/loginctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "show-user" ]; then
  echo "Linger=yes"
fi
exit 0
EOF

chmod +x "$FAKE_BIN/node" "$FAKE_BIN/npm" "$FAKE_BIN/systemctl" "$FAKE_BIN/loginctl"

OUT_FILE="$WORK_DIR/output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start >"$OUT_FILE" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  echo "FAIL: npm-init.sh --no-start exited $rc" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

UNIT_DIR="$FAKE_HOME/.config/systemd/user"

if [ ! -f "$UNIT_DIR/spur-web.service" ]; then
  echo "FAIL: spur-web.service was not installed into $UNIT_DIR" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

if [ ! -f "$UNIT_DIR/spur-daemon.service" ]; then
  echo "FAIL: spur-daemon.service was not installed into $UNIT_DIR" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

if [ -f "$UNIT_DIR/spur-direct-terminal.service" ]; then
  echo "FAIL: spur-direct-terminal.service must not be installed" >&2
  exit 1
fi

if grep -qi "spur-direct-terminal\|14801" "$OUT_FILE"; then
  echo "FAIL: npm-init.sh output references the removed spur-direct-terminal unit or :14801" >&2
  cat "$OUT_FILE" >&2
  exit 1
fi

if grep -qi "spur-direct-terminal\|14801" "$UNIT_DIR"/*.service; then
  echo "FAIL: an installed unit references the removed spur-direct-terminal unit or :14801" >&2
  exit 1
fi

echo "npm-init.test.sh: OK"
