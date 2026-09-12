import { describe, expect, it, vi } from "vitest";
import { executeDiskGc, type DiskGcExecutorDeps, type DiskGcPlan } from "../../src/disk-gc.js";
import type { InstanceConfigReadResult } from "../../src/config.js";
import type { AppConfig, SessionRecord } from "../../src/types.js";

function emptyPlan(overrides: Partial<DiskGcPlan> = {}): DiskGcPlan {
  return {
    generatedAt: new Date().toISOString(),
    buildCache: { candidates: [], blocked: [] },
    profiles: { candidates: [], blocked: [] },
    browserRevisions: [],
    npmCap: { kind: "not-over-cap" },
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
    profileDeleteGuard: async () => null,
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
  it("dry run removes nothing and reports the projected freed bytes and candidate paths", async () => {
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
          {
            path: "/home/user/.cache/ms-playwright/mcp-chrome-x",
            rootId: "playwright-browsers",
            sizeBytes: 200,
            ageDays: 10,
          },
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
    expect(report.buildCache.removed).toEqual([]);
    expect(report.profiles.removed).toEqual([]);
    // B3: the dry-run report must still name every candidate path and its
    // bytes — a total with no paths is not "printing exactly what it would
    // remove".
    expect(report.buildCache.candidates).toEqual([
      {
        path: "/data/worktrees/api/s1/.cache/webpack",
        sizeBytes: 500,
        reason: expect.any(String),
      },
    ]);
    expect(report.profiles.candidates).toEqual([
      {
        path: "/home/user/.cache/ms-playwright/mcp-chrome-x",
        sizeBytes: 200,
        reason: expect.any(String),
      },
    ]);
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
    expect(report.buildCache.removed).toEqual([]);
    expect(report.buildCache.failures).toEqual([
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
    const deps = makeDeps({
      rm,
      readSessionFresh: () => session({ id: "s1", status: "completed" }),
    });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).toHaveBeenCalledWith("/data/worktrees/api/s1/.cache/webpack");
    expect(report.buildCache.removed).toEqual(["/data/worktrees/api/s1/.cache/webpack"]);
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
    expect(report.buildCache.removed).toEqual([]);
    expect(report.buildCache.failures).toEqual([
      { path: "/data/worktrees/api/s1/.cache/webpack", message: "refused: outside worktreeDir" },
    ]);
  });

  it("B5: an executor deps built with a symlinked-but-realpath-resolved worktreeDir accepts a legitimate candidate", async () => {
    // worktreeDirReal simulates createDiskGcDeps's realpath() resolution:
    // the candidate's own realpath lands under the RESOLVED dir even though
    // the lexical worktreeDir differs (a symlink ancestor). The guard must
    // compare real-to-real, never lexical-to-real.
    const rm = vi.fn(async () => {});
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees-symlink/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees-symlink/api/s1",
            sizeBytes: 500,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
    });
    const deps = makeDeps({
      rm,
      worktreeDirReal: "/data/real-worktrees",
      readSessionFresh: () => session({ id: "s1", status: "completed" }),
      realpath: async () => "/data/real-worktrees/api/s1/.cache/webpack",
    });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).toHaveBeenCalledWith("/data/worktrees-symlink/api/s1/.cache/webpack");
    expect(report.buildCache.removed).toEqual(["/data/worktrees-symlink/api/s1/.cache/webpack"]);
  });
});

