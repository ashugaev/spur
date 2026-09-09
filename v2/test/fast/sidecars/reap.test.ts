import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type * as timersPromisesModule from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSidecarClaims,
  collectTree,
  confirmReaps,
  findLeakedSidecarTrees,
  reapRecordedIdentity,
  reapRecordedPortDaemon,
  snapshotProcesses,
  _computeSurvivorCandidatesForTests,
  _defaultPathExistsForTests,
  _isPathInsideForTests,
  _parseDaemonArgvForTests,
  _parsePsOutputForTests,
  _readProcArgvForTests,
  type LeakedSidecarTree,
  type ProcSnapshot,
  type ProcessInfo,
  type SidecarClaim,
} from "../../../src/sidecars/reap.js";
import type { SessionRecord } from "../../../src/types.js";
import { createTempDir } from "../../helpers/common.js";

const execFileAsync = promisify(execFile);

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

// Narrows the LeakedSidecarTree union to one variant, for tests that only
// exercise that variant — a runtime assertion, not a cast, so a predicate
// regression that emits the wrong kind fails the test instead of silently
// reading undefined fields.
function mustKind<K extends LeakedSidecarTree["kind"]>(
  value: LeakedSidecarTree | undefined,
  kind: K,
  message: string,
): Extract<LeakedSidecarTree, { kind: K }> {
  const found = must(value, message);
  if (found.kind !== kind) {
    throw new Error(`expected kind "${kind}", got "${found.kind}"`);
  }
  return found as Extract<LeakedSidecarTree, { kind: K }>;
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

describe("_defaultPathExistsForTests", () => {
  it("returns false only on ENOENT (genuinely gone)", async () => {
    await expect(_defaultPathExistsForTests("/nonexistent-spur-test-path/cli.js")).resolves.toBe(
      false,
    );
  });

  it("returns true on any other error (e.g. EACCES on a cross-uid checkout) — cannot tell means assume it exists", async () => {
    const unreadableDir = await mkdtemp(join(tmpdir(), "spur-patexists-test-"));
    const nestedPath = join(unreadableDir, "nested", "cli.js");
    mkdirSync(join(unreadableDir, "nested"), { recursive: true });
    writeFileSync(nestedPath, "", "utf8");
    chmodSync(unreadableDir, 0o000);
    try {
      await expect(_defaultPathExistsForTests(nestedPath)).resolves.toBe(true);
    } finally {
      chmodSync(unreadableDir, 0o755);
      await rm(unreadableDir, { recursive: true, force: true });
    }
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
    const leaked = mustKind(result.leaked[0], "worktree-tree", "expected one leaked tree");
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
    const leaked = mustKind(result.leaked[0], "worktree-tree", "expected one leaked tree");
    expect(leaked.sidecarName).toBeNull();
    expect(leaked.reapable).toBe(false);
  });
});

// Authoritative-argv test seam: every fixture in this file sets a
// snapshot row's `args` to the exact daemon invocation NUL-split parsing
// would see, so splitting that same string on whitespace reproduces the
// real argv for a pid the snapshot knows about.
function argvFromSnapshot(snapshot: ProcSnapshot): (pid: number) => Promise<string[] | null> {
  return async (pid: number) => {
    const argsField = snapshot.byPid.get(pid)?.args;
    return argsField ? argsField.trim().split(/\s+/) : null;
  };
}

describe("findLeakedSidecarTrees: orphan-daemon detection", () => {
  const nonDefaultConfigPath = "/tmp/spur-isolated-daemon.abc123/config.yaml";
  const cliEntryPath = "/tmp/spur-worktrees-checkout/v2/dist/cli.js";
  const daemonArgs = `/usr/bin/node ${cliEntryPath} --config ${nonDefaultConfigPath} daemon start`;

  // No worktree-tree claim is exercised by these rows (empty claims/paths):
  // orphan-daemon detection is entirely independent of the worktree-tree
  // predicate's claims/cwd machinery.
  it("AC8: reports a reparented daemon (ppid 1) with a missing cli.js as kind orphan-daemon, reapable:false", async () => {
    const snapshot = snapshotFrom([info({ pid: 900, ppid: 1, pgid: 900, args: daemonArgs })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked).toHaveLength(1);
    const leaked = mustKind(
      result.leaked[0],
      "orphan-daemon",
      "expected one leaked orphan-daemon row",
    );
    expect(leaked.reapable).toBe(false);
    expect(leaked.configPath).toBe(nonDefaultConfigPath);
    expect(leaked.cliEntryPath).toBe(cliEntryPath);
  });

  it("AC8: reports a reparented daemon whose ppid is absent from the snapshot", async () => {
    const snapshot = snapshotFrom([info({ pid: 901, ppid: 55555, pgid: 901, args: daemonArgs })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked).toHaveLength(1);
    expect(must(result.leaked[0], "expected one row").kind).toBe("orphan-daemon");
  });

  it("AC8: reports a reparented daemon whose parent is systemd --user", async () => {
    const snapshot = snapshotFrom([
      info({ pid: 1415, ppid: 1, pgid: 1415, args: "/usr/lib/systemd/systemd --user" }),
      info({ pid: 902, ppid: 1415, pgid: 902, args: daemonArgs }),
    ]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    // The daemon at 902 qualifies; the systemd --user process itself at 1415
    // (ppid 1, no daemon-shaped argv) never does.
    const orphanRows = result.leaked.filter((tree) => tree.kind === "orphan-daemon");
    expect(orphanRows).toHaveLength(1);
    expect(must(orphanRows[0], "expected one row").rootPid).toBe(902);
  });

  it("AC9: never reports it when the cli.js still exists on disk", async () => {
    const snapshot = snapshotFrom([info({ pid: 903, ppid: 1, pgid: 903, args: daemonArgs })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => true,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked.filter((tree) => tree.kind === "orphan-daemon")).toEqual([]);
  });

  it("AC9: never reports it when argv carries no --config", async () => {
    const snapshot = snapshotFrom([
      info({
        pid: 904,
        ppid: 1,
        pgid: 904,
        args: `/usr/bin/node ${cliEntryPath} daemon start`,
      }),
    ]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked.filter((tree) => tree.kind === "orphan-daemon")).toEqual([]);
  });

  it("AC9: never reports it when --config is the default instance config", async () => {
    const snapshot = snapshotFrom([
      info({
        pid: 905,
        ppid: 1,
        pgid: 905,
        args: `/usr/bin/node ${cliEntryPath} --config ${homedir()}/.spur/config.yaml daemon start`,
      }),
    ]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked.filter((tree) => tree.kind === "orphan-daemon")).toEqual([]);
  });

  it("dedupes a pid matching both predicates (ppid exactly 1, no subreaper) to a single worktree-tree row", async () => {
    // A non-systemd host (container, CI image) has no subreaper to
    // reparent onto, so a genuinely orphaned pid's ppid is exactly 1 — the
    // same fact both the worktree-tree loop and findOrphanDaemonTrees key
    // on. Without the claimedPids exclusion this pid would render twice:
    // once [reapable] (worktree-tree, unclaimed worktree) and once
    // [report-only] (orphan-daemon, missing cli.js) — and --reap would
    // silently signal the row an operator read as report-only.
    const dedupeWorktreeDir = "/tmp/spur-worktrees";
    const dedupeWorktreePath = "/tmp/spur-worktrees/api/api-1";
    const snapshot = snapshotFrom([info({ pid: 950, ppid: 1, pgid: 950, args: daemonArgs })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [dedupeWorktreePath],
      worktreeDirRealpath: dedupeWorktreeDir,
      readCwd: async () => dedupeWorktreePath,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
    });
    expect(result.leaked).toHaveLength(1);
    const leaked = mustKind(
      result.leaked[0],
      "worktree-tree",
      "expected exactly one row, not a double count",
    );
    expect(leaked.rootPid).toBe(950);
  });

  it("859/AC10: never emits a row whose configPath matches selfConfigPath under samePathOnDisk", async () => {
    const dir = await createTempDir("spur-reap-self-config-");
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "server:\n  port: 4399\n");
    const selfArgs = `/usr/bin/node ${cliEntryPath} --config ${configPath} daemon start`;
    const snapshot = snapshotFrom([info({ pid: 906, ppid: 1, pgid: 906, args: selfArgs })]);
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
      selfConfigPath: configPath,
    });
    expect(result.leaked.filter((tree) => tree.kind === "orphan-daemon")).toEqual([]);
  });

  it("859/AC12: reports port from its own instance config and liveness serving/not-serving/unknown", async () => {
    const dir = await createTempDir("spur-reap-liveness-");
    const servingConfigPath = join(dir, "serving.yaml");
    writeFileSync(servingConfigPath, "server:\n  port: 4321\n");
    const notServingConfigPath = join(dir, "not-serving.yaml");
    writeFileSync(notServingConfigPath, "server:\n  port: 4322\n");
    const emptyListenersConfigPath = join(dir, "empty-listeners.yaml");
    writeFileSync(emptyListenersConfigPath, "server:\n  port: 4323\n");
    // 0 is rejected by asOptionalNumber's own positive-number check, so a
    // config claiming it never parses to "ok" at all — the reachable
    // out-of-range case is one that PARSES (no upper-bound check in
    // asOptionalNumber) but still fails findListenerPids' 1..65535 guard.
    const invalidPortConfigPath = join(dir, "invalid-port.yaml");
    writeFileSync(invalidPortConfigPath, "server:\n  port: 70000\n");
    const argsFor = (configPath: string) =>
      `/usr/bin/node ${cliEntryPath} --config ${configPath} daemon start`;
    const snapshot = snapshotFrom([
      info({ pid: 910, ppid: 1, pgid: 910, args: argsFor(servingConfigPath) }),
      info({ pid: 911, ppid: 1, pgid: 911, args: argsFor(notServingConfigPath) }),
      info({ pid: 912, ppid: 1, pgid: 912, args: argsFor(emptyListenersConfigPath) }),
      info({ pid: 913, ppid: 1, pgid: 913, args: argsFor(invalidPortConfigPath) }),
      info({ pid: 914, ppid: 1, pgid: 914, args: argsFor("/nonexistent/absent.yaml") }),
    ]);
    const findListenersCalls: number[] = [];
    const result = await findLeakedSidecarTrees({
      snapshot,
      claims: new Map(),
      worktreePaths: [],
      worktreeDirRealpath: "/tmp/spur-worktrees",
      readCwd: async () => null,
      pathExists: async () => false,
      readArgv: argvFromSnapshot(snapshot),
      findListeners: async (port: number) => {
        findListenersCalls.push(port);
        if (port === 4321) return [910];
        if (port === 4322) return [99999];
        if (port === 4323) return [];
        throw new Error("must not be called for an invalid or absent-config port");
      },
    });
    const orphanRows = result.leaked.filter(
      (tree): tree is Extract<LeakedSidecarTree, { kind: "orphan-daemon" }> =>
        tree.kind === "orphan-daemon",
    );
    expect(orphanRows).toHaveLength(5);
    const byPid = new Map(orphanRows.map((row) => [row.rootPid, row]));
    expect(must(byPid.get(910), "serving row")).toMatchObject({ port: 4321, liveness: "serving" });
    expect(must(byPid.get(911), "not-serving row")).toMatchObject({
      port: 4322,
      liveness: "not-serving",
    });
    expect(must(byPid.get(912), "empty-listeners row")).toMatchObject({
      port: 4323,
      liveness: "unknown",
    });
    expect(must(byPid.get(913), "invalid-port row")).toMatchObject({
      port: 70000,
      liveness: "unknown",
    });
    expect(must(byPid.get(914), "absent-config row")).toMatchObject({
      port: null,
      liveness: "unknown",
    });
    // The invalid-port and absent-config rows never call findListeners —
    // AC12's "must not throw" half, proven by the seam's own guard above.
    expect(findListenersCalls.sort((a, b) => a - b)).toEqual([4321, 4322, 4323]);
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
      // Let the child settle before the baseline snapshot. `ps -o etimes`
      // reads a still-warming-up /proc/<pid>/stat can occasionally report a
      // wildly wrong (huge) elapsed time for a pid snapshotted within
      // microseconds of its own fork — reproduced directly against this
      // host's `ps`. `computeSurvivorCandidates` would then read the later,
      // correct, much-smaller etimes as "went backwards" and treat this pid
      // as already reused, skipping it entirely. A real tmux pane is never
      // this fresh when reaped, so this settle delay matches production
      // usage rather than masking anything under test.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = await snapshotProcesses();
      expect(snapshot.byPid.has(pid)).toBe(true);
      const tree = collectTree(pid, snapshot);
      const pending = { sessionName: "test", panePid: pid, tree, ownedGroups: [], snapshot };
      const [outcome] = await confirmReaps([pending], 50);
      // `survivors: []` IS the death proof: confirmGone only reaches it via
      // its own bounded ESRCH-polling loop. A second ad hoc probe here
      // (wait-then-single-kill(pid, 0)) adds no coverage and races real pid
      // reuse under CI contention — the kernel is free to hand the just-
      // freed pid to an unrelated live process before this line runs,
      // making `toThrow()` fail even though the spawned tree is long dead.
      expect(outcome?.survivors).toEqual([]);
    } finally {
      killGroupSafely(pid);
    }
  });

  it("drops a real zombie pid instead of reporting it as a survivor", async () => {
    // A zombie's kill(pid, 0) probe succeeds (the pid still occupies a slot
    // in the process table) — only isZombie's /proc/<pid>/stat state check
    // tells it apart from a genuinely alive survivor. Force a real zombie:
    // a backgrounded grandchild that exits quickly while its parent (kept
    // busy by a long foreground sleep) never reaps it.
    const parent = spawn("bash", ["-c", "(sleep 0.2) & disown; sleep 5"], {
      stdio: "ignore",
      detached: true,
    });
    const parentPid = must(parent.pid, "expected a spawned parent pid");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { stdout } = await execFileAsync("ps", [
        "--ppid",
        String(parentPid),
        "-o",
        "pid=,stat=",
      ]);
      const zombieLine = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^\d+\s+Z/.test(line));
      const zombiePidToken = must(
        zombieLine,
        "expected a zombie grandchild under the spawned parent",
      ).split(/\s+/)[0];
      const zombiePid = Number.parseInt(must(zombiePidToken, "expected a pid token"), 10);
      const pending = {
        sessionName: "zombie-test",
        panePid: null,
        tree: [zombiePid],
        ownedGroups: [],
        snapshot: { ok: true, byPid: new Map(), byPgid: new Map() } as ProcSnapshot,
      };
      const [outcome] = await confirmReaps([pending], 50);
      expect(outcome?.survivors).toEqual([]);
    } finally {
      killGroupSafely(parentPid);
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
      // See the identical note in "reaps a real spawned process tree with
      // zero survivors" above: `survivors: []` already proves death via
      // confirmGone's own bounded ESRCH polling; a second wait-then-probe
      // here races real pid reuse under load instead of adding coverage.
      expect(outcome?.survivors).toEqual([]);
    } finally {
      killGroupSafely(pid);
    }
  });
});

