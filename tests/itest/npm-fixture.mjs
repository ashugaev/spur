// Persistent-VM harness only. Never proxies packages or changes release guards.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { setTimeout, clearTimeout } from "node:timers";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid package JSON");
  }
}
const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`invalid JSON: ${basename(path)}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function validateManifest(manifest, now = Date.now()) {
  assert(manifest?.schema === 1, "unsupported manifest");
  assert(/^[a-f0-9]{40}$/.test(manifest.sourceSha), "invalid source SHA");
  assert(/^[a-f0-9]{64}$/.test(manifest.runtimeBuildId), "invalid build identity");
  const evidence = manifest.publicReleases;
  assert(evidence?.stale === false && evidence.error === null, "untrusted release membership");
  const age = now - Date.parse(evidence.fetchedAt);
  assert(age >= 0 && age <= 10 * 60 * 1000, "stale release membership");
  assert(
    Array.isArray(evidence.entries) && evidence.entries.length >= 2,
    "two public releases required",
  );
  assert(
    Array.isArray(manifest.candidates) && manifest.candidates.length === 2,
    "two candidates required",
  );
  const selection = manifest.initialPublicReleases ?? evidence;
  assert(
    selection.stale === false &&
      selection.error === null &&
      Array.isArray(selection.entries) &&
      selection.entries.length >= 2,
    "untrusted initial release selection",
  );
  for (const [index, candidate] of manifest.candidates.entries()) {
    const entry = selection.entries[1 - index];
    const current = evidence.entries.find((release) => release.tag === candidate.version);
    assert(
      entry &&
        current &&
        [entry, current].every((release) =>
          Object.keys(release).every((key) => key === "tag" || key === "publishedAt"),
        ),
      "release entry must come from production discovery",
    );
    assert(/^\d+\.\d+\.\d+$/.test(candidate.version), "invalid release version");
    assert(
      candidate.version === entry.tag &&
        Number.isFinite(Date.parse(entry.publishedAt)) &&
        Number.isFinite(Date.parse(current.publishedAt)),
      "candidate absent from fresh public releases",
    );
    assert(
      candidate.sourceSha === manifest.sourceSha &&
        candidate.runtimeBuildId === manifest.runtimeBuildId,
      "candidate source/build mismatch",
    );
    assert(
      /^[a-f0-9]{64}$/.test(candidate.sha256) &&
        /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(candidate.integrity),
      "invalid candidate checksum",
    );
    assert(
      candidate.tarball === basename(candidate.tarball) && candidate.tarball.endsWith(".tgz"),
      "invalid tarball path",
    );
  }
  assert(manifest.candidates[0].version !== manifest.candidates[1].version, "duplicate candidate");
  return manifest;
}

export async function prepareCandidates(exportPath, outputPath, repoRoot) {
  const exported = await readJson(join(exportPath, "manifest.json"));
  assert(/^[a-f0-9]{40}$/.test(exported.sourceSha), "invalid exported source SHA");
  assert(exported.tarball === basename(exported.tarball), "invalid export tarball");
  const tarball = join(exportPath, exported.tarball);
  assert(hash(await readFile(tarball)) === exported.sha256, "export checksum mismatch");
  const { getReleases } = await import(
    pathToFileURL(join(repoRoot, "v2/dist/releases-cache.js")).href
  );
  const { computeBuildId } = await import(
    pathToFileURL(join(repoRoot, "v2/dist/build-identity.js")).href
  );
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert(
    sourceSha === exported.sourceSha &&
      computeBuildId(join(repoRoot, "v2/dist")) === exported.runtimeBuildId,
    "export does not match current source/build",
  );
  const publicReleases = { ...(await getReleases()), fetchedAt: new Date().toISOString() };
  assert(
    !publicReleases.stale && !publicReleases.error && publicReleases.entries.length >= 2,
    "fresh public release membership unavailable",
  );
  await mkdir(outputPath, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(tmpdir(), "spur-candidates-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", staging]);
    const packagePath = join(staging, "package");
    const packageJsonPath = join(packagePath, "package.json");
    const original = await readJson(packageJsonPath);
    assert(
      original.name === "@shugaev/spur" && original.version === exported.packageVersion,
      "export package mismatch",
    );
    assert(
      computeBuildId(join(packagePath, "dist")) === exported.runtimeBuildId,
      "export build mismatch",
    );
    const candidates = [];
    for (const entry of publicReleases.entries.slice(0, 2).reverse()) {
      await writeFile(
        packageJsonPath,
        `${JSON.stringify({ ...original, version: entry.tag }, null, 2)}\n`,
      );
      const filename = execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--silent", "--pack-destination", resolve(outputPath)],
        { cwd: packagePath, encoding: "utf8" },
      ).trim();
      assert(filename === `shugaev-spur-${entry.tag}.tgz`, "invalid npm pack result");
      const candidatePath = join(outputPath, filename);
      execFileSync("bash", [join(repoRoot, "scripts/verify-package-tarball.sh"), candidatePath]);
      const repacked = await mkdtemp(join(tmpdir(), "spur-repacked-"));
      try {
        execFileSync("tar", ["-xzf", candidatePath, "-C", repacked]);
        assert(
          computeBuildId(join(repacked, "package/dist")) === exported.runtimeBuildId,
          "packed runtime differs from source build",
        );
      } finally {
        await rm(repacked, { recursive: true, force: true });
      }
      const bytes = await readFile(candidatePath);
      candidates.push({
        version: entry.tag,
        tarball: filename,
        sha256: hash(bytes),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        sourceSha: exported.sourceSha,
        runtimeBuildId: exported.runtimeBuildId,
      });
    }
    const manifest = validateManifest({
      schema: 1,
      sourceSha: exported.sourceSha,
      runtimeBuildId: exported.runtimeBuildId,
      publicReleases,
      candidates,
    });
    await writeFile(join(outputPath, "candidates.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export class McpBindFault {
  constructor(
    configPath,
    evidencePath,
    stopMcp = () => execFileSync("systemctl", ["--user", "stop", "spur-mcp.service"]),
  ) {
    this.configPath = configPath;
    this.evidencePath = evidencePath;
    this.stopMcp = stopMcp;
    this.nonce = null;
    this.listener = null;
    this.events = [];
  }

  async record(event) {
    this.events.push({ event, nonce: this.nonce, at: new Date().toISOString() });
    await writeFile(this.evidencePath, `${JSON.stringify(this.events)}\n`, { mode: 0o600 });
  }

  async close(reason = "fixture-stopped") {
    if (!this.listener) return;
    const listener = this.listener;
    this.listener = null;
    clearTimeout(this.timer);
    await new Promise((done) => listener.close(done));
    await this.record(reason);
  }

  async beforeServe(version, allowedVersions) {
    let config;
    try {
      config = parseJson(await readFile(this.configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    assert(
      typeof config.nonce === "string" && /^[a-z0-9-]{1,80}$/.test(config.nonce),
      "invalid fault nonce",
    );
    assert(
      allowedVersions.includes(config.targetVersion) &&
        allowedVersions.includes(config.previousVersion) &&
        config.targetVersion !== config.previousVersion,
      "fault requires two verified candidates",
    );
    assert(
      Number.isInteger(config.mcpPort) && config.mcpPort >= 1 && config.mcpPort <= 65535,
      "invalid fault port",
    );
    if (this.listener && version === config.previousVersion) {
      await this.close("rollback-artifact-requested");
      return;
    }
    if (version !== config.targetVersion || this.nonce === config.nonce) return;
    assert(!this.listener, "fault already armed");
    this.nonce = config.nonce;
    await this.stopMcp();
    const listener = createTcpServer((socket) => socket.destroy());
    await new Promise((ready, reject) => {
      listener.once("error", reject);
      listener.listen(config.mcpPort, "127.0.0.1", ready);
    });
    this.listener = listener;
    await this.record("armed-before-target-artifact");
    // Release on rollback's actual prior-artifact request. Deadline is cleanup,
    // never rollback proof; failed runs cannot hold a VM port indefinitely.
    this.timer = setTimeout(() => {
      void this.close("deadline-expired");
    }, 300_000);
    this.timer.unref();
  }
}

export async function startFixture(
  manifestPath,
  { port = 0, logPath, readyPath, faultPath, faultEvidencePath } = {},
) {
  assert(!faultPath || typeof faultEvidencePath === "string", "fault evidence path required");
  const manifest = validateManifest(await readJson(manifestPath));
  // Validate once at startup; a reboot requires fresh membership evidence.
  const candidates = await Promise.all(
    manifest.candidates.map(async (candidate) => {
      const bytes = await readFile(join(dirname(manifestPath), candidate.tarball));
      assert(hash(bytes) === candidate.sha256, "candidate checksum mismatch");
      const metadata = parseJson(
        execFileSync(
          "tar",
          ["-xOf", join(dirname(manifestPath), candidate.tarball), "package/package.json"],
          { encoding: "utf8" },
        ),
      );
      assert(
        metadata.name === "@shugaev/spur" && metadata.version === candidate.version,
        "candidate package version mismatch",
      );
      const unpacked = await mkdtemp(join(tmpdir(), "spur-fixture-verify-"));
      try {
        execFileSync("tar", [
          "-xzf",
          join(dirname(manifestPath), candidate.tarball),
          "-C",
          unpacked,
        ]);
        const { computeBuildId } = await import(
          pathToFileURL(join(unpacked, "package/dist/build-identity.js")).href
        );
        assert(
          computeBuildId(join(unpacked, "package/dist")) === manifest.runtimeBuildId,
          "candidate runtime payload mismatch",
        );
      } finally {
        await rm(unpacked, { recursive: true, force: true });
      }
      return { ...candidate, bytes, metadata };
    }),
  );
  const fault = faultPath ? new McpBindFault(faultPath, faultEvidencePath) : null;
  const server = createServer(async (request, response) => {
    const path = request.url;
    const candidate = candidates.find((item) => path === `/spur-${item.version}.tgz`);
    const metadataRequest =
      path === "/@shugaev%2fspur" || path === "/@shugaev%2Fspur" || path === "/@shugaev/spur";
    let status = 404;
    let payload = Buffer.from("not allowed");
    let type = "text/plain";
    if (request.method === "GET" && candidate) {
      try {
        await fault?.beforeServe(
          candidate.version,
          candidates.map((item) => item.version),
        );
      } catch {
        response.writeHead(503).end("itest fault setup failed");
        return;
      }
      status = 200;
      payload = candidate.bytes;
      type = "application/octet-stream";
    } else if (request.method === "GET" && metadataRequest) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const versions = Object.fromEntries(
        candidates.map((item) => [
          item.version,
          {
            ...item.metadata,
            dist: {
              tarball: `${origin}/spur-${item.version}.tgz`,
              integrity: item.integrity,
              shasum: hash(item.bytes, "sha1"),
            },
          },
        ]),
      );
      status = 200;
      type = "application/json";
      payload = Buffer.from(
        JSON.stringify({
          name: "@shugaev/spur",
          "dist-tags": { latest: candidates[0].version },
          versions,
        }),
      );
    }
    if (logPath)
      void import("node:fs/promises")
        .then(({ appendFile }) =>
          appendFile(
            logPath,
            `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path, status, sha256: candidate?.sha256 })}\n`,
            { mode: 0o600 },
          ),
        )
        .catch(() => server.close());
    response.writeHead(status, { "content-type": type, "content-length": payload.length });
    response.end(payload);
  });
  server.once("close", () => {
    void fault?.close();
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveReady);
  });
  if (readyPath)
    await writeFile(
      readyPath,
      `${JSON.stringify({ port: server.address().port, pid: process.pid })}\n`,
      { mode: 0o600 },
    );
  return server;
}

export async function refreshMembership(manifestPath, releasesModule) {
  // Reboot may occur after the original ten-minute evidence window.
  // Re-use unchanged production discovery against public npm before serving.
  const { getReleases } = await import(pathToFileURL(resolve(releasesModule)).href);
  const current = await readJson(manifestPath);
  const previous = current.publicReleases;
  if (!current.initialPublicReleases) current.initialPublicReleases = previous;
  current.publicReleases = { ...(await getReleases()), fetchedAt: new Date().toISOString() };
  validateManifest(current);
  await writeFile(manifestPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, input, output, root] = process.argv.slice(2);
  if (command === "prepare")
    await prepareCandidates(resolve(input), resolve(output), resolve(root));
  else if (command === "serve") {
    if (!process.env.ITEST_RELEASES_MODULE)
      throw new Error("ITEST_RELEASES_MODULE must identify verified branch dist/releases-cache.js");
    await refreshMembership(resolve(input), process.env.ITEST_RELEASES_MODULE);
    await startFixture(resolve(input), {
      port: Number(process.env.ITEST_REGISTRY_PORT ?? 0),
      logPath: process.env.ITEST_REGISTRY_LOG,
      readyPath: process.env.ITEST_REGISTRY_READY,
      faultPath: process.env.ITEST_REGISTRY_FAULT_FILE,
      faultEvidencePath: process.env.ITEST_REGISTRY_FAULT_EVIDENCE,
    });
  } else
    throw new Error(
      "usage: npm-fixture.mjs prepare <export-dir> <output-dir> <repo-root> | serve <candidates.json>",
    );
}
