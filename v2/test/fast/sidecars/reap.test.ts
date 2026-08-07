import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import type * as timersPromisesModule from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSidecarClaims,
  collectTree,
  confirmReaps,
  findLeakedSidecarTrees,
  reapRecordedIdentity,
  snapshotProcesses,
  _computeSurvivorCandidatesForTests,
  _isPathInsideForTests,
  _parsePsOutputForTests,
  type ProcSnapshot,
  type ProcessInfo,
  type SidecarClaim,
} from "../../../src/sidecars/reap.js";
import type { SessionRecord } from "../../../src/types.js";
import { createTempDir } from "../../helpers/common.js";

// Spy on the module's own sleep so timing assertions can count invocations
// instead of trusting wall-clock, which a loaded CI host can blow past even
// when the implementation is correct (a single `ps` fork can itself take
// hundreds of ms under contention). Defaults to the real delay so every
// other test in this file — including the real-process reap below — keeps
// its actual timing; only the ONE test that needs invocation counts
// overrides it.
const timerPromisesSleepMock = vi.hoisted(() => vi.fn<(ms: number) => Promise<void>>());

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof timersPromisesModule>();
  return { ...actual, setTimeout: timerPromisesSleepMock };
});

beforeEach(async () => {
  const actual = await vi.importActual<typeof timersPromisesModule>("node:timers/promises");
  timerPromisesSleepMock.mockReset().mockImplementation((ms: number) => actual.setTimeout(ms));
});

// Narrows `T | undefined` without a non-null assertion.
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

