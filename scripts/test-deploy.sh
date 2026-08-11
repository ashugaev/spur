#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK_DIR="$(mktemp -d)"
WEB_PID=""
trap 'kill "$WEB_PID" 2>/dev/null || true; rm -rf "$WORK_DIR"' EXIT

if [[ -n "${SPUR_TEST_DEPLOY_PREFIX:-}" ]]; then
  PREFIX="$SPUR_TEST_DEPLOY_PREFIX"
else
  PREFIX="$WORK_DIR/prefix"
fi

if [[ "$(realpath -m "$PREFIX")" = "$(realpath -m "$HOME/.local")" ]]; then
  echo "test-deploy: refusing production npm prefix $HOME/.local — use a throwaway prefix, e.g. SPUR_TEST_DEPLOY_PREFIX=\$(mktemp -d)/prefix" >&2
  exit 1
fi

pnpm --dir packages/web build

bash "$REPO_ROOT/scripts/bundle-web.sh"

pnpm --dir v2 build

TGZ_NAME="$(cd v2 && npm pack --pack-destination "$WORK_DIR" 2>/dev/null | tail -1)"
TGZ="$WORK_DIR/$TGZ_NAME"

bash "$REPO_ROOT/scripts/verify-package-tarball.sh" "$TGZ"

npm install -g --prefix "$PREFIX" "$TGZ"

WEB_PORT="$(node -e 'const net = require("node:net"); const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") process.exit(1); console.log(address.port); server.close(); });')"

NODE_ENV=production WEB_HOST=127.0.0.1 PORT="$WEB_PORT" \
  node "$PREFIX/lib/node_modules/@shugaev/spur/web/dist-server/web-server.js" &
WEB_PID=$!

echo "test-deploy: web-server.js started (pid=$WEB_PID port=$WEB_PORT)"

code=""
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$WEB_PORT/" || true)"
  if [[ "$code" = "200" ]]; then break; fi
  sleep 1
done
kill "$WEB_PID" 2>/dev/null || true
WEB_PID=""
if [[ "$code" != "200" ]]; then
  echo "test-deploy: web-server.js did not serve HTTP 200 (got $code)" >&2
  exit 1
fi

"$PREFIX/bin/spur" --version
