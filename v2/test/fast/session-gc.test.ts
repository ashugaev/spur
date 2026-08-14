import { describe, expect, it } from "vitest";
import { planSessionGc } from "../../src/session-gc.js";
import type { SessionRecord } from "../../src/types.js";

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

  it("marks restore-loss only for stopped members", () => {
    const result = plan([
      session({
        id: "api-1",
        workspaceId: "api-1",
        status: "stopped",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      session({
        id: "api-2",
        workspaceId: "api-1",
        status: "completed",
        worktreePath: `${WORKTREE_DIR}/api/api-1`,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    expect(result.groups[0]?.restoreLossSessionIds).toEqual(["api-1"]);
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

  it("sorts groups oldest-first and applies the limit", () => {
    const result = plan(
      [
        session({ id: "api-1", workspaceId: "api-1", updatedAt: "2026-06-01T00:00:00.000Z" }),
        session({ id: "api-2", workspaceId: "api-2", updatedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      { limit: 1 },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.sessionIds).toEqual(["api-2"]);
  });
});