// Test-only cleanup: signals the whole detached group so a test process
// that outlives its assertions (e.g. a reap bug leaving survivors) never
// leaks a real `sleep` process past the test file. Safe because every
// spawn in this file uses `detached: true`, so the pgid is exclusively the
// spawned child's own — never the test runner's.
function killGroupSafely(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function info(overrides: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return {
    ppid: 1,
    pgid: overrides.pid,
    rssKb: 1000,
    etimes: 10,
    args: "some-process",
    ...overrides,
  };
}

function snapshotFrom(rows: ProcessInfo[]): ProcSnapshot {
  const byPid = new Map<number, ProcessInfo>();
  const byPgid = new Map<number, ProcessInfo[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const group = byPgid.get(row.pgid) ?? [];
    group.push(row);
    byPgid.set(row.pgid, group);
  }
  return { ok: true, byPid, byPgid };
}

describe("_parsePsOutputForTests", () => {
  it("keeps args containing spaces and '=' intact", () => {
    const stdout = "  1234   1   1234   2048   99   node /a/b c.js --port=8730 --flag value\n";
    const snapshot = _parsePsOutputForTests(stdout);
    expect(snapshot.ok).toBe(true);
    const row = snapshot.byPid.get(1234);
    expect(row).toEqual({
      pid: 1234,
      ppid: 1,
      pgid: 1234,
      rssKb: 2048,
      etimes: 99,
      args: "node /a/b c.js --port=8730 --flag value",
    });
  });

  it("returns ok:false when zero rows parse (unusable ps output)", () => {
    const snapshot = _parsePsOutputForTests("garbage, no columns here\nmore garbage\n");
    expect(snapshot.ok).toBe(false);
    expect(snapshot.byPid.size).toBe(0);
  });
});

describe("snapshotProcesses", () => {
  it("returns ok:false when the ps fork itself fails", async () => {
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-bin-dir-for-spur-test";
    try {
      const snapshot = await snapshotProcesses();
      expect(snapshot.ok).toBe(false);
      expect(snapshot.byPid.size).toBe(0);
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  it("finds a real live process with a real ps fork", async () => {
    const snapshot = await snapshotProcesses();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.byPid.get(process.pid)).toBeDefined();
  });
});

describe("collectTree", () => {
  it("reaches a setsid escapee via ppid even though it sits in a different pgid", () => {
    // pane(100) -> sh(101) -> bash(102); bash setsid's escapee(200) whose
    // ppid is 102 but whose pgid is its own (200) — a different process
    // group entirely, exactly the measured spur-6128 leak shape.
    const snapshot = snapshotFrom([
      info({ pid: 100, ppid: 50, pgid: 100 }),
      info({ pid: 101, ppid: 100, pgid: 100 }),
      info({ pid: 102, ppid: 101, pgid: 100 }),
      info({ pid: 200, ppid: 102, pgid: 200 }),
      info({ pid: 201, ppid: 200, pgid: 200 }),
    ]);
    const tree = collectTree(100, snapshot);
    expect(tree).toEqual([100, 101, 102, 200, 201]);
  });

  it("is cycle-guarded", () => {
    const snapshot = snapshotFrom([
      info({ pid: 1, ppid: 2, pgid: 1 }),
      info({ pid: 2, ppid: 1, pgid: 1 }),
    ]);
    const tree = collectTree(1, snapshot);
    expect(tree.sort()).toEqual([1, 2]);
  });
});

describe("findLeakedSidecarTrees", () => {
  const worktreeDir = "/tmp/spur-worktrees";
  const worktreePath = "/tmp/spur-worktrees/api/api-1";

  function claimsWithLivePgid(
    pgid: number | undefined,
    identityRecorded = true,
  ): Map<string, SidecarClaim> {
    return new Map([
      [
        worktreePath,
        {
          sidecarNames: new Set(["dev"]),
          livePgids: new Set(pgid !== undefined ? [pgid] : []),
          identityRecorded,
        },
      ],
    ]);
  }

  it("reports unsupported and no leaks when the snapshot is unusable", async () => {
    const result = await findLeakedSidecarTrees({
      snapshot: { ok: false, byPid: new Map(), byPgid: new Map() },
      claims: new Map(),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
    });
    expect(result.supported).toBe(false);
    expect(result.leaked).toEqual([]);
  });

  it("does not flag a row whose cwd is unreadable", async () => {
    const snapshot = snapshotFrom([info({ pid: 500, ppid: 1, pgid: 500 })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => null,
    });
    expect(result.supported).toBe(true);
    expect(result.leaked).toEqual([]);
  });

  it("does not flag a row whose cwd is outside worktreeDir", async () => {
    const snapshot = snapshotFrom([info({ pid: 500, ppid: 1, pgid: 500 })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => "/home/other/somewhere",
    });
    expect(result.leaked).toEqual([]);
  });

  it("does not flag a row whose pgid is claimed live by a non-terminal sibling", async () => {
    const snapshot = snapshotFrom([info({ pid: 500, ppid: 1, pgid: 500 })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: claimsWithLivePgid(500),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => worktreePath,
    });
    expect(result.leaked).toEqual([]);
  });

  it("flags an orphan whose worktree records a different live sidecar pgid", async () => {
    const snapshot = snapshotFrom([
      info({ pid: 500, ppid: 1, pgid: 500, args: "node dev-server.js", rssKb: 4000, etimes: 300 }),
      info({ pid: 501, ppid: 500, pgid: 500 }),
    ]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: claimsWithLivePgid(999),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => worktreePath,
    });
    expect(result.leaked).toHaveLength(1);
    const leaked = must(result.leaked[0], "expected one leaked tree");
    expect(leaked.rootPid).toBe(500);
    expect(leaked.pgid).toBe(500);
    expect(leaked.worktreePath).toBe(worktreePath);
    expect(leaked.tree).toEqual([500, 501]);
    expect(leaked.sidecarName).toBe("dev");
    expect(leaked.reapable).toBe(true);
    // Sum of the whole tree's rss (root 4000 + child's default 1000), not
    // just the root pid's own 4000 — the root alone understates a leak.
    expect(leaked.treeRssKb).toBe(5000);
  });

  it("flags an orphan on a worktree with no non-terminal session at all", async () => {
    const snapshot = snapshotFrom([info({ pid: 600, ppid: 1, pgid: 600 })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => worktreePath,
    });
    expect(result.leaked).toHaveLength(1);
    expect(must(result.leaked[0], "expected one leaked tree").reapable).toBe(true);
  });

  it("reports but refuses to reap when the live claim never recorded any identity", async () => {
    const snapshot = snapshotFrom([info({ pid: 700, ppid: 1, pgid: 700 })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: claimsWithLivePgid(999, false),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => worktreePath,
    });
    expect(result.leaked).toHaveLength(1);
    expect(must(result.leaked[0], "expected one leaked tree").reapable).toBe(false);
  });

  it("reports but refuses to reap an unrelated orphan even when the worktree has recorded identity", async () => {
    // identityRecorded=true (some other sidecar on this worktree has been
    // tracked), but this orphan's own args don't name any known sidecar —
    // e.g. a stray `nohup ... &` left behind by an agent. identityRecorded
    // alone must not be enough to sweep it.
    const snapshot = snapshotFrom([
      info({ pid: 800, ppid: 1, pgid: 800, args: "nohup some-unrelated-script.sh" }),
    ]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: claimsWithLivePgid(999, true),
      worktreePaths: [worktreePath],
      worktreeDirRealpath: worktreeDir,
      readCwd: async () => worktreePath,
    });
    expect(result.leaked).toHaveLength(1);
    const leaked = must(result.leaked[0], "expected one leaked tree");
    expect(leaked.sidecarName).toBeNull();
    expect(leaked.reapable).toBe(false);
  });
});

describe("buildSidecarClaims", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
    return {
      project: "api",
      agent: "claude",
      prompt: "ship it",
      branch: overrides.id,
      worktree: true,
      worktreePath: "",
      tmuxSession: overrides.id,
      launchCommand: "claude",
      status: "running",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...overrides,
    };
  }

  it("unions sidecarNames and livePgids across non-terminal desk siblings sharing a worktree", async () => {
    const dir = await createTempDir("spur-reap-claims-");
    tempDirs.push(dir);
    const real = realpathSync(dir);
    const claims = buildSidecarClaims([
      session({
        id: "api-1",
        worktreePath: dir,
        sidecarNames: ["dev"],
        sidecarProcs: { dev: { pid: 111, pgid: 111, starttime: 1 } },
      }),
      session({
        id: "api-2",
        worktreePath: dir,
        sidecarNames: ["preview"],
      }),
    ]);
    const claim = claims.get(real);
    expect(claim?.sidecarNames).toEqual(new Set(["dev", "preview"]));
    expect(claim?.livePgids).toEqual(new Set([111]));
    expect(claim?.identityRecorded).toBe(true);
  });

  it("excludes terminal sessions from the claim set", async () => {
    const dir = await createTempDir("spur-reap-claims-");
    tempDirs.push(dir);
    const claims = buildSidecarClaims([
      session({ id: "api-1", worktreePath: dir, status: "completed", sidecarNames: ["dev"] }),
    ]);
    expect(claims.size).toBe(0);
  });

  it("skips a session whose worktreePath does not resolve", () => {
    const claims = buildSidecarClaims([
      session({ id: "api-1", worktreePath: "/nonexistent/path/for/spur/test" }),
    ]);
    expect(claims.size).toBe(0);
  });
});

