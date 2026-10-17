import { describe, expect, it } from "vitest";
import { planSessionGc } from "../../src/session-gc.js";
import { hasRetainedSessionError, type SessionRecord } from "../../src/types.js";

const WORKTREE_DIR = "/data/worktrees";
const NOW = new Date("2026-08-01T00:00:00.000Z");

function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
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

function plan(
  sessions: SessionRecord[],
  overrides: Partial<{
    olderThanDays: number;
    statuses: ("completed" | "killed" | "stopped")[];
    limit: number;
    projectFilter: string;
    pathExists: (path: string) => boolean;
    now: Date;
    protectedSessionIds: ReadonlySet<string>;
  }> = {},
) {
  return planSessionGc({
    sessions,
    ...(overrides.protectedSessionIds
      ? { protectedSessionIds: overrides.protectedSessionIds }
      : {}),
    worktreeDir: WORKTREE_DIR,
    now: overrides.now ?? NOW,
    olderThanDays: overrides.olderThanDays ?? 30,
    statuses: overrides.statuses ?? ["completed", "killed", "stopped"],
    limit: overrides.limit ?? 100,
    ...(overrides.projectFilter ? { projectFilter: overrides.projectFilter } : {}),
    pathExists: overrides.pathExists ?? (() => true),
  });
}

