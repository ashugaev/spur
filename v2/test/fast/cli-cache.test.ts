import type * as FsPromises from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CacheRetentionModule from "../../src/cache-retention.js";
import type { CacheCandidate, CachePlan } from "../../src/cache-retention.js";
import type * as ConfigModule from "../../src/config.js";

const {
  planCachePruneMock,
  executePruneMock,
  rmMock,
  writeStdoutMock,
  loadInstanceConfigReadOnlyMock,
} = vi.hoisted(() => ({
  planCachePruneMock: vi.fn(),
  executePruneMock: vi.fn(),
  rmMock: vi.fn(),
  writeStdoutMock: vi.fn(),
  loadInstanceConfigReadOnlyMock: vi.fn(),
}));

// Only `planCachePrune` (the measurement path) is replaced with a fixed
// fixture — `executePrune` is mocked separately to allow testing the CLI
// wiring without running real deletion. The actual deletion guard is
// exercised by cache-retention.test.ts at the unit boundary.
vi.mock("../../src/cache-retention.js", async () => {
  const actual = await vi.importActual<typeof CacheRetentionModule>("../../src/cache-retention.js");
  return { ...actual, planCachePrune: planCachePruneMock, executePrune: executePruneMock };
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

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../../src/config.js");
  return { ...actual, loadInstanceConfigReadOnly: loadInstanceConfigReadOnlyMock };
});

