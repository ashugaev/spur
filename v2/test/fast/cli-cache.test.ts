import type * as FsPromises from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CacheRetentionModule from "../../src/cache-retention.js";
import type { CachePlan } from "../../src/cache-retention.js";

const { planCachePruneMock, rmMock, writeStdoutMock } = vi.hoisted(() => ({
  planCachePruneMock: vi.fn(),
  rmMock: vi.fn(),
  writeStdoutMock: vi.fn(),
}));

// Only `planCachePrune` (the measurement path) is replaced with a fixed
// fixture — `executePrune` stays real so the flag matrix exercises the
// actual deletion guard against a synthetic mkdtemp tree. Never mocked away:
// this is the one piece of behavior AC10/AC11 need to prove.
vi.mock("../../src/cache-retention.js", async () => {
  const actual = await vi.importActual<typeof CacheRetentionModule>("../../src/cache-retention.js");
  return { ...actual, planCachePrune: planCachePruneMock };
});

// `rm` is the only real filesystem mutation `executePrune` can perform;
// spying on it (rather than letting deletion run for real) is what makes the
// "N calls for N prunable candidates" assertion exact and hermetic.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return { ...actual, rm: rmMock };
});

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

async function parseCache(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "cache", ...args]);
}

// `executePrune`'s guard resolves the "tmp" cache root to the literal "/tmp"
// (cli.ts never overrides `tmpPath`), so the fixture's candidate paths must
// physically live under real "/tmp" for the containment check to pass —
// hence mkdtemp rooted at "/tmp" directly rather than `os.tmpdir()`.
let tempDir: string;
let bigPath: string;
let smallPath: string;

function makePlan(): CachePlan {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    roots: [{ rootId: "tmp", path: "/tmp", status: "measured", totalKb: 600, entryCount: 3 }],
    candidates: [
      {
        entry: {
          path: smallPath,
          rootId: "tmp",
          entryClass: { kind: "tmp-entry", name: "small" },
          sizeKb: 100,
          newestChangeMs: Date.now(),
          ageDays: 40,
        },
        verdict: { kind: "prunable" },
      },
      {
        entry: {
          path: bigPath,
          rootId: "tmp",
          entryClass: { kind: "tmp-entry", name: "big" },
          sizeKb: 500,
          newestChangeMs: Date.now(),
          ageDays: 40,
        },
        verdict: { kind: "prunable" },
      },
      {
        entry: {
          path: join(tempDir, "kept"),
          rootId: "tmp",
          entryClass: { kind: "tmp-entry", name: "kept" },
          sizeKb: 999_999,
          newestChangeMs: Date.now(),
          ageDays: 1,
        },
        verdict: { kind: "protected", reason: { kind: "too-recent", ageDays: 1, floorDays: 7 } },
      },
    ],
    reclaimableKb: 600,
    processTreeReadable: true,
    pinSourceCount: 1,
  };
}

describe("spur cache CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    planCachePruneMock.mockReset();
    rmMock.mockReset();
    rmMock.mockResolvedValue(undefined);
    writeStdoutMock.mockReset();
    tempDir = mkdtempSync("/tmp/spur-cache-cli-test-");
    process.env["TMPDIR"] = tempDir;
    process.env["SPUR_CONFIG"] = join(tempDir, "config-does-not-exist.yaml");
    smallPath = join(tempDir, "small-entry");
    bigPath = join(tempDir, "big-entry");
    writeFileSync(smallPath, "x");
    writeFileSync(bigPath, "x");
    planCachePruneMock.mockResolvedValue(makePlan());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["TMPDIR"];
    delete process.env["SPUR_CONFIG"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("never calls rm with no flags (dry-run)", async () => {
    await parseCache([]);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("never calls rm with --prune alone, and prints the --yes hint", async () => {
    await parseCache(["--prune"]);
    expect(rmMock).not.toHaveBeenCalled();
    const output = writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("re-run with --prune --yes");
  });

  it("calls rm exactly once per prunable candidate with --prune --yes", async () => {
    await parseCache(["--prune", "--yes"]);
    expect(rmMock).toHaveBeenCalledTimes(2);
    const removedPaths = rmMock.mock.calls.map((call) => call[0]);
    expect(removedPaths).toEqual(expect.arrayContaining([smallPath, bigPath]));
  });

  it("ranks the human-readable report by size descending and shows protected reasons", async () => {
    await parseCache([]);
    const output = writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output.indexOf(bigPath)).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(bigPath)).toBeLessThan(output.indexOf(smallPath));
    expect(output).toContain("too recent");
  });

  it("prints the raw plan as JSON with --json", async () => {
    await parseCache(["--json"]);
    expect(rmMock).not.toHaveBeenCalled();
    const printed = writeStdoutMock.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("{"));
    expect(printed).toBeDefined();
    const parsed = JSON.parse(printed ?? "{}") as {
      plan: CachePlan;
      wouldPrune: boolean;
      outcome?: unknown;
    };
    expect(parsed.plan.candidates).toHaveLength(3);
    expect(parsed.wouldPrune).toBe(false);
    expect(parsed.outcome).toBeUndefined();
  });

  it("includes the prune outcome in --json output when executed", async () => {
    await parseCache(["--json", "--prune", "--yes"]);
    const printed = writeStdoutMock.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("{"));
    const parsed = JSON.parse(printed ?? "{}") as { outcome?: { removed: unknown[] } };
    expect(parsed.outcome?.removed).toHaveLength(2);
  });
});
