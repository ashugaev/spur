#!/usr/bin/env bash
# Smoke test for scripts/install-and-restart.sh. Runs the helper with stubbed
# NPM/SYSTEMCTL/CURL commands so it cannot mutate the host, then asserts the
# log output, switch-state file, and symlink layout.
#
# Run directly: bash v2/test/install-and-restart.test.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/../scripts/install-and-restart.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/install-and-restart.log"
BIN_DIR="$ROOT/bin"
mkdir -p "$BIN_DIR"

# npm stub: materializes the per-version package dir the script expects.
# Args: install -g --prefix <prefix> @shugaev/spur@<version>
cat >"$BIN_DIR/npm-stub" <<'EOF'
#!/usr/bin/env bash
prefix=""
spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    install|-g) shift ;;
    *) spec="$1"; shift ;;
  esac
done
pkg_dir="$prefix/lib/node_modules/@shugaev/spur"
mkdir -p "$pkg_dir/dist"
echo "cli" >"$pkg_dir/dist/cli.js"
echo "npm-stub install $spec prefix=$prefix"
EOF
chmod +x "$BIN_DIR/npm-stub"

# curl stub: prints an /info body with the version from CURL_STUB_VERSION.
cat >"$BIN_DIR/curl-stub" <<'EOF'
#!/usr/bin/env bash
printf '{"ok":true,"version":"%s"}' "${CURL_STUB_VERSION:-0.0.0}"
EOF
chmod +x "$BIN_DIR/curl-stub"

state_file() { cat "$1/deploy/switch-state.json"; }

fail() {
  echo "FAIL: $1" >&2
  [ -f "$LOG_FILE" ] && cat "$LOG_FILE" >&2
  exit 1
}

fresh_data_dir() {
  local dir="$ROOT/data-$1"
  mkdir -p "$dir"
  echo "$dir"
}

run_helper() {
  local data_dir="$1"
  shift
  SPUR_DATA_DIR="$data_dir" SPUR_INSTALL_LOG_DIR="$LOG_DIR" \
    NPM="$BIN_DIR/npm-stub" SYSTEMCTL=echo CURL="$BIN_DIR/curl-stub" \
    SPUR_HEALTH_ATTEMPTS=2 SPUR_HEALTH_INTERVAL=0 \
    bash "$HELPER" "$@"
}

# Case 1: healthy switch — install, flip, restart, state done.
DATA="$(fresh_data_dir 1)"
rm -f "$LOG_FILE"
if ! CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=1.0.0 run_helper "$DATA" 1.2.3; then
  fail "helper exited non-zero on healthy switch"
fi
grep -q "switch 1.0.0 -> 1.2.3" "$LOG_FILE" || fail "log missing switch line"
grep -q "npm-stub install @shugaev/spur@1.2.3" "$LOG_FILE" || fail "log missing npm argv"
grep -q "restart spur-daemon.service spur-web.service" "$LOG_FILE" || fail "log missing restart argv"
[ "$(readlink "$DATA/current")" = "$DATA/versions/1.2.3/lib/node_modules/@shugaev/spur" ] ||
  fail "current symlink not flipped to 1.2.3"
state_file "$DATA" | grep -q '"phase":"done"' || fail "state not done"
state_file "$DATA" | grep -q '"from":"1.0.0"' || fail "state missing from"
state_file "$DATA" | grep -q '"finishedAt"' || fail "state missing finishedAt"

# Case 2: alpha version accepted end-to-end.
DATA="$(fresh_data_dir 2)"
rm -f "$LOG_FILE"
CURL_STUB_VERSION=1.3.0-alpha.4 SPUR_CURRENT_VERSION=1.2.3 run_helper "$DATA" 1.3.0-alpha.4 ||
  fail "alpha switch exited non-zero"
[ "$(readlink "$DATA/current")" = "$DATA/versions/1.3.0-alpha.4/lib/node_modules/@shugaev/spur" ] ||
  fail "current symlink not flipped to alpha"

