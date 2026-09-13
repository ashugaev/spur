import type * as NodeFs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the fs calls the walk makes (readdirSync at the root, realpathSync and statSync
// per symlink entry, opendirSync per below-root directory opened, and readSync pulls on the
// Dir handle opendirSync returns). vi.spyOn cannot wrap these bindings: session-artifacts.ts
// imports them as named ESM bindings, and vitest throws "Cannot spy on export ... Module
// namespace is not configurable in ESM." Wrapping node:fs itself with vi.mock's
// importOriginal delegates to the real filesystem so the fixture tree still gets built and
// walked for real; only the call counts are observed. opendirSync's own count
// (counts.opendirSync) bounds directories opened (D2); wrapping readSync on the returned Dir
// (counts.dirReadSync) bounds entries pulled from a single directory (D3) — the two counters
// the plain call-count mock above them cannot tell apart.
const counts = vi.hoisted(() => ({
  readdirSync: 0,
  realpathSync: 0,
  statSync: 0,
  opendirSync: 0,
  dirReadSync: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readdirSync: ((...args: unknown[]) => {
      counts.readdirSync++;
      return (actual.readdirSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.readdirSync,
    realpathSync: ((...args: unknown[]) => {
      counts.realpathSync++;
      return (actual.realpathSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.realpathSync,
    statSync: ((...args: unknown[]) => {
      counts.statSync++;
      return (actual.statSync as (...fnArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof actual.statSync,
    opendirSync: ((...args: unknown[]) => {
      counts.opendirSync++;
      const realDir = (actual.opendirSync as (...fnArgs: unknown[]) => NodeFs.Dir)(...args);
      const realReadSync = realDir.readSync.bind(realDir);
      realDir.readSync = (() => {
        counts.dirReadSync++;
        return realReadSync();
      }) as typeof realDir.readSync;
      return realDir;
    }) as unknown as typeof actual.opendirSync,
  };
});

const {
  MAX_NESTED_ARTIFACT_ROWS,
  MAX_NESTED_ARTIFACT_WALK_ENTRIES,
  listSessionArtifacts,
  sessionArtifactsDir,
} = await import("../../src/session-artifacts.js");
const { createTempDir } = await import("../helpers/common.js");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  counts.readdirSync = 0;
  counts.realpathSync = 0;
  counts.statSync = 0;
  counts.opendirSync = 0;
  counts.dirReadSync = 0;
});

describe("session artifact walk budget", () => {
  it("stops on the entry budget when entries greatly outnumber emitted rows", async () => {
    const dataDir = await createTempDir("spur-artifacts-budget-");
    tempDirs.push(dataDir);
    const sessionId = "api-budget-entries";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });

    // A single depth-1 directory holding 3,000 EMPTY depth-2 subdirectories: below the
    // root, the walk examines 3,000 entries but emits zero SessionArtifact rows (none of
    // them are files). This is the case MAX_NESTED_ARTIFACT_ROWS cannot bind on — only the
    // entry budget can stop the walk here, so a truncated result proves that budget fires.
    const parent = join(dir, "parent");
    mkdirSync(parent, { recursive: true });
    const subdirCount = 3000;
    for (let index = 0; index < subdirCount; index++) {
      mkdirSync(join(parent, `sub-${index}`), { recursive: true });
    }
    counts.readdirSync = 0;
    counts.realpathSync = 0;
    counts.statSync = 0;
    counts.opendirSync = 0;
    counts.dirReadSync = 0;

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);

    expect(truncated).toBe(true);
    // Zero nested rows were emitted (no files exist below the root at all), which is well
    // under MAX_NESTED_ARTIFACT_ROWS — proving this truncation came from the entry budget,
    // not the row budget.
    expect(artifacts.length).toBe(0);
    expect(artifacts.length).toBeLessThan(MAX_NESTED_ARTIFACT_ROWS);

    // The walk must have stopped at (or just past) the entry budget, not walked all 3,000
    // subdirectories. All 3,000 are plain (non-symlink) directories, so D1 means the walk
    // never pays realpathSync/statSync for them at all — only D3's opendirSync/readSync
    // pulls are the operative bound here.
    expect(counts.realpathSync).toBeLessThanOrEqual(5);
    expect(counts.statSync).toBeLessThanOrEqual(5);
    expect(counts.opendirSync).toBeLessThanOrEqual(5);
    expect(counts.dirReadSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 64);
  });

  it("examines at most MAX_NESTED_ARTIFACT_WALK_ENTRIES entries below the root", async () => {
    const dataDir = await createTempDir("spur-artifacts-budget-");
    tempDirs.push(dataDir);
    const sessionId = "api-budget";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });

    // 200 depth-1 files, unbudgeted, plus 20 depth-1 directories each holding 300 nested
    // files: 6,000 nested files, far past MAX_NESTED_ARTIFACT_WALK_ENTRIES.
    const depth1Count = 200;
    for (let index = 0; index < depth1Count; index++) {
      writeFileSync(join(dir, `root-${index}.txt`), "x", "utf8");
    }
    for (let dirIndex = 0; dirIndex < 20; dirIndex++) {
      const nestedDir = join(dir, `nested-${dirIndex}`);
      mkdirSync(nestedDir, { recursive: true });
      for (let fileIndex = 0; fileIndex < 300; fileIndex++) {
        writeFileSync(join(nestedDir, `f-${fileIndex}.txt`), "x", "utf8");
      }
    }

    // Only the walk under test should be measured; discard whatever the fixture setup and
    // createTempDir's own containment checks cost.
    counts.readdirSync = 0;
    counts.realpathSync = 0;
    counts.statSync = 0;
    counts.opendirSync = 0;
    counts.dirReadSync = 0;

    const { truncated } = listSessionArtifacts(dataDir, sessionId);
    expect(truncated).toBe(true);

    // After D1 a plain (non-symlink) dirent never pays realpathSync/statSync; only a
    // statSync per depth-1 root FILE (no symlinks in this fixture, so realpathSync stays at
    // the single root-resolving call). The root level is unbudgeted by design and still
    // costs its own small, fixed overhead linear in depth1Count, not in the 6,000-file
    // nested tree.
    const rootOverhead = depth1Count + 10;
    expect(counts.realpathSync).toBeLessThanOrEqual(5);
    expect(counts.statSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + rootOverhead);
    // After D3 the nested loop no longer calls readdirSync at all (it pulls incrementally
    // via opendirSync/readSync); the root's own single readdirSync is the only call left.
    expect(counts.readdirSync).toBe(1);
    expect(counts.opendirSync).toBeLessThanOrEqual(20 + 5);
    expect(counts.dirReadSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 64);
    // And it must be nowhere near the unbounded case: 6,000 nested files plus 20
    // directories would cost ~6,020 stat/realpath calls if the walk were unbounded.
    expect(counts.statSync).toBeLessThan(6000);
  });

  it("bounds entries pulled from a single oversized directory", async () => {
    const dataDir = await createTempDir("spur-artifacts-budget-");
    tempDirs.push(dataDir);
    const sessionId = "api-budget-oversized-dir";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });

    // One depth-1 directory holding 20,000 files: the F3 hole this fixture closes let a
    // single oversized directory's full readdirSync materialize before any budget check ran.
    const oversizedDir = join(dir, "oversized");
    mkdirSync(oversizedDir, { recursive: true });
    const fileCount = 20_000;
    for (let index = 0; index < fileCount; index++) {
      writeFileSync(join(oversizedDir, `f-${String(index).padStart(6, "0")}.txt`), "x", "utf8");
    }
    counts.readdirSync = 0;
    counts.realpathSync = 0;
    counts.statSync = 0;
    counts.opendirSync = 0;
    counts.dirReadSync = 0;

    const { truncated } = listSessionArtifacts(dataDir, sessionId);

    expect(truncated).toBe(true);
    expect(counts.dirReadSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 64);
    expect(counts.opendirSync).toBeLessThanOrEqual(5);
  });

  it("truncates on directory expansion alone and skips the per-directory stat", async () => {
    const dataDir = await createTempDir("spur-artifacts-budget-");
    tempDirs.push(dataDir);
    const sessionId = "api-budget-empty-dirs";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });

    // 3,000 EMPTY depth-1 directories directly under the root: no files exist anywhere, so
    // only directory expansion (D2's per-open tick) can ever set truncated here.
    const dirCount = 3000;
    for (let index = 0; index < dirCount; index++) {
      mkdirSync(join(dir, `sub-${index}`), { recursive: true });
    }
    counts.readdirSync = 0;
    counts.realpathSync = 0;
    counts.statSync = 0;
    counts.opendirSync = 0;
    counts.dirReadSync = 0;

    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);

    expect(truncated).toBe(true);
    expect(artifacts.length).toBe(0);
    expect(counts.statSync).toBeLessThanOrEqual(50);
    expect(counts.realpathSync).toBeLessThanOrEqual(5);
    expect(counts.opendirSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 5);
  });
});
