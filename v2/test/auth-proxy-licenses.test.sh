#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts" "$fixture/companion/auth-proxy" "$fixture/probe-bin" "$fixture/goroot"
cp "$root/scripts/collect-auth-proxy-licenses.sh" "$fixture/scripts/"
printf 'runtime license\n' >"$fixture/goroot/LICENSE"
printf 'runtime patent grant\n' >"$fixture/goroot/PATENTS"
export LICENSE_FIXTURE="$fixture" LICENSE_CALLS="$fixture/calls"

cat >"$fixture/probe-bin/go" <<'GO'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == env ]]; then
  case "$2" in
    GOVERSION) echo go1.26.10 ;;
    GOHOSTOS) echo linux ;;
    GOHOSTARCH) echo amd64 ;;
    GOROOT) echo "$LICENSE_FIXTURE/goroot" ;;
    *) exit 91 ;;
  esac
  exit
fi
[[ "$*" == 'install -p 2 github.com/google/go-licenses/v2@v2.0.1' ]]
[[ "$GOOS" == linux && "$GOARCH" == amd64 ]]
mkdir -p "$GOBIN"
cat >"$GOBIN/go-licenses" <<'SCANNER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$GOOS" == linux && "$CGO_ENABLED" == 0 ]]
printf '%s:%s\n' "$GOARCH" "$1" >>"$LICENSE_CALLS"
echo "$LICENSE_FIXTURE/private-user/module-cache: scanner warning" >&2
[[ "$GOARCH" != "${LICENSE_FAIL_ARCH:-none}" ]] || exit 42
if [[ "$1" == report ]]; then
  echo 'example.com/dependency,https://example.test/LICENSE,MIT'
  exit
fi
[[ "$1" == save ]]
while [[ "$1" != --save_path ]]; do shift; done
mkdir -p "$2/example.com/dependency"
printf 'dependency license\n' >"$2/example.com/dependency/LICENSE"
printf 'dependency notice\n' >"$2/example.com/dependency/NOTICE"
SCANNER
chmod +x "$GOBIN/go-licenses"
GO
chmod +x "$fixture/probe-bin/go"
export PATH="$fixture/probe-bin:$PATH"

bash "$fixture/scripts/collect-auth-proxy-licenses.sh"
output="$fixture/v2/licenses/auth-proxy"
for arch in amd64 arm64; do
  test -s "$output/linux-$arch/example.com/dependency/LICENSE"
  test -s "$output/linux-$arch/example.com/dependency/NOTICE"
  grep -qxF 'example.com/dependency,https://example.test/LICENSE,MIT' "$output/linux-$arch/report.csv"
  grep -qxF "$arch:save" "$LICENSE_CALLS"
  grep -qxF "$arch:report" "$LICENSE_CALLS"
done
cmp "$fixture/goroot/LICENSE" "$output/go/LICENSE"
cmp "$fixture/goroot/PATENTS" "$output/go/PATENTS"
grep -qxF go1.26.10 "$output/go/version.txt"

printf 'preserve prior complete notices\n' >"$output/preserved"
if LICENSE_FAIL_ARCH=arm64 bash "$fixture/scripts/collect-auth-proxy-licenses.sh" >"$fixture/failure.log" 2>&1; then
  echo 'FAIL: failed dependency scan accepted' >&2
  exit 1
fi
test -s "$output/preserved"
grep -qxF 'auth-proxy dependency license collection failed for linux-arm64' "$fixture/failure.log"
if grep -qF "$fixture" "$fixture/failure.log"; then
  echo 'FAIL: scanner filesystem paths leaked' >&2
  exit 1
fi

echo 'auth-proxy-licenses.test.sh: OK'
