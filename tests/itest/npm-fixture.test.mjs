import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import {
  validateManifest,
  startFixture,
  McpBindFault,
  refreshMembership,
  prepareCandidates,
  ROLLBACK_WAIT_MS,
} from "./npm-fixture.mjs";
import { createServer as createTcpServer } from "node:net";
const { fetch } = globalThis;

const sourceSha = "a".repeat(40);
const runtimeBuildId = "b".repeat(64);
function manifest() {
  return {
    schema: 1,
    sourceSha,
    runtimeBuildId,
    publicReleases: {
      stale: false,
      error: null,
      fetchedAt: new Date().toISOString(),
      entries: [
        { tag: "2.0.1", publishedAt: "2026-01-02" },
        { tag: "2.0.0", publishedAt: "2026-01-01" },
      ],
    },
    candidates: ["2.0.0", "2.0.1"].map((version) => ({
      version,
      sourceSha,
      runtimeBuildId,
      tarball: `${version}.tgz`,
      sha256: "c".repeat(64),
      integrity: "sha512-YQ==",
    })),
  };
}

test("candidate repacking does not buffer npm's file listing above one MiB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spur-pack-output-test-"));
  try {
    const repo = join(dir, "repo");
    const exported = join(dir, "export");
    const packagePath = join(dir, "package");
    const dist = join(repo, "v2/dist");
    const payload = join(packagePath, "payload", "x".repeat(220));
    for (const path of [dist, exported, payload, join(repo, "scripts"), join(packagePath, "dist")])
      await mkdir(path, { recursive: true });
    await writeFile(join(repo, "package.json"), '{"type":"module"}');
    const buildModule = `export const computeBuildId = () => "${runtimeBuildId}";`;
    await writeFile(join(dist, "build-identity.js"), buildModule);
    await writeFile(join(packagePath, "dist/build-identity.js"), buildModule);
    await writeFile(
      join(dist, "releases-cache.js"),
      `export const getReleases = async () => (${JSON.stringify({
        entries: manifest().publicReleases.entries,
        stale: false,
        error: null,
      })});`,
    );
    await writeFile(join(repo, "scripts/verify-package-tarball.sh"), "#!/bin/sh\nexit 0\n");
    await writeFile(
      join(packagePath, "package.json"),
      JSON.stringify({ name: "@shugaev/spur", version: "0.0.0-managed", type: "module" }),
    );
    for (let index = 0; index < 4200; index++) await writeFile(join(payload, `${index}.txt`), "");
    assert.throws(
      () =>
        execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
          cwd: packagePath,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      { code: "ENOBUFS" },
    );
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: repo },
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const tarball = "fixture.tgz";
    execFileSync("tar", ["-czf", join(exported, tarball), "-C", dir, "package"]);
    await writeFile(
      join(exported, "manifest.json"),
      JSON.stringify({
        sourceSha: sha,
        runtimeBuildId,
        packageVersion: "0.0.0-managed",
        tarball,
        sha256: createHash("sha256")
          .update(await readFile(join(exported, tarball)))
          .digest("hex"),
      }),
    );
    const output = join(dir, "candidates");
    const prepared = await prepareCandidates(exported, output, repo);
    assert.deepEqual(
      prepared.candidates.map((candidate) => candidate.version),
      ["2.0.0", "2.0.1"],
    );
    for (const candidate of prepared.candidates)
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(output, candidate.tarball)))
          .digest("hex"),
        candidate.sha256,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest rejects stale, unpublished and mismatched candidates", () => {
  assert.equal(validateManifest(manifest()).schema, 1);
  const unselected = manifest();
  unselected.publicReleases.entries.unshift({ tag: "2.0.2", publishedAt: "2026-01-03" });
  assert.throws(() => validateManifest(unselected));
  for (const mutate of [
    (m) => {
      m.publicReleases.stale = true;
    },
    (m) => {
      m.publicReleases.error = "registry unavailable";
    },
    (m) => {
      m.publicReleases.fetchedAt = "2000-01-01";
    },
    (m) => {
      m.publicReleases.entries[1].deprecated = true;
    },
    (m) => {
      m.candidates[0].version = "9.0.0";
    },
    (m) => {
      m.candidates[0].sourceSha = "d".repeat(40);
    },
    (m) => {
      m.candidates[0].runtimeBuildId = "d".repeat(64);
    },
    (m) => {
      m.candidates[0].tarball = "../escape.tgz";
    },
    (m) => {
      m.candidates[0].sha256 = "wrong";
    },
  ]) {
    const invalid = manifest();
    mutate(invalid);
    assert.throws(() => validateManifest(invalid));
  }
});

