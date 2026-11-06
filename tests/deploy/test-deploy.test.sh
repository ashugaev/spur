#!/usr/bin/env bash
# Hermetic tests for scripts/verify-package-tarball.sh and the production-prefix
# refusal in scripts/test-deploy.sh and tests/integration/onboarding-test.sh.
#
# a                  verifies exact Node-helper dispatch and failure propagation.
# Archive/required-entry phase fixtures live in review-app-distribution.test.ts.
# b                  drives test-deploy.sh's prefix-refusal with stub npm/pnpm on PATH.
# c                  drives onboarding-test.sh's prefix-refusal with stub npm on PATH.
#
# Run directly: bash tests/deploy/test-deploy.test.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verify_script="$repo_root/scripts/verify-package-tarball.sh"
test_deploy_script="$repo_root/scripts/test-deploy.sh"

pass=0
fail=0
ok() {
  printf 'ok - %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf 'NOT OK - %s\n' "$1"
  fail=$((fail + 1))
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
VERIFY_BIN="$WORK_DIR/verify-bin"
mkdir -p "$VERIFY_BIN"
cat >"$VERIFY_BIN/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$VERIFY_ARGV_LOG"
exit "$VERIFY_STUB_EXIT"
EOF
chmod +x "$VERIFY_BIN/node"

run_dispatch() {
  local label="$1" expected="$2"
  shift 2
  local argv_log="$WORK_DIR/argv" expected_log="$WORK_DIR/expected-argv"
  rm -f "$argv_log"
  set +e
  PATH="$VERIFY_BIN:$PATH" VERIFY_ARGV_LOG="$argv_log" VERIFY_STUB_EXIT="$expected" \
    bash "$verify_script" "$@" >/dev/null 2>&1
  local result=$?
  set -e
  printf '%s\0' "$repo_root/scripts/verify-review-app-package.mjs" --tarball "$1" > "$expected_log"
  if [[ "$result" -eq "$expected" ]] && cmp -s "$argv_log" "$expected_log"; then
    ok "$label: exact helper argv and exit propagation"
  else
    bad "$label: helper dispatch mismatch"
  fi
}

run_dispatch "a-success" 0 "$WORK_DIR/input with spaces.tgz"
run_dispatch "a-failure" 17 "$WORK_DIR/input with spaces.tgz"
for mode in missing extra; do
  rm -f "$WORK_DIR/argv"
  args=()
  [[ "$mode" = extra ]] && args=(first.tgz second.tgz)
  if PATH="$VERIFY_BIN:$PATH" VERIFY_ARGV_LOG="$WORK_DIR/argv" VERIFY_STUB_EXIT=0 \
    bash "$verify_script" "${args[@]}" >/dev/null 2>&1; then
    bad "a-$mode: invalid grammar accepted"
  elif [[ -e "$WORK_DIR/argv" ]]; then
    bad "a-$mode: helper invoked before argument rejection"
  else
    ok "a-$mode: invalid grammar rejected before helper"
  fi
done

# b: SPUR_TEST_DEPLOY_PREFIX == HOME/.local -> refusal before any build/install
# Covers: exact, trailing slash, path traversal, dot suffix, symlink, leading space, trailing space.
FAKE_HOME="$WORK_DIR/b-home"
mkdir -p "$FAKE_HOME/.local"
FAKE_BIN="$WORK_DIR/b-bin"
mkdir -p "$FAKE_BIN"
MARKER="$WORK_DIR/b-marker"
FAKE_SYM="$WORK_DIR/b-sym"
ln -s "$FAKE_HOME/.local" "$FAKE_SYM"

cat >"$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
touch "$MARKER"
exit 0
EOF
cat >"$FAKE_BIN/pnpm" <<EOF
#!/usr/bin/env bash
touch "$MARKER"
exit 0
EOF
chmod +x "$FAKE_BIN/npm" "$FAKE_BIN/pnpm"

run_b() {
  local label="$1"
  local prefix="$2"
  rm -f "$MARKER"
  set +e
  local out
  out="$(HOME="$FAKE_HOME" SPUR_TEST_DEPLOY_PREFIX="$prefix" \
    PATH="$FAKE_BIN:$PATH" bash "$test_deploy_script" 2>&1)"
  local rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    bad "$label: should exit non-zero (got 0)"
  elif [[ -f "$MARKER" ]]; then
    bad "$label: stub was invoked before refusal (marker exists)"
  elif echo "$out" | grep -q "refusing production npm prefix"; then
    ok "$label: refuses production prefix"
  else
    bad "$label: refusal message not found (got: $out)"
  fi
}

run_b "b-exact"          "$FAKE_HOME/.local"
run_b "b-slash"          "$FAKE_HOME/.local/"
run_b "b-traverse"       "$FAKE_HOME/.local/../.local"
run_b "b-dot"            "$FAKE_HOME/.local/."
run_b "b-symlink"        "$FAKE_SYM"
run_b "b-leading-space"  " $FAKE_HOME/.local"
run_b "b-trailing-space" "$FAKE_HOME/.local "

# c: onboarding-test.sh guard — npm prefix == HOME/.local with trailing slash
# Placed here because it tests the same prefix-refusal boundary as the b-cases.
ONBOARDING_SCRIPT="$repo_root/tests/integration/onboarding-test.sh"
C_HOME="$WORK_DIR/c-home"
mkdir -p "$C_HOME/.local"
C_BIN="$WORK_DIR/c-bin"
mkdir -p "$C_BIN"
C_MARKER="$WORK_DIR/c-marker"

# Stub npm: return the trailing-slash prefix for "config get prefix"; touch marker otherwise.
cat >"$C_BIN/npm" <<EOF
#!/usr/bin/env bash
if [[ "\$1" = "config" && "\$2" = "get" && "\$3" = "prefix" ]]; then
  echo "$C_HOME/.local/"
  exit 0
fi
touch "$C_MARKER"
exit 0
EOF
chmod +x "$C_BIN/npm"

rm -f "$C_MARKER"
set +e
c_out="$(HOME="$C_HOME" PATH="$C_BIN:$PATH" timeout --foreground 10 bash "$ONBOARDING_SCRIPT" 2>&1)"
c_rc=$?
set -e

if [[ "$c_rc" -eq 0 ]]; then
  bad "c-slash: onboarding-test.sh should exit non-zero for trailing-slash prefix (got 0)"
elif [[ -f "$C_MARKER" ]]; then
  bad "c-slash: npm stub was invoked after refusal (marker exists)"
elif echo "$c_out" | grep -q "onboarding-test: refusing production npm prefix"; then
  ok "c-slash: onboarding-test.sh refuses trailing-slash production prefix"
else
  bad "c-slash: refusal marker line not found (got: $c_out)"
fi

echo ""
echo "test-deploy.test.sh: pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]] || exit 1
