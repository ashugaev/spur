#!/usr/bin/env bash
# Hermetic tests for scripts/verify-package-tarball.sh and the production-prefix
# refusal in scripts/test-deploy.sh and tests/integration/onboarding-test.sh.
#
# a1/a1b/a2/a-large  invoke verify-package-tarball.sh directly — no build, no install.
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

make_tarball() {
  local name="$1"
  shift
  local pkg_dir="$WORK_DIR/$name/package"
  mkdir -p "$pkg_dir"
  for entry in "$@"; do
    mkdir -p "$pkg_dir/$(dirname "$entry")"
    touch "$pkg_dir/$entry"
  done
  local tgz="$WORK_DIR/$name.tgz"
  tar -czf "$tgz" -C "$WORK_DIR/$name" package
  echo "$tgz"
}

# a-large: all required entries present at the START, followed by enough
# filler entries to exceed the 64 KiB pipe buffer (grep exits on the first
# match, SIGPIPEs tar, pipefail makes the broken pipe appear as a failure).
# The verifier MUST accept this tarball.
make_large_tarball() {
  local name="$1"
  local dir="$WORK_DIR/$name"
  local pkg_dir="$dir/package"
  mkdir -p "$pkg_dir/deploy" "$pkg_dir/dist" "$pkg_dir/web/dist-server" "$pkg_dir/filler"
  touch "$pkg_dir/deploy/spur-daemon.npm.service"
  touch "$pkg_dir/deploy/spur-web.npm.service"
  touch "$pkg_dir/dist/cli.js"
  touch "$pkg_dir/web/dist-server/web-server.js"
  touch "$pkg_dir/spur.yaml.reference"
  local i=0
  while [ "$i" -lt 5000 ]; do
    printf '%0.s_%.0s' {1..100} >"$pkg_dir/filler/$i.txt"
    i=$((i + 1))
  done
  local tgz="$WORK_DIR/$name.tgz"
  tar -czf "$tgz" -C "$dir" package
  echo "$tgz"
}

tgz_large="$(make_large_tarball large)"

set +e
out_large="$(bash "$verify_script" "$tgz_large" 2>&1)"
rc_large=$?
set -e

if [[ "$rc_large" -eq 0 ]]; then
  ok "a-large: verify-package-tarball.sh accepts large tarball (no SIGPIPE false rejection)"
else
  bad "a-large: verify-package-tarball.sh rejected large tarball (got: $out_large)"
fi

# a1: missing web/dist-server/web-server.js -> non-zero, names the file
tgz_a1="$(make_tarball a1 \
  deploy/spur-daemon.npm.service \
  deploy/spur-web.npm.service \
  dist/cli.js)"

set +e
out_a1="$(bash "$verify_script" "$tgz_a1" 2>&1)"
rc_a1=$?
set -e

if [[ "$rc_a1" -eq 0 ]]; then
  bad "a1: verify-package-tarball.sh should exit non-zero for incomplete tarball"
elif echo "$out_a1" | grep -qF "web/dist-server/web-server.js"; then
  ok "a1: verify-package-tarball.sh rejects incomplete tarball, names missing file"
else
  bad "a1: output did not name web/dist-server/web-server.js (got: $out_a1)"
fi

# a1b: tarball with web-server.js.map but no web-server.js -> rejected (unanchored-match hole)
tgz_a1b="$(make_tarball a1b \
  deploy/spur-daemon.npm.service \
  deploy/spur-web.npm.service \
  dist/cli.js \
  "web/dist-server/web-server.js.map")"

set +e
out_a1b="$(bash "$verify_script" "$tgz_a1b" 2>&1)"
rc_a1b=$?
set -e

if [[ "$rc_a1b" -eq 0 ]]; then
  bad "a1b: tarball with only web-server.js.map should be rejected"
elif echo "$out_a1b" | grep -qF "web/dist-server/web-server.js"; then
  ok "a1b: verify-package-tarball.sh rejects .map-only tarball, names missing file"
else
  bad "a1b: output did not name web/dist-server/web-server.js (got: $out_a1b)"
fi

# a2: all required entries present -> exit 0
tgz_a2="$(make_tarball a2 \
  deploy/spur-daemon.npm.service \
  deploy/spur-web.npm.service \
  dist/cli.js \
  web/dist-server/web-server.js \
  spur.yaml.reference)"

set +e
bash "$verify_script" "$tgz_a2" 2>&1
rc_a2=$?
set -e

if [[ "$rc_a2" -eq 0 ]]; then
  ok "a2: verify-package-tarball.sh accepts complete tarball"
else
  bad "a2: verify-package-tarball.sh exited $rc_a2 on complete tarball"
fi

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
c_out="$(HOME="$C_HOME" PATH="$C_BIN:$PATH" timeout 10 bash "$ONBOARDING_SCRIPT" 2>&1)"
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