test("registry serves only exact candidate payloads and rejects checksum/version mismatches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spur-registry-test-"));
  let server;
  try {
    const value = manifest();
    for (const candidate of value.candidates) {
      const packagePath = join(dir, candidate.version, "package");
      await mkdir(packagePath, { recursive: true });
      await mkdir(join(packagePath, "dist"));
      await writeFile(
        join(packagePath, "dist/build-identity.js"),
        `export const computeBuildId = () => "${runtimeBuildId}";`,
      );
      await writeFile(
        join(packagePath, "package.json"),
        JSON.stringify({ name: "@shugaev/spur", version: candidate.version, type: "module" }),
      );
      execFileSync("tar", [
        "-czf",
        join(dir, candidate.tarball),
        "-C",
        join(dir, candidate.version),
        "package",
      ]);
      const { readFile } = await import("node:fs/promises");
      const bytes = await readFile(join(dir, candidate.tarball));
      candidate.sha256 = createHash("sha256").update(bytes).digest("hex");
      candidate.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    }
    const path = join(dir, "candidates.json");
    await writeFile(path, JSON.stringify(value));
    server = await startFixture(path);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const metadata = await (await fetch(`${origin}/@shugaev%2fspur`)).json();
    assert.equal(metadata["dist-tags"].latest, "2.0.0");
    assert.deepEqual(Object.keys(metadata.versions), ["2.0.0", "2.0.1"]);
    const served = Buffer.from(
      await (await fetch(metadata.versions["2.0.1"].dist.tarball)).arrayBuffer(),
    );
    assert.equal(createHash("sha256").update(served).digest("hex"), value.candidates[1].sha256);
    for (const denied of [
      "/@other/package",
      "/@shugaev%2fother",
      "/spur-9.0.0.tgz",
      "/@shugaev%2fspur?token=private",
    ])
      assert.equal((await fetch(`${origin}${denied}`)).status, 404);
    assert.equal((await fetch(`${origin}/@shugaev%2fspur`, { method: "POST" })).status, 404);
    const laterModule = join(dir, "later-release.mjs");
    await writeFile(
      laterModule,
      `export const getReleases = async () => (${JSON.stringify({
        entries: [{ tag: "2.0.2", publishedAt: "2026-01-03" }, ...value.publicReleases.entries],
        stale: false,
        error: null,
      })});`,
    );
    await refreshMembership(path, laterModule);
    await new Promise((done) => server.close(done));
    server = await startFixture(path);
    const restarted = `http://127.0.0.1:${server.address().port}`;
    const refreshedMetadata = await (await fetch(`${restarted}/@shugaev%2fspur`)).json();
    assert.equal(refreshedMetadata["dist-tags"].latest, "2.0.0");
    assert.deepEqual(Object.keys(refreshedMetadata.versions), ["2.0.0", "2.0.1"]);
    const refreshedBytes = Buffer.from(
      await (await fetch(refreshedMetadata.versions["2.0.0"].dist.tarball)).arrayBuffer(),
    );
    assert.equal(
      createHash("sha256").update(refreshedBytes).digest("hex"),
      value.candidates[0].sha256,
    );
    value.candidates[0].sha256 = "d".repeat(64);
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(startFixture(path), /checksum/);
    value.candidates[0].sha256 = value.candidates[1].sha256;
    value.candidates[0].tarball = value.candidates[1].tarball;
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(startFixture(path), /version mismatch/);
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});

