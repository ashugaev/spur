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
# Also guards the Tailscale private-access block: a stub `tailscale` command
# resolving a valid tailnet (100.x) IPv4 must widen the installed unit's
# WEB_HOST to `127.0.0.1,<ip>`; an unresolved tailnet (empty/"NoState") or a
# resolved-but-non-100.x address (e.g. 0.0.0.0) must leave it on loopback only
# and print the `sudo tailscale up` hint; `--no-tailscale` must never touch
# WEB_HOST or invoke tailscale/curl at all.
#
# Run directly: bash v2/test/npm-init.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NPM_INIT_SRC="$HERE/../scripts/npm-init.sh"
DEPLOY_WEB_UNIT="$HERE/../deploy/spur-web.npm.service"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Builds a fresh fake PKG_ROOT + fake HOME + fake bin dir under
# "$WORK_DIR/$1", installs the real npm-init.sh and (unless the caller writes
# its own) the real spur-web.npm.service template so WEB_HOST sed edits have
# something to match, and stubs node/npm/systemctl/loginctl. Prints the
# scenario's FAKE_HOME/FAKE_BIN/PKG_ROOT paths as `HOME=... BIN=... PKG=...`
# on stdout for the caller to capture.
setup_scenario() {
  local name="$1"
  local scenario_dir="$WORK_DIR/$name"
  local fake_home="$scenario_dir/home"
  local fake_bin="$scenario_dir/bin"
  local pkg_root="$scenario_dir/pkg"

  mkdir -p "$fake_home" "$fake_bin" "$pkg_root/scripts" "$pkg_root/deploy" "$pkg_root/dist" \
    "$pkg_root/web/dist-server"

  cp "$NPM_INIT_SRC" "$pkg_root/scripts/npm-init.sh"
  chmod +x "$pkg_root/scripts/npm-init.sh"

  : >"$pkg_root/deploy/spur-daemon.npm.service"
  cp "$DEPLOY_WEB_UNIT" "$pkg_root/deploy/spur-web.npm.service"
  : >"$pkg_root/dist/cli.js"
  : >"$pkg_root/web/dist-server/web-server.js"

  cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"$fake_bin/npm" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "config" ] && [ "\$2" = "get" ] && [ "\$3" = "prefix" ]; then
  echo "$fake_home/.local"
  exit 0
fi
exit 0
EOF

  cat >"$fake_bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"$fake_bin/loginctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "show-user" ]; then
  echo "Linger=yes"
fi
exit 0
EOF

  chmod +x "$fake_bin/node" "$fake_bin/npm" "$fake_bin/systemctl" "$fake_bin/loginctl"

  echo "HOME=$fake_home BIN=$fake_bin PKG=$pkg_root"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- Scenario 1: base run (--no-start), unrelated to Tailscale -------------

read -r home_kv bin_kv pkg_kv < <(setup_scenario base)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

# No `tailscale` in this scenario's PATH; --no-tailscale keeps it that way
# without ever needing the command.
OUT_FILE="$WORK_DIR/base-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --no-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start --no-tailscale exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"

[ -f "$UNIT_DIR/spur-web.service" ] || fail "spur-web.service was not installed into $UNIT_DIR"
[ -f "$UNIT_DIR/spur-daemon.service" ] || fail "spur-daemon.service was not installed into $UNIT_DIR"
[ ! -f "$UNIT_DIR/spur-direct-terminal.service" ] || fail "spur-direct-terminal.service must not be installed"

grep -qi "spur-direct-terminal\|14801" "$OUT_FILE" &&
  fail "npm-init.sh output references the removed spur-direct-terminal unit or :14801"
grep -qi "spur-direct-terminal\|14801" "$UNIT_DIR"/*.service &&
  fail "an installed unit references the removed spur-direct-terminal unit or :14801"

grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "--no-tailscale must leave WEB_HOST on loopback only"

echo "npm-init.test.sh: base scenario OK"

# --- Scenario 2: tailscale resolves a valid IPv4 ----------------------------

read -r home_kv bin_kv pkg_kv < <(setup_scenario tailscale-up)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ip" ]; then
  echo "100.64.11.22"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/tailscale"

# curl must not be invoked in this scenario (tailscale is already present) —
# fail loudly if npm-init.sh tries to fetch the install script anyway.
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "unexpected curl invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/curl"

OUT_FILE="$WORK_DIR/tailscale-up-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale up) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1,100\.64\.11\.22$' "$UNIT_DIR/spur-web.service" ||
  fail "tailscale IP was not applied to WEB_HOST (expected 127.0.0.1,100.64.11.22)"
grep -qi "unexpected curl invocation" "$OUT_FILE" &&
  fail "npm-init.sh invoked curl even though tailscale was already installed"

echo "npm-init.test.sh: tailscale-up scenario OK"

# --- Scenario 3: tailscale installed but tailnet not up (empty/NoState) ----

read -r home_kv bin_kv pkg_kv < <(setup_scenario tailscale-down)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ip" ]; then
  echo "NoState"
  exit 1
fi
exit 0
EOF
chmod +x "$FAKE_BIN/tailscale"

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "unexpected curl invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/curl"

OUT_FILE="$WORK_DIR/tailscale-down-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale down) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "an unresolved tailnet must leave WEB_HOST on loopback only"
grep -qi "sudo tailscale up" "$OUT_FILE" ||
  fail "expected the 'sudo tailscale up' hint when the tailnet is not up"
grep -qi "unexpected curl invocation" "$OUT_FILE" &&
  fail "npm-init.sh invoked curl even though tailscale was already installed"

echo "npm-init.test.sh: tailscale-down scenario OK"

# --- Scenario 4: tailscale resolves a non-tailnet (non-100.x) address ------
# A stub returning a wildcard/public-looking value (e.g. 0.0.0.0) must never
# be baked into WEB_HOST; it must be rejected exactly like the tailnet-down
# case, staying on loopback only with the "sudo tailscale up" hint.

read -r home_kv bin_kv pkg_kv < <(setup_scenario tailscale-non-cgnat)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "ip" ]; then
  echo "0.0.0.0"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/tailscale"

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "unexpected curl invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/curl"

OUT_FILE="$WORK_DIR/tailscale-non-cgnat-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale non-cgnat) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "a non-100.x tailscale IP must be rejected, leaving WEB_HOST on loopback only"
grep -qi "sudo tailscale up" "$OUT_FILE" ||
  fail "expected the 'sudo tailscale up' hint when the resolved IP is not a tailnet 100.x address"
grep -qi "unexpected curl invocation" "$OUT_FILE" &&
  fail "npm-init.sh invoked curl even though tailscale was already installed"

echo "npm-init.test.sh: tailscale-non-cgnat scenario OK"

# --- Scenario 5: --no-tailscale never calls tailscale or WEB_HOST edits ----

read -r home_kv bin_kv pkg_kv < <(setup_scenario no-tailscale)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
echo "unexpected tailscale invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/tailscale"

cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "unexpected curl invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/curl"

OUT_FILE="$WORK_DIR/no-tailscale-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --no-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start --no-tailscale exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "--no-tailscale must leave WEB_HOST on loopback only"
grep -qi "unexpected tailscale invocation\|unexpected curl invocation" "$OUT_FILE" &&
  fail "--no-tailscale must never invoke tailscale or curl"

echo "npm-init.test.sh: no-tailscale scenario OK"

echo "npm-init.test.sh: OK"