# Case 3: invalid versions exit 2 without touching state.
DATA="$(fresh_data_dir 3)"
for bad in bogus 1.2.3-beta.1 1.2.3-alpha; do
  rm -f "$LOG_FILE"
  set +e
  run_helper "$DATA" "$bad"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "expected exit 2 for $bad, got $rc"
  grep -q "invalid version: $bad" "$LOG_FILE" || fail "log missing rejection for $bad"
  [ ! -f "$DATA/deploy/switch-state.json" ] || fail "state written for invalid version $bad"
done

# Case 4: npm install failure — exit 4, state failed, symlink untouched.
DATA="$(fresh_data_dir 4)"
rm -f "$LOG_FILE"
set +e
SPUR_DATA_DIR="$DATA" SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM=false SYSTEMCTL=echo \
  CURL="$BIN_DIR/curl-stub" SPUR_CURRENT_VERSION=1.0.0 bash "$HELPER" 1.2.3
rc=$?
set -e
[ "$rc" -eq 4 ] || fail "expected exit 4 on npm failure, got $rc"
state_file "$DATA" | grep -q '"phase":"failed"' || fail "state not failed after npm failure"
state_file "$DATA" | grep -q '"error":"npm install failed' || fail "state missing npm error"
[ ! -e "$DATA/current" ] || fail "symlink created despite npm failure"

# Case 5: healthcheck stuck on the old version — rollback, exit 5.
DATA="$(fresh_data_dir 5)"
rm -f "$LOG_FILE"
mkdir -p "$DATA/versions/1.0.0/lib/node_modules/@shugaev/spur/dist"
ln -s "$DATA/versions/1.0.0/lib/node_modules/@shugaev/spur" "$DATA/current"
set +e
CURL_STUB_VERSION=1.0.0 SPUR_CURRENT_VERSION=1.0.0 run_helper "$DATA" 1.2.3
rc=$?
set -e
[ "$rc" -eq 5 ] || fail "expected exit 5 on rollback, got $rc"
[ "$(readlink "$DATA/current")" = "$DATA/versions/1.0.0/lib/node_modules/@shugaev/spur" ] ||
  fail "symlink not rolled back to previous version"
state_file "$DATA" | grep -q '"phase":"rolled_back"' || fail "state not rolled_back"
state_file "$DATA" | grep -q '"error":"healthcheck timeout' || fail "state missing health error"
[ "$(grep -c "restart spur-daemon.service spur-web.service" "$LOG_FILE")" -ge 2 ] ||
  fail "rollback restart not logged"

# Case 6: healthcheck fails with no previous version — state failed, exit 6.
DATA="$(fresh_data_dir 6)"
rm -f "$LOG_FILE"
set +e
CURL_STUB_VERSION=0.0.0 SPUR_CURRENT_VERSION=unknown run_helper "$DATA" 1.2.3
rc=$?
set -e
[ "$rc" -eq 6 ] || fail "expected exit 6 without rollback target, got $rc"
state_file "$DATA" | grep -q '"phase":"failed"' || fail "state not failed without rollback target"
state_file "$DATA" | grep -q "no previous version" || fail "state missing no-previous error"

# Case 7: backup copies config.yaml and root JSON, never sessions/.
DATA="$(fresh_data_dir 7)"
rm -f "$LOG_FILE"
echo "cfg" >"$DATA/config.yaml"
echo "{}" >"$DATA/root-state.json"
mkdir -p "$DATA/sessions/demo"
echo "{}" >"$DATA/sessions/demo/session.json"
CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=1.0.0 run_helper "$DATA" 1.2.3 ||
  fail "backup case switch failed"
[ -f "$DATA/deploy/backup-1.0.0/config.yaml" ] || fail "backup missing config.yaml"
[ -f "$DATA/deploy/backup-1.0.0/root-state.json" ] || fail "backup missing root JSON"
[ ! -e "$DATA/deploy/backup-1.0.0/session.json" ] || fail "backup copied sessions content"

