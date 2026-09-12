import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskBudgetReport } from "../../src/disk-budget.js";
import type * as DiskBudgetModule from "../../src/disk-budget.js";
import type * as MetadataModule from "../../src/metadata.js";
import type * as ConfigModule from "../../src/config.js";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const {
  measureDiskBudgetMock,
  writeDiskBudgetReportMock,
  writeStdoutMock,
  listSessionsMock,
  ensureInstanceConfigMock,
  loadConfigMock,
  setTmuxSocketNameMock,
} = vi.hoisted(() => ({
  measureDiskBudgetMock: vi.fn(),
  writeDiskBudgetReportMock: vi.fn(),
  writeStdoutMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
  ensureInstanceConfigMock: vi.fn(),
  loadConfigMock: vi.fn(),
  setTmuxSocketNameMock: vi.fn(),
}));

vi.mock("../../src/disk-budget.js", async () => {
  const actual = await vi.importActual<typeof DiskBudgetModule>("../../src/disk-budget.js");
  return {
    ...actual,
    measureDiskBudget: measureDiskBudgetMock,
    writeDiskBudgetReport: writeDiskBudgetReportMock,
  };
});

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

vi.mock("../../src/metadata.js", async () => {
  const actual = await vi.importActual<typeof MetadataModule>("../../src/metadata.js");
  return { ...actual, listSessions: listSessionsMock };
});

vi.mock("../../src/config.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../../src/config.js");
  return {
    ...actual,
    ensureInstanceConfig: ensureInstanceConfigMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../../src/runtime-tmux.js", async () => {
  const actual = await vi.importActual<typeof RuntimeTmuxModule>("../../src/runtime-tmux.js");
  return { ...actual, setTmuxSocketName: setTmuxSocketNameMock };
});

async function parseDisk(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "disk", ...args]);
}

let tempDir: string;

function fixtureReport(): DiskBudgetReport {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    roots: [
      {
        id: "npm-cacache",
        path: "/home/user/.npm/_cacache",
        sizeBytes: 50_000_000_000,
        status: "measured",
        reclaimedByDiskGc: false,
        reclaimedBy: "spur cache",
      },
      {
        id: "session-artifacts",
        path: join(tempDir, ".spur", "session-artifacts"),
        sizeBytes: 100,
        status: "measured",
        reclaimedByDiskGc: false,
        reclaimedBy: "none",
      },
    ],
    totals: { attributableBytes: 50_000_000_100 },
  };
}

describe("spur disk CLI", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    measureDiskBudgetMock.mockReset();
    writeDiskBudgetReportMock.mockReset();
    writeDiskBudgetReportMock.mockResolvedValue(undefined);
    writeStdoutMock.mockReset();
    listSessionsMock.mockReset();
    listSessionsMock.mockReturnValue([]);
    ensureInstanceConfigMock.mockReset();
    loadConfigMock.mockReset();
    setTmuxSocketNameMock.mockReset();
    tempDir = mkdtempSync("/tmp/spur-disk-cli-test-");
    const configPath = join(tempDir, "config.yaml");
    ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
    loadConfigMock.mockReturnValue({
      dataDir: join(tempDir, ".spur"),
      worktreeDir: join(tempDir, ".spur", "worktrees"),
      tmux: { socketName: "spur-test" },
      projects: {},
    });
    measureDiskBudgetMock.mockResolvedValue(fixtureReport());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes the disk-budget.json report as a side effect", async () => {
    await parseDisk([]);
    expect(writeDiskBudgetReportMock).toHaveBeenCalledTimes(1);
  });

  it("--json prints roots and a byte total", async () => {
    await parseDisk(["--json"]);
    const printed = writeStdoutMock.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.startsWith("{"));
    expect(printed).toBeDefined();
    const parsed = JSON.parse(printed ?? "{}") as DiskBudgetReport;
    expect(parsed.roots).toHaveLength(2);
    expect(parsed.totals.attributableBytes).toBe(50_000_000_100);
  });

  it("the human-readable report names each root's reclaiming owner", async () => {
    await parseDisk([]);
    const output = writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("reclaimedBy=spur cache");
    expect(output).toContain("reclaimedBy=none");
  });

  it("filters a session worktreePath outside worktreeDir via containmentRel, same rule as disk-gc", async () => {
    const worktreeDir = join(tempDir, ".spur", "worktrees");
    listSessionsMock.mockReturnValue([
      { id: "s1", worktreePath: join(worktreeDir, "abc") },
      // A `worktree: false` session's real checkout, outside worktreeDir —
      // must never reach measureDiskBudget's worktreePaths.
      { id: "s2", worktreePath: "/home/user/some-other-repo" },
    ] as never);

    await parseDisk([]);

    expect(measureDiskBudgetMock).toHaveBeenCalledTimes(1);
    const [, input] = measureDiskBudgetMock.mock.calls[0] as [unknown, { worktreePaths: string[] }];
    expect(input.worktreePaths).toEqual([join(worktreeDir, "abc")]);
  });
});
