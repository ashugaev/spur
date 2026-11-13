#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/repo/scripts" "$work/repo/companion/auth-proxy" "$work/bin"
cp "$repo_root/scripts/build-auth-proxy.sh" "$work/repo/scripts/"
cp "$repo_root/companion/auth-proxy/go.mod" "$work/repo/companion/auth-proxy/"
cat >"$work/repo/scripts/collect-auth-proxy-licenses.sh" <<'COLLECTOR'
#!/usr/bin/env bash
echo notices >>"$AUTH_TEST_LOG"
COLLECTOR

cat >"$work/bin/go" <<'GO'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s %s\n' "$GOTOOLCHAIN" "${GOARCH:-}" "$*" >>"$AUTH_TEST_LOG"
if [[ "$1" == env && "$2" == GOVERSION ]]; then
  echo "${AUTH_TEST_SELECTED_TOOLCHAIN:-$GOTOOLCHAIN}"
  exit "${AUTH_TEST_TOOLCHAIN_RC:-0}"
fi
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then
    shift
    printf '#!/bin/sh\nexit 0\n' >"$1"
    chmod +x "$1"
    exit 0
  fi
  shift
done
exit 1
GO
chmod +x "$work/bin/go"
export PATH="$work/bin:$PATH" AUTH_TEST_LOG="$work/go.log"
builder="$work/repo/scripts/build-auth-proxy.sh"
bash "$builder" --check-toolchain
[[ "$(wc -l <"$AUTH_TEST_LOG")" == 1 ]]
[[ ! -d "$work/repo/v2" ]]
bash "$builder"
for arch in amd64 arm64; do
  [[ -x "$work/repo/v2/bin/auth-proxy/linux-$arch" ]]
  grep -qxF "bin/auth-proxy/linux-$arch" "$repo_root/v2/required-package-files.txt"
done
grep -q 'go1.26.10 amd64 .*build -mod=readonly' "$AUTH_TEST_LOG"
grep -q 'go1.26.10 arm64 .*build -mod=readonly' "$AUTH_TEST_LOG"
grep -qx notices "$AUTH_TEST_LOG"
export AUTH_TEST_TOOLCHAIN_RC=1
if bash "$builder" --check-toolchain; then echo 'toolchain error ignored' >&2; exit 1; fi
export AUTH_TEST_TOOLCHAIN_RC=0 AUTH_TEST_SELECTED_TOOLCHAIN=go1.20.0
if bash "$builder" --check-toolchain 2>/dev/null; then echo 'unsupported bootstrap ignored' >&2; exit 1; fi
printf 'PASS: preflight, pinned toolchain, both executable package targets\n'