describe("executeDiskGc — profile execute-time liveness re-check", () => {
  it("blocks a profile whose argv match appears between plan and execute", async () => {
    const rm = vi.fn(async () => {});
    const profilePath = "/home/user/.cache/ms-playwright/mcp-chrome-x";
    const plan = emptyPlan({
      profiles: {
        candidates: [
          { path: profilePath, rootId: "playwright-browsers", sizeBytes: 200, ageDays: 10 },
        ],
        blocked: [],
      },
    });
    const deps = makeDeps({
      rm,
      profileDeleteGuard: async () => "in_use_argv",
    });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: false,
    });

    expect(rm).not.toHaveBeenCalled();
    expect(report.profiles.removed).toEqual([]);
    expect(report.profiles.failures).toEqual([{ path: profilePath, message: "in_use_argv" }]);
  });

  it("dry run total includes browser revisions and npm cap projections", async () => {
    const plan = emptyPlan({
      buildCache: {
        candidates: [
          {
            path: "/data/worktrees/api/s1/.cache/webpack",
            worktreePath: "/data/worktrees/api/s1",
            sizeBytes: 100,
            ageDays: 30,
            sessionIds: ["s1"],
          },
        ],
        blocked: [],
      },
      browserRevisions: [
        {
          entry: {
            path: "/home/user/.cache/ms-playwright/chromium-123",
            sizeKb: 10,
            ageDays: 40,
            entryClass: { kind: "browser-revision", revision: "123" },
          },
          verdict: { kind: "prunable" },
        } as never,
      ],
      npmCap: {
        kind: "planned",
        currentSizeBytes: 5000,
        capBytes: 2000,
        overCapBytes: 3000,
        plan: { victims: [{ key: "pkg-a", size: 500 }], victimBytes: 500 },
      },
    });
    const deps = makeDeps();

    const report = await executeDiskGc(plan, deps, {
      dryRun: true,
      browserRevisions: true,
      npmCap: true,
    });

    expect(report.freedBytes).toBe(100 + 10 * 1024 + 500);
  });
});

