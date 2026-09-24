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
LOCK_FILE="$LOG_DIR/install-and-restart.lock"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_helper() {
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo SYSTEMCTL=echo bash "$HELPER" "$@"
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
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo SYSTEMCTL=/nonexistent/spur-test-systemctl \
  bash "$HELPER" 1.2.3
if ! grep -q "systemctl not available, manual restart required" "$LOG_FILE"; then
  echo "FAIL: log missing manual-restart hint" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 3b: no systemctl records restart_skipped on the status file (A3) — same
# branch as Case 3, with a status file to see what it wrote after a real install.
rm -f "$LOG_FILE"
STATUS_FILE3B="$LOG_DIR/restart-skipped-status.json"
LEDGER_FILE3B="$LOG_DIR/restart-skipped-ledger.jsonl"
rm -f "$STATUS_FILE3B" "$LEDGER_FILE3B"
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" \
  SPUR_INSTALL_STATUS_FILE="$STATUS_FILE3B" SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE3B" \
  NPM=echo SYSTEMCTL=spur-no-such-systemctl \
  bash "$HELPER" 1.2.3
grep -q '"phase":"succeeded"' "$STATUS_FILE3B" || fail "no-systemctl run recorded no success status"
grep -q '"outcome":"restart_skipped"' "$STATUS_FILE3B" || fail "no-systemctl run recorded no restart_skipped outcome"
if grep -q 'failureKind' "$STATUS_FILE3B"; then
  fail "a restart_skipped status must carry no failureKind"
fi
if [ -e "$LEDGER_FILE3B" ]; then
  fail "a restart_skipped run must never block its own version: $(cat "$LEDGER_FILE3B")"
fi

# Case 4: multi-word SYSTEMCTL override (the real default is "systemctl --user")
# splits into command + args.
rm -f "$LOG_FILE"
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo SYSTEMCTL="echo --user" bash "$HELPER" 1.2.3
if ! grep -q -- "--user restart spur-daemon.service spur-web.service" "$LOG_FILE"; then
  echo "FAIL: log missing multi-word systemctl argv" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 5: a failing restart propagates its exit code instead of masking it, and
# records install_unhealthy — this branch has no rollback, so the host is left
# on the newly installed version and must never be auto-retried.
rm -f "$LOG_FILE"
STATUS_FILE5="$LOG_DIR/deploy-switch-5.json"
rm -f "$STATUS_FILE5"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE5" SPUR_DEPLOY_INITIATOR=auto \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo SYSTEMCTL=false \
  bash "$HELPER" 1.2.3
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: expected non-zero exit when systemctl restart fails" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
grep -q '"failureKind":"install_unhealthy"' "$STATUS_FILE5" ||
  fail "case 5 status must record failureKind install_unhealthy: $(cat "$STATUS_FILE5")"
grep -q '"initiator":"auto"' "$STATUS_FILE5" || fail "case 5 status lost the initiator"

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
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo PATH="$STUB_BIN_DIR:$PATH" \
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
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo PATH="$STUB_BIN_DIR:$PATH" SYSTEMCTL=echo \
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
PKG_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR="$PKG_DIR/scripts"
mkdir -p "$PKG_SCRIPTS_DIR" "$PKG_DIR/deploy" "$PKG_DIR/dist" "$PKG_DIR/web/dist-server" "$PKG_DIR/skills/spur" "$PREFIX_DIR/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR/required-package-files.txt"
: >"$PKG_DIR/deploy/spur-daemon.npm.service"
: >"$PKG_DIR/deploy/spur-web.npm.service"
: >"$PKG_DIR/dist/cli.js"
: >"$PKG_DIR/web/dist-server/web-server.js"
: >"$PKG_DIR/spur.yaml.reference"
: >"$PKG_DIR/skills/spur/SKILL.md"
printf '{"version":"1.2.3"}' >"$PKG_DIR/package.json"
cat >"$PREFIX_DIR/bin/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$PREFIX_DIR/bin/spur"

rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo \
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

# Case 12: npm ENOTEMPTY removes only scoped stale rename directories and retries once.
NPM_STUB="$PREFIX_DIR/npm-stub"
NPM_COUNT="$PREFIX_DIR/npm-count"
STALE_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/.spur-pMSp82au"
KEEP_MATCHING_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/.spur-notours"
KEEP_UNSHAPED_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/.spur-stale-dir-name"
KEEP_OWNED_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/.spur-AbCd1234"
KEEP_DIR="$PREFIX_DIR/lib/node_modules/@shugaev/not-spur-stale"
mkdir -p "$STALE_DIR" "$KEEP_MATCHING_DIR" "$KEEP_UNSHAPED_DIR" "$KEEP_OWNED_DIR" "$KEEP_DIR"
printf '%s\n' '{"name":"@shugaev/spur"}' >"$STALE_DIR/package.json"
printf '%s\n' '{"name":"not-spur"}' >"$KEEP_MATCHING_DIR/package.json"
printf '%s\n' '{"name":"@shugaev/spur"}' >"$KEEP_UNSHAPED_DIR/package.json"
printf '%s\n' '{"name":"@shugaev/spur"}' >"$KEEP_OWNED_DIR/package.json"
cat >"$NPM_STUB" <<'EOF'
#!/usr/bin/env bash
count=0
[ ! -f "$NPM_COUNT" ] || count="$(cat "$NPM_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" >"$NPM_COUNT"
if [ "$count" -eq 1 ]; then
  echo "npm ERR! code ENOTEMPTY"
  echo "npm ERR! dest $NPM_STALE_DEST"
  exit 217
fi
echo "installed"
EOF
chmod +x "$NPM_STUB"
rm -f "$LOG_FILE"
NPM_COUNT="$NPM_COUNT" NPM_STALE_DEST="$STALE_DIR" SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" \
  NPM="$NPM_STUB" SYSTEMCTL=echo bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.3
[ ! -d "$STALE_DIR" ] || fail "stale npm rename directory was not removed"
[ -d "$KEEP_MATCHING_DIR" ] || fail "cleanup removed a matching-name non-Spur directory"
[ -d "$KEEP_UNSHAPED_DIR" ] || fail "cleanup removed an unshaped Spur directory"
[ -d "$KEEP_OWNED_DIR" ] || fail "cleanup removed an owned temp directory npm did not report"
[ -d "$KEEP_DIR" ] || fail "cleanup removed a non-matching directory"
[ "$(cat "$NPM_COUNT")" -eq 2 ] || fail "npm install was not retried exactly once"

# Case 13: concurrent helpers serialize the npm install section.
LOCK_NPM_STUB="$PREFIX_DIR/lock-npm-stub"
LOCK_TRACE="$PREFIX_DIR/lock-trace"
cat >"$LOCK_NPM_STUB" <<'EOF'
#!/usr/bin/env bash
echo start >>"$LOCK_TRACE"
sleep 0.2
echo end >>"$LOCK_TRACE"
EOF
chmod +x "$LOCK_NPM_STUB"
rm -f "$LOCK_TRACE"
LOCK_TRACE="$LOCK_TRACE" SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" \
  NPM="$LOCK_NPM_STUB" SYSTEMCTL=echo bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.3 &
first_pid=$!
LOCK_TRACE="$LOCK_TRACE" SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" \
  NPM="$LOCK_NPM_STUB" SYSTEMCTL=echo bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.4 &
second_pid=$!
wait "$first_pid" "$second_pid"
[ "$(tr '\n' ' ' <"$LOCK_TRACE")" = "start end start end " ] || fail "concurrent installs overlapped"

# Case 14: a held lock makes the helper give up instead of waiting forever,
# and records install_failed so a record-less retry can never happen (a lock
# give-up now runs under the armed trap; A1). No daemon writes the "running"
# record here, so the :64-78 wait loop spins its full ~2s before the lock is
# even attempted — acceptable, noted in the spec's test plan. The hold is not
# a tuned duration: the case kills the holder below, so a hold far longer than
# any runner can spend in the barrier plus the helper's wait costs nothing and
# makes the guarantee unconditional.
# stdout/stderr detached: a failing run leaves the holder alive, and an
# inherited stdout would hold the caller's pipe open for the rest of the hold.
flock "$LOCK_FILE" -c "sleep 600" >/dev/null 2>&1 &
holder_pid=$!
# Barrier, not a sleep: wait until the holder actually owns the lock. A fixed
# delay is a guess about how long a backgrounded flock takes to acquire, and
# under load it can still be starting — the helper then wins the lock and the
# case asserts nothing, failing with rc=0. Probe non-blockingly instead: while
# the probe can take the lock, the holder does not have it yet. rc 1 is the
# only "held" answer flock gives; any other non-zero rc (66 on an unopenable
# lock file) is a broken probe, not a held lock, so fail on it with the rc.
lock_held=""
for _ in $(seq 1 200); do
  set +e
  flock -n "$LOCK_FILE" -c true
  probe_rc=$?
  set -e
  if [ "$probe_rc" -eq 1 ]; then
    lock_held="yes"
    break
  fi
  [ "$probe_rc" -eq 0 ] || fail "lock probe failed (rc=$probe_rc)"
  sleep 0.05
done
[ -n "$lock_held" ] || fail "lock holder never acquired the lock"
STATUS_FILE14="$PREFIX_DIR/lock-give-up-status.json"
LEDGER_FILE14="$PREFIX_DIR/lock-give-up-ledger.jsonl"
rm -f "$STATUS_FILE14" "$LEDGER_FILE14"
set +e
SPUR_INSTALL_LOCK_WAIT_SECONDS=1 SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" \
  SPUR_INSTALL_STATUS_FILE="$STATUS_FILE14" SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE14" \
  NPM=echo SYSTEMCTL=echo bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.3
lock_rc=$?
set -e
[ "$lock_rc" -eq 1 ] || fail "helper did not give up on a held lock (rc=$lock_rc)"
grep -q "install-and-restart lock failed" "$LOG_DIR/install-and-restart.log" || fail "missing lock failure log"
grep -q '"phase":"failed"' "$STATUS_FILE14" || fail "a lock give-up recorded no terminal status"
grep -q '"failureKind":"install_failed"' "$STATUS_FILE14" || fail "a lock give-up recorded no failureKind"
if [ -e "$LEDGER_FILE14" ]; then
  fail "a lock give-up must never write a ledger line: $(cat "$LEDGER_FILE14")"
fi
# The hold outlasts the helper's wait by a wide margin so a slow runner cannot
# release it early; the case ends it here rather than sitting out the remainder.
# Kill both the backgrounded flock wrapper and any child sleep holding the fd.
pkill -P "$holder_pid" 2>/dev/null || true
kill "$holder_pid" 2>/dev/null || true
# Both kills swallow their rc, and the hold outlives the whole suite, so a kill
# that failed would surface as the `wait` below, and then Case 15, sitting out
# the remaining hold. Probe the lock back before waiting on the holder:
# signal delivery is asynchronous, so allow a short window, then fail here by
# name instead of stalling later.
lock_released=""
for _ in $(seq 1 40); do
  set +e
  flock -n "$LOCK_FILE" -c true
  probe_rc=$?
  set -e
  if [ "$probe_rc" -eq 0 ]; then
    lock_released="yes"
    break
  fi
  [ "$probe_rc" -eq 1 ] || fail "lock probe failed (rc=$probe_rc)"
  sleep 0.05
done
[ -n "$lock_released" ] || fail "lock holder survived the kill and still holds the lock"
wait "$holder_pid" 2>/dev/null || true

# Case 15: detached deploy runs replace the durable running record with terminal status.
STATUS_FILE="$PREFIX_DIR/deploy-switch.json"
LEDGER_FILE15="$PREFIX_DIR/update-ledger.jsonl"
printf '%s\n' '{"phase":"running"}' >"$STATUS_FILE"
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE" SPUR_DEPLOY_INITIATOR=auto SPUR_INSTALL_LOG_DIR="$LOG_DIR" \
  SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE15" \
  SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo SYSTEMCTL=echo \
  bash "$PKG_SCRIPTS_DIR/install-and-restart.sh" 1.2.3
grep -q '"phase":"succeeded"' "$STATUS_FILE" || fail "helper did not persist success status"
grep -q '"version":"1.2.3"' "$STATUS_FILE" || fail "helper status lost target version"
grep -q '"initiator":"auto"' "$STATUS_FILE" || fail "helper status lost the initiator"
if grep -q 'failureKind' "$STATUS_FILE"; then
  fail "a succeeded status must carry no failureKind"
fi
if [ -e "$LEDGER_FILE15" ]; then
  fail "a succeeded run must never block its own version: $(cat "$LEDGER_FILE15")"
fi

# Case 9: install layout with required files missing -> non-zero exit, rollback
# install logged, no spur reinit, no systemctl restart.
PREFIX_DIR9="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR" "$PREFIX_DIR9"' EXIT
PKG_DIR9="$PREFIX_DIR9/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR9="$PKG_DIR9/scripts"
mkdir -p "$PKG_SCRIPTS_DIR9" "$PKG_DIR9/deploy" "$PKG_DIR9/dist" "$PKG_DIR9/web/dist-server" "$PKG_DIR9/skills/spur" "$PREFIX_DIR9/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR9/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR9/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR9/required-package-files.txt"
: >"$PKG_DIR9/deploy/spur-daemon.npm.service"
: >"$PKG_DIR9/deploy/spur-web.npm.service"
: >"$PKG_DIR9/dist/cli.js"
: >"$PKG_DIR9/spur.yaml.reference"
: >"$PKG_DIR9/skills/spur/SKILL.md"
printf '{"version":"1.2.3"}' >"$PKG_DIR9/package.json"
cat >"$PREFIX_DIR9/bin/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$PREFIX_DIR9/bin/spur"

rm -f "$LOG_FILE"
# The status file is what carries failureKind, so this case must ask for one:
# without SPUR_INSTALL_STATUS_FILE the EXIT trap writes nothing at all. No
# daemon is here to write the "running" record, so the helper pays its 2s wait.
STATUS_FILE9="$PREFIX_DIR9/deploy-switch.json"
LEDGER_FILE9="$PREFIX_DIR9/update-ledger.jsonl"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE9" SPUR_DEPLOY_INITIATOR=auto \
  SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE9" \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR9/install-and-restart.sh" 1.3.0
rc9=$?
set -e
if [ "$rc9" -eq 0 ]; then
  echo "FAIL: case 9 expected non-zero exit for missing required file, got 0" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "web/dist-server/web-server.js" "$LOG_FILE"; then
  echo "FAIL: case 9 log does not name the missing file web/dist-server/web-server.js" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q -- "install -g --prefix $PREFIX_DIR9 @shugaev/spur@1.2.3" "$LOG_FILE"; then
  echo "FAIL: case 9 log missing rollback install line" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "spur reinit" "$LOG_FILE"; then
  echo "FAIL: case 9 log must not contain spur reinit" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "restart spur-daemon.service" "$LOG_FILE"; then
  echo "FAIL: case 9 log must not contain systemctl restart" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
# NPM=echo makes the rollback install return 0, and this branch never reinits,
# so the previous version is restored: rolled_back, never auto-retried.
grep -q '"failureKind":"rolled_back"' "$STATUS_FILE9" ||
  fail "case 9 status must record failureKind rolled_back: $(cat "$STATUS_FILE9")"
grep -q '"initiator":"auto"' "$STATUS_FILE9" || fail "case 9 status lost the initiator"
# The record can be cleared by the operator; the ledger line is what keeps this
# version off the auto path for good.
ledger_lines9="$(wc -l <"$LEDGER_FILE9")"
[ "$ledger_lines9" -eq 1 ] ||
  fail "case 9 must append exactly one ledger line, got $ledger_lines9: $(cat "$LEDGER_FILE9")"
grep -q '{"kind":"blocked","version":"1.3.0","failureKind":"rolled_back"' "$LEDGER_FILE9" ||
  fail "case 9 ledger line does not block 1.3.0 as rolled_back: $(cat "$LEDGER_FILE9")"

# Case 10: all required files present, spur exits 1 -> health rollback: rollback
# install of 1.0.0, second reinit, exit non-zero. Two spur reinit rc= log lines.
PREFIX_DIR10="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR" "$PREFIX_DIR9" "$PREFIX_DIR10"' EXIT
PKG_DIR10="$PREFIX_DIR10/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR10="$PKG_DIR10/scripts"
mkdir -p "$PKG_SCRIPTS_DIR10" "$PKG_DIR10/deploy" "$PKG_DIR10/dist" "$PKG_DIR10/web/dist-server" "$PKG_DIR10/skills/spur" "$PREFIX_DIR10/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR10/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR10/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR10/required-package-files.txt"
: >"$PKG_DIR10/deploy/spur-daemon.npm.service"
: >"$PKG_DIR10/deploy/spur-web.npm.service"
: >"$PKG_DIR10/dist/cli.js"
: >"$PKG_DIR10/web/dist-server/web-server.js"
: >"$PKG_DIR10/spur.yaml.reference"
: >"$PKG_DIR10/skills/spur/SKILL.md"
printf '{"version":"1.0.0"}' >"$PKG_DIR10/package.json"
cat >"$PREFIX_DIR10/bin/spur" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$PREFIX_DIR10/bin/spur"

rm -f "$LOG_FILE"
STATUS_FILE10="$PREFIX_DIR10/deploy-switch.json"
LEDGER_FILE10="$PREFIX_DIR10/nested/update-ledger.jsonl"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE10" SPUR_DEPLOY_INITIATOR=manual \
  SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE10" \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR10/install-and-restart.sh" 1.1.0
rc10=$?
set -e
if [ "$rc10" -eq 0 ]; then
  echo "FAIL: case 10 expected non-zero exit when reinit fails, got 0" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q -- "install -g --prefix $PREFIX_DIR10 @shugaev/spur@1.0.0" "$LOG_FILE"; then
  echo "FAIL: case 10 log missing rollback install of 1.0.0" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
reinit_lines="$(grep -c "install-and-restart spur reinit rc=" "$LOG_FILE" || true)"
if [ "$reinit_lines" -ne 2 ]; then
  echo "FAIL: case 10 expected 2 spur reinit rc= log lines, got $reinit_lines" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "restart spur-daemon.service" "$LOG_FILE"; then
  echo "FAIL: case 10 log must not contain bare systemctl restart" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
# The spur stub exits 1 unconditionally, so the post-rollback reinit fails too:
# installed, failed, and NOT restored -> install_unhealthy, not rolled_back.
grep -q '"failureKind":"install_unhealthy"' "$STATUS_FILE10" ||
  fail "case 10 status must record failureKind install_unhealthy: $(cat "$STATUS_FILE10")"
grep -q '"initiator":"manual"' "$STATUS_FILE10" || fail "case 10 status lost the initiator"
# Nested path on purpose: the daemon hands over a path under dataDir that may
# not exist yet on a host that has never blocked a version.
ledger_lines10="$(wc -l <"$LEDGER_FILE10")"
[ "$ledger_lines10" -eq 1 ] ||
  fail "case 10 must append exactly one ledger line, got $ledger_lines10: $(cat "$LEDGER_FILE10")"
grep -q '{"kind":"blocked","version":"1.1.0","failureKind":"install_unhealthy"' "$LEDGER_FILE10" ||
  fail "case 10 ledger line does not block 1.1.0 as install_unhealthy: $(cat "$LEDGER_FILE10")"

# Case 11: downgrade to a version whose tree lacks scripts/verify-package-files.sh.
# The validator was copied from the current (pre-install) package into a temp dir
# before the install, so validation still runs and passes, and reinit is reached.
PREFIX_DIR11="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR" "$PREFIX_DIR9" "$PREFIX_DIR10" "$PREFIX_DIR11"' EXIT
PKG_DIR11="$PREFIX_DIR11/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR11="$PKG_DIR11/scripts"
mkdir -p "$PKG_SCRIPTS_DIR11" "$PKG_DIR11/deploy" "$PKG_DIR11/dist" "$PKG_DIR11/web/dist-server" "$PKG_DIR11/skills/spur" "$PREFIX_DIR11/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR11/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR11/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR11/required-package-files.txt"
: >"$PKG_DIR11/deploy/spur-daemon.npm.service"
: >"$PKG_DIR11/deploy/spur-web.npm.service"
: >"$PKG_DIR11/dist/cli.js"
: >"$PKG_DIR11/web/dist-server/web-server.js"
: >"$PKG_DIR11/spur.yaml.reference"
: >"$PKG_DIR11/skills/spur/SKILL.md"
printf '{"version":"1.5.0"}' >"$PKG_DIR11/package.json"
cat >"$PREFIX_DIR11/bin/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$PREFIX_DIR11/bin/spur"

FAKE_NPM11="$(mktemp)"
cat >"$FAKE_NPM11" <<EOF
#!/usr/bin/env bash
echo "\$@"
rm -f "$PKG_DIR11/scripts/verify-package-files.sh"
rm -f "$PKG_DIR11/required-package-files.txt"
EOF
chmod +x "$FAKE_NPM11"

rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM="$FAKE_NPM11" \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR11/install-and-restart.sh" 0.9.0
rc11=$?
set -e
rm -f "$FAKE_NPM11"
if [ "$rc11" -ne 0 ]; then
  echo "FAIL: case 11 expected exit 0 for downgrade (validator from pre-install copy), got $rc11" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if ! grep -q "spur reinit rc=0" "$LOG_FILE"; then
  echo "FAIL: case 11 log missing spur reinit rc=0 (downgrade must still reach reinit)" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
if grep -q "package validation failed" "$LOG_FILE"; then
  echo "FAIL: case 11 log must not contain package validation failed (pre-install copy should have been used)" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

# Case 16: a failed npm install records install_failed — nothing was installed,
# so the daemon's tick may attempt this version again on the next tick.
STATUS_FILE16="$LOG_DIR/deploy-switch-16.json"
LEDGER_FILE16="$LOG_DIR/update-ledger-16.jsonl"
rm -f "$LOG_FILE" "$STATUS_FILE16" "$LEDGER_FILE16"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE16" SPUR_DEPLOY_INITIATOR=auto \
  SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE16" \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=false SYSTEMCTL=echo \
  bash "$HELPER" 1.4.0
rc16=$?
set -e
[ "$rc16" -ne 0 ] || fail "case 16 expected a non-zero exit when npm install fails"
grep -q "npm install failed" "$LOG_FILE" || fail "case 16 log missing the npm install failure line"
grep -q '"failureKind":"install_failed"' "$STATUS_FILE16" ||
  fail "case 16 status must record failureKind install_failed: $(cat "$STATUS_FILE16")"
grep -q '"phase":"failed"' "$STATUS_FILE16" || fail "case 16 status must be phase failed"
grep -q '"initiator":"auto"' "$STATUS_FILE16" || fail "case 16 status lost the initiator"
if grep -q "restart spur-daemon.service" "$LOG_FILE"; then
  fail "case 16 must not restart anything after a failed install"
fi
if [ -e "$LEDGER_FILE16" ]; then
  fail "case 16 must not block a version that never installed: $(cat "$LEDGER_FILE16")"
fi

# Case 17: package validation fails AND the rollback install fails too. Same
# branch as case 9, opposite outcome: the previous version was not restored, so
# the kind stays install_unhealthy and must not be upgraded to rolled_back.
PREFIX_DIR17="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR" "$PREFIX_DIR9" "$PREFIX_DIR10" "$PREFIX_DIR11" "$PREFIX_DIR17"' EXIT
PKG_DIR17="$PREFIX_DIR17/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR17="$PKG_DIR17/scripts"
mkdir -p "$PKG_SCRIPTS_DIR17" "$PKG_DIR17/deploy" "$PKG_DIR17/dist" "$PKG_DIR17/web/dist-server" "$PREFIX_DIR17/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR17/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR17/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR17/required-package-files.txt"
: >"$PKG_DIR17/deploy/spur-daemon.npm.service"
: >"$PKG_DIR17/deploy/spur-web.npm.service"
: >"$PKG_DIR17/dist/cli.js"
: >"$PKG_DIR17/spur.yaml.reference"
printf '{"version":"1.2.3"}' >"$PKG_DIR17/package.json"
cat >"$PREFIX_DIR17/bin/spur" <<'EOF'
#!/usr/bin/env bash
echo "$@"
EOF
chmod +x "$PREFIX_DIR17/bin/spur"

# Installs the target, refuses the rollback back to 1.2.3.
FAKE_NPM17="$(mktemp)"
cat >"$FAKE_NPM17" <<'EOF'
#!/usr/bin/env bash
echo "$@"
for arg in "$@"; do
  if [ "$arg" = "@shugaev/spur@1.2.3" ]; then
    exit 1
  fi
done
exit 0
EOF
chmod +x "$FAKE_NPM17"

STATUS_FILE17="$PREFIX_DIR17/deploy-switch.json"
rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE17" SPUR_DEPLOY_INITIATOR=auto \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM="$FAKE_NPM17" \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR17/install-and-restart.sh" 1.3.0
rc17=$?
set -e
rm -f "$FAKE_NPM17"
[ "$rc17" -ne 0 ] || fail "case 17 expected a non-zero exit for a failed validation"
grep -q "rollback install rc=1" "$LOG_FILE" ||
  fail "case 17 log missing the failed rollback install line"
grep -q '"failureKind":"install_unhealthy"' "$STATUS_FILE17" ||
  fail "case 17 status must stay install_unhealthy: $(cat "$STATUS_FILE17")"
if grep -q "rolled_back" "$STATUS_FILE17"; then
  fail "case 17 must not claim a rollback that failed: $(cat "$STATUS_FILE17")"
fi

# Case 18: the reinit branch's other half. Rollback install FAILS while the
# post-rollback reinit SUCCEEDS — the only input that separates the two
# conjuncts at install-and-restart.sh's `_rollback_rc -eq 0 &&
# _rollback_reinit_rc -eq 0`. Previous version not reinstalled, so the kind
# stays install_unhealthy no matter how well the reinit went.
PREFIX_DIR18="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR" "$STUB_BIN_DIR" "$PREFIX_DIR" "$PREFIX_DIR9" "$PREFIX_DIR10" "$PREFIX_DIR11" "$PREFIX_DIR17" "$PREFIX_DIR18"' EXIT
PKG_DIR18="$PREFIX_DIR18/lib/node_modules/@shugaev/spur"
PKG_SCRIPTS_DIR18="$PKG_DIR18/scripts"
mkdir -p "$PKG_SCRIPTS_DIR18" "$PKG_DIR18/deploy" "$PKG_DIR18/dist" "$PKG_DIR18/web/dist-server" "$PKG_DIR18/skills/spur" "$PREFIX_DIR18/bin"
cp "$HELPER" "$PKG_SCRIPTS_DIR18/install-and-restart.sh"
cp "$HERE/../scripts/verify-package-files.sh" "$PKG_SCRIPTS_DIR18/verify-package-files.sh"
cp "$HERE/../required-package-files.txt" "$PKG_DIR18/required-package-files.txt"
: >"$PKG_DIR18/deploy/spur-daemon.npm.service"
: >"$PKG_DIR18/deploy/spur-web.npm.service"
: >"$PKG_DIR18/dist/cli.js"
: >"$PKG_DIR18/web/dist-server/web-server.js"
: >"$PKG_DIR18/spur.yaml.reference"
: >"$PKG_DIR18/skills/spur/SKILL.md"
printf '{"version":"1.0.0"}' >"$PKG_DIR18/package.json"

# First reinit (the new version) fails, the second one (after the rollback
# install) succeeds.
SPUR_COUNT18="$LOG_DIR/spur-count-18"
rm -f "$SPUR_COUNT18"
cat >"$PREFIX_DIR18/bin/spur" <<EOF
#!/usr/bin/env bash
echo "\$@"
count=\$(cat "$SPUR_COUNT18" 2>/dev/null || echo 0)
count=\$((count + 1))
printf '%s' "\$count" >"$SPUR_COUNT18"
[ "\$count" -eq 1 ] && exit 1
exit 0
EOF
chmod +x "$PREFIX_DIR18/bin/spur"

# Installs the new version, refuses the rollback back to 1.0.0.
FAKE_NPM18="$(mktemp)"
cat >"$FAKE_NPM18" <<'EOF'
#!/usr/bin/env bash
echo "$@"
for arg in "$@"; do
  if [ "$arg" = "@shugaev/spur@1.0.0" ]; then
    exit 1
  fi
done
exit 0
EOF
chmod +x "$FAKE_NPM18"

STATUS_FILE18="$PREFIX_DIR18/deploy-switch.json"
rm -f "$LOG_FILE"
set +e
SPUR_INSTALL_STATUS_FILE="$STATUS_FILE18" SPUR_DEPLOY_INITIATOR=auto \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM="$FAKE_NPM18" \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR18/install-and-restart.sh" 1.1.0
rc18=$?
set -e
rm -f "$FAKE_NPM18"
[ "$rc18" -ne 0 ] || fail "case 18 expected a non-zero exit when the first reinit fails"
grep -q "rollback install rc=1" "$LOG_FILE" ||
  fail "case 18 log missing the failed rollback install line"
grep -q "spur reinit rc=0" "$LOG_FILE" ||
  fail "case 18 expected the post-rollback reinit to succeed"
grep -q '"failureKind":"install_unhealthy"' "$STATUS_FILE18" ||
  fail "case 18 status must stay install_unhealthy: $(cat "$STATUS_FILE18")"
if grep -q "rolled_back" "$STATUS_FILE18"; then
  fail "case 18 must not claim a rollback whose install failed: $(cat "$STATUS_FILE18")"
fi

# Case 19: the ledger line does not depend on the status file. Same fixture as
# case 10, run with no SPUR_INSTALL_STATUS_FILE at all: the never-retry memory
# still lands, so a lost or buried status record cannot re-arm this version.
LEDGER_FILE19="$LOG_DIR/update-ledger-19.jsonl"
rm -f "$LOG_FILE" "$LEDGER_FILE19"
set +e
SPUR_UPDATE_LEDGER_FILE="$LEDGER_FILE19" \
  SPUR_INSTALL_LOG_DIR="$LOG_DIR" SPUR_INSTALL_LOCK_FILE="$LOCK_FILE" NPM=echo \
  env -u SYSTEMCTL bash "$PKG_SCRIPTS_DIR10/install-and-restart.sh" 1.1.0
rc19=$?
set -e
[ "$rc19" -ne 0 ] || fail "case 19 expected a non-zero exit when reinit fails"
grep -q '{"kind":"blocked","version":"1.1.0","failureKind":"install_unhealthy"' "$LEDGER_FILE19" ||
  fail "case 19 must append the ledger line with no status file: $(cat "$LEDGER_FILE19" 2>&1)"

echo "install-and-restart.test.sh: OK"
