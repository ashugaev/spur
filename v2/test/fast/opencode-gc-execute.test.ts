import { execFile } from "node:child_process";
import { open, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenCodeGcDeps,
  executeOpenCodeGc,
  writeLogTailArchive,
  type OpenCodeGcExecutorDeps,
  type OpenCodeGcPlan,
} from "../../src/opencode-gc.js";
import type { SessionRecord } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const execFileAsync = promisify(execFile);

async function du(path: string): Promise<number> {
  const { stdout } = await execFileAsync("du", ["-s", "--block-size=1", "--", path]);
  return Number.parseInt(/^(\d+)/.exec(stdout)?.[1] ?? "", 10);
}

function planFixture(overrides: Partial<OpenCodeGcPlan> = {}): OpenCodeGcPlan {
  return {
    storeRoot: "/store",
    reason: null,
    olderThanDays: 14,
    statuses: ["completed", "killed"],
    limit: 20,
    sessions: [
      {
        id: "ses_a",
        directory: "/w/a",
        canonicalDirectory: "/w/a",
        updatedAt: "2026-08-01T00:00:00.000Z",
        ageDays: 40,
        recordIds: ["spur-a"],
      },
    ],
    skipped: [],
    snapshotLeaves: [],
    log: null,
    enumeration: { listedCount: 1, limit: 100_000, truncated: false, note: "floor" },
    vacuum: {
      dbPath: "/store/opencode.db",
      dbSizeBytes: 1000,
      freeBytes: 10_000,
      requiredBytes: 2000,
      blockReasons: [],
    },
    ...overrides,
  };
}