describe("planSessionGc", () => {
  it.each(["errored", "stopped", "running"] as const)(
    "blocks a workspace with a retained %s error, including a completed sibling",
    (status) => {
      const result = plan([
        session({ id: "api-1", workspaceId: "shared" }),
        session({ id: "api-2", workspaceId: "shared", status, error: "probe failed" }),
      ]);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]?.action).toBe("blocked");
      expect(result.groups[0]?.blockReasons).toContain("retained_error");
    },
  );

  it.each(["completed", "killed", "stopped"] as const)(
    "keeps %s cleanup available without retained error evidence",
    (status) => {
      const result = plan([session({ id: "api-1", status })]);
      expect(result.groups[0]?.action).toBe("reclaim");
    },
  );

  it("blocks archive-only stopped sessions with errors", () => {
    const result = plan([
      session({ id: "api-1", status: "stopped", error: "probe failed", worktree: false }),
    ]);
    expect(result.groups[0]?.blockReasons).toEqual(["retained_error"]);
  });

  it("groups sessions by project + workspaceId", () => {
    const result = plan([
      session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      session({ id: "api-2", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      session({ id: "api-3", workspaceId: "api-3", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(result.groups).toHaveLength(2);
    const groupOne = result.groups.find((group) => group.sessionIds.includes("api-1"));
    expect(groupOne?.sessionIds.sort()).toEqual(["api-1", "api-2"]);
  });

  it("coalesces two groups that share an identical worktree path, even across projects", () => {
    const sharedPath = `${WORKTREE_DIR}/api/shared`;
    const result = plan([
      session({
        id: "api-1",
        workspaceId: "api-1",
        worktreePath: sharedPath,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      session({
        id: "web-1",
        project: "web",
        workspaceId: "web-1",
        worktreePath: sharedPath,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessionIds.sort()).toEqual(["api-1", "web-1"]);
  });

  it("blocks the whole group when a single member has a non-eligible status", () => {
    const result = plan([
      session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      session({
        id: "api-2",
        workspaceId: "api-1",
        status: "running",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.action).toBe("blocked");
    expect(result.groups[0]?.blockReasons).toContain("not_eligible_status");
  });

  it("blocks the whole group when a single member is protected by its caller", () => {
    const result = plan(
      [
        session({ id: "api-1", workspaceId: "api-1" }),
        session({ id: "api-2", workspaceId: "api-1" }),
      ],
      { protectedSessionIds: new Set(["api-2"]) },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.action).toBe("blocked");
    expect(result.groups[0]?.blockReasons).toEqual(["live_session"]);
  });

  it("never treats a group younger than the age threshold as a candidate", () => {
    const result = plan(
      [session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-07-20T00:00:00.000Z" })],
      { olderThanDays: 30 },
    );

    expect(result.groups[0]?.action).toBe("blocked");
    expect(result.groups[0]?.blockReasons).toEqual(["too_recent"]);
  });

  it("marks an old-enough eligible group with a reclaimable path as reclaim", () => {
    const result = plan([
      session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(result.groups[0]?.action).toBe("reclaim");
    expect(result.groups[0]?.blockReasons).toEqual([]);
  });

  it("yields archive, never reclaim, for a worktree:false member — its path never reaches removeWorktree", () => {
    const result = plan([
      session({
        id: "api-1",
        workspaceId: "api-1",
        worktree: false,
        worktreePath: "/repo/api",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups[0]?.action).toBe("archive");
  });

  it("yields archive when the worktree dir no longer exists", () => {
    const result = plan(
      [session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" })],
      { pathExists: () => false },
    );

    expect(result.groups[0]?.action).toBe("archive");
  });

  it("blocks a path outside config.worktreeDir instead of reclaiming it", () => {
    const result = plan([
      session({
        id: "api-1",
        workspaceId: "api-1",
        worktreePath: "/repo/api",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups[0]?.action).toBe("blocked");
    expect(result.groups[0]?.blockReasons).toEqual(["path_outside_worktree_dir"]);
  });

  it("filters by project when projectFilter is set", () => {
    const result = plan(
      [
        session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
        session({
          id: "web-1",
          project: "web",
          workspaceId: "web-1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      { projectFilter: "api" },
    );

    expect(result.scanned.sessions).toBe(1);
    expect(result.groups.map((group) => group.project)).toEqual(["api"]);
  });

  it("sorts groups oldest-first and leaves limiting to the executor", () => {
    const result = plan(
      [
        session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-06-01T00:00:00.000Z" }),
        session({ id: "api-2", workspaceId: "api-2", updatedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      { limit: 1 },
    );

    expect(result.groups.map((group) => group.sessionIds[0])).toEqual(["api-2", "api-1"]);
    expect(result.limit).toBe(1);
  });
});

describe("planSessionGc partial groups", () => {
  const OLD = "2026-01-01T00:00:00.000Z";
  const shared = (overrides: Partial<SessionRecord> & { id: string }): SessionRecord =>
    session({ worktree: false, worktreePath: "/repo/api", updatedAt: OLD, ...overrides });

  function archivedOf(sessions: SessionRecord[], options?: Parameters<typeof plan>[1]) {
    const group = plan(sessions, options).groups[0];
    if (!group) throw new Error("no group");
    return group;
  }

  it("archives eligible worktree:false siblings of a running member and keeps the anchor it references", () => {
    const group = archivedOf([
      shared({ id: "A" }),
      shared({ id: "B", workspaceId: "A" }),
      shared({ id: "C", workspaceId: "A", status: "running" }),
      shared({ id: "D" }),
    ]);

    expect(group.sessionIds.sort()).toEqual(["A", "B", "C", "D"]);
    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds.sort()).toEqual(["B", "D"]);
    expect(group.blockReasons).toEqual(["not_eligible_status"]);
    const kept = group.members.filter((member) => !group.archiveSessionIds.includes(member.id));
    for (const member of kept) {
      expect(group.archiveSessionIds).not.toContain(member.workspaceId ?? member.id);
    }
  });

  it("keeps retained-error and too-recent members and the anchors they reference", () => {
    const group = archivedOf([
      shared({ id: "A" }),
      shared({ id: "B", workspaceId: "A", status: "errored", error: "boom" }),
      shared({ id: "C", updatedAt: "2026-07-25T00:00:00.000Z" }),
      shared({ id: "D" }),
      shared({ id: "E" }),
    ]);

    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds.sort()).toEqual(["D", "E"]);
    expect(group.blockReasons).toEqual(
      expect.arrayContaining(["retained_error", "not_eligible_status", "too_recent"]),
    );
  });

  it("never reclaims an owned worktree group with a running member and keeps a path keeper", () => {
    const path = `${WORKTREE_DIR}/api/desk`;
    const own = (overrides: Partial<SessionRecord> & { id: string }) =>
      session({ worktreePath: path, workspaceId: "desk", updatedAt: OLD, ...overrides });
    const group = archivedOf([
      own({ id: "desk" }),
      own({ id: "x1", updatedAt: "2026-01-02T00:00:00.000Z" }),
      own({ id: "x2", updatedAt: "2026-01-03T00:00:00.000Z" }),
      own({ id: "x3", status: "running" }),
    ]);

    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds.sort()).toEqual(["x1", "x2"]);
    expect(group.archiveSessionIds).not.toContain("desk");
    expect(group.ownedWorktreePaths).toEqual([path]);
  });

  it("keeps one record of an existing owned path outside the worktree dir when no retained member holds it", () => {
    const own = (overrides: Partial<SessionRecord> & { id: string }) =>
      session({ workspaceId: "o0", worktreePath: "/elsewhere/o", updatedAt: OLD, ...overrides });
    const group = archivedOf([
      own({ id: "o0", worktreePath: "/elsewhere/r" }),
      own({ id: "o1" }),
      own({ id: "o2", updatedAt: "2026-01-02T00:00:00.000Z" }),
      own({ id: "r", worktreePath: "/elsewhere/r", status: "running" }),
    ]);

    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds).toEqual(["o1"]);
  });

  it("keeps a stale-parked member and archives the old completed sibling", () => {
    const group = archivedOf([
      shared({ id: "P", status: "stopped", stopReason: "stale_timeout" }),
      shared({ id: "Q" }),
    ]);

    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds).toEqual(["Q"]);
    expect(group.blockReasons).toEqual(["live_session"]);
  });

  it("archives every member of a fully eligible group exactly as before", () => {
    const group = archivedOf([shared({ id: "A" }), shared({ id: "B", workspaceId: "A" })]);

    expect(group.action).toBe("archive");
    expect(group.archiveSessionIds.sort()).toEqual(["A", "B"]);
    expect(group.blockReasons).toEqual([]);
  });

  it("keeps one record of an existing owned worktree in a mixed archive group", () => {
    const path = `${WORKTREE_DIR}/api/mixed`;
    const group = archivedOf([
      // The alias is newer, yet only the worktree:true record may be kept.
      session({
        id: "m1",
        worktree: false,
        worktreePath: path,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      session({ id: "m2", worktree: true, worktreePath: path, updatedAt: OLD }),
    ]);

    expect(group.action).toBe("partial");
    expect(group.archiveSessionIds).toEqual(["m1"]);
    expect(group.blockReasons).toEqual(["owned_worktree"]);
  });

  it("ages a partial group by its archived subset so it sorts ahead of a younger blocked group", () => {
    const result = plan([
      shared({ id: "A", updatedAt: "2026-03-01T00:00:00.000Z" }),
      shared({ id: "R", status: "running", updatedAt: "2026-07-31T00:00:00.000Z" }),
      session({
        id: "Y",
        workspaceId: "Y",
        status: "running",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups[0]?.action).toBe("partial");
    expect(result.groups[0]?.sessionIds).toContain("A");
    expect(result.groups[0]?.ageDays).toBeGreaterThan(100);
  });
});

describe("hasRetainedSessionError", () => {
  it("retains errored status without text and derived error without persisted text", () => {
    expect(hasRetainedSessionError({ status: "errored" })).toBe(true);
    expect(hasRetainedSessionError({ status: "running" }, "error")).toBe(true);
    expect(hasRetainedSessionError({ status: "stopped", error: "   " })).toBe(false);
  });

  it.each(["completed", "killed"] as const)(
    "preserves explicit %s disposal authority even with error evidence",
    (status) => {
      expect(hasRetainedSessionError({ status, error: "probe failed" }, "error")).toBe(false);
      expect(
        plan([session({ id: "api-1", status, error: "probe failed" })]).groups[0]?.action,
      ).toBe("reclaim");
    },
  );
});
