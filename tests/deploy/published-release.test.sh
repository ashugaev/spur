#!/usr/bin/env bash
# Verify the publication/deploy boundary with registry and GitHub transport fixtures.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin" "$work_dir/package/dist" "$work_dir/package/deploy" \
  "$work_dir/package/web/dist-server" "$work_dir/package/skills/spur"
printf '%s\n' '{"name":"@shugaev/spur","version":"1.2.3"}' >"$work_dir/package/package.json"
touch "$work_dir/package/deploy/spur-daemon.npm.service" "$work_dir/package/deploy/spur-web.npm.service" \
  "$work_dir/package/spur.yaml.reference" "$work_dir/package/skills/spur/SKILL.md"
cat >"$work_dir/package/dist/cli.js" <<'EOF'
console.log('1.2.3');
EOF
cat >"$work_dir/package/web/dist-server/web-server.js" <<'EOF'
require('node:http').createServer((req, res) => res.end('Spur test')).listen(Number(process.env.PORT), '127.0.0.1');
EOF
tar -czf "$work_dir/package.tgz" -C "$work_dir" package
cat >"$work_dir/registry.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
globalThis.fetch = async url => {
  if (url.origin !== 'https://registry.npmjs.org') throw new Error('unexpected registry');
  const bytes = url.pathname.endsWith('.tgz')
    ? readFileSync(`${process.env.FIXTURE_DIR}/package.tgz`)
    : readFileSync(`${process.env.FIXTURE_DIR}/metadata.json`);
  return { ok: true, arrayBuffer: async () => bytes };
};
EOF
cat >"$work_dir/bin/gh" <<'EOF'
#!/usr/bin/env node
const fs = require('node:fs');
const endpoint = process.argv[3];
const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const wrong = process.env.BAD_EVIDENCE;
let result;
if (endpoint.includes('/actions/runs/')) result = { id: 12, head_sha: head, event: 'push', path: '.github/workflows/release.yml', status: 'completed', conclusion: wrong === 'run' ? 'failure' : 'success' };
else if (endpoint.includes('/releases/tags/')) result = { id: 14, tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [{ id: 15, name: 'spur-1.2.3.tgz' }] };
else if (endpoint.includes('/git/ref/')) result = { object: { type: 'commit', sha: wrong === 'tag' ? merge : head } };
else if (endpoint.includes('/compare/')) result = { status: wrong === 'ancestry' ? 'diverged' : 'ahead', merge_base_commit: { sha: merge } };
else if (endpoint.includes('/releases/assets/')) {
  process.stdout.write(wrong === 'asset' ? Buffer.from('wrong asset') : fs.readFileSync(`${process.env.FIXTURE_DIR}/package.tgz`));
  process.exit(0);
} else process.exit(1);
console.log(JSON.stringify(result));
EOF
cat >"$work_dir/bin/npm" <<'EOF'
#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'install' || args[1] !== '-g' || args[2] !== '--prefix') process.exit(1);
fs.writeFileSync(`${process.env.FIXTURE_DIR}/installed`, 'yes');
const prefix = args[3];
const dir = `${prefix}/lib/node_modules/@shugaev/spur`;
fs.mkdirSync(dir, { recursive: true });
if (spawnSync('tar', ['-xzf', args[4], '-C', dir, '--strip-components=1']).status !== 0) process.exit(1);
fs.mkdirSync(`${prefix}/bin`, { recursive: true });
fs.writeFileSync(`${prefix}/bin/spur`, '#!/usr/bin/env node\nconsole.log("1.2.3");\n', { mode: 0o755 });
EOF
cat >"$work_dir/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "published mode must not build checkout" >&2
exit 1
EOF
chmod +x "$work_dir/bin/gh" "$work_dir/bin/npm" "$work_dir/bin/pnpm"
export FIXTURE_DIR="$work_dir" PATH="$work_dir/bin:$PATH"
export NODE_OPTIONS="--import=$work_dir/registry.mjs"
export SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:4399"
node --input-type=module - "$work_dir" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = process.argv[2];
const integrity = `sha512-${createHash('sha512').update(readFileSync(`${dir}/package.tgz`)).digest('base64')}`;
writeFileSync(`${dir}/proof.json`, JSON.stringify({ repository: 'fixture/spur', mergeSha: 'b'.repeat(40), gitHead: 'a'.repeat(40), version: '1.2.3', integrity, tag: 'v1.2.3', releaseRunId: 12 }));
writeFileSync(`${dir}/metadata.json`, JSON.stringify({ name: '@shugaev/spur', version: '1.2.3', gitHead: 'a'.repeat(40), dist: { integrity, tarball: 'https://registry.npmjs.org/@shugaev/spur/-/spur-1.2.3.tgz' } }));
EOF
script="$repo_root/scripts/test-published-release.mjs"
node "$script" --proof "$work_dir/proof.json" --output "$work_dir/deployed.json"
node --input-type=module - "$work_dir/deployed.json" <<'EOF'
import { readFileSync } from 'node:fs';
const proof = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (proof.installedVersion !== '1.2.3' || proof.webStatus !== 200 || !/^[a-f0-9]{64}$/.test(proof.packageSha256)) process.exit(1);
EOF
printf 'ok - published registry bytes installed and served HTTP 200\n'
reject() {
  local label="$1"
  shift
  rm -f "$work_dir/installed"
  if "$@" >"$work_dir/negative.log" 2>&1; then
    echo "NOT OK - $label" >&2; exit 1
  fi
  [[ ! -f "$work_dir/installed" ]] || { echo "NOT OK - installed rejected publication" >&2; exit 1; }
  printf 'ok - %s\n' "$label"
}
for evidence in run tag ancestry asset; do
  reject "$evidence binding rejected" env BAD_EVIDENCE="$evidence" node "$script" --proof "$work_dir/proof.json" --output "$work_dir/rejected.json"
