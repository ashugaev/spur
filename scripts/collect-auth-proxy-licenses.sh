#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module="$root/companion/auth-proxy"
output="$root/v2/licenses/auth-proxy"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cd "$module"

export GOTOOLCHAIN="$(go env GOVERSION)"
GOBIN="$scratch/bin" CGO_ENABLED=0 GOOS="$(go env GOHOSTOS)" \
  GOARCH="$(go env GOHOSTARCH)" GOMAXPROCS="${GOMAXPROCS:-2}" \
  go install -p 2 github.com/google/go-licenses/v2@v2.0.1

scan() {
  if ! "$scratch/bin/go-licenses" "$@" 2>"$scratch/scan.log"; then
    echo "auth-proxy dependency license collection failed for linux-$arch" >&2
    return 1
  fi
}

for arch in amd64 arm64; do
  export CGO_ENABLED=0 GOOS=linux GOARCH="$arch"
  target="$scratch/notices/linux-$arch"
  scan save . --ignore github.com/ashugaev/spur --save_path "$target"
  scan report . --ignore github.com/ashugaev/spur >"$scratch/report.csv"
  LC_ALL=C sort "$scratch/report.csv" >"$target/report.csv"
done

mkdir -p "$scratch/notices/go" "$(dirname "$output")"
cp "$(go env GOROOT)/LICENSE" "$(go env GOROOT)/PATENTS" "$scratch/notices/go/"
go env GOVERSION >"$scratch/notices/go/version.txt"
rm -rf "$output"
mv "$scratch/notices" "$output"
