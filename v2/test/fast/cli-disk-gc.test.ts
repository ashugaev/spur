import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskGcReport } from "../../src/disk-gc.js";
import type * as DiskGcModule from "../../src/disk-gc.js";
import type * as DiskBudgetModule from "../../src/disk-budget.js";
import type * as MetadataModule from "../../src/metadata.js";
import type * as ConfigModule from "../../src/config.js";
import type * as ProcessTreeModule from "../../src/process-tree.js";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const {
  executeDiskGcMock,
  planBuildCacheGcMock,
  planProfileGcMock,
  planBrowserRevisionCandidatesMock,
  planNpmCapMock,
  createDiskGcDepsMock,
  writeStdoutMock,
  listSessionsMock,
  ensureInstanceConfigMock,
  loadConfigMock,
  loadInstanceConfigReadOnlyMock,
  snapshotProcessesMock,
  realDuMock,
  setTmuxSocketNameMock,
} = vi.hoisted(() => ({
  executeDiskGcMock: vi.fn(),
  planBuildCacheGcMock: vi.fn(),
  planProfileGcMock: vi.fn(),
  planBrowserRevisionCandidatesMock: vi.fn(),
  planNpmCapMock: vi.fn(),
  createDiskGcDepsMock: vi.fn(),
  writeStdoutMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
  ensureInstanceConfigMock: vi.fn(),
  loadConfigMock: vi.fn(),
  loadInstanceConfigReadOnlyMock: vi.fn(),
  snapshotProcessesMock: vi.fn(),
  realDuMock: vi.fn(),
  setTmuxSocketNameMock: vi.fn(),
}));

vi.mock("../../src/disk-gc.js", async () => {
  const actual = await vi.importActual<typeof DiskGcModule>("../../src/disk-gc.js");
  return {
    ...actual,
    executeDiskGc: executeDiskGcMock,
    planBuildCacheGc: planBuildCacheGcMock,
    planProfileGc: planProfileGcMock,
    planBrowserRevisionCandidates: planBrowserRevisionCandidatesMock,
    planNpmCap: planNpmCapMock,
    createDiskGcDeps: createDiskGcDepsMock,
  };
});

vi.mock("../../src/disk-budget.js", async () => {
  const actual = await vi.importActual<typeof DiskBudgetModule>("../../src/disk-budget.js");
  return { ...actual, realDu: realDuMock };
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
    loadInstanceConfigReadOnly: loadInstanceConfigReadOnlyMock,
  };
});

vi.mock("../../src/process-tree.js", async () => {
  const actual = await vi.importActual<typeof ProcessTreeModule>("../../src/process-tree.js");
  return { ...actual, snapshotProcesses: snapshotProcessesMock };
});

vi.mock("../../src/runtime-tmux.js", async () => {
  const actual = await vi.importActual<typeof RuntimeTmuxModule>("../../src/runtime-tmux.js");
  return { ...actual, setTmuxSocketName: setTmuxSocketNameMock };
});

async function parseDiskGc(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", "disk-gc", ...args]);
}

let tempDir: string;

function emptyReport(dryRun: boolean): DiskGcReport {
  return {
    dryRun,
    freedBytes: 0,
    buildCache: { candidates: [], removed: [], failures: [] },
    profiles: { candidates: [], removed: [], failures: [] },
    browserRevisions: { candidates: [], removed: [], failures: [], freedBytes: 0 },
    npmCap: { status: "not-over-cap" },
  };
}

describe("spur disk-gc CLI", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of [
      executeDiskGcMock,
      planBuildCacheGcMock,
      planProfileGcMock,
      planBrowserRevisionCandidatesMock,
      planNpmCapMock,
      createDiskGcDepsMock,
      writeStdoutMock,
      listSessionsMock,
      ensureInstanceConfigMock,
      loadConfigMock,
      loadInstanceConfigReadOnlyMock,
      snapshotProcessesMock,
      realDuMock,
      setTmuxSocketNameMock,
    ]) {
      mock.mockReset();
    }
    listSessionsMock.mockReturnValue([]);
    tempDir = mkdtempSync("/tmp/spur-disk-gc-cli-test-");
    const configPath = join(tempDir, "config.yaml");
    ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
    const config = {
      dataDir: join(tempDir, ".spur"),
      worktreeDir: join(tempDir, ".spur", "worktrees"),
      tmux: { socketName: "spur-test" },
      projects: {},
      diskBudget: {
        enabled: false,
        intervalMinutes: 360,
        warnAttributableGb: 60,
        npmCacheMaxGb: 20,
        buildCacheOlderThanDays: 14,
        maxWorktreesPerSweep: 20,
      },
    };
    loadConfigMock.mockReturnValue(config);
    loadInstanceConfigReadOnlyMock.mockReturnValue({ status: "ok", config });
    planBuildCacheGcMock.mockResolvedValue({ candidates: [], blocked: [] });
    planProfileGcMock.mockResolvedValue({ candidates: [], blocked: [] });
    planBrowserRevisionCandidatesMock.mockResolvedValue([]);
    planNpmCapMock.mockResolvedValue({ kind: "not-over-cap" });
    createDiskGcDepsMock.mockResolvedValue({});
    snapshotProcessesMock.mockResolvedValue({
      status: "ok",
      processes: [{ pid: 1, args: "sleep 1" }],
    });
    realDuMock.mockResolvedValue(null);
    executeDiskGcMock.mockResolvedValue(emptyReport(true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("bare disk-gc never calls executeDiskGc with dryRun false", async () => {
    await parseDiskGc([]);
    expect(executeDiskGcMock).toHaveBeenCalledTimes(1);
    const [, , options] = executeDiskGcMock.mock.calls[0] as [
      unknown,
      unknown,
      { dryRun: boolean },
    ];
    expect(options.dryRun).toBe(true);
  });

  it("--execute calls executeDiskGc with dryRun false", async () => {
    executeDiskGcMock.mockResolvedValue(emptyReport(false));
    await parseDiskGc(["--execute"]);
    const [, , options] = executeDiskGcMock.mock.calls[0] as [
      unknown,
      unknown,
      { dryRun: boolean },
    ];
    expect(options.dryRun).toBe(false);
  });

  it("throws before planning when instance config is absent", async () => {
    loadInstanceConfigReadOnlyMock.mockReturnValue({ status: "absent" });
    await expect(parseDiskGc([])).rejects.toThrow("requires a resolved instance config");
    expect(executeDiskGcMock).not.toHaveBeenCalled();
  });
});
