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

# The script derives its unit dir from XDG_CONFIG_HOME, falling back to
# $HOME/.config. An inherited value would write units outside the fixture HOME,
# so drop every XDG base-dir variable; scenarios then resolve under their HOME.
unset XDG_CONFIG_HOME XDG_RUNTIME_DIR XDG_DATA_HOME

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
    "$pkg_root/web/dist-server" "$pkg_root/skills/spur"

  cp "$NPM_INIT_SRC" "$pkg_root/scripts/npm-init.sh"
  cp "$VERIFY_PACKAGE_FILES_SRC" "$pkg_root/scripts/verify-package-files.sh"
  cp "$REQUIRED_FILES_LIST" "$pkg_root/required-package-files.txt"
  chmod +x "$pkg_root/scripts/npm-init.sh" "$pkg_root/scripts/verify-package-files.sh"

  : >"$pkg_root/deploy/spur-daemon.npm.service"
  cp "$DEPLOY_WEB_UNIT" "$pkg_root/deploy/spur-web.npm.service"
  cp "$HERE/../deploy/spur-mcp.npm.service" "$pkg_root/deploy/spur-mcp.npm.service"
  cp "$HERE/../deploy/spur-mcp-tunnel.npm.service" "$pkg_root/deploy/spur-mcp-tunnel.npm.service"
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    # Presence-only placeholders; this test never executes the companion.
    case "$entry" in
      dist/*|bin/auth-proxy/*|licenses/auth-proxy/*)
        mkdir -p "$(dirname "$pkg_root/$entry")"
        : >"$pkg_root/$entry"
        ;;
    esac
  done <"$REQUIRED_FILES_LIST"
  : >"$pkg_root/web/dist-server/web-server.js"
  : >"$pkg_root/spur.yaml.reference"
  : >"$pkg_root/skills/spur/SKILL.md"

  cat >"$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 6 ] && [ "${1:-}" = "--input-type=module" ]; then printf '%s' "$HOME/.spur/config.yaml"; fi
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

  # Logs every call to <scenario>/loginctl.log. LINGER_STATE, SHOW_RC and
  # ENABLE_RC (set per run) steer show-user output/exit and enable-linger exit.
  cat >"$fake_bin/loginctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../loginctl.log"
case "$1" in
  show-user)
    [ "${SHOW_RC:-0}" -eq 0 ] || exit "$SHOW_RC"
    echo "${LINGER_STATE:-Linger=yes}"
    ;;
  --no-ask-password)
    [ "$2" != "enable-linger" ] || exit "${ENABLE_RC:-0}"
    ;;
  enable-linger)
    exit "${ENABLE_RC:-0}"
    ;;
esac
exit 0
EOF

  # The script itself never calls sudo; any call is logged so scenarios can
  # assert the log never appears.
  cat >"$fake_bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../sudo.log"
exit 0
EOF

  chmod +x "$fake_bin/node" "$fake_bin/npm" "$fake_bin/systemctl" "$fake_bin/loginctl" "$fake_bin/sudo"

  echo "HOME=$fake_home BIN=$fake_bin PKG=$pkg_root"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Symlinks the real tools npm-init.sh and verify-package-files.sh call into
# the fake bin so a scenario can run with PATH = fake bin only. This keeps the
# host's real tailscale, curl and sudo unreachable.
link_real_tools() {
  local fake_bin="$1" tool real
  for tool in bash sh id dirname sed grep install mkdir rm head tr cut tail seq cat chmod sleep journalctl; do
    real="$(command -v "$tool" || true)"
    case "$real" in
      /*) ln -sf "$real" "$fake_bin/$tool" ;;
    esac
  done
}

# Logging stub for a command that must never be called. Writes its argv to
# <scenario>/<name>.log next to the bin dir and fails.
write_logging_stub() {
  local fake_bin="$1" name="$2"
  cat >"$fake_bin/$name" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"\$(dirname "\$0")/../$name.log"
exit 1
EOF
  chmod +x "$fake_bin/$name"
}

assert_no_log() {
  local fake_bin="$1" name="$2"
  [ ! -e "$fake_bin/../$name.log" ] || fail "$name was called: $(cat "$fake_bin/../$name.log")"
}

assert_out() {
  local file="$1" text="$2"
  grep -qF -- "$text" "$file" || { cat "$file" >&2; fail "expected output line: $text"; }
}

refute_out() {
  local file="$1" text="$2"
  ! grep -qF -- "$text" "$file" || { cat "$file" >&2; fail "unexpected output line: $text"; }
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
LINGER_STATE="Linger=no" HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --no-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start --no-tailscale exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"

# Plan lines print before the summary, and the summary labels keep their order.
assert_out "$OUT_FILE" "npm-init: plan (units, linger, services, Tailscale):"
assert_out "$OUT_FILE" "npm-init:   install user units spur-daemon, spur-web, spur-mcp, spur-mcp-tunnel in $UNIT_DIR"
assert_out "$OUT_FILE" "npm-init:   enable linger for $(id -un) if allowed (best effort, no sudo): services keep running after logout and start at boot"
assert_out "$OUT_FILE" "npm-init:   leave services stopped (--no-start)"
assert_out "$OUT_FILE" "npm-init:   agent integrations: skill links, Cursor hook"
assert_out "$OUT_FILE" "npm-init:   Tailscale: skipped; web UI is on 127.0.0.1 (pass --tailscale for private remote access)"
assert_out "$OUT_FILE" "npm-init:   units installed: spur-daemon spur-web spur-mcp spur-mcp-tunnel in $UNIT_DIR"
assert_out "$OUT_FILE" "npm-init:   started: none (--no-start)"
assert_out "$OUT_FILE" "npm-init:   linger: enabled"
assert_out "$OUT_FILE" "npm-init:   web UI: 127.0.0.1:5555"
assert_out "$OUT_FILE" "npm-init:   Tailscale: not requested"
plan_line="$(grep -n '^npm-init: plan' "$OUT_FILE" | head -1 | cut -d: -f1)"
summary_line="$(grep -n '^npm-init: summary:' "$OUT_FILE" | head -1 | cut -d: -f1)"
[ "$plan_line" -lt "$summary_line" ] || fail "plan must print before the summary"
label_order="$(grep -n '^npm-init:   \(units installed\|started\|linger\|web UI\|Tailscale\):' "$OUT_FILE" |
  sed -n '/units installed:/,$p' | cut -d: -f3 | tr '\n' '|')"
[ "$label_order" = "   units installed|   started|   linger|   web UI|   Tailscale|" ] ||
  fail "summary labels out of order: $label_order"
grep -q -- '--no-ask-password enable-linger' "$FAKE_BIN/../loginctl.log" ||
  fail "linger must be enabled with --no-ask-password"
assert_no_log "$FAKE_BIN" sudo

[ -f "$UNIT_DIR/spur-web.service" ] || fail "spur-web.service was not installed into $UNIT_DIR"
[ -f "$UNIT_DIR/spur-daemon.service" ] || fail "spur-daemon.service was not installed into $UNIT_DIR"
[ -f "$UNIT_DIR/spur-mcp.service" ] || fail "spur-mcp.service was not installed"
[ -f "$UNIT_DIR/spur-mcp-tunnel.service" ] || fail "spur-mcp-tunnel.service template was not installed"
grep -q '^Restart=always$' "$UNIT_DIR/spur-mcp.service" || fail "MCP must restart after crashes"
grep -q '^WantedBy=default.target$' "$UNIT_DIR/spur-mcp.service" || fail "MCP must start at boot"
if grep -Eq '^(Requires|BindsTo|EnvironmentFile)=' "$UNIT_DIR/spur-mcp.service"; then
  fail "generic MCP must survive daemon stop and must not inherit tunnel secrets"
fi
[ ! -f "$UNIT_DIR/spur-direct-terminal.service" ] || fail "spur-direct-terminal.service must not be installed"

grep -qi "spur-direct-terminal\|14801" "$OUT_FILE" &&
  fail "npm-init.sh output references the removed spur-direct-terminal unit or :14801"
grep -qi "spur-direct-terminal\|14801" "$UNIT_DIR"/*.service &&
  fail "an installed unit references the removed spur-direct-terminal unit or :14801"

grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "--no-tailscale must leave WEB_HOST on loopback only"

# Requires= propagates the daemon's stop to spur-web with no matching start
# job, so `systemctl stop spur-daemon` left the web UI dead until an operator
# started it by hand. Ordering (After=) and a Wants= pull are all this unit
# needs — it never talks to the daemon at startup.
grep -q '^Requires=' "$UNIT_DIR/spur-web.service" &&
  fail "spur-web.service must not Require spur-daemon.service (a daemon stop would strand it)"
grep -q '^Wants=spur-daemon.service$' "$UNIT_DIR/spur-web.service" ||
  fail "spur-web.service must Want spur-daemon.service"

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
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --install-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale up) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1,100\.64\.11\.22$' "$UNIT_DIR/spur-web.service" ||
  fail "tailscale IP was not applied to WEB_HOST (expected 127.0.0.1,100.64.11.22)"
grep -qi "unexpected curl invocation" "$OUT_FILE" &&
  fail "npm-init.sh invoked curl even though tailscale was already installed"
assert_out "$OUT_FILE" "npm-init:   web UI: 127.0.0.1,100.64.11.22:5555"
assert_out "$OUT_FILE" "npm-init:   Tailscale: already installed, bound"
assert_out "$OUT_FILE" "npm-init:   linger: already enabled"
assert_no_log "$FAKE_BIN" sudo
if grep -q -- 'enable-linger' "$FAKE_BIN/../loginctl.log"; then
  fail "linger already on: enable-linger must not be called"
fi

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
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --install-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale down) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "an unresolved tailnet must leave WEB_HOST on loopback only"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not up; web UI listens on 127.0.0.1 only when spur-web next starts. For remote access: sudo tailscale up, then spur init --tailscale"
assert_out "$OUT_FILE" "npm-init:   Tailscale: already installed, not up"
refute_out "$OUT_FILE" "Tailscale is not installed"
grep -qi "unexpected curl invocation" "$OUT_FILE" &&
  fail "npm-init.sh invoked curl even though tailscale was already installed"
assert_no_log "$FAKE_BIN" sudo

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
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-start --install-tailscale >"$OUT_FILE" 2>&1
rc=$?
set -e

[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "npm-init.sh --no-start (tailscale non-cgnat) exited $rc"; }

UNIT_DIR="$FAKE_HOME/.config/systemd/user"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
  fail "a non-100.x tailscale IP must be rejected, leaving WEB_HOST on loopback only"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not up; web UI listens on 127.0.0.1 only when spur-web next starts."
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
assert_no_log "$FAKE_BIN" sudo

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
write_logging_stub "$FAKE_BIN" tailscale
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
  bash "$PKG_ROOT/scripts/npm-init.sh" --web-port 6200 --expose-web >"$OUT_FILE" 2>&1
grep -q '^Environment=PORT=6200$' "$FAKE_HOME/.config/systemd/user/spur-web.service" ||
  fail "configured web port was not preserved in the installed unit"
assert_out "$OUT_FILE" "npm-init:   Tailscale: skipped (--expose-web binds 0.0.0.0)"
assert_out "$OUT_FILE" "npm-init:   web UI: 0.0.0.0:6200"
assert_out "$OUT_FILE" "npm-init:   Tailscale: skipped (--expose-web)"
assert_no_log "$FAKE_BIN" tailscale
assert_no_log "$FAKE_BIN" sudo
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
assert_out "$OUT_FILE" "npm-init:   start spur-daemon, spur-web, spur-mcp"
assert_out "$OUT_FILE" "npm-init:   started: spur-daemon spur-web spur-mcp"
assert_out "$OUT_FILE" "npm-init:   web UI: 127.0.0.1:5555"

echo "npm-init.test.sh: slow-readiness scenario OK"

# A reachable stale daemon must never satisfy the install readiness gate.
read -r home_kv bin_kv pkg_kv < <(setup_scenario stale-daemon)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"
cat >"$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
if [ "$#" -eq 6 ] && [ "${1:-}" = "--input-type=module" ]; then printf '%s' "$HOME/.spur/config.yaml"; fi
if [ "$#" -eq 3 ] && [ "${1:-}" = "--input-type=module" ]; then exit 1; fi
exit 0
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 200
EOF
cat >"$FAKE_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/curl" "$FAKE_BIN/sleep"
OUT_FILE="$WORK_DIR/stale-daemon-output.log"
if HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-tailscale >"$OUT_FILE" 2>&1; then
  fail "npm-init.sh accepted a daemon whose identity check failed"
fi
grep -q 'one or more units failed to start' "$OUT_FILE" ||
  fail "npm-init.sh did not report failed readiness"
refute_out "$OUT_FILE" "npm-init: summary:"
echo "npm-init.test.sh: stale-daemon scenario OK"

read -r home_kv bin_kv pkg_kv < <(setup_scenario configured-tunnel)
FAKE_HOME="${home_kv#HOME=}"
FAKE_BIN="${bin_kv#BIN=}"
PKG_ROOT="${pkg_kv#PKG=}"
mkdir -p "$FAKE_HOME/.spur"
printf 'SPUR_MCP_TUNNEL_PROFILE=fixture\nCONTROL_PLANE_API_KEY=fixture\n' >"$FAKE_HOME/.spur/mcp-tunnel.env"
chmod 600 "$FAKE_HOME/.spur/mcp-tunnel.env"
SYSTEMCTL_TRACE="$WORK_DIR/configured-tunnel-trace"
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$SYSTEMCTL_TRACE"
exit 0
EOF
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 200
EOF
chmod +x "$FAKE_BIN/systemctl" "$FAKE_BIN/curl"
OUT_FILE="$WORK_DIR/configured-tunnel-output.log"
SYSTEMCTL_TRACE="$SYSTEMCTL_TRACE" HOME="$FAKE_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" \
  bash "$PKG_ROOT/scripts/npm-init.sh" --no-tailscale >"$OUT_FILE" 2>&1
grep -q -- '--user enable spur-daemon.service spur-web.service spur-mcp.service spur-mcp-tunnel.service' "$SYSTEMCTL_TRACE" ||
  fail "configured tunnel must be enabled with mandatory services"
grep -q -- '--user restart spur-mcp-tunnel.service' "$SYSTEMCTL_TRACE" ||
  fail "configured tunnel must restart during init/reinit"
assert_out "$OUT_FILE" "npm-init:   start spur-daemon, spur-web, spur-mcp, spur-mcp-tunnel"
assert_out "$OUT_FILE" "npm-init:   started: spur-daemon spur-web spur-mcp spur-mcp-tunnel"
echo "npm-init.test.sh: configured-tunnel scenario OK"

# --- Scenarios 9+: PATH = fake bin only ------------------------------------
# The host may carry a real tailscale, curl and sudo; these scenarios never see
# them. Every stub that could install or elevate logs its argv instead.

# Sets FAKE_HOME FAKE_BIN PKG_ROOT UNIT_DIR OUT_FILE for scenario "$1".
new_isolated_scenario() {
  read -r home_kv bin_kv pkg_kv < <(setup_scenario "$1")
  FAKE_HOME="${home_kv#HOME=}"
  FAKE_BIN="${bin_kv#BIN=}"
  PKG_ROOT="${pkg_kv#PKG=}"
  UNIT_DIR="$FAKE_HOME/.config/systemd/user"
  OUT_FILE="$WORK_DIR/$1-output.log"
  link_real_tools "$FAKE_BIN"
}

# Runs npm-init.sh with PATH = fake bin only; sets rc. Per-run env (LINGER_STATE,
# SHOW_RC, ENABLE_RC, TS_STUB) is passed as a prefix assignment by the caller.
run_isolated_init() {
  set +e
  HOME="$FAKE_HOME" PATH="$FAKE_BIN" "$BASH" "$PKG_ROOT/scripts/npm-init.sh" "$@" >"$OUT_FILE" 2>&1
  rc=$?
  set -e
}

assert_loopback() {
  grep -q '^Environment=WEB_HOST=127\.0\.0\.1$' "$UNIT_DIR/spur-web.service" ||
    fail "WEB_HOST must stay on loopback only"
}

# tailscale stub for "up" hosts: logs argv, `ip -4` answers a tailnet address.
write_up_tailscale_stub() {
  cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../tailscale.log"
if [ "$1" = "ip" ]; then echo "100.64.11.22"; exit 0; fi
if [ "$1" = "status" ]; then exit "${TS_STATUS_RC:-0}"; fi
exit 1
EOF
  chmod +x "$FAKE_BIN/tailscale"
}

# default-no-install: no flag, no tailscale binary. Nothing installs, nothing
# elevates, and no Tailscale info line is printed.
new_isolated_scenario default-no-install
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --no-start
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "default-no-install exited $rc"; }
assert_no_log "$FAKE_BIN" curl
assert_no_log "$FAKE_BIN" sudo
assert_no_log "$FAKE_BIN" tailscale
assert_loopback
assert_out "$OUT_FILE" "npm-init:   Tailscale: skipped; web UI is on 127.0.0.1 (pass --tailscale for private remote access)"
assert_out "$OUT_FILE" "npm-init:   Tailscale: not requested"
refute_out "$OUT_FILE" "npm-init: info: Tailscale"
echo "npm-init.test.sh: default-no-install scenario OK"

# hint-up: no flag, Tailscale already up. Only `status` and `ip -4` are called; the web UI
# stays on loopback and an info line names the one command that binds it.
new_isolated_scenario hint-up
write_up_tailscale_stub
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --no-start
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "hint-up exited $rc"; }
[ "$(cat "$FAKE_BIN/../tailscale.log" | tr '\n' '|')" = "status|ip -4|" ] ||
  fail "hint mode may only call 'tailscale status' and 'tailscale ip -4'"
assert_no_log "$FAKE_BIN" curl
assert_no_log "$FAKE_BIN" sudo
assert_loopback
assert_out "$OUT_FILE" "npm-init: info: Tailscale is up but the web UI is not on the tailnet. To bind it: spur init --tailscale"
assert_out "$OUT_FILE" "npm-init:   Tailscale: not requested"
echo "npm-init.test.sh: hint-up scenario OK"

# keep-bind-binary-missing: --tailscale (legacy keep) never installs.
new_isolated_scenario keep-bind-binary-missing
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --no-start --tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "keep-bind-binary-missing exited $rc"; }
assert_no_log "$FAKE_BIN" curl
assert_no_log "$FAKE_BIN" sudo
assert_loopback
assert_out "$OUT_FILE" "npm-init:   Tailscale: not found, bind skipped"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not installed; web UI listens on 127.0.0.1 only when spur-web next starts. To restore the tailnet bind: spur init --tailscale"
refute_out "$OUT_FILE" "web UI is now on 127.0.0.1 only"
refute_out "$OUT_FILE" "Tailscale is not up"
echo "npm-init.test.sh: keep-bind-binary-missing scenario OK"

# keep-bind-started: services restart, so the web UI really is on loopback now.
new_isolated_scenario keep-bind-started
rm -f "$FAKE_BIN/sleep"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/sleep"
printf '#!/usr/bin/env bash\necho 200\n' >"$FAKE_BIN/curl"
chmod +x "$FAKE_BIN/sleep" "$FAKE_BIN/curl"
run_isolated_init --tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "keep-bind-started exited $rc"; }
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not installed; web UI is now on 127.0.0.1 only. To restore the tailnet bind: spur init --tailscale"
echo "npm-init.test.sh: keep-bind-started scenario OK"

# prior-release-handoff: an older `update` sends `--web-port <n> --tailscale`
# for a retained bind. With the binary gone the new script must not install.
new_isolated_scenario prior-release-handoff
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --web-port 5555 --tailscale --no-start
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "prior-release-handoff exited $rc"; }
assert_no_log "$FAKE_BIN" curl
assert_no_log "$FAKE_BIN" sudo
assert_loopback
assert_out "$OUT_FILE" "npm-init:   Tailscale: not found, bind skipped"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not installed; web UI listens on 127.0.0.1 only when spur-web next starts. To restore the tailnet bind: spur init --tailscale"
echo "npm-init.test.sh: prior-release-handoff scenario OK"

# install-not-up-started: --install-tailscale with Tailscale down and services restarted.
new_isolated_scenario install-not-up-started
rm -f "$FAKE_BIN/sleep"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/sleep"
printf '#!/usr/bin/env bash\necho 200\n' >"$FAKE_BIN/curl"
printf '#!/usr/bin/env bash\nexit 1\n' >"$FAKE_BIN/tailscale"
chmod +x "$FAKE_BIN/sleep" "$FAKE_BIN/curl" "$FAKE_BIN/tailscale"
run_isolated_init --install-tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "install-not-up-started exited $rc"; }
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not up; web UI is on 127.0.0.1. For remote access: sudo tailscale up, then spur init --tailscale"
echo "npm-init.test.sh: install-not-up-started scenario OK"

# keep-bind-down: --tailscale, Tailscale installed but not up.
new_isolated_scenario keep-bind-down
cat >"$FAKE_BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
echo "NoState"
exit 1
EOF
chmod +x "$FAKE_BIN/tailscale"
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --no-start --tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "keep-bind-down exited $rc"; }
assert_no_log "$FAKE_BIN" curl
assert_loopback
assert_out "$OUT_FILE" "npm-init:   Tailscale: not up"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not up; web UI listens on 127.0.0.1 only when spur-web next starts. To restore the tailnet bind: sudo tailscale up, then spur init --tailscale"
echo "npm-init.test.sh: keep-bind-down scenario OK"

# keep-bind-stopped: `ip -4` still answers a cached 100.x after `tailscale
# down`, but `status` fails => not up, no bind.
new_isolated_scenario keep-bind-stopped
write_up_tailscale_stub
write_logging_stub "$FAKE_BIN" curl
TS_STATUS_RC=1 run_isolated_init --no-start --tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "keep-bind-stopped exited $rc"; }
assert_loopback
assert_out "$OUT_FILE" "npm-init:   Tailscale: not up"
assert_out "$OUT_FILE" "npm-init: info: Tailscale is not up; web UI listens on 127.0.0.1 only when spur-web next starts."
assert_no_log "$FAKE_BIN" curl
echo "npm-init.test.sh: keep-bind-stopped scenario OK"

# keep-bind-up: --tailscale rebinds when Tailscale is up; never installs.
new_isolated_scenario keep-bind-up
write_up_tailscale_stub
write_logging_stub "$FAKE_BIN" curl
run_isolated_init --no-start --tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "keep-bind-up exited $rc"; }
grep -q '^Environment=WEB_HOST=127\.0\.0\.1,100\.64\.11\.22$' "$UNIT_DIR/spur-web.service" ||
  fail "--tailscale must bind the tailnet IP when Tailscale is up"
assert_no_log "$FAKE_BIN" curl
assert_no_log "$FAKE_BIN" sudo
assert_out "$OUT_FILE" "npm-init:   Tailscale: kept"
echo "npm-init.test.sh: keep-bind-up scenario OK"

# opt-in-install-fail: --install-tailscale, install.sh fails => rc 1 before any unit write.
new_isolated_scenario opt-in-install-fail
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../curl.log"
exit 1
EOF
chmod +x "$FAKE_BIN/curl"
run_isolated_init --no-start --install-tailscale
[ "$rc" -eq 1 ] || { cat "$OUT_FILE" >&2; fail "opt-in-install-fail must exit 1, got $rc"; }
grep -q 'tailscale.com/install.sh' "$FAKE_BIN/../curl.log" || fail "--install-tailscale must run the install script"
assert_out "$OUT_FILE" "npm-init: Tailscale install failed; no units changed, running services and any existing tailnet bind left as they were. Install Tailscale manually (https://tailscale.com/download), then re-run: spur init --tailscale"
[ ! -e "$UNIT_DIR" ] || fail "units must not be written when the Tailscale install fails"
refute_out "$OUT_FILE" "npm-init: summary:"
echo "npm-init.test.sh: opt-in-install-fail scenario OK"

# opt-in-install-ok: install.sh drops a tailscale binary that is up.
new_isolated_scenario opt-in-install-ok
cat >"$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../curl.log"
cat <<'SNIPPET'
printf '#!/usr/bin/env bash\nif [ "$1" = ip ]; then echo 100.64.11.22; fi\nexit 0\n' >"$TS_STUB"
chmod 755 "$TS_STUB"
SNIPPET
EOF
chmod +x "$FAKE_BIN/curl"
TS_STUB="$FAKE_BIN/tailscale" run_isolated_init --no-start --install-tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "opt-in-install-ok exited $rc"; }
grep -q 'tailscale.com/install.sh' "$FAKE_BIN/../curl.log" || fail "--install-tailscale must run the install script"
grep -q '^Environment=WEB_HOST=127\.0\.0\.1,100\.64\.11\.22$' "$UNIT_DIR/spur-web.service" ||
  fail "installed Tailscale must bind the tailnet IP"
assert_out "$OUT_FILE" "npm-init:   Tailscale: installed, bound"
assert_out "$OUT_FILE" "npm-init:   web UI: 127.0.0.1,100.64.11.22:5555"
echo "npm-init.test.sh: opt-in-install-ok scenario OK"

# linger-refused: loginctl refuses => info line, rc 0, units still installed.
new_isolated_scenario linger-refused
LINGER_STATE="Linger=no" ENABLE_RC=1 run_isolated_init --no-start --no-tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "linger-refused must exit 0, got $rc"; }
[ -f "$UNIT_DIR/spur-web.service" ] || fail "units must be installed when linger is refused"
grep -q -- '--no-ask-password enable-linger' "$FAKE_BIN/../loginctl.log" ||
  fail "linger must be requested with --no-ask-password"
assert_no_log "$FAKE_BIN" sudo
assert_out "$OUT_FILE" "npm-init:   linger: not enabled"
assert_out "$OUT_FILE" "npm-init: info: linger not enabled (loginctl refused); services stop at logout and do not start at boot. To enable: sudo loginctl enable-linger $(id -un)"
echo "npm-init.test.sh: linger-refused scenario OK"

# linger-show-fails: show-user exits 1 => treated as not enabled, enable runs.
new_isolated_scenario linger-show-fails
SHOW_RC=1 run_isolated_init --no-start --no-tailscale
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "linger-show-fails must exit 0, got $rc"; }
assert_out "$OUT_FILE" "npm-init:   linger: enabled"
refute_out "$OUT_FILE" "npm-init: info: linger"
echo "npm-init.test.sh: linger-show-fails scenario OK"

# user-unset: $USER unset must not abort the plan, and linger targets the
# account from `id -un`.
new_isolated_scenario user-unset
saved_user="${USER:-}"
unset USER
LINGER_STATE="Linger=no" run_isolated_init --no-start --no-tailscale
USER="$saved_user"
export USER
[ "$rc" -eq 0 ] || { cat "$OUT_FILE" >&2; fail "user-unset must exit 0, got $rc"; }
assert_out "$OUT_FILE" "npm-init:   enable linger for $(id -un) if allowed"
grep -q -- "enable-linger $(id -un)\$" "$FAKE_BIN/../loginctl.log" ||
  fail "linger must target the id -un account"
assert_out "$OUT_FILE" "npm-init:   linger: enabled"
echo "npm-init.test.sh: user-unset scenario OK"

echo "npm-init.test.sh: OK"