describe("_computeSurvivorCandidatesForTests", () => {
  it("keeps a pid missing from the re-snapshot as a survivor candidate, never drops it silently", () => {
    // spur-6128 FIX 2: a pid can transiently fail to enumerate in a `ps`
    // fork of a genuinely-still-alive tree under load. Dropping it here
    // would exclude it from BOTH the SIGKILL pass and confirmGone's ESRCH
    // probe, letting confirmReaps report a clean reap that never ran.
    const originalSnapshot = snapshotFrom([info({ pid: 500 })]);
    const snapshot2 = snapshotFrom([]); // pid 500 absent from the re-snapshot
    const candidates = _computeSurvivorCandidatesForTests([500], snapshot2, originalSnapshot);
    expect(candidates).toEqual([500]);
  });

  it("drops a pid whose etimes went backwards — a reused pid, never signal it", () => {
    const originalSnapshot = snapshotFrom([info({ pid: 500, etimes: 100 })]);
    const snapshot2 = snapshotFrom([info({ pid: 500, etimes: 1 })]);
    const candidates = _computeSurvivorCandidatesForTests([500], snapshot2, originalSnapshot);
    expect(candidates).toEqual([]);
  });

  it("keeps a pid present with an unchanged or larger etimes", () => {
    const originalSnapshot = snapshotFrom([info({ pid: 500, etimes: 10 })]);
    const snapshot2 = snapshotFrom([info({ pid: 500, etimes: 10 })]);
    expect(_computeSurvivorCandidatesForTests([500], snapshot2, originalSnapshot)).toEqual([500]);
    const grown = snapshotFrom([info({ pid: 500, etimes: 11 })]);
    expect(_computeSurvivorCandidatesForTests([500], grown, originalSnapshot)).toEqual([500]);
  });
});

