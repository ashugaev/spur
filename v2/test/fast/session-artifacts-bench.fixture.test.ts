// Benchmarks listSessionArtifacts against the syscall bounds in
// $SPUR_SESSION_ARTIFACTS_DIR/spec.md AC-9/AC-9F, four fixtures: (A) one depth-1
// directory with 20,000 files, (B) 3,000 empty depth-1 directories, (C) a depth-1 symlink
// alias alongside its target, (D) a typical live-session artifacts root (6 root files, two
// shallow nested dirs). No comparison against `main` (G2 in the spec): `origin/main`'s
// listSessionArtifacts has no `truncated` field and never descends, so it does strictly
// less work than this branch on every fixture — any ratio would measure a feature gap, not
// a regression. Every syscall bound below is absolute, against the captured baseline in
// bench-before.txt (branch, same host, N=15).
//
// There is NO wall-time assertion in this file. Wall time on this host is not a reliable
// instrument: the same pre-fix fixture B measured 129.64 ms in one session and 396.8 ms in
// another under different load (this host is simultaneously the CI runner and the worktree
// host), a ~3x drift that swamps the effect being measured. An assertion that cannot
// distinguish signal from host load does not belong in a test. Syscall counts are
// deterministic and are asserted below; the measured medians are only printed via
// `console.log` for a human reading a run to eyeball. Measured: opendirSync+readSync costs
// ~2.6x per directory versus a batched readdirSync at IDENTICAL syscall counts (getdents64
// 4003 vs 4003, openat 2048 vs 2049 over 2000 empty dirs) — the cost is V8<->libuv
// marshaling per call plus per-Dir allocation, not kernel work.
//
// *.fixture.test.ts so vitest.fast.config.ts excludes it from the normal fast run; invoke it
// explicitly through vitest.fixture.config.ts (precedent: temp-dir-safety-net.test.ts).
import type * as NodeFs from "node:fs";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

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

const { MAX_NESTED_ARTIFACT_WALK_ENTRIES, listSessionArtifacts, sessionArtifactsDir } =
  await import("../../src/session-artifacts.js");
const { createTempDir } = await import("../helpers/common.js");

const N = 15;

function resetCounts(): void {
  counts.readdirSync = 0;
  counts.realpathSync = 0;
  counts.statSync = 0;
  counts.opendirSync = 0;
  counts.dirReadSync = 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1] ?? 0;
    const upper = sorted[mid] ?? 0;
    return (lower + upper) / 2;
  }
  return sorted[mid] ?? 0;
}

interface BenchResult {
  medianMs: number;
  counts: typeof counts;
  artifactsLength: number;
  truncated: boolean;
}

function bench(dataDir: string, sessionId: string): BenchResult {
  const samples: number[] = [];
  let lastCounts = { ...counts };
  let lastArtifactsLength = 0;
  let lastTruncated = false;
  for (let index = 0; index < N; index++) {
    resetCounts();
    const start = process.hrtime.bigint();
    const { artifacts, truncated } = listSessionArtifacts(dataDir, sessionId);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    samples.push(elapsedMs);
    lastCounts = { ...counts };
    lastArtifactsLength = artifacts.length;
    lastTruncated = truncated;
  }
  return {
    medianMs: median(samples),
    counts: lastCounts,
    artifactsLength: lastArtifactsLength,
    truncated: lastTruncated,
  };
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session artifact walk bench", () => {
  it("fixture A stays within its syscall bounds", async () => {
    const dataDir = await createTempDir("spur-artifacts-bench-a-");
    tempDirs.push(dataDir);
    const sessionId = "bench-a";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const oversizedDir = join(dir, "oversized");
    mkdirSync(oversizedDir, { recursive: true });
    for (let index = 0; index < 20_000; index++) {
      writeFileSync(join(oversizedDir, `f-${String(index).padStart(6, "0")}.txt`), "x", "utf8");
    }

    const result = bench(dataDir, sessionId);
    // eslint-disable-next-line no-console
    console.log("fixture A (20k files in one dir):", result);

    expect(result.truncated).toBe(true);
    expect(result.counts.realpathSync).toBeLessThanOrEqual(5);
    expect(result.counts.statSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 10);
    expect(result.counts.dirReadSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 64);
    expect(result.counts.opendirSync).toBeLessThanOrEqual(5);
  });

  it("fixture B truncates on directory expansion within its syscall bounds", async () => {
    const dataDir = await createTempDir("spur-artifacts-bench-b-");
    tempDirs.push(dataDir);
    const sessionId = "bench-b";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 3000; index++) {
      mkdirSync(join(dir, `sub-${index}`), { recursive: true });
    }

    const result = bench(dataDir, sessionId);
    // eslint-disable-next-line no-console
    console.log("fixture B (3000 empty dirs):", result);

    expect(result.truncated).toBe(true);
    expect(result.artifactsLength).toBe(0);
    expect(result.counts.statSync).toBeLessThanOrEqual(50);
    expect(result.counts.realpathSync).toBeLessThanOrEqual(5);
    expect(result.counts.opendirSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 5);
    expect(result.counts.dirReadSync).toBeLessThanOrEqual(MAX_NESTED_ARTIFACT_WALK_ENTRIES + 64);
  });

  it("fixture C lists both alias paths within its syscall bounds", async () => {
    const dataDir = await createTempDir("spur-artifacts-bench-c-");
    tempDirs.push(dataDir);
    const sessionId = "bench-c";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(join(dir, "reports", "2026-08"), { recursive: true });
    writeFileSync(join(dir, "reports", "2026-08", "summary.md"), "hi", "utf8");
    symlinkSync(join(dir, "reports", "2026-08"), join(dir, "latest"), "dir");

    const result = bench(dataDir, sessionId);
    // eslint-disable-next-line no-console
    console.log("fixture C (symlink alias):", result);

    expect(result.truncated).toBe(false);
    expect(result.artifactsLength).toBe(2);
    expect(result.counts.statSync).toBeLessThanOrEqual(20);
    expect(result.counts.opendirSync).toBeLessThanOrEqual(5);
  });

  it("fixture D typical root stays under the fleet per-call ceiling", async () => {
    const dataDir = await createTempDir("spur-artifacts-bench-d-");
    tempDirs.push(dataDir);
    const sessionId = "bench-d";
    const dir = sessionArtifactsDir(dataDir, sessionId);
    mkdirSync(join(dir, "design"), { recursive: true });
    mkdirSync(join(dir, "notes", "2026-08"), { recursive: true });
    for (let index = 0; index < 6; index++) {
      writeFileSync(join(dir, `root-${index}.txt`), "x", "utf8");
    }
    for (let index = 0; index < 2; index++) {
      writeFileSync(join(dir, "design", `d-${index}.md`), "x", "utf8");
    }
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(dir, "notes", "2026-08", `n-${index}.md`), "x", "utf8");
    }

    const result = bench(dataDir, sessionId);
    // eslint-disable-next-line no-console
    console.log("fixture D (typical root):", result);

    expect(result.truncated).toBe(false);
    expect(result.counts.statSync).toBeLessThanOrEqual(20);
    expect(result.counts.opendirSync).toBeLessThanOrEqual(5);
  });
});
