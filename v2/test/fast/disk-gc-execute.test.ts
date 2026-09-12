import { describe, expect, it, vi } from "vitest";
import { executeDiskGc, type DiskGcExecutorDeps, type DiskGcPlan } from "../../src/disk-gc.js";
import type { InstanceConfigReadResult } from "../../src/config.js";
import type { AppConfig, SessionRecord } from "../../src/types.js";
import type { NpmCacheIndexEntry } from "../../src/npm-cache-cap.js";

function emptyPlan(overrides: Partial<DiskGcPlan> = {}): DiskGcPlan {
  return {
    generatedAt: new Date().toISOString(),
    buildCache: { candidates: [], blocked: [] },
    profiles: { candidates: [], blocked: [] },
    browserRevisions: [],
    npmCap: undefined,
    ...overrides,
  };
}

function fakeInstanceConfig(): Extract<InstanceConfigReadResult, { status: "ok" }> {
  return {
    status: "ok" as const,
    config: {
      dataDir: "/data",
      worktreeDir: "/data/worktrees",
      projects: {},
    } as unknown as AppConfig,
  };
}

function makeDeps(overrides: Partial<DiskGcExecutorDeps> = {}): DiskGcExecutorDeps {
  return {
    worktreeDirReal: "/data/worktrees",
    readSessionFresh: () => null,
    rm: vi.fn(async () => {}),
    realpath: async (path: string) => path,
    npmClean: vi.fn(async () => {}),
    npmVerify: vi.fn(async () => {}),
    measureCacacheBytes: async () => null,
    instanceConfig: fakeInstanceConfig(),
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    project: "api",
    workspaceId: overrides.id,
    agent: "claude",
    prompt: "ship it",
    branch: overrides.id,
    worktree: true,
    worktreePath: "/data/worktrees/api/s1",
    tmuxSession: overrides.id,
    launchCommand: "claude",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("executeDiskGc — AC3 dry run removes nothing", () => {
  it("dry run removes nothing and reports the projected freed bytes", async () => {
    const rm = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const npmVerify = vi.fn(async () => {});
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees/api/s1",
            sizeBytes: 500,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
      profiles: {
        candidates: [
          { path: "/home/user/.cache/ms-playwright/mcp-chrome-x", rootId: "playwright-browsers", sizeBytes: 200, ageDays: 10 },
        ],
        blocked: [],
      },
    });
    const deps = makeDeps({ rm, npmClean, npmVerify });

    const report = await executeDiskGc(plan, deps, {
      dryRun: true,
      browserRevisions: false,
      npmCap: false,
    });

    expect(report.dryRun).toBe(true);
    expect(report.freedBytes).toBe(700);
    expect(report.buildCacheRemoved).toEqual([]);
    expect(report.profilesRemoved).toEqual([]);
    expect(rm).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    expect(npmVerify).not.toHaveBeenCalled();
  });
});

describe("executeDiskGc — AC6 execute-time re-read guard", () => {
  it("blocks a candidate whose session left the terminal set mid-run", async () => {
    const rm = vi.fn(async () => {});
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees/api/s1",
            sizeBytes: 500,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
    });
    // Flipped to "running" between plan and execute.
    const deps = makeDeps({ rm, readSessionFresh: () => session({ id: "s1", status: "running" }) });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).not.toHaveBeenCalled();
    expect(report.buildCacheRemoved).toEqual([]);
    expect(report.buildCacheFailures).toEqual([
      { path: "/data/worktrees/api/s1/.cache/webpack", message: "changed_during_run" },
    ]);
  });

  it("removes a candidate whose session is still terminal", async () => {
    const rm = vi.fn(async () => {});
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees/api/s1",
            sizeBytes: 500,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
    });
    const deps = makeDeps({ rm, readSessionFresh: () => session({ id: "s1", status: "completed" }) });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).toHaveBeenCalledWith("/data/worktrees/api/s1/.cache/webpack");
    expect(report.buildCacheRemoved).toEqual(["/data/worktrees/api/s1/.cache/webpack"]);
    expect(report.freedBytes).toBe(500);
  });
});

describe("executeDiskGc — AC13 executor containment re-check", () => {
  it("executor refuses a candidate that realpaths outside worktreeDir", async () => {
    const rm = vi.fn(async () => {});
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees/api/s1",
            sizeBytes: 500,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
    });
    // A symlink swapped in between plan and execute resolves outside worktreeDir.
    const deps = makeDeps({
      rm,
      readSessionFresh: () => session({ id: "s1", status: "completed" }),
      realpath: async () => "/home/alek/projects/ao/packages/web/.next/cache",
    });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).not.toHaveBeenCalled();
    expect(report.buildCacheRemoved).toEqual([]);
    expect(report.buildCacheFailures).toEqual([
      { path: "/data/worktrees/api/s1/.cache/webpack", message: "refused: outside worktreeDir" },
    ]);
  });
});

describe("executeDiskGc — AC7 npm cap: verify, clean oldest keys, verify, never wipes the root", () => {
  const victims: NpmCacheIndexEntry[] = [
    { key: "pkg-a", integrity: "sha512-a", time: 100, size: 1000 },
    { key: "pkg-b", integrity: "sha512-b", time: 200, size: 500 },
  ];

  it("runs verify, cleans oldest-first, verifies again, and reports freed bytes", async () => {
    const calls: string[] = [];
    const npmVerify = vi.fn(async () => {
      calls.push("verify");
    });
    const npmClean = vi.fn(async (key: string) => {
      calls.push(`clean:${key}`);
    });
    let measureCall = 0;
    const measureCacacheBytes = vi.fn(async () => {
      measureCall += 1;
      return measureCall === 1 ? 5000 : 3500;
    });
    const plan = emptyPlan({
      npmCap: {
        overCapBytes: 3000,
        capResult: { ok: true, plan: { victims, victimBytes: 1500, indexedTotalBytes: 1500 } },
      },
    });
    const deps = makeDeps({ npmVerify, npmClean, measureCacacheBytes });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(calls).toEqual(["verify", "clean:pkg-a", "clean:pkg-b", "verify"]);
    expect(report.npmCap?.cleanedKeys).toBe(2);
    expect(report.npmCap?.freedBytes).toBe(1500);
    expect(report.freedBytes).toBe(1500);
  });

  it("dry run projects the steps without running verify or clean", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const plan = emptyPlan({
      npmCap: {
        overCapBytes: 3000,
        capResult: { ok: true, plan: { victims, victimBytes: 1500, indexedTotalBytes: 1500 } },
      },
    });
    const deps = makeDeps({ npmVerify, npmClean });

    const report = await executeDiskGc(plan, deps, {
      dryRun: true,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    expect(report.npmCap?.cleanedKeys).toBe(2);
    expect(report.npmCap?.freedBytes).toBe(1500);
    expect(report.npmCap?.ranSteps.every((s) => s.startsWith("[projected, not measured]"))).toBe(
      true,
    );
  });

  it("an unreadable index-v5 aborts cleanly and cleans nothing", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const plan = emptyPlan({
      npmCap: {
        overCapBytes: 3000,
        capResult: { ok: false, reason: "npm_index_unreadable" },
      },
    });
    const deps = makeDeps({ npmVerify, npmClean });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    expect(report.npmCap).toBeUndefined();
  });
});
