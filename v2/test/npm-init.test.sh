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
VERIFY_PACKAGE_FILES_SRC="$HERE/../scripts/verify-package-files.sh"
REQUIRED_FILES_LIST="$HERE/../required-package-files.txt"
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
  cp "$VERIFY_PACKAGE_FILES_SRC" "$pkg_root/scripts/verify-package-files.sh"
  cp "$REQUIRED_FILES_LIST" "$pkg_root/required-package-files.txt"
  chmod +x "$pkg_root/scripts/npm-init.sh" "$pkg_root/scripts/verify-package-files.sh"

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
  # Fails loudly on a dropped or misspelled --globalconfig flag instead of
  # silently answering any "config get prefix" argv (H5) — the persisted pin
  # lives in Spur's own \$HOME/.spur/npmrc, not \$HOME/.npmrc, so the gate
  # must pass both flags to agree with the heal.
  case " \$* " in
    *" --userconfig $fake_home/.npmrc "*) ;;
    *) echo "fake npm: missing --userconfig $fake_home/.npmrc (got: \$*)" >&2; exit 1 ;;
  esac
  case " \$* " in
    *" --globalconfig $fake_home/.spur/npmrc "*) ;;
    *) echo "fake npm: missing --globalconfig $fake_home/.spur/npmrc (got: \$*)" >&2; exit 1 ;;
  esac
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

# The installed web unit must not gate boot on building node-pty (the
# ExecStartPre that compiled it from source on first start took the whole
# unit down on hosts without a C/C++ toolchain) — it must still run
# web-server.js directly.
grep -q '^ExecStartPre=' "$UNIT_DIR/spur-web.service" &&
  fail "spur-web.service must not have an ExecStartPre (no on-host node-pty build)"
grep -qi 'node-pty\|npm run install' "$UNIT_DIR/spur-web.service" &&
  fail "spur-web.service must not reference building node-pty on the host"
grep -q '^ExecStart=/usr/bin/node .*web/dist-server/web-server\.js$' "$UNIT_DIR/spur-web.service" ||
  fail "spur-web.service must still run web/dist-server/web-server.js"

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

# --- Scenario 6: a pre-#573 stale spur-direct-terminal.service is removed ---
# Hosts that ran `spur init` before the in-process /ws change carry a
# spur-direct-terminal.service whose ExecStart now points at attach-only code;
# re-running npm-init.sh (e.g. via `spur update`) must stop/disable/remove it
# so it can't crash-loop under Restart=always.

read -r home_kv bin_kv pkg_kv < <(setup_scenario stale-terminal-unit)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
echo "stale pre-#573 unit" >"$UNIT_DIR/spur-direct-terminal.service"

OUT_FILE="$WORK_DIR/stale-terminal-output.log"
set +e
HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --no-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh (stale terminal unit) exited $rc"; }
[ ! -f "$UNIT_DIR/spur-direct-terminal.service" ] ||
  fail "npm-init.sh must remove a pre-existing spur-direct-terminal.service"

echo "npm-init.test.sh: stale-terminal-unit scenario OK"

# --- Scenario 7: restart hands the configured web port from old to new -----

read -r home_kv bin_kv pkg_kv < <(setup_scenario port-handoff)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"
SYSTEMCTL_TRACE="$WORK_DIR/systemctl-trace"
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SYSTEMCTL_TRACE"
if [ "$1" = "is-active" ]; then exit 0; fi
exit 0
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 200
EOF
chmod +x "$FAKE_BIN/systemctl" "$FAKE_BIN/curl"
OUT_FILE="$WORK_DIR/port-handoff-output.log"
SYSTEMCTL_TRACE="$SYSTEMCTL_TRACE" HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --web-port 6200 --no-tailscale >"$OUT_FILE" 2>&1
grep -q '^Environment=PORT=6200$' "$FAKE_HOME/.config/systemd/user/spur-web.service" ||
  fail "configured web port was not preserved in the installed unit"
handoff_trace="$(grep -E '^--user (stop spur-web|restart spur-daemon|start spur-web)' "$SYSTEMCTL_TRACE" | tr '\n' '|')"
[ "$handoff_trace" = "--user stop spur-web.service|--user restart spur-daemon.service|--user start spur-web.service|" ] ||
  fail "web restart did not stop old web before starting the new unit: $handoff_trace"

echo "npm-init.test.sh: port-handoff scenario OK"

# --- Scenario 8: a slow daemon can become ready after the old 10s cutoff ---

read -r home_kv bin_kv pkg_kv < <(setup_scenario slow-readiness)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"
CURL_COUNT="$WORK_DIR/slow-readiness-curl-count"
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "is-active" ]; then exit 0; fi
exit 0
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f "$CURL_COUNT" ]; then count="$(cat "$CURL_COUNT")"; fi
count=$((count + 1))
echo "$count" >"$CURL_COUNT"
if [ "$count" -le 20 ]; then exit 1; fi
echo 200
EOF
cat >"$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl" "$FAKE_BIN/curl" "$FAKE_BIN/sleep"
OUT_FILE="$WORK_DIR/slow-readiness-output.log"
CURL_COUNT="$CURL_COUNT" HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-tailscale >"$OUT_FILE" 2>&1
[ "$(cat "$CURL_COUNT")" -gt 20 ] ||
  fail "npm-init.sh did not wait beyond the old 10-second readiness cutoff"
grep -q 'npm-init: spur-daemon active=1 spur-web active=1' "$OUT_FILE" ||
  fail "npm-init.sh rejected services that became ready within the extended window"

echo "npm-init.test.sh: slow-readiness scenario OK"

echo "npm-init.test.sh: OK"