describe("executeDiskGc — AC7/B1 npm cap: verify, RE-MEASURE, gate, clean oldest keys, verify", () => {
  const npmCapPlanned = (overCapBytes = 3000) =>
    ({
      kind: "planned" as const,
      currentSizeBytes: 5000,
      capBytes: 5000 - overCapBytes,
      overCapBytes,
      plan: {
        victims: [
          { key: "pkg-a", size: 1000 },
          { key: "pkg-b", size: 500 },
        ],
        victimBytes: 1500,
      },
    }) satisfies DiskGcPlan["npmCap"];

  it("runs verify, cleans oldest-first, verifies again, and reports freed bytes when still over cap after verify", async () => {
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
      // First measurement (post-verify, pre-clean) is STILL over the 3500 cap
      // by enough that BOTH ranked victims (1000 + 500) are needed to clear
      // it (4600 - 1000 = 3600, still over; -500 = 3100, still over — both
      // consumed); second (post-clean, post-verify) is under it.
      return measureCall === 1 ? 4600 : 3000;
    });
    const plan = emptyPlan({ npmCap: npmCapPlanned(1500) });
    const deps = makeDeps({ npmVerify, npmClean, measureCacacheBytes });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(calls).toEqual(["verify", "clean:pkg-a", "clean:pkg-b", "verify"]);
    expect(report.npmCap).toMatchObject({ status: "planned", cleanedKeys: 2, freedBytes: 2000 });
    expect(report.freedBytes).toBe(2000);
  });

  it("BLOCKER fix: cleans only the prefix of ranked victims still needed against the POST-verify size", async () => {
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
      // capBytes = 5000 - 2000 = 3000. Post-verify size is 4000: pkg-a alone
      // (1000) brings the projected total to 3000, at the cap. pkg-b and
      // pkg-c must NEVER be cleaned — they are still-valid, already-under-cap
      // content once pkg-a alone clears it, and re-cleaning the whole
      // pre-verify list would delete them for no reason (the exact bug this
      // fix closes).
      return measureCall === 1 ? 4000 : 3000;
    });
    const plan = emptyPlan({
      npmCap: {
        kind: "planned",
        currentSizeBytes: 5000,
        capBytes: 3000,
        overCapBytes: 2000,
        plan: {
          victims: [
            { key: "pkg-a", size: 1000 },
            { key: "pkg-b", size: 500 },
            { key: "pkg-c", size: 300 },
          ],
          victimBytes: 1800,
        },
      },
    });
    const deps = makeDeps({ npmVerify, npmClean, measureCacacheBytes });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(calls).toEqual(["verify", "clean:pkg-a", "verify"]);
    expect(npmClean).not.toHaveBeenCalledWith("pkg-b");
    expect(npmClean).not.toHaveBeenCalledWith("pkg-c");
    if (report.npmCap.status !== "planned") throw new Error("expected planned");
    expect(report.npmCap.cleanedKeys).toBe(1);
    // Dry-run/report contract unchanged: the report still names the FULL
    // planned victim set, even though only a prefix was actually cleaned.
    expect(report.npmCap.victims.map((v) => v.path)).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });

  it("B1: verify alone clears the cap — clean is NEVER called, and no valid entry is touched", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    // capBytes = 5000 - 1500 = 3500. Verify alone (orphan collection) drops
    // the measured size to 3200, already under cap.
    const measureCacacheBytes = vi.fn(async () => 3200);
    const plan = emptyPlan({ npmCap: npmCapPlanned(1500) });
    const deps = makeDeps({ npmVerify, npmClean, measureCacacheBytes });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).toHaveBeenCalledTimes(1);
    expect(npmClean).not.toHaveBeenCalled();
    expect(report.npmCap).toMatchObject({ status: "planned", cleanedKeys: 0, freedBytes: 1800 });
    expect(report.freedBytes).toBe(1800);
  });

  it("dry run projects the steps without running verify or clean", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const plan = emptyPlan({ npmCap: npmCapPlanned() });
    const deps = makeDeps({ npmVerify, npmClean });

    const report = await executeDiskGc(plan, deps, {
      dryRun: true,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    if (report.npmCap.status !== "planned") throw new Error("expected planned");
    expect(report.npmCap.cleanedKeys).toBe(2);
    expect(report.npmCap.freedBytes).toBe(1500);
    expect(report.freedBytes).toBe(1500);
    expect(
      report.npmCap.ranSteps.every((step: string) => step.startsWith("[projected, not measured]")),
    ).toBe(true);
  });

  it("an unreadable index-v5 reports index-unreadable and cleans nothing", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const plan = emptyPlan({ npmCap: { kind: "index-unreadable", overCapBytes: 3000 } });
    const deps = makeDeps({ npmVerify, npmClean });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    expect(report.npmCap).toEqual({ status: "index-unreadable", overCapBytes: 3000 });
  });

  it("S8: a running package manager reports its own status kind, distinct from index-unreadable", async () => {
    const npmVerify = vi.fn(async () => {});
    const npmClean = vi.fn(async () => {});
    const plan = emptyPlan({
      npmCap: { kind: "skipped-package-manager-active", overCapBytes: 3000 },
    });
    const deps = makeDeps({ npmVerify, npmClean });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(npmVerify).not.toHaveBeenCalled();
    expect(npmClean).not.toHaveBeenCalled();
    expect(report.npmCap).toEqual({
      status: "skipped-package-manager-active",
      overCapBytes: 3000,
    });
  });

  it("records npm cap execution failures without discarding the report", async () => {
    const npmVerify = vi.fn(async () => {
      throw new Error("npm verify failed");
    });
    const plan = emptyPlan({ npmCap: npmCapPlanned() });
    const deps = makeDeps({ npmVerify });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(report.npmCap).toMatchObject({
      status: "execution-failed",
      message: "npm verify failed",
      ranSteps: [],
      cleanedKeys: 0,
      freedBytes: null,
    });
    expect(report.buildCache.candidates).toEqual([]);
  });

  it("a clean that throws mid-loop still reports the keys cleaned ahead of it", async () => {
    const calls: string[] = [];
    const npmVerify = vi.fn(async () => {
      calls.push("verify");
    });
    const npmClean = vi.fn(async (key: string) => {
      if (key === "pkg-b") {
        throw new Error("clean pkg-b failed");
      }
      calls.push(`clean:${key}`);
    });
    // Post-verify size stays over cap so both ranked victims are needed.
    const measureCacacheBytes = vi.fn(async () => 4600);
    const plan = emptyPlan({ npmCap: npmCapPlanned(1500) });
    const deps = makeDeps({ npmVerify, npmClean, measureCacacheBytes });

    const report = await executeDiskGc(plan, deps, {
      dryRun: false,
      browserRevisions: false,
      npmCap: true,
    });

    expect(calls).toEqual(["verify", "clean:pkg-a"]);
    expect(report.npmCap).toMatchObject({
      status: "execution-failed",
      message: "clean pkg-b failed",
      ranSteps: ["npm cache verify", "npm cache clean pkg-a"],
      cleanedKeys: 1,
      // No post-clean verify/measure ran, so freed bytes are unknown, not 0.
      freedBytes: null,
    });
  });
});