done
for field in version gitHead integrity name; do
  cp "$work_dir/metadata.json" "$work_dir/original.json"
  node --input-type=module - "$work_dir" "$field" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2], field = process.argv[3];
const metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8'));
if (field === 'integrity') metadata.dist.integrity = 'sha512-' + 'A'.repeat(86) + '==';
else metadata[field] = field === 'gitHead' ? 'c'.repeat(40) : 'wrong';
writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata));
EOF
  reject "npm $field rejected" node "$script" --proof "$work_dir/proof.json" --output "$work_dir/rejected.json"
  mv "$work_dir/original.json" "$work_dir/metadata.json"
done
printf 'checkout-pack substitute' >"$work_dir/local.tgz"
reject 'local source tarball rejected' node "$script" --proof "$work_dir/proof.json" --tarball "$work_dir/local.tgz" --verify-only
reject 'missing release evidence rejected' node "$script" --output "$work_dir/rejected.json"
reject 'production prefix rejected' env SPUR_TEST_DEPLOY_PREFIX="$HOME/.local" bash "$repo_root/scripts/test-deploy.sh" --published-tarball "$work_dir/package.tgz" --release-proof "$work_dir/proof.json"
reject 'missing isolated daemon rejected' env -u SPUR_ISOLATED_DAEMON_URL bash "$repo_root/scripts/test-deploy.sh" --published-tarball "$work_dir/package.tgz" --release-proof "$work_dir/proof.json"
reject 'production daemon rejected' env SPUR_ISOLATED_DAEMON_URL=http://127.0.0.1:4310 bash "$repo_root/scripts/test-deploy.sh" --published-tarball "$work_dir/package.tgz" --release-proof "$work_dir/proof.json"
cp "$work_dir/metadata.json" "$work_dir/original.json"
printf 'invalid JSON' >"$work_dir/metadata.json"
reject 'malformed registry JSON rejected' node "$script" --proof "$work_dir/proof.json" --output "$work_dir/rejected.json"
mv "$work_dir/original.json" "$work_dir/metadata.json"
node --input-type=module - "$work_dir" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
const metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8'));
metadata.dist.tarball = 'file:///package.tgz';
writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata));
EOF
reject 'nonregistry tarball rejected' node "$script" --proof "$work_dir/proof.json" --output "$work_dir/rejected.json"
printf '%s\n' '{"name":"@shugaev/spur","version":"9.9.9"}' >"$work_dir/package/package.json"
tar -czf "$work_dir/package.tgz" -C "$work_dir" package
node --input-type=module - "$work_dir" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = process.argv[2];
const integrity = `sha512-${createHash('sha512').update(readFileSync(`${dir}/package.tgz`)).digest('base64')}`;
const proof = JSON.parse(readFileSync(`${dir}/proof.json`, 'utf8'));
proof.integrity = integrity;
writeFileSync(`${dir}/proof.json`, JSON.stringify(proof));
const metadata = JSON.parse(readFileSync(`${dir}/metadata.json`, 'utf8'));
metadata.dist = { integrity, tarball: 'https://registry.npmjs.org/@shugaev/spur/-/spur-1.2.3.tgz' };
writeFileSync(`${dir}/metadata.json`, JSON.stringify(metadata));
EOF
reject 'tarball manifest version rejected despite matching integrity' node "$script" --proof "$work_dir/proof.json" --output "$work_dir/rejected.json"
printf 'published-release.test.sh: PASS\n'