/** A record that still matches the plan, so the freshness gate passes. */
function freshRecord(id: string, status = "completed"): SessionRecord {
  return {
    id,
    project: "sp",
    agent: "opencode",
    prompt: "ship it",
    branch: id,
    worktree: true,
    worktreePath: `/w/${id}`,
    tmuxSession: id,
    launchCommand: "opencode",
    status: status as SessionRecord["status"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function spyDeps(overrides: Partial<OpenCodeGcExecutorDeps> = {}) {
  return {
    measureSize: vi.fn(async () => 4096),
    removePath: vi.fn(async () => {}),
    readRecords: vi.fn((ids: readonly string[]) => ids.map((id) => freshRecord(id))),
    deleteSession: vi.fn(async () => {}),
    writeLogArchive: vi.fn(async () => {}),
    truncateLog: vi.fn(async () => {}),
    measureDbPayload: vi.fn(async () => 999),
    statDbSize: vi.fn(async () => 1000),
    vacuum: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("executeOpenCodeGc dry run (AC1)", () => {
  it("dry run performs no destructive IO", async () => {
    const deps = spyDeps();
    const plan = planFixture({
      snapshotLeaves: ["/store/snapshot/p/dead"],
      log: {
        path: "/store/log/opencode.log",
        archivePath: "/store/log/opencode.log.1",
        sizeBytes: 10_000,
        tailBytes: 1000,
      },
    });

    const report = await executeOpenCodeGc(plan, deps, {
      dryRun: true,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.removePath).toHaveBeenCalledTimes(0);
    expect(deps.deleteSession).toHaveBeenCalledTimes(0);
    expect(deps.writeLogArchive).toHaveBeenCalledTimes(0);
    expect(deps.truncateLog).toHaveBeenCalledTimes(0);
    expect(deps.vacuum).toHaveBeenCalledTimes(0);
    // The plan still reports candidates and non-zero bytes.
    expect(report.totals.sessionsSelected).toBe(1);
    expect(report.totals.sessionsDeleted).toBe(0);
    expect(report.totals.snapshotLeavesRemoved).toBe(0);
    expect(report.totals.freedBytes).toBeGreaterThan(0);
    expect(report.totals.dbFileBytesFreed).toBeNull();
    expect(report.vacuum.attempted).toBe(false);
  });

  it("an executing run does perform the same IO", async () => {
    const deps = spyDeps();
    const plan = planFixture({ snapshotLeaves: ["/store/snapshot/p/dead"] });

    const report = await executeOpenCodeGc(plan, deps, {
      dryRun: false,
      sizes: true,
      vacuum: false,
      dbPayload: true,
    });

    expect(deps.deleteSession).toHaveBeenCalledWith("ses_a");
    expect(deps.removePath).toHaveBeenCalledWith("/store/snapshot/p/dead");
    expect(report.totals.sessionsDeleted).toBe(1);
    expect(report.totals.snapshotLeavesRemoved).toBe(1);
  });
});

describe("execute-time freshness re-read", () => {
  it("refuses a session whose record went running after the plan was built", async () => {
    // The plan saw `completed`; disk now says `running`. `completed` is in
    // isRespawnableStatus, so this is a normal respawn, and an opencode
    // resume is `--session <agentSessionId>` — deleting the rows would bring
    // the session back empty.
    const deps = spyDeps({
      readRecords: vi.fn((ids: readonly string[]) => ids.map((id) => freshRecord(id, "running"))),
    });

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.deleteSession).toHaveBeenCalledTimes(0);
    expect(report.sessions[0]?.blockReason).toBe("changed_during_run");
    expect(report.sessions[0]?.deleted).toBe(false);
    expect(report.totals.sessionsBlocked).toBe(1);
    expect(report.totals.sessionsDeleted).toBe(0);
    // A blocked delete must also block the VACUUM.
    expect(deps.vacuum).toHaveBeenCalledTimes(0);
  });

  it("refuses a session whose record vanished, and one whose read threw", async () => {
    const gone = spyDeps({ readRecords: vi.fn(() => [null]) });
    const threw = spyDeps({
      readRecords: vi.fn(() => {
        throw new Error("EIO");
      }),
    });

    for (const deps of [gone, threw]) {
      const report = await executeOpenCodeGc(planFixture(), deps, {
        dryRun: false,
        sizes: true,
        vacuum: false,
        dbPayload: true,
      });
      expect(deps.deleteSession).toHaveBeenCalledTimes(0);
      expect(report.sessions[0]?.blockReason).toBe("changed_during_run");
    }
  });

  it("re-reads immediately before each delete, not once up front", async () => {
    const calls: string[] = [];
    const deps = spyDeps({
      readRecords: vi.fn((ids: readonly string[]) => {
        calls.push(`read:${ids.join(",")}`);
        return ids.map((id) => freshRecord(id));
      }),
      deleteSession: vi.fn(async (id: string) => {
        calls.push(`delete:${id}`);
      }),
    });
    const plan = planFixture({
      sessions: [
        {
          id: "ses_a",
          directory: "/w/a",
          canonicalDirectory: "/w/a",
          updatedAt: "2026-08-01T00:00:00.000Z",
          ageDays: 40,
          recordIds: ["spur-a"],
        },
        {
          id: "ses_b",
          directory: "/w/b",
          canonicalDirectory: "/w/b",
          updatedAt: "2026-08-01T00:00:00.000Z",
          ageDays: 40,
          recordIds: ["spur-b"],
        },
      ],
    });

    await executeOpenCodeGc(plan, deps, {
      dryRun: false,
      sizes: true,
      vacuum: false,
      dbPayload: true,
    });

    // Interleaved, so the second entry's window is not the first's.
    expect(calls).toEqual(["read:spur-a", "delete:ses_a", "read:spur-b", "delete:ses_b"]);
  });

  it("never re-reads on a dry run, which deletes nothing anyway", async () => {
    const deps = spyDeps();

    await executeOpenCodeGc(planFixture(), deps, {
      dryRun: true,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.readRecords).toHaveBeenCalledTimes(0);
  });
});

describe("the payload estimate is CLI-only", () => {
  it("skips measureDbPayload when dbPayload is false (the daemon sweep)", async () => {
    const deps = spyDeps();

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: false,
      dbPayload: false,
    });

    expect(deps.measureDbPayload).toHaveBeenCalledTimes(0);
    expect(report.totals.dbPayloadBytesEstimate).toBeNull();
    // du sizing survives; only the sqlite3 aggregate is dropped.
    expect(report.totals.freedBytes).not.toBeNull();
  });

  it("runs measureDbPayload when dbPayload is true (the CLI)", async () => {
    const deps = spyDeps();

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: false,
      dbPayload: true,
    });

    expect(deps.measureDbPayload).toHaveBeenCalledTimes(1);
    expect(report.totals.dbPayloadBytesEstimate).toBe(999);
  });
});

describe("executeOpenCodeGc vacuum interlocks", () => {
  it("names dry_run as its own vacuum block reason", async () => {
    const deps = spyDeps();

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: true,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    // Independent of `no_sessions_deleted`: a dry run must say WHY, and the
    // guard must not rest on "a dry run happens to delete nothing".
    expect(report.vacuum.blockReasons).toEqual(["dry_run", "no_sessions_deleted"]);
    expect(deps.vacuum).toHaveBeenCalledTimes(0);
  });

  it("honors the planner's interlocks, whole array, not just computes them", async () => {
    // Every other executor case plans an EMPTY blockReasons array, so the
    // propagation itself was invisible: an executor that dropped the
    // planner's reasons would VACUUM despite live_opencode_record — the one
    // interlock guarding a running opencode agent against a 93 s whole-file
    // rewrite. Two reasons, asserted with toEqual, so propagating only the
    // first element also reds.
    const deps = spyDeps();
    const plan = planFixture();

    const report = await executeOpenCodeGc(
      planFixture({
        vacuum: {
          ...plan.vacuum,
          blockReasons: ["insufficient_free_space", "live_opencode_record"],
        },
      }),
      deps,
      { dryRun: false, sizes: true, vacuum: true, dbPayload: true },
    );

    expect(deps.vacuum).toHaveBeenCalledTimes(0);
    expect(report.vacuum.blockReasons).toContain("live_opencode_record");
    expect(report.vacuum.blockReasons).toEqual(["insufficient_free_space", "live_opencode_record"]);
    expect(report.vacuum.attempted).toBe(false);
    // The delete DID run, so neither the freshness gate nor
    // `no_sessions_deleted` is what blocked the VACUUM here.
    expect(report.totals.sessionsDeleted).toBe(1);
  });

  it("never vacuums when the daemon disables it (I5)", async () => {
    const deps = spyDeps();

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: false,
      dbPayload: true,
    });

    expect(deps.vacuum).toHaveBeenCalledTimes(0);
    expect(report.totals.dbFileBytesFreed).toBeNull();
  });

  it("refuses a vacuum that deleted nothing", async () => {
    const deps = spyDeps();

    const report = await executeOpenCodeGc(planFixture({ sessions: [] }), deps, {
      dryRun: false,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.vacuum).toHaveBeenCalledTimes(0);
    expect(report.vacuum.blockReasons).toEqual(["no_sessions_deleted"]);
  });

  it("vacuums once and reports the stat delta when every interlock clears", async () => {
    const statDbSize = vi.fn();
    statDbSize.mockResolvedValueOnce(3000).mockResolvedValueOnce(1000);
    const deps = spyDeps({ statDbSize });

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.vacuum).toHaveBeenCalledTimes(1);
    expect(report.vacuum.ok).toBe(true);
    expect(report.totals.dbFileBytesFreed).toBe(2000);
  });

  it("counts a failed vacuum as an error without retrying", async () => {
    const deps = spyDeps({
      vacuum: vi.fn(async () => {
        throw new Error("database is locked");
      }),
    });

    const report = await executeOpenCodeGc(planFixture(), deps, {
      dryRun: false,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(deps.vacuum).toHaveBeenCalledTimes(1);
    expect(report.vacuum.ok).toBe(false);
    expect(report.vacuum.error).toMatch(/locked/);
    expect(report.totals.errors).toBe(1);
  });
});

describe("freed bytes match a du of the same paths (AC3)", () => {
  async function makeLeaf(root: string, name: string, bytes: number): Promise<string> {
    const leaf = join(root, "snapshot", "proj", name);
    await mkdir(leaf, { recursive: true });
    await writeFile(join(leaf, "pack"), Buffer.alloc(bytes, 7));
    return leaf;
  }

  it("AC3.1 snapshot leaves only: freedBytes equals the du sum exactly", async () => {
    const root = await createTempDir("opencode-gc-du-leaves");
    const leaves = [
      await makeLeaf(root, "dead-a", 40_000),
      await makeLeaf(root, "dead-b", 130_000),
    ];
    const deps = spyDeps({ measureSize: vi.fn(du), measureDbPayload: vi.fn(async () => null) });

    const report = await executeOpenCodeGc(planFixture({ snapshotLeaves: leaves }), deps, {
      dryRun: true,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    const expected = (await Promise.all(leaves.map(du))).reduce((sum, n) => sum + n, 0);
    expect(report.snapshotLeaves.map((entry) => entry.path)).toEqual(leaves);
    expect(report.totals.freedBytes).toBe(expected);
    // Nothing was removed, so the du above measured the very same paths.
    expect(report.totals.snapshotLeavesRemoved).toBe(0);
    expect(report.totals.dbPayloadBytesEstimate).toBeNull();
    expect(report.totals.dbFileBytesFreed).toBeNull();
  });

  it("I3 never folds the DB payload estimate into freedBytes", async () => {
    const root = await createTempDir("opencode-gc-du-db");
    const leaf = await makeLeaf(root, "dead-a", 40_000);
    const deps = spyDeps({
      measureSize: vi.fn(du),
      measureDbPayload: vi.fn(async () => 999_999_999),
    });

    const report = await executeOpenCodeGc(planFixture({ snapshotLeaves: [leaf] }), deps, {
      dryRun: true,
      sizes: true,
      vacuum: true,
      dbPayload: true,
    });

    expect(report.totals.dbPayloadBytesEstimate).toBe(999_999_999);
    expect(report.totals.freedBytes).toBe(await du(leaf));
  });

  it("AC3.2 log included: freedBytes is the leaf du sum plus du(log) - du(archive)", async () => {
    const root = await createTempDir("opencode-gc-du-log");
    const leaf = await makeLeaf(root, "dead-a", 40_000);
    const logDir = join(root, "log");
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, "opencode.log");
    const archivePath = `${logPath}.1`;
    await writeFile(logPath, Buffer.alloc(300_000, 65));

    const leafDu = await du(leaf);
    const logDu = await du(logPath);
    const deps = {
      ...spyDeps({ measureSize: vi.fn(du), measureDbPayload: vi.fn(async () => null) }),
      writeLogArchive: writeLogTailArchive,
      truncateLog: vi.fn(async () => {}),
    };

    const report = await executeOpenCodeGc(
      planFixture({
        sessions: [],
        snapshotLeaves: [leaf],
        log: { path: logPath, archivePath, sizeBytes: 300_000, tailBytes: 50_000 },
      }),
      deps,
      { dryRun: false, sizes: true, vacuum: false, dbPayload: true },
    );

    const archiveDu = await du(archivePath);
    expect(report.log?.projected).toBe(false);
    expect(report.log?.duBytes).toBe(logDu);
    expect(report.log?.retainedBytes).toBe(archiveDu);
    expect(report.log?.freedBytes).toBe(logDu - archiveDu);
    expect(report.totals.freedBytes).toBe(leafDu + (logDu - archiveDu));
    expect(report.totals.dbPayloadBytesEstimate).toBeNull();
    expect(report.totals.dbFileBytesFreed).toBeNull();
  });

  it("projects the retained tail on a dry run, where no archive exists", async () => {
    const root = await createTempDir("opencode-gc-du-log-dry");
    const logPath = join(root, "opencode.log");
    await writeFile(logPath, Buffer.alloc(300_000, 65));
    const logDu = await du(logPath);
    const deps = spyDeps({ measureSize: vi.fn(du), measureDbPayload: vi.fn(async () => null) });

    const report = await executeOpenCodeGc(
      planFixture({
        sessions: [],
        log: {
          path: logPath,
          archivePath: `${logPath}.1`,
          sizeBytes: 300_000,
          tailBytes: 50_000,
        },
      }),
      deps,
      { dryRun: true, sizes: true, vacuum: false, dbPayload: true },
    );

    expect(deps.writeLogArchive).toHaveBeenCalledTimes(0);
    expect(deps.truncateLog).toHaveBeenCalledTimes(0);
    expect(report.log?.projected).toBe(true);
    expect(report.log?.retainedBytes).toBe(50_000);
    expect(report.totals.freedBytes).toBe(logDu - 50_000);
  });
});

describe("log reclaim truncates, never renames (AC7)", () => {
  it("keeps the inode and lets an O_APPEND holder resume at offset 0", async () => {
    const root = await createTempDir("opencode-gc-truncate");
    const logPath = join(root, "opencode.log");
    const archivePath = `${logPath}.1`;
    await writeFile(logPath, Buffer.alloc(200_000, 66));
    const inodeBefore = (await stat(logPath)).ino;

    // The real holders open this file O_APPEND; reproduce that exactly.
    const holder = await open(logPath, "a");
    try {
      const config = { worktreeDir: root, dataDir: root, opencodeGc: { logLevel: "WARN" } };
      const deps = createOpenCodeGcDeps(config as never);
      const report = await executeOpenCodeGc(
        planFixture({
          sessions: [],
          log: { path: logPath, archivePath, sizeBytes: 200_000, tailBytes: 4_000 },
        }),
        deps,
        { dryRun: false, sizes: true, vacuum: false, dbPayload: true },
      );

      expect(report.log?.truncated).toBe(true);
      expect((await stat(logPath)).size).toBe(0);
      expect((await stat(logPath)).ino).toBe(inodeBefore);
      expect((await stat(archivePath)).size).toBe(4_000);

      await holder.write("resumed\n");
      expect((await stat(logPath)).size).toBe(8);
      expect(await readFile(logPath, "utf8")).toBe("resumed\n");
    } finally {
      await holder.close();
    }
  });
});
