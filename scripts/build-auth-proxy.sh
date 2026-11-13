#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module="$root/companion/auth-proxy"
if ! command -v go >/dev/null 2>&1; then
  echo "auth-proxy build requires Go 1.21+; installed npm packages include the binaries" >&2
  exit 1
fi

while read -r directive value _; do
  if [[ "$directive" == go ]]; then
    export GOTOOLCHAIN="go$value"
    break
  fi
done <"$module/go.mod"

selected_toolchain="$(go env GOVERSION)"
if [[ "$selected_toolchain" != "$GOTOOLCHAIN" ]]; then
  echo "auth-proxy build requires Go 1.21+ with toolchain selection support" >&2
  exit 1
fi
case "${1:-}" in
  --check-toolchain) exit 0 ;;
  "") ;;
  *) echo "usage: build-auth-proxy.sh [--check-toolchain]" >&2; exit 2 ;;
esac

for arch in amd64 arm64; do
  output="$root/v2/bin/auth-proxy/linux-$arch"
  mkdir -p "$(dirname "$output")"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" GOMAXPROCS="${GOMAXPROCS:-2}" \
    go -C "$module" build -mod=readonly -p 2 -trimpath -ldflags='-s -w' -o "$output" .
done

bash "$root/scripts/collect-auth-proxy-licenses.sh"
