#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageName = '@shugaev/spur';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('invalid JSON evidence');
  }
}

async function gh(endpoint) {
  const { stdout } = await execFile('gh', ['api', endpoint], { maxBuffer: 4 * 1024 * 1024 });
  return parseJson(stdout);
}

async function registryBytes(url) {
  const target = new URL(url);
  requireEvidence(target.origin === 'https://registry.npmjs.org' && !target.username && !target.password,
    'tarball must come from the npm registry');
  const response = await globalThis.fetch(target, { redirect: 'error', signal: globalThis.AbortSignal.timeout(120_000) });
  requireEvidence(response.ok, 'npm registry request failed');
  return Buffer.from(await response.arrayBuffer());
}

function verifyIntegrity(bytes, integrity) {
  requireEvidence(`sha512-${createHash('sha512').update(bytes).digest('base64')}` === integrity,
    'published tarball integrity mismatch');
}

async function main() {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const name = process.argv[i];
    requireEvidence(['--proof', '--output', '--tarball', '--verify-only'].includes(name) && !options.has(name),
      'usage: test-published-release.mjs --proof <file> --output <file>');
    if (name === '--verify-only') options.set(name, true);
    else {
      const value = process.argv[++i];
      requireEvidence(value && !value.startsWith('--'), 'missing argument value');
      options.set(name, value);
    }
  }
  requireEvidence(typeof options.get('--proof') === 'string', 'release proof required');
  const verifyOnly = options.get('--verify-only') === true;
  requireEvidence(verifyOnly ? typeof options.get('--tarball') === 'string' && !options.has('--output')
    : typeof options.get('--output') === 'string' && !options.has('--tarball'), 'invalid deployment arguments');
  const proof = parseJson(await readFile(options.get('--proof'), 'utf8'));
  requireEvidence(proof && typeof proof === 'object' && !Array.isArray(proof), 'invalid release proof');
  requireEvidence(typeof proof.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(proof.repository),
    'invalid repository');
  requireEvidence(typeof proof.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(proof.version),
    'invalid semantic version');
  for (const field of ['mergeSha', 'gitHead']) requireEvidence(typeof proof[field] === 'string'
    && /^[a-f0-9]{40}$/.test(proof[field]), `invalid ${field}`);
  requireEvidence(proof.tag === `v${proof.version}`, 'release tag/version mismatch');
  requireEvidence(typeof proof.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(proof.integrity),
    'invalid npm integrity');
  requireEvidence(Number.isSafeInteger(proof.releaseRunId) && proof.releaseRunId > 0, 'release run required');

  const metadata = parseJson(await registryBytes(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${proof.version}`));
  requireEvidence(metadata.name === packageName && metadata.version === proof.version, 'npm package/version mismatch');
  requireEvidence(metadata.gitHead === proof.gitHead, 'npm gitHead mismatch');
  requireEvidence(metadata.dist?.integrity === proof.integrity && typeof metadata.dist.tarball === 'string',
    'npm integrity evidence mismatch');
  const tarballUrl = new URL(metadata.dist.tarball);
  requireEvidence(tarballUrl.origin === 'https://registry.npmjs.org' && !tarballUrl.username && !tarballUrl.password,
    'tarball must come from the npm registry');
  const base = `repos/${proof.repository}`;
  const run = await gh(`${base}/actions/runs/${proof.releaseRunId}`);
  requireEvidence(run.id === proof.releaseRunId && run.head_sha === proof.gitHead && run.event === 'push'
    && run.path === '.github/workflows/release.yml' && run.status === 'completed' && run.conclusion === 'success',
  'successful matching release run required');
  const release = await gh(`${base}/releases/tags/${proof.tag}`);
  requireEvidence(release.tag_name === proof.tag && release.draft === false && release.prerelease === false
    && Number.isSafeInteger(release.id), 'published GitHub release required');
  const ref = await gh(`${base}/git/ref/tags/${proof.tag}`);
  let tag = ref.object;
  for (let depth = 0; tag?.type === 'tag' && depth < 8; depth += 1) {
    requireEvidence(/^[a-f0-9]{40}$/.test(tag.sha), 'invalid annotated tag');
    tag = (await gh(`${base}/git/tags/${tag.sha}`)).object;
  }
  requireEvidence(tag?.type === 'commit' && tag.sha === proof.gitHead, 'release tag/gitHead mismatch');
  const comparison = await gh(`${base}/compare/${proof.mergeSha}...${proof.gitHead}`);
  requireEvidence(['ahead', 'identical'].includes(comparison.status)
    && comparison.merge_base_commit?.sha === proof.mergeSha, 'release does not contain merge');
  const assets = Array.isArray(release.assets) ? release.assets.filter(asset =>
    typeof asset.name === 'string' && asset.name.endsWith('.tgz') && Number.isSafeInteger(asset.id)) : [];
  requireEvidence(assets.length === 1, 'one GitHub release tarball required');

  const bytes = verifyOnly ? await readFile(options.get('--tarball')) : await registryBytes(metadata.dist.tarball);
  verifyIntegrity(bytes, proof.integrity);
  const { stdout: assetBytes } = await execFile('gh', ['api', `${base}/releases/assets/${assets[0].id}`,
    '-H', 'Accept: application/octet-stream'], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  verifyIntegrity(assetBytes, proof.integrity);
  const workDir = await mkdtemp(join(tmpdir(), 'spur-published-'));
  try {
    const tarball = join(workDir, 'published.tgz');
    await writeFile(tarball, bytes);
    const { stdout: manifestJson } = await execFile('tar', ['-xOf', tarball, 'package/package.json']);
    const manifest = parseJson(manifestJson);
    requireEvidence(manifest.name === packageName && manifest.version === proof.version, 'tarball package/version mismatch');
    await execFile('bash', [join(repoRoot, 'scripts/verify-package-tarball.sh'), tarball]);
    if (verifyOnly) return;
    const receipt = join(workDir, 'deployment.json');
    await execFile('bash', [join(repoRoot, 'scripts/test-deploy.sh'), '--published-tarball', tarball,
      '--release-proof', resolve(options.get('--proof'))], {
      env: { ...process.env, SPUR_TEST_DEPLOY_RECEIPT: receipt }, maxBuffer: 4 * 1024 * 1024,
    });
    const deployed = parseJson(await readFile(receipt, 'utf8'));
    requireEvidence(deployed.installedVersion === proof.version && deployed.webStatus === 200,
      'installed publication proof missing');
    await writeFile(options.get('--output'), `${JSON.stringify({ repository: proof.repository,
      mergeSha: proof.mergeSha, gitHead: proof.gitHead, version: proof.version, integrity: proof.integrity,
      tag: proof.tag, releaseRunId: proof.releaseRunId, package: packageName,
      releaseId: release.id, packageSha256: createHash('sha256').update(bytes).digest('hex'),
      installedVersion: deployed.installedVersion, webStatus: deployed.webStatus }, null, 2)}\n`, { mode: 0o600 });
    console.log('published-release: verified publication and isolated deployment');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  // External command output may contain host paths or credentials.
  console.error(`published-release: ${error?.cmd || error?.code ? 'external verification command failed' : error.message}`);
  process.exitCode = 1;
});