describe("_readProcArgvForTests / _parseDaemonArgvForTests", () => {
  it("859/AC9: parseDaemonArgv keeps a --config value containing a space, which the ps-args whitespace path would truncate", () => {
    const argv = [
      "/usr/bin/node",
      "/tmp/checkout/v2/dist/cli.js",
      "--config",
      "/tmp/spur isolated/config.yaml",
      "daemon",
      "start",
    ];
    expect(_parseDaemonArgvForTests(argv)).toEqual({
      cliEntryPath: "/tmp/checkout/v2/dist/cli.js",
      configPath: "/tmp/spur isolated/config.yaml",
    });
  });

  it("returns null when readProcArgv's own cmdline read fails (unreadable/nonexistent pid)", async () => {
    await expect(_readProcArgvForTests(999_999_999)).resolves.toBeNull();
  });
});

describe("reapRecordedPortDaemon", () => {
  const cliEntryPath = (worktreePath: string) => join(worktreePath, "v2", "dist", "cli.js");
  const nonDefaultConfigPath = "/tmp/spur-isolated-daemon.recorded-port/config.yaml";
  const daemonArgv = (configPath: string, entryPath: string) => [
    "/usr/bin/node",
    entryPath,
    "--config",
    configPath,
    "daemon",
    "start",
  ];

  it("859/AC1: signals and confirms a listener whose argv parses to a non-default config and a cli.js inside worktreePath", async () => {
    const worktreePath = await createTempDir("spur-reap-port-ac1-");
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    try {
      const argv = daemonArgv(nonDefaultConfigPath, cliEntryPath(worktreePath));
      const outcome = await reapRecordedPortDaemon({
        ports: [43210],
        worktreePath,
        findListeners: async (port) => (port === 43210 ? [pid] : []),
        readArgv: async (candidate) => (candidate === pid ? argv : null),
      });
      expect(outcome?.survivors).toEqual([]);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });

  // A `confirmGone` last-mile check (859/N7) probes every never-signaled
  // candidate with `kill(pid, 0)` before reporting it — that is a liveness
  // probe, not a kill, so asserting "no signal was issued" must ignore
  // signal-0 calls and only fail on a real terminating signal. Typed
  // structurally over just `.mock.calls` (not `ReturnType<typeof vi.spyOn>`)
  // so every concretely-typed `vi.spyOn(process, "kill")` instance at the
  // call sites below is assignable regardless of its inferred signal
  // parameter type — matching by shape, not by the spy's own generic.
  const realSignalCalls = (killSpy: { mock: { calls: readonly unknown[][] } }) =>
    killSpy.mock.calls.filter((call) => call[1] !== 0 && call[1] !== undefined);

  it("859/AC2: the same listener with cli.js OUTSIDE worktreePath is not signaled and is a survivor", async () => {
    // A REAL spawned pid, not a fake number: a T4 regression that lets this
    // candidate through would actually try to signal it, which the killSpy
    // assertion below must catch — a fake nonexistent pid would let a
    // removed T4 gate pass vacuously (snapshot.byPid.get would already
    // return undefined for it, "surviving" for an unrelated reason).
    const worktreePath = await createTempDir("spur-reap-port-ac2-");
    const outsidePath = "/tmp/spur-elsewhere/v2/dist/cli.js";
    const argv = daemonArgv(nonDefaultConfigPath, outsidePath);
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    const killSpy = vi.spyOn(process, "kill");
    try {
      const outcome = await reapRecordedPortDaemon({
        ports: [43211],
        worktreePath,
        findListeners: async (port) => (port === 43211 ? [pid] : []),
        readArgv: async (candidate) => (candidate === pid ? argv : null),
      });
      expect(outcome?.survivors).toEqual([pid]);
      expect(realSignalCalls(killSpy)).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killSpy.mockRestore();
      killGroupSafely(pid);
    }
  });

  it("859/AC2b: a `../../` traversal out of worktreePath fails T4 on the resolved path, not the raw string prefix", async () => {
    // isPathInside is a raw string startsWith: without normalizing first,
    // `<worktreePath>/../../elsewhere/v2/dist/cli.js` literally starts with
    // `<worktreePath>/`, which would pass containment despite resolving
    // outside it. A REAL spawned pid, same reasoning as AC2 above: a
    // regressed (unnormalized) T4 would actually try to signal it.
    const worktreePath = await createTempDir("spur-reap-port-ac2b-");
    const traversalPath = `${worktreePath}/../../elsewhere/v2/dist/cli.js`;
    const argv = daemonArgv(nonDefaultConfigPath, traversalPath);
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    const killSpy = vi.spyOn(process, "kill");
    try {
      const outcome = await reapRecordedPortDaemon({
        ports: [43220],
        worktreePath,
        findListeners: async (port) => (port === 43220 ? [pid] : []),
        readArgv: async (candidate) => (candidate === pid ? argv : null),
      });
      expect(outcome?.survivors).toEqual([pid]);
      expect(realSignalCalls(killSpy)).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killSpy.mockRestore();
      killGroupSafely(pid);
    }
  });

  it("859/AC3a: a listener whose argv reads and parses but is not a Spur daemon is dropped — no signal, no survivor", async () => {
    const worktreePath = await createTempDir("spur-reap-port-ac3a-");
    const killSpy = vi.spyOn(process, "kill");
    try {
      const outcome = await reapRecordedPortDaemon({
        ports: [43212],
        worktreePath,
        findListeners: async (port) => (port === 43212 ? [777_002] : []),
        readArgv: async () => ["/usr/bin/some-other-server", "--port", "43212"],
      });
      expect(outcome).toBeNull();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("859/AC3b: a listener whose argv cannot be read is a survivor with no signal — distinct from AC3a", async () => {
    // A REAL spawned pid, not a fake number: 859/N7 routes every
    // never-signaled candidate through `confirmGone` before reporting it, so
    // a genuinely nonexistent pid would now be dropped (correctly) as
    // already-gone, never reaching the survivor list this test pins.
    const worktreePath = await createTempDir("spur-reap-port-ac3b-");
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    const killSpy = vi.spyOn(process, "kill");
    try {
      const outcome = await reapRecordedPortDaemon({
        ports: [43213],
        worktreePath,
        findListeners: async (port) => (port === 43213 ? [pid] : []),
        readArgv: async () => null,
      });
      expect(outcome?.survivors).toEqual([pid]);
      expect(realSignalCalls(killSpy)).toEqual([]);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killSpy.mockRestore();
      killGroupSafely(pid);
    }
  });

  it("859/N7: a listed pid that exits before the T4 mismatch is checked is dropped, never named as a survivor", async () => {
    // The confirmGone last-mile check must actually strip a pid that is
    // already gone by the time reapRecordedPortDaemon gets around to
    // deciding it can't prove membership — otherwise stop names a dead pid.
    const worktreePath = await createTempDir("spur-reap-port-ac-n7-");
    const outsidePath = "/tmp/spur-elsewhere/v2/dist/cli.js";
    const argv = daemonArgv(nonDefaultConfigPath, outsidePath);
    const child = spawn("bash", ["-c", "true"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    const outcome = await reapRecordedPortDaemon({
      ports: [43217],
      worktreePath,
      findListeners: async (port) => (port === 43217 ? [pid] : []),
      readArgv: async (candidate) => (candidate === pid ? argv : null),
    });
    expect(outcome).toBeNull();
  });

  it("859/AC4: a listener whose --config is the default instance config is dropped regardless of the recorded port", async () => {
    const worktreePath = await createTempDir("spur-reap-port-ac4-");
    const argv = daemonArgv(`${homedir()}/.spur/config.yaml`, cliEntryPath(worktreePath));
    const killSpy = vi.spyOn(process, "kill");
    try {
      const outcome = await reapRecordedPortDaemon({
        ports: [43214],
        worktreePath,
        findListeners: async (port) => (port === 43214 ? [777_004] : []),
        readArgv: async () => argv,
      });
      expect(outcome).toBeNull();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("859/AC5: a proven daemon whose pgid is not its own is signaled per-pid only — no negative-pid group signal", async () => {
    // `spawn` with no `detached` shares THIS process's own pgid, not its
    // own — info.pgid === pid is false, so computeOwnedGroups must return
    // [] without even reaching the containment check.
    const worktreePath = await createTempDir("spur-reap-port-ac5-");
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore" });
    const pid = must(child.pid, "expected a spawned pid");
    const killSpy = vi.spyOn(process, "kill");
    try {
      const argv = daemonArgv(nonDefaultConfigPath, cliEntryPath(worktreePath));
      const outcome = await reapRecordedPortDaemon({
        ports: [43215],
        worktreePath,
        findListeners: async (port) => (port === 43215 ? [pid] : []),
        readArgv: async (candidate) => (candidate === pid ? argv : null),
      });
      expect(outcome?.survivors).toEqual([]);
      for (const call of killSpy.mock.calls) {
        const target = call[0];
        expect(typeof target === "number" ? target : 1).toBeGreaterThan(0);
      }
    } finally {
      killSpy.mockRestore();
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("859/AC6: a deleted worktreePath does not throw, and stays a plain, non-throwing outcome", async () => {
    const worktreePath = await createTempDir("spur-reap-port-ac6-");
    await rm(worktreePath, { recursive: true, force: true });
    const child = spawn("bash", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
    const pid = must(child.pid, "expected a spawned pid");
    try {
      const argv = daemonArgv(nonDefaultConfigPath, cliEntryPath(worktreePath));
      await expect(
        reapRecordedPortDaemon({
          ports: [43216],
          worktreePath,
          findListeners: async (port) => (port === 43216 ? [pid] : []),
          readArgv: async (candidate) => (candidate === pid ? argv : null),
        }),
      ).resolves.not.toThrow();
    } finally {
      killGroupSafely(pid);
    }
  });

  it("returns null when no port is recorded at all", async () => {
    const outcome = await reapRecordedPortDaemon({ ports: [], worktreePath: "/tmp/whatever" });
    expect(outcome).toBeNull();
  });
});

describe("859/AC16 GUARD: reapRecordedPortDaemon reachability", () => {
  it("is reachable from exactly one call site, inside stopSidecarLocked", async () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");
    const { stdout } = await execFileAsync("grep", ["-rn", "reapRecordedPortDaemon", srcDir]);
    const hits = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(hits).toHaveLength(3);
    const callSite = hits.find(
      (hit) => hit.includes("session-service.ts") && hit.includes("await reapRecordedPortDaemon"),
    );
    if (!callSite) {
      throw new Error(`expected one call site inside session-service.ts, got: ${hits.join("\n")}`);
    }
    const [, lineNumberRaw] = callSite.split(":");
    const callLine = Number.parseInt(lineNumberRaw ?? "", 10);
    const sessionServiceSource = await readFile(resolve(srcDir, "session-service.ts"), "utf8");
    const sessionServiceLines = sessionServiceSource.split("\n");
    const stopSidecarLockedStart = sessionServiceLines.findIndex((line) =>
      line.includes("private async stopSidecarLocked("),
    );
    const nextMethodStart = sessionServiceLines.findIndex(
      (line, index) =>
        index > stopSidecarLockedStart + 5 &&
        /^\s{2}(private |async |public )/.test(line) &&
        !line.includes("stopSidecarLocked"),
    );
    expect(stopSidecarLockedStart).toBeGreaterThan(-1);
    expect(nextMethodStart).toBeGreaterThan(stopSidecarLockedStart);
    // callLine is 1-indexed from grep; sessionServiceLines is 0-indexed.
    expect(callLine - 1).toBeGreaterThan(stopSidecarLockedStart);
    expect(callLine - 1).toBeLessThan(nextMethodStart);
  });
});

describe("859/AC-item3 GUARD: every production findLeakedSidecarTrees/sweepSidecars call site pins selfConfigPath", () => {
  // selfConfigPath is optional on FindLeakedSidecarTreesInput/
  // SweepSidecarsInput (a required field would force ~15 unrelated
  // worktree-tree-only test call sites in this file to pass a dummy value
  // for no behavioral gain — both real production callers already always
  // pass it). This guard is the compile-time-adjacent substitute: it pins,
  // by source inspection, that every CURRENT production call site
  // constructs its input object with selfConfigPath present, so a future
  // caller that copies one of these call sites verbatim but drops the
  // field reds here instead of silently shipping with no self-exclusion.
  const CALL_SITES: { file: string; marker: string }[] = [
    { file: "../../../src/host-install.ts", marker: "findLeakedSidecarTrees({" },
    { file: "../../../src/sidecars/reap.ts", marker: "findLeakedSidecarTrees({" },
    { file: "../../../src/session-service.ts", marker: "sweepSidecars({" },
  ];

  it.each(CALL_SITES)("$file's $marker call passes selfConfigPath", async ({ file, marker }) => {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), file);
    const source = await readFile(path, "utf8");
    const lines = source.split("\n");
    const startIndex = lines.findIndex((line) => line.includes(marker));
    if (startIndex === -1) {
      throw new Error(`expected to find a "${marker}" call site in ${file}`);
    }
    // The call site is either a single line (session-service.ts's
    // `return sweepSidecars({ ...assembled, reap, selfConfigPath: ... });`)
    // or a multi-line object literal closed by a bare "});" a few lines
    // down — scan forward only when the marker line itself isn't already
    // self-contained.
    const markerLine = lines[startIndex] ?? "";
    const endIndex = markerLine.includes("});")
      ? startIndex
      : lines.findIndex((line, index) => index > startIndex && line.trim() === "});");
    if (endIndex === -1) {
      throw new Error(`could not find the closing "});" for the ${marker} call site in ${file}`);
    }
    const block = lines.slice(startIndex, endIndex + 1);
    expect(block.join("\n")).toContain("selfConfigPath");
  });
});