test("bind fault survives slow reinit and releases only for rollback artifact without stale expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  const dir = await mkdtemp(join(tmpdir(), "spur-bind-fault-test-"));
  const reservation = createTcpServer();
  await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  let stops = 0;
  const configPath = join(dir, "fault.json");
  const fault = new McpBindFault(configPath, join(dir, "evidence.json"), () => {
    stops += 1;
  });
  try {
    await fault.beforeServe("2.0.1", ["2.0.0", "2.0.1"]);
    assert.equal(stops, 0);
    await writeFile(
      configPath,
      JSON.stringify({
        nonce: "one",
        targetVersion: "2.0.1",
        previousVersion: "2.0.0",
        mcpPort: port,
      }),
    );
    await fault.beforeServe("2.0.0", ["2.0.0", "2.0.1"]);
    assert.equal(stops, 0);
    await fault.beforeServe("2.0.1", ["2.0.0", "2.0.1"]);
    assert.equal(stops, 1);
    t.mock.timers.tick(300_001);
    const conflicting = createTcpServer();
    await assert.rejects(
      new Promise((ready, reject) => {
        conflicting.once("error", reject);
        conflicting.listen(port, "127.0.0.1", ready);
      }),
      { code: "EADDRINUSE" },
    );
    await fault.beforeServe("2.0.1", ["2.0.0", "2.0.1"]);
    assert.equal(stops, 1);
    await fault.beforeServe("2.0.0", ["2.0.0", "2.0.1"]);
    assert.deepEqual(
      fault.events.map((event) => event.event),
      ["armed-before-target-artifact", "rollback-artifact-requested"],
    );
    const restored = createTcpServer();
    await new Promise((ready) => restored.listen(port, "127.0.0.1", ready));
    await new Promise((done) => restored.close(done));
    t.mock.timers.tick(ROLLBACK_WAIT_MS + 30_000);
    await setImmediate();
    assert.deepEqual(
      fault.events.map((event) => event.event),
      ["armed-before-target-artifact", "rollback-artifact-requested"],
    );
    await writeFile(
      configPath,
      JSON.stringify({
        nonce: "two",
        targetVersion: "9.0.0",
        previousVersion: "2.0.0",
        mcpPort: port,
      }),
    );
    await assert.rejects(fault.beforeServe("9.0.0", ["2.0.0", "2.0.1"]), /verified candidates/);
  } finally {
    await fault.close();
    t.mock.timers.reset();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fault deadline releases the listener without claiming rollback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  const dir = await mkdtemp(join(tmpdir(), "spur-bind-fault-expiry-"));
  const reservation = createTcpServer();
  await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const configPath = join(dir, "fault.json");
  const evidencePath = join(dir, "evidence.json");
  const fault = new McpBindFault(configPath, evidencePath, () => {});
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        nonce: "expires",
        targetVersion: "2.0.1",
        previousVersion: "2.0.0",
        mcpPort: port,
      }),
    );
    await fault.beforeServe("2.0.1", ["2.0.0", "2.0.1"]);
    t.mock.timers.tick(ROLLBACK_WAIT_MS + 30_000);
    for (let attempt = 0; attempt < 100 && fault.events.length < 2; attempt += 1)
      await setImmediate();
    assert.deepEqual(
      fault.events.map((event) => event.event),
      ["armed-before-target-artifact", "deadline-expired"],
    );
    const restored = createTcpServer();
    await new Promise((ready) => restored.listen(port, "127.0.0.1", ready));
    await new Promise((done) => restored.close(done));
    // Wait for the timer's asynchronous evidence write before removing its directory.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let events;
      try {
        events = JSON.parse(await readFile(evidencePath, "utf8"));
      } catch {
        /* Write in progress. */
      }
      if (events?.length === 2) break;
      await setImmediate();
    }
    assert.deepEqual(
      JSON.parse(await readFile(evidencePath, "utf8")).map((event) => event.event),
      ["armed-before-target-artifact", "deadline-expired"],
    );
  } finally {
    await fault.close();
    t.mock.timers.reset();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixture reboot refresh requires fresh production discovery and preserves initial evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spur-membership-test-"));
  try {
    const path = join(dir, "candidates.json");
    const value = manifest();
    value.publicReleases.fetchedAt = "2000-01-01";
    await writeFile(path, JSON.stringify(value));
    const productionResult = { entries: value.publicReleases.entries, stale: false, error: null };
    const module = join(dir, "fresh.mjs");
    await writeFile(
      module,
      `export const getReleases = async () => (${JSON.stringify(productionResult)});`,
    );
    await refreshMembership(path, module);
    const { readFile } = await import("node:fs/promises");
    const refreshed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(refreshed.initialPublicReleases.fetchedAt, "2000-01-01");
    validateManifest(refreshed);
    const staleModule = join(dir, "stale.mjs");
    await writeFile(
      staleModule,
      `export const getReleases = async () => (${JSON.stringify({ ...productionResult, stale: true, error: "offline" })});`,
    );
    await assert.rejects(refreshMembership(path, staleModule), /untrusted release/);
    for (const [name, entries] of [
      ["missing", [productionResult.entries[0], { tag: "3.0.0", publishedAt: "2026-02-01" }]],
      [
        "deprecated",
        [productionResult.entries[0], { ...productionResult.entries[1], deprecated: true }],
      ],
    ]) {
      const rejectedModule = join(dir, `${name}.mjs`);
      await writeFile(
        rejectedModule,
        `export const getReleases = async () => (${JSON.stringify({ entries, stale: false, error: null })});`,
      );
      await assert.rejects(refreshMembership(path, rejectedModule));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