describe("confirmReaps", () => {
  it("sleeps ONE shared grace window regardless of pending count", async () => {
    // Deterministic by call count, not wall-clock: a loaded host can push a
    // single real sleep well past any fixed millisecond budget, which would
    // make a timing-based assertion flaky without the implementation ever
    // regressing. Skip the real delay entirely and just count invocations.
    timerPromisesSleepMock.mockReset().mockResolvedValue(undefined);
    const pendings = [1, 2, 3].map((n) => ({
      sessionName: `sidecar-${n}`,
      panePid: null,
      // A pid that certainly doesn't exist — still exercises the sleep path
      // (tree non-empty) without requiring a real spawned process. It also
      // fails process.kill(pid, 0) with ESRCH on the very first probe, so
      // confirmGone's own interval sleep is never reached — the only sleep
      // call left to observe is confirmReaps' shared grace window.
      tree: [900000 + n],
      ownedGroups: [],
      snapshot: { ok: true, byPid: new Map(), byPgid: new Map() } as ProcSnapshot,
    }));
    const outcomes = await confirmReaps(pendings, 100);
    expect(outcomes).toHaveLength(3);
    // One shared window sleeps exactly once; per-pending sleeping would call
    // this three times, once per pending.
    expect(timerPromisesSleepMock).toHaveBeenCalledTimes(1);
    expect(timerPromisesSleepMock).toHaveBeenCalledWith(100);
  });

  it("reaps a real spawned process tree with zero survivors", async () => {
    // `detached: true` gives the child its OWN process group (pgid ===
    // child.pid), isolated from the test runner's group — mirrors a real
    // tmux pane and guarantees a group signal here can never reach this
    // test process or its siblings.
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    try {
      const snapshot = await snapshotProcesses();
      expect(snapshot.byPid.has(pid)).toBe(true);
      const tree = collectTree(pid, snapshot);
      const pending = { sessionName: "test", panePid: pid, tree, ownedGroups: [], snapshot };
      const [outcome] = await confirmReaps([pending], 50);
      expect(outcome?.survivors).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });
});

describe("isPathInside", () => {
  it("never treats an empty or root parent as containing", () => {
    expect(_isPathInsideForTests("/anything", "")).toBe(false);
    expect(_isPathInsideForTests("/anything", "/")).toBe(false);
  });

  it("still matches a real parent/child pair", () => {
    expect(_isPathInsideForTests("/a/b", "/a")).toBe(true);
    expect(_isPathInsideForTests("/a", "/a")).toBe(true);
    expect(_isPathInsideForTests("/ab", "/a")).toBe(false);
  });
});

describe("reapRecordedIdentity", () => {
  it("refuses to signal a leaderless group when worktreePath is empty", async () => {
    // Backgrounds `sleep 30` and exits immediately: the child keeps the
    // parent's pgid (no setsid), but once bash exits the group leader is
    // gone while the group still has a live member — the exact leaderless-
    // group shape reapLeaderlessGroup exists to handle.
    const child = spawn("bash", ["-c", "sleep 30 & exit 0"], {
      stdio: "ignore",
      detached: true,
      cwd: "/tmp",
    });
    const pid = must(child.pid, "expected a spawned pid");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const outcome = await reapRecordedIdentity({ pid, pgid: pid, starttime: 0 }, "");
      expect(outcome).toBeNull();
      // Nothing was signaled — the orphaned group member is still alive.
      expect(() => process.kill(-pid, 0)).not.toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });

  it("does not signal when the recorded starttime no longer matches (pid reused)", async () => {
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    try {
      const outcome = await reapRecordedIdentity({ pid, pgid: pid, starttime: -1 }, "/tmp");
      expect(outcome).toBeNull();
      // Still alive — nothing was signaled.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });

  it("reaps a matched identity by pid+starttime", async () => {
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    try {
      const snapshot = await snapshotProcesses();
      const row = must(snapshot.byPid.get(pid), "expected the spawned pid in the snapshot");
      const statRaw = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = statRaw.lastIndexOf(")");
      const fields = statRaw
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const starttime = Number.parseInt(fields[19] ?? "", 10);
      const outcome = await reapRecordedIdentity({ pid, pgid: row.pgid, starttime }, "/tmp");
      expect(outcome?.survivors).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });
});
