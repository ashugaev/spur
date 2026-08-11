#!/usr/bin/env bash
# Hermetic tests for scripts/verify-package-tarball.sh and the production-prefix
# refusal in scripts/test-deploy.sh.
#
# a1/a2 invoke verify-package-tarball.sh directly — no build, no install.
# b    drives test-deploy.sh's prefix-refusal with stub npm/pnpm on PATH.
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

# a2: all four present -> exit 0
tgz_a2="$(make_tarball a2 \
  deploy/spur-daemon.npm.service \
  deploy/spur-web.npm.service \
  dist/cli.js \
  web/dist-server/web-server.js)"

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
# Tests four bypass forms: exact, trailing slash, path traversal, dot suffix, symlink.
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

run_b "b-exact"    "$FAKE_HOME/.local"
run_b "b-slash"    "$FAKE_HOME/.local/"
run_b "b-traverse" "$FAKE_HOME/.local/../.local"
run_b "b-dot"      "$FAKE_HOME/.local/."
run_b "b-symlink"  "$FAKE_SYM"

echo ""
echo "test-deploy.test.sh: pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]] || exit 1