async function parseCache(args: string[], globalArgs: string[] = []): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync([
    "node",
    "spur",
    ...globalArgs,
    "cache",
    ...args,
  ]);
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
    roots: [
      {
        rootId: "npm-cacache",
        path: "/tmp",
        status: "measured",
        totalKb: 600,
        entryCount: 5,
      },
    ],
    candidates: [
      {
        entry: {
          path: smallPath,
          rootId: "npm-cacache",
          entryClass: { kind: "vendor-cache" },
          sizeKb: 100,
          ageDays: 40,
        },
        verdict: { kind: "prunable" },
      },
      {
        entry: {
          path: bigPath,
          rootId: "npm-cacache",
          entryClass: { kind: "vendor-cache" },
          sizeKb: 500,
          ageDays: 40,
        },
        verdict: { kind: "prunable" },
      },
      {
        entry: {
          path: join(tempDir, "kept"),
          rootId: "npm-cacache",
          entryClass: { kind: "vendor-cache" },
          sizeKb: 999_999,
          ageDays: 1,
        },
        verdict: { kind: "protected", reason: { kind: "too-recent", ageDays: 1, floorDays: 7 } },
      },
      {
        entry: {
          path: join(tempDir, "pin-src-hash"),
          rootId: "npm-npx",
          entryClass: { kind: "npx-package", hash: "pin-src-hash" },
          sizeKb: 200,
          ageDays: 60,
        },
        verdict: { kind: "protected", reason: { kind: "pin-source" } },
      },
      {
        entry: {
          path: join(tempDir, ".spur", "sessions"),
          rootId: "xdg-cache",
          entryClass: { kind: "generic", name: "sessions" },
          sizeKb: 300,
          ageDays: 60,
        },
        verdict: { kind: "protected", reason: { kind: "spur-owned" } },
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
    executePruneMock.mockReset();
    rmMock.mockReset();
    rmMock.mockResolvedValue(undefined);
    writeStdoutMock.mockReset();
    loadInstanceConfigReadOnlyMock.mockReset();
    tempDir = mkdtempSync("/tmp/spur-cache-cli-test-");
    process.env["TMPDIR"] = tempDir;
    process.env["SPUR_CONFIG"] = join(tempDir, "config-does-not-exist.yaml");
    smallPath = join(tempDir, "small-entry");
    bigPath = join(tempDir, "big-entry");
    writeFileSync(smallPath, "x");
    writeFileSync(bigPath, "x");
    planCachePruneMock.mockResolvedValue(makePlan());
    executePruneMock.mockResolvedValue({
      removed: [
        { path: smallPath, sizeKb: 100 },
        { path: bigPath, sizeKb: 500 },
      ],
      failures: [],
      freedKb: 600,
    });
    loadInstanceConfigReadOnlyMock.mockReturnValue({
      status: "ok",
      config: {
        configPath: join(tempDir, "config.yaml"),
        dataDir: join(tempDir, ".spur"),
        worktreeDir: join(tempDir, ".spur", "worktrees"),
        tmux: { socketName: "spur-test" },
        projects: {},
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["TMPDIR"];
    delete process.env["SPUR_CONFIG"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("never calls executePrune with no flags (dry-run)", async () => {
    await parseCache([]);
    expect(executePruneMock).not.toHaveBeenCalled();
  });

  it("never calls executePrune with --prune alone, and prints the --yes hint", async () => {
    await parseCache(["--prune"]);
    expect(executePruneMock).not.toHaveBeenCalled();
    const output = writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("re-run with --prune --yes");
  });

  it("AC5: --prune --yes throws before planning when instance config is absent", async () => {
    loadInstanceConfigReadOnlyMock.mockReturnValue({ status: "absent" });
    await expect(parseCache(["--prune", "--yes"])).rejects.toThrow(
      "requires a resolved instance config",
    );
    expect(planCachePruneMock).not.toHaveBeenCalled();
    expect(executePruneMock).not.toHaveBeenCalled();
  });

  it("--config to absent file rejects --prune --yes before planning", async () => {
    const selectedPath = "/nonexistent/spur.yaml";
    loadInstanceConfigReadOnlyMock.mockImplementation((input?: string) => {
      if (input === selectedPath) return { status: "absent" };
      return {
        status: "ok",
        config: {
          configPath: join(tempDir, "config.yaml"),
          dataDir: join(tempDir, ".spur"),
          worktreeDir: join(tempDir, ".spur", "worktrees"),
          tmux: { socketName: "spur-test" },
          projects: {},
        },
      };
    });
    await expect(parseCache(["--prune", "--yes"], ["--config", selectedPath])).rejects.toThrow(
      "requires a resolved instance config",
    );
    expect(loadInstanceConfigReadOnlyMock).toHaveBeenCalledWith(selectedPath);
    expect(planCachePruneMock).not.toHaveBeenCalled();
    expect(executePruneMock).not.toHaveBeenCalled();
  });

  it("--config path is forwarded to loadInstanceConfigReadOnly", async () => {
    let capturedInput: string | undefined;
    loadInstanceConfigReadOnlyMock.mockImplementation((input?: string) => {
      capturedInput = input;
      return {
        status: "ok",
        config: {
          configPath: join(tempDir, "custom.yaml"),
          dataDir: join(tempDir, ".spur"),
          worktreeDir: join(tempDir, ".spur", "worktrees"),
          tmux: { socketName: "spur-test" },
          projects: {},
        },
      };
    });
    const configPath = join(tempDir, "custom.yaml");
    await parseCache(["--prune", "--yes"], ["--config", configPath]);
    expect(capturedInput).toBe(configPath);
    expect(executePruneMock).toHaveBeenCalledTimes(1);
  });

  it("calls executePrune with the prunable candidates with --prune --yes", async () => {
    await parseCache(["--prune", "--yes"]);
    expect(executePruneMock).toHaveBeenCalledTimes(1);
    const [candidates] = executePruneMock.mock.calls[0] as [CacheCandidate[]];
    const removedPaths = candidates
      .filter((candidate) => candidate.verdict.kind === "prunable")
      .map((candidate) => candidate.entry.path);
    expect(removedPaths).toEqual(expect.arrayContaining([smallPath, bigPath]));
  });

  it("ranks the human-readable report by size descending and shows protected reasons", async () => {
    await parseCache([]);
    const output = writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output.indexOf(bigPath)).toBeGreaterThanOrEqual(0);
    expect(output.indexOf(bigPath)).toBeLessThan(output.indexOf(smallPath));
    expect(output).toContain("too recent");
    expect(output).toContain("npx-package is a browsers.json pin source");
    expect(output).toContain("resolves inside Spur data directory");
  });

  it("prints the raw plan as JSON with --json", async () => {
    await parseCache(["--json"]);
    expect(executePruneMock).not.toHaveBeenCalled();
    const printed = writeStdoutMock.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("{"));
    expect(printed).toBeDefined();
    const parsed = JSON.parse(printed ?? "{}") as {
      plan: CachePlan;
      wouldPrune: boolean;
      outcome?: unknown;
    };
    expect(parsed.plan.candidates).toHaveLength(5);
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
