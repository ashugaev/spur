import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyOrphanedWorktrees, planBuildCacheGc, planProfileGc } from "../../src/disk-gc.js";
import type { SessionRecord, SessionStatus } from "../../src/types.js";

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

const OLD_MTIME = NOW.getTime() - 30 * 86_400_000;

function fakeListBuildCacheDirs(paths: string[]) {
  return async () => paths.map((path) => ({ path, newestMtimeMs: OLD_MTIME }));
}

const measureBytesFixed = async () => 1_000_000;

describe("planBuildCacheGc — AC4 live-session boundary", () => {
  const NON_TERMINAL_STATUSES: SessionStatus[] = [
    "spawning",
    "running",
    "stopped",
    "paused",
    "errored",
  ];

  it.each(NON_TERMINAL_STATUSES)(
    "never selects a build cache in a worktree with a %s session",
    async (status) => {
      const worktreePath = `${WORKTREE_DIR}/api/s1`;
      const result = await planBuildCacheGc({
        sessions: [session({ id: "s1", status, worktreePath })],
        worktreeDir: WORKTREE_DIR,
        now: NOW,
        olderThanDays: 14,
        maxWorktrees: 20,
        listBuildCacheDirs: fakeListBuildCacheDirs([join(worktreePath, ".cache", "webpack")]),
        measureBytes: measureBytesFixed,
      });

      expect(result.candidates).toEqual([]);
      expect(result.blocked).toEqual([
        { worktreePath, reason: "live_session", sessionIds: ["s1"] },
      ]);
    },
  );

  it("a mixed worktree (one completed + one running) yields zero candidates", async () => {
    const worktreePath = `${WORKTREE_DIR}/api/mixed`;
    const result = await planBuildCacheGc({
      sessions: [
        session({ id: "s1", status: "completed", worktreePath }),
        session({ id: "s2", status: "running", worktreePath }),
      ],
      worktreeDir: WORKTREE_DIR,
      now: NOW,
      olderThanDays: 14,
      maxWorktrees: 20,
      listBuildCacheDirs: fakeListBuildCacheDirs([join(worktreePath, ".cache", "webpack")]),
      measureBytes: measureBytesFixed,
    });

    expect(result.candidates).toEqual([]);
    expect(result.blocked).toEqual([
      { worktreePath, reason: "live_session", sessionIds: ["s1", "s2"] },
    ]);
  });

  it("selects only build-cache dirs under a fully terminal worktree", async () => {
    const worktreePath = `${WORKTREE_DIR}/api/done`;
    const cacheDir = join(worktreePath, ".cache", "webpack");
    const result = await planBuildCacheGc({
      sessions: [session({ id: "s1", status: "killed", worktreePath })],
      worktreeDir: WORKTREE_DIR,
      now: NOW,
      olderThanDays: 14,
      maxWorktrees: 20,
      listBuildCacheDirs: fakeListBuildCacheDirs([cacheDir]),
      measureBytes: measureBytesFixed,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.path).toBe(cacheDir);
    expect(result.blocked).toEqual([]);
  });
});

describe("planBuildCacheGc — AC13 worktreeDir containment", () => {
  it("a worktree:false session whose worktreePath is the operator checkout yields zero candidates", async () => {
    const operatorCheckout = "/home/alek/projects/ao";
    const result = await planBuildCacheGc({
      sessions: [
        session({
          id: "s1",
          status: "completed",
          worktree: false,
          worktreePath: operatorCheckout,
        }),
      ],
      worktreeDir: WORKTREE_DIR,
      now: NOW,
      olderThanDays: 14,
      maxWorktrees: 20,
      listBuildCacheDirs: fakeListBuildCacheDirs([
        join(operatorCheckout, "packages/web/.next/cache"),
      ]),
      measureBytes: measureBytesFixed,
    });

    expect(result.candidates).toEqual([]);
    expect(result.blocked).toEqual([
      { worktreePath: operatorCheckout, reason: "path_outside_worktree_dir", sessionIds: ["s1"] },
    ]);
  });

  it("the worktrees root itself yields zero candidates", async () => {
    const result = await planBuildCacheGc({
      sessions: [session({ id: "s1", status: "completed", worktreePath: WORKTREE_DIR })],
      worktreeDir: WORKTREE_DIR,
      now: NOW,
      olderThanDays: 14,
      maxWorktrees: 20,
      listBuildCacheDirs: fakeListBuildCacheDirs([join(WORKTREE_DIR, ".cache", "webpack")]),
      measureBytes: measureBytesFixed,
    });

    expect(result.candidates).toEqual([]);
    expect(result.blocked).toEqual([
      { worktreePath: WORKTREE_DIR, reason: "path_outside_worktree_dir", sessionIds: ["s1"] },
    ]);
  });
});

describe("planBuildCacheGc — AC15 report-only classes", () => {
  it("a worktree with no session record at all is never a candidate (orphaned_no_record)", () => {
    const knownSessions = [
      session({ id: "s1", status: "completed", worktreePath: "/data/worktrees/api/s1" }),
    ];
    const discovered = ["/data/worktrees/api/s1", "/data/worktrees/api/orphan"];
    expect(classifyOrphanedWorktrees(discovered, knownSessions)).toEqual([
      "/data/worktrees/api/orphan",
    ]);
  });
});

// findBuildCacheDirs itself has its own real-fs test in build-cache-scan.test.ts
// (it lives in build-cache-scan.ts now, imported here only as an IO seam).

describe("planProfileGc — AC20 mcp profile default target and live-launch protection", () => {
  const profileRoot = {
    rootId: "playwright-browsers" as const,
    path: "/home/user/.cache/ms-playwright",
  };
  const roots = [profileRoot];

  it("a live argv match protects the profile dir", async () => {
    const profilePath = join(profileRoot.path, "mcp-chrome-abc");
    const result = await planProfileGc({
      roots,
      now: NOW,
      processes: [{ pid: 123, args: `chrome --user-data-dir=${profilePath}` } as never],
      myUid: 1000,
      listProfileDirs: async () => ["mcp-chrome-abc"],
      statProfile: async () => ({ uid: 1000, isSymlink: false, mtimeMs: OLD_MTIME }),
      measureBytes: measureBytesFixed,
      singletonLockLivePid: async () => null,
    });

    expect(result.candidates).toEqual([]);
    expect(result.blocked).toEqual([{ path: profilePath, reason: "in_use_argv" }]);
  });

  it("a live SingletonLock pid protects the profile dir", async () => {
    const profilePath = join(profileRoot.path, "mcp-chrome-def");
    const result = await planProfileGc({
      roots,
      now: NOW,
      processes: [],
      myUid: 1000,
      listProfileDirs: async () => ["mcp-chrome-def"],
      statProfile: async () => ({ uid: 1000, isSymlink: false, mtimeMs: OLD_MTIME }),
      measureBytes: measureBytesFixed,
      singletonLockLivePid: async () => 456,
    });

    expect(result.candidates).toEqual([]);
    expect(result.blocked).toEqual([{ path: profilePath, reason: "singleton_lock_live" }]);
  });

  it("a stale, unreferenced profile dir is selected", async () => {
    const profilePath = join(profileRoot.path, "mcp-chrome-stale");
    const result = await planProfileGc({
      roots,
      now: NOW,
      processes: [],
      myUid: 1000,
      listProfileDirs: async () => ["mcp-chrome-stale"],
      statProfile: async () => ({ uid: 1000, isSymlink: false, mtimeMs: OLD_MTIME }),
      measureBytes: measureBytesFixed,
      singletonLockLivePid: async () => null,
    });

    expect(result.candidates).toEqual([
      { path: profilePath, rootId: "playwright-browsers", sizeBytes: 1_000_000, ageDays: 30 },
    ]);
    expect(result.blocked).toEqual([]);
  });

  it("a non mcp-* dir (e.g. a browser revision) is never a profile candidate", async () => {
    const result = await planProfileGc({
      roots,
      now: NOW,
      processes: [],
      myUid: 1000,
      listProfileDirs: async () => ["chromium-1234"],
      statProfile: async () => ({ uid: 1000, isSymlink: false, mtimeMs: OLD_MTIME }),
      measureBytes: measureBytesFixed,
      singletonLockLivePid: async () => null,
    });

    expect(result.candidates).toEqual([]);
  });
});