# Case 8: GC keeps newest three versions plus target and previous.
DATA="$(fresh_data_dir 8)"
rm -f "$LOG_FILE"
for v in 0.9.0 0.9.1 0.9.2 0.9.3; do
  mkdir -p "$DATA/versions/$v/lib/node_modules/@shugaev/spur/dist"
  touch -d "2026-01-0$((${v##*.} + 1))" "$DATA/versions/$v" 2>/dev/null || true
done
ln -s "$DATA/versions/0.9.3/lib/node_modules/@shugaev/spur" "$DATA/current"
CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=0.9.3 run_helper "$DATA" 1.2.3 ||
  fail "gc case switch failed"
[ -d "$DATA/versions/1.2.3" ] || fail "gc removed target"
[ -d "$DATA/versions/0.9.3" ] || fail "gc removed previous version"
[ "$(ls -1 "$DATA/versions" | wc -l)" -le 4 ] || fail "gc kept too many versions"
grep -q "gc removed" "$LOG_FILE" || fail "gc did not remove any old version"

# Case 9: log rotation truncates a >1 MB log on start.
DATA="$(fresh_data_dir 9)"
mkdir -p "$LOG_DIR"
head -c 1100000 /dev/zero | tr '\0' 'x' >"$LOG_FILE"
CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=1.0.0 run_helper "$DATA" 1.2.3 ||
  fail "rotation case switch failed"
[ "$(wc -c <"$LOG_FILE")" -lt 1048576 ] || fail "log not truncated"

# Case 10: systemctl missing — symlink flipped, state done, exit 0.
DATA="$(fresh_data_dir 10)"
rm -f "$LOG_FILE"
SPUR_DATA_DIR="$DATA" SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM="$BIN_DIR/npm-stub" \
  SYSTEMCTL=/nonexistent/spur-test-systemctl CURL="$BIN_DIR/curl-stub" \
  SPUR_CURRENT_VERSION=1.0.0 bash "$HELPER" 1.2.3 ||
  fail "systemctl-missing case exited non-zero"
grep -q "systemctl not available, manual restart required" "$LOG_FILE" ||
  fail "log missing manual-restart hint"
state_file "$DATA" | grep -q '"phase":"done"' || fail "state not done without systemctl"
[ "$(readlink "$DATA/current")" = "$DATA/versions/1.2.3/lib/node_modules/@shugaev/spur" ] ||
  fail "symlink not flipped without systemctl"

# Case 11: multi-word SYSTEMCTL override splits into command + args.
DATA="$(fresh_data_dir 11)"
rm -f "$LOG_FILE"
SPUR_DATA_DIR="$DATA" SPUR_INSTALL_LOG_DIR="$LOG_DIR" NPM="$BIN_DIR/npm-stub" \
  SYSTEMCTL="echo --user" CURL="$BIN_DIR/curl-stub" \
  SPUR_HEALTH_ATTEMPTS=2 SPUR_HEALTH_INTERVAL=0 \
  CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=1.0.0 bash "$HELPER" 1.2.3 ||
  fail "multi-word systemctl case failed"
grep -q -- "--user restart spur-daemon.service spur-web.service" "$LOG_FILE" ||
  fail "log missing multi-word systemctl argv"

# Case 12: concurrent run blocked by the lock, exit 3.
DATA="$(fresh_data_dir 12)"
rm -f "$LOG_FILE"
mkdir -p "$DATA/deploy"
exec 8>"$DATA/deploy/switch.lock"
flock -n 8 || fail "test could not take the lock"
set +e
CURL_STUB_VERSION=1.2.3 SPUR_CURRENT_VERSION=1.0.0 run_helper "$DATA" 1.2.3
rc=$?
set -e
exec 8>&-
[ "$rc" -eq 3 ] || fail "expected exit 3 when lock held, got $rc"
grep -q "lock held" "$LOG_FILE" || fail "log missing lock-held line"

echo "install-and-restart.test.sh: OK"
