import { describe, expect, it, vi } from "vitest";
import {
  executeSessionGc,
  planSessionGc,
  type GcOpenPrIndex,
  type SessionGcExecutorDeps,
} from "../../src/session-gc.js";
import type { SessionRecord } from "../../src/types.js";

const WORKTREE_DIR = "/data/worktrees";
const NOW = new Date("2026-08-01T00:00:00.000Z");

function makeSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    project: "api",
    workspaceId: overrides.id,
    agent: "claude",
    prompt: "ship it",
    branch: overrides.id,
    worktree: true,
    worktreePath: `${WORKTREE_DIR}/api/${overrides.id}`,
    tmuxSession: overrides.id,
    launchCommand: "claude",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function planOne(session: SessionRecord, limit = 100) {
  return planSessionGc({
    sessions: [session],
    worktreeDir: WORKTREE_DIR,
    now: NOW,
    olderThanDays: 30,
    statuses: ["completed", "killed", "stopped"],
    limit,
    pathExists: () => true,
  });
}

function makeDeps(overrides: Partial<SessionGcExecutorDeps> = {}): SessionGcExecutorDeps {
  return {
    cwd: "/home/dev",
    readGroupMembers: (ids) => ids.map((id) => makeSession({ id })),
    checkGroupLiveness: vi.fn<SessionGcExecutorDeps["checkGroupLiveness"]>(() => "inactive"),
    probeGuards: vi.fn(async () => []),
    openPrIndex: vi.fn(
      async (): Promise<GcOpenPrIndex> => ({ numbers: new Set(), branches: new Set() }),
    ),
    measureSize: vi.fn(async () => 1024),
    removeWorktree: vi.fn(async () => {}),
    archiveGroup: vi.fn<SessionGcExecutorDeps["archiveGroup"]>((members) => ({
      archivedIds: members.map((member) => member.id),
    })),
    pruneRepo: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("executeSessionGc", () => {
  it("removes the worktree and archives records for a reclaim group", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({ readGroupMembers: (ids) => ids.map(() => record) });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: true });

    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.pruneRepo).toHaveBeenCalledTimes(1);
    expect(deps.archiveGroup).toHaveBeenCalledTimes(1);
    expect(report.groups[0]?.action).toBe("reclaim");
    expect(report.groups[0]?.removed).toBe(true);
    expect(report.groups[0]?.archived).toBe(true);
    expect(report.totals.worktreesRemoved).toBe(1);
    expect(report.totals.recordsArchived).toBe(1);
    expect(report.totals.freedBytes).toBe(1024);
  });

  it("checks every coalesced member after awaited probes and blocks the whole group", async () => {
    const sharedPath = `${WORKTREE_DIR}/api/shared`;
    const records = [
      makeSession({ id: "api-1", workspaceId: "shared", worktreePath: sharedPath }),
      makeSession({ id: "api-2", workspaceId: "shared", worktreePath: sharedPath }),
    ];
    const plan = planSessionGc({
      sessions: records,
      worktreeDir: WORKTREE_DIR,
      now: NOW,
      olderThanDays: 30,
      statuses: ["completed", "killed", "stopped"],
      limit: 100,
      pathExists: () => true,
    });
    const order: string[] = [];
    const deps = makeDeps({
      readGroupMembers: (ids) =>
        ids.map((id) => records.find((record) => record.id === id) ?? null),
      probeGuards: vi.fn(async () => {
        order.push("guards");
        return [];
      }),
      openPrIndex: vi.fn(async (): Promise<GcOpenPrIndex> => {
        order.push("pr");
        return { numbers: new Set(), branches: new Set() };
      }),
      checkGroupLiveness: vi.fn<SessionGcExecutorDeps["checkGroupLiveness"]>((ids) => {
        order.push(`liveness:${ids.join(",")}`);
        return "live";
      }),
      removeWorktree: vi.fn(async () => {
        order.push("remove");
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(order).toEqual(["guards", "pr", "liveness:api-1,api-2"]);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.pruneRepo).not.toHaveBeenCalled();
    expect(deps.archiveGroup).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["live_session"]);
  });

  it.each(["unknown", "throw"] as const)(
    "fails closed when the execution-time liveness check returns %s",
    async (failure) => {
      const record = makeSession({ id: "api-1" });
      const plan = planOne(record);
      const deps = makeDeps({
        readGroupMembers: () => [record],
        checkGroupLiveness: vi.fn<SessionGcExecutorDeps["checkGroupLiveness"]>(() => {
          if (failure === "throw") throw new Error("metadata unreadable");
          return "unknown";
        }),
      });

      const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

      expect(deps.removeWorktree).not.toHaveBeenCalled();
      expect(deps.archiveGroup).not.toHaveBeenCalled();
      expect(report.groups[0]?.blockReasons).toEqual(["liveness_check_failed"]);
    },
  );

  it("checks liveness again immediately before archive", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const order: string[] = [];
    const checkGroupLiveness = vi
      .fn<SessionGcExecutorDeps["checkGroupLiveness"]>()
      .mockImplementationOnce(() => {
        order.push("liveness:remove");
        return "inactive";
      })
      .mockImplementationOnce(() => {
        order.push("liveness:archive");
        return "live";
      });
    const deps = makeDeps({
      readGroupMembers: () => [record],
      checkGroupLiveness,
      removeWorktree: vi.fn(async () => {
        order.push("remove");
      }),
      pruneRepo: vi.fn(async () => {
        order.push("prune");
      }),
      archiveGroup: vi.fn(() => {
        order.push("archive");
        return { archivedIds: [record.id] };
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(order).toEqual(["liveness:remove", "remove", "prune", "liveness:archive"]);
    expect(deps.archiveGroup).not.toHaveBeenCalled();
    expect(report.groups[0]).toMatchObject({
      action: "blocked",
      blockReasons: ["live_session"],
      removed: true,
      archived: false,
    });
  });

  it("dry run performs zero removeWorktree, archive, or size-skipping writes but still reports sizes and reasons", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({ readGroupMembers: (ids) => ids.map(() => record) });

    const report = await executeSessionGc(plan, deps, { dryRun: true, sizes: true });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.pruneRepo).not.toHaveBeenCalled();
    expect(deps.archiveGroup).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.groups[0]?.action).toBe("reclaim");
    expect(report.groups[0]?.removed).toBe(false);
    expect(report.groups[0]?.archived).toBe(false);
    expect(report.groups[0]?.sizeBytes).toBe(1024);
    // A dry run projects what the reclaim would free.
    expect(report.totals.freedBytes).toBe(1024);
  });

  it("blocks and never removes when hasUncommittedChanges reports dirty", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      probeGuards: vi.fn(async () => ["uncommitted_changes"]),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.archiveGroup).not.toHaveBeenCalled();
    expect(report.groups[0]?.action).toBe("blocked");
    expect(report.groups[0]?.blockReasons).toEqual(["uncommitted_changes"]);
  });

  it("blocks and never removes when hasUnpushedCommits reports unpushed work (via probeGuards)", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      probeGuards: vi.fn(async () => ["unpushed_commits"]),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["unpushed_commits"]);
  });

  it("blocks on an open PR bound by number", async () => {
    const record = makeSession({
      id: "api-1",
      pr: { number: 42, repo: "acme/api", url: "https://github.com/acme/api/pull/42" },
    });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      openPrIndex: vi.fn(
        async (): Promise<GcOpenPrIndex> => ({ numbers: new Set([42]), branches: new Set() }),
      ),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.action).toBe("blocked");
    expect(report.groups[0]?.blockReasons).toEqual(["open_pr"]);
  });

  it("blocks on an open PR matched only by branch", async () => {
    const record = makeSession({ id: "api-1", branch: "feature/x" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      openPrIndex: vi.fn(
        async (): Promise<GcOpenPrIndex> => ({
          numbers: new Set(),
          branches: new Set(["feature/x"]),
        }),
      ),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["open_pr"]);
  });

  it("blocks with probe_failed when the PR probe throws — never reads a throw as no PR", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      openPrIndex: vi.fn(async () => {
        throw new Error("gh not authenticated");
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["probe_failed"]);
  });

  it("blocks with changed_during_run when a fresh re-read disagrees with the plan", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: () => [{ ...record, status: "running" }],
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["changed_during_run"]);
  });

  it.each([
    ["worktreePath", { worktreePath: `${WORKTREE_DIR}/api/moved` }],
    ["worktree", { worktree: false }],
    ["branch", { branch: "feature/renamed" }],
    [
      "pr",
      { pr: { number: 7, repo: "acme/api", url: "https://github.com/acme/api/pull/7" } as const },
    ],
  ])(
    "blocks with changed_during_run when a concurrent write changes %s without bumping updatedAt",
    async (_field, overrides) => {
      const record = makeSession({ id: "api-1" });
      const plan = planOne(record);
      const deps = makeDeps({
        readGroupMembers: () => [{ ...record, ...overrides }],
      });

      const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

      expect(deps.removeWorktree).not.toHaveBeenCalled();
      expect(deps.archiveGroup).not.toHaveBeenCalled();
      expect(report.groups[0]?.blockReasons).toEqual(["changed_during_run"]);
    },
  );

  it("blocks with changed_during_run when a member vanished (already archived elsewhere)", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({ readGroupMembers: () => [null] });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["changed_during_run"]);
  });

  it("blocks with path_is_cwd_or_ancestor instead of removing the CLI's own cwd", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      cwd: `${WORKTREE_DIR}/api/api-1/nested`,
      readGroupMembers: (ids) => ids.map(() => record),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(report.groups[0]?.blockReasons).toEqual(["path_is_cwd_or_ancestor"]);
  });

  it("leaves records unarchived and excludes bytes from the freed total when removeWorktree throws", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      removeWorktree: vi.fn(async () => {
        throw new Error("git worktree remove failed");
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: true });

    expect(deps.archiveGroup).not.toHaveBeenCalled();
    expect(report.groups[0]?.removed).toBe(false);
    expect(report.groups[0]?.archived).toBe(false);
    expect(report.groups[0]?.error).toMatch(/git worktree remove failed/);
    expect(report.totals.freedBytes).toBe(0);
    expect(report.totals.errors).toBe(1);
  });

  it("archives without removing a worktree for an archive-only group", async () => {
    const record = makeSession({ id: "api-1", worktree: false, worktreePath: "/repo/api" });
    const plan = planOne(record);
    const deps = makeDeps({ readGroupMembers: (ids) => ids.map(() => record) });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: true });

    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.archiveGroup).toHaveBeenCalledTimes(1);
    expect(report.groups[0]?.action).toBe("archive");
    expect(report.groups[0]?.archived).toBe(true);
    expect(report.groups[0]?.sizeBytes).toBeNull();
  });

  it("--no-sizes yields sizeBytes: null with zero measureSize invocations", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({ readGroupMembers: (ids) => ids.map(() => record) });

    const report = await executeSessionGc(plan, deps, { dryRun: true, sizes: false });

    expect(deps.measureSize).not.toHaveBeenCalled();
    expect(report.groups[0]?.sizeBytes).toBeNull();
  });

  it("measures size before removal, so freed bytes survive the delete", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const order: string[] = [];
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      measureSize: vi.fn(async () => {
        order.push("measure");
        return 2048;
      }),
      removeWorktree: vi.fn(async () => {
        order.push("remove");
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: true });

    expect(order).toEqual(["measure", "remove"]);
    expect(report.totals.freedBytes).toBe(2048);
  });

  it("does not probe or reclaim a group already blocked at plan time", async () => {
    const record = makeSession({ id: "api-1", status: "running" });
    const plan = planOne(record);
    const deps = makeDeps();

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(deps.probeGuards).not.toHaveBeenCalled();
    expect(deps.openPrIndex).not.toHaveBeenCalled();
    expect(report.groups[0]?.action).toBe("blocked");
    expect(report.groups[0]?.blockReasons).toEqual(["not_eligible_status"]);
  });
});

describe("executeSessionGc exit-code totals", () => {
  it("counts group errors in totals.errors for the CLI to key its exit code off", async () => {
    const record = makeSession({ id: "api-1" });
    const plan = planOne(record);
    const deps = makeDeps({
      readGroupMembers: (ids) => ids.map(() => record),
      archiveGroup: vi.fn(() => {
        throw new Error("disk full");
      }),
    });

    const report = await executeSessionGc(plan, deps, { dryRun: false, sizes: false });

    expect(report.totals.errors).toBe(1);
    expect(report.groups[0]?.error).toMatch(/disk full/);
  });
});
