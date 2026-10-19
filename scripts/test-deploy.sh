#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PUBLISHED_TARBALL=""
RELEASE_PROOF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --published-tarball|--release-proof)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "test-deploy: missing argument" >&2; exit 1; }
      if [[ "$1" = --published-tarball ]]; then PUBLISHED_TARBALL="$2"; else RELEASE_PROOF="$2"; fi
      shift 2
      ;;
    *) echo "test-deploy: unknown argument" >&2; exit 1 ;;
  esac
done
if [[ -n "$PUBLISHED_TARBALL" || -n "$RELEASE_PROOF" ]]; then
  [[ -n "$PUBLISHED_TARBALL" && -n "$RELEASE_PROOF" ]] || { echo "test-deploy: published tarball and release proof required" >&2; exit 1; }
fi

WORK_DIR="$(mktemp -d)"
WEB_PID=""
trap 'kill "$WEB_PID" 2>/dev/null || true; rm -rf "$WORK_DIR"' EXIT

if [[ -n "${SPUR_TEST_DEPLOY_PREFIX:-}" ]]; then
  PREFIX="$SPUR_TEST_DEPLOY_PREFIX"
else
  PREFIX="$WORK_DIR/prefix"
fi

# Strip leading/trailing whitespace so a padded value cannot bypass the guard.
PREFIX="${PREFIX#"${PREFIX%%[![:space:]]*}"}"
PREFIX="${PREFIX%"${PREFIX##*[![:space:]]}"}"

if [[ "$(realpath -m "$PREFIX")" = "$(realpath -m "$HOME/.local")" ]]; then
  echo "test-deploy: refusing production npm prefix — use a throwaway prefix" >&2
  exit 1
fi

EXPECTED_VERSION=""
if [[ -n "$PUBLISHED_TARBALL" ]]; then
  [[ -z "${SPUR_TEST_DEPLOY_PREFIX:-}" ]] || { echo "test-deploy: published mode requires its throwaway prefix" >&2; exit 1; }
  [[ -n "${SPUR_ISOLATED_DAEMON_URL:-}" ]] || { echo "test-deploy: owned isolated daemon required" >&2; exit 1; }
  ISOLATED_PORT="$(node -e 'try { const u = new URL(process.argv[1]); if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.port === "4310" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) process.exit(1); console.log(u.port); } catch { process.exit(1); }' "$SPUR_ISOLATED_DAEMON_URL")" || { echo "test-deploy: unsafe isolated daemon URL" >&2; exit 1; }
  node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ server: { host: "127.0.0.1", port: Number(process.argv[2]) }, tmux: { socketName: "spur-" + process.argv[2] } }));' "$WORK_DIR/config.json" "$ISOLATED_PORT"
  export SPUR_CONFIG="$WORK_DIR/config.json"
  export SPUR_DAEMON_URL="$SPUR_ISOLATED_DAEMON_URL"
  export SPUR_TMUX_SOCKET_NAME="spur-$ISOLATED_PORT"
  # Pin the input bytes before verification; never install a caller-replaced path.
  cp "$PUBLISHED_TARBALL" "$WORK_DIR/published.tgz"
  cp "$RELEASE_PROOF" "$WORK_DIR/release-proof.json"
  RELEASE_PROOF="$WORK_DIR/release-proof.json"
  TGZ="$WORK_DIR/published.tgz"
  node "$REPO_ROOT/scripts/test-published-release.mjs" --proof "$RELEASE_PROOF" --tarball "$TGZ" --verify-only
  EXPECTED_VERSION="$(node -e 'const fs = require("node:fs"); try { console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version); } catch { process.exit(1); }' "$RELEASE_PROOF")"
else
  pnpm --dir packages/web build

  bash "$REPO_ROOT/scripts/bundle-web.sh"

  pnpm --dir v2 build

  TGZ_NAME="$(cd v2 && npm pack --pack-destination "$WORK_DIR" 2>/dev/null | tail -1)"
  TGZ="$WORK_DIR/$TGZ_NAME"
fi

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

INSTALLED_VERSION="$("$PREFIX/bin/spur" --version)"
if [[ -n "$EXPECTED_VERSION" && "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "test-deploy: installed version mismatch" >&2
  exit 1
fi
if [[ -n "${SPUR_TEST_DEPLOY_RECEIPT:-}" ]]; then
  node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ installedVersion: process.argv[2], webStatus: 200 }) + "\n", { mode: 0o600 });' "$SPUR_TEST_DEPLOY_RECEIPT" "$INSTALLED_VERSION"
fi
printf '%s\n' "$INSTALLED_VERSION"

# Export only after package verification, installation and the web smoke pass.
if [[ -n "${SPUR_TEST_DEPLOY_EXPORT_DIR:-}" ]]; then
  mkdir -p "$SPUR_TEST_DEPLOY_EXPORT_DIR"
  node --input-type=module - "$REPO_ROOT" "$TGZ" "$SPUR_TEST_DEPLOY_EXPORT_DIR" <<'NODE'
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, tarball, output] = process.argv.slice(2);
const { computeBuildId } = await import(pathToFileURL(`${root}/v2/dist/build-identity.js`).href);
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) throw new Error('candidate export requires a clean committed worktree');
const bytes = readFileSync(tarball);
let packageJson;
try { packageJson = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })); }
catch { throw new Error('invalid packed package metadata'); }
if (packageJson?.name !== '@shugaev/spur' || typeof packageJson.version !== 'string') throw new Error('unexpected packed package');
const manifest = {
  sourceSha, runtimeBuildId: computeBuildId(), packageVersion: packageJson.version, tarball: basename(tarball),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
};
copyFileSync(tarball, join(output, basename(tarball)));
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
fi
