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
FAKE_HOME="$WORK_DIR/b-home"
mkdir -p "$FAKE_HOME"
FAKE_BIN="$WORK_DIR/b-bin"
mkdir -p "$FAKE_BIN"
MARKER="$WORK_DIR/b-marker"

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

set +e
out_b="$(HOME="$FAKE_HOME" SPUR_TEST_DEPLOY_PREFIX="$FAKE_HOME/.local" \
  PATH="$FAKE_BIN:$PATH" bash "$test_deploy_script" 2>&1)"
rc_b=$?
set -e

test_deploy_ref_count="$(echo "$out_b" | grep -c 'test-deploy\.sh' || true)"

if [[ "$rc_b" -eq 0 ]]; then
  bad "b: test-deploy.sh should exit non-zero when prefix equals HOME/.local"
elif [[ -f "$MARKER" ]]; then
  bad "b: stub npm/pnpm was invoked before the prefix refusal (marker exists)"
elif echo "$out_b" | grep -q "refusing production npm prefix"; then
  ok "b: test-deploy.sh refuses production prefix before any build or install"
else
  bad "b: refusal message not found in output (got: $out_b)"
fi

if [[ "$test_deploy_ref_count" -ge 1 ]]; then
  ok "b: refusal message references test-deploy.sh ($test_deploy_ref_count time(s))"
else
  bad "b: refusal message does not reference test-deploy.sh"
fi

echo ""
echo "test-deploy.test.sh: pass=$pass fail=$fail"
[[ "$fail" -eq 0 ]] || exit 1
