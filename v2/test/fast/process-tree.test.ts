import { describe, expect, it, vi } from "vitest";
import type * as childProcessModule from "node:child_process";
import {
  canReadProcessTree,
  classifyProcessOwnership,
  collectDescendants,
  isPidAlive,
  isZombieProcessState,
  killProcessTree,
  listProcesses,
  parseElapsedSeconds,
  snapshotProcesses,
  snapshotProcessLiveness,
  type ProcessSnapshotEntry,
  type PpidReader,
} from "../../src/process-tree.js";

// tree: 100(root) -> 200 -> 300; 400 is unrelated (parent 1)
const tree: Record<number, number> = { 200: 100, 300: 200, 400: 1 };
const reader: PpidReader = async (pid) => tree[pid] ?? null;

describe("classifyProcessOwnership", () => {
  it("owns the ancestor itself", async () => {
    expect(await classifyProcessOwnership(100, 100, reader)).toBe("owned");
  });

  it("owns a direct and a transitive descendant", async () => {
    expect(await classifyProcessOwnership(200, 100, reader)).toBe("owned");
    expect(await classifyProcessOwnership(300, 100, reader)).toBe("owned");
  });

  it("reports a confirmed unrelated process as foreign", async () => {
    expect(await classifyProcessOwnership(400, 100, reader)).toBe("foreign");
  });

  it("reports an unreadable parent link as unknown, not foreign", async () => {
    // 999 has no entry -> reader returns null -> cannot tell.
    expect(await classifyProcessOwnership(999, 100, reader)).toBe("unknown");
  });

  it("treats a mid-chain read failure as unknown", async () => {
    // 300 -> 200 -> (200's parent missing) : parent of 200 is 100 here, so
    // build a chain that breaks partway.
    const broken: PpidReader = async (pid) => (pid === 700 ? 800 : null);
    expect(await classifyProcessOwnership(700, 100, broken)).toBe("unknown");
  });

  it("bounds the walk against cycles", async () => {
    const cyclic: PpidReader = async () => 500;
    expect(await classifyProcessOwnership(500, 100, cyclic, 5)).toBe("foreign");
  });
});

describe("canReadProcessTree", () => {
  it("is true when the pid resolves a parent", async () => {
    expect(await canReadProcessTree(200, reader)).toBe(true);
  });

  it("is false when procfs cannot be read", async () => {
    expect(await canReadProcessTree(999, reader)).toBe(false);
  });
});

describe("parseElapsedSeconds", () => {
  it("parses MM:SS", () => {
    expect(parseElapsedSeconds("05:03")).toBe(5 * 60 + 3);
  });

  it("parses HH:MM:SS", () => {
    expect(parseElapsedSeconds("01:05:03")).toBe(1 * 3_600 + 5 * 60 + 3);
  });

  it("parses D-HH:MM:SS", () => {
    expect(parseElapsedSeconds("2-01:05:03")).toBe(2 * 86_400 + 1 * 3_600 + 5 * 60 + 3);
  });

  it("returns 0 on an unparseable token", () => {
    expect(parseElapsedSeconds("garbage")).toBe(0);
    expect(parseElapsedSeconds("")).toBe(0);
    expect(parseElapsedSeconds("1:2:3:4")).toBe(0);
  });
});

describe("collectDescendants", () => {
  const table: ProcessSnapshotEntry[] = [
    { pid: 100, ppid: 1, rssKb: 1000, elapsedSeconds: 10, args: "root" },
    { pid: 200, ppid: 100, rssKb: 1000, elapsedSeconds: 10, args: "child" },
    { pid: 300, ppid: 200, rssKb: 1000, elapsedSeconds: 10, args: "grandchild" },
    { pid: 400, ppid: 1, rssKb: 1000, elapsedSeconds: 10, args: "unrelated" },
  ];

  it("collects root plus descendants, root first", () => {
    expect(collectDescendants(100, table)).toEqual([100, 200, 300]);
  });

  it("excludes unrelated processes", () => {
    expect(collectDescendants(100, table)).not.toContain(400);
  });

  it("is bounded against a ppid cycle", () => {
    const cyclic: ProcessSnapshotEntry[] = [
      { pid: 500, ppid: 600, rssKb: 1000, elapsedSeconds: 10, args: "a" },
      { pid: 600, ppid: 500, rssKb: 1000, elapsedSeconds: 10, args: "b" },
    ];
    expect(collectDescendants(500, cyclic).sort()).toEqual([500, 600]);
  });

  it("returns the root followed by breadth-ordered descendants", () => {
    const table: ProcessSnapshotEntry[] = [
      { pid: 200, ppid: 100, rssKb: 1000, elapsedSeconds: 10, args: "child" },
      { pid: 300, ppid: 200, rssKb: 1000, elapsedSeconds: 10, args: "grandchild" },
      { pid: 400, ppid: 100, rssKb: 1000, elapsedSeconds: 10, args: "sibling" },
    ];
    expect(collectDescendants(100, table)).toEqual([100, 200, 400, 300]);
  });
});

describe("isZombieProcessState", () => {
  it("treats every ps -o stat= zombie code as a zombie", () => {
    expect(isZombieProcessState("Z")).toBe(true);
    expect(isZombieProcessState("Zs")).toBe(true);
    expect(isZombieProcessState("Z+")).toBe(true);
    // Leading/trailing whitespace as ps -o stat=<pid> can emit it.
    expect(isZombieProcessState("  Z  ")).toBe(true);
  });

  it("does not treat a live state as a zombie", () => {
    expect(isZombieProcessState("R")).toBe(false);
    expect(isZombieProcessState("S")).toBe(false);
    expect(isZombieProcessState("S+")).toBe(false);
    expect(isZombieProcessState("Ss")).toBe(false);
    expect(isZombieProcessState("")).toBe(false);
  });
});

describe("isPidAlive", () => {
  // A real OS zombie cannot be manufactured from inside this Node process
  // (see the isZombieProcessState comment), so this exercises the real `ps`
  // plumbing against the two cases that ARE constructible: a genuinely live
  // pid (this test process itself) and a pid that does not exist.
  it("is true for a live, non-zombie pid", async () => {
    expect(await isPidAlive(process.pid)).toBe(true);
  });

  it("is false for a pid with no ps row", async () => {
    // Reserved/unlikely-to-exist on any real host; pid_max never reaches
    // this on Linux (32-bit ceiling, default max is far lower) or macOS.
    expect(await isPidAlive(2_147_483_647)).toBe(false);
  });
});

describe("snapshotProcessLiveness", () => {
  it("takes one batch ps fork covering the whole table and finds this test process alive", async () => {
    const snapshot = await snapshotProcessLiveness();
    expect(snapshot.status).toBe("ok");
    if (snapshot.status !== "ok") throw new Error("unreachable");
    expect(snapshot.alivePids.has(process.pid)).toBe(true);
  });

  it("is unavailable, not 'found nobody', when ps cannot be forked at all", async () => {
    // EAGAIN/EMFILE-under-fork-pressure simulation: execFile's callback
    // fires with an error and no stdout, exactly what a failed fork looks
    // like. This must NOT collapse into an empty (all-dead) snapshot.
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof childProcessModule>();
      return {
        ...actual,
        execFile: (
          _file: string,
          _args: string[],
          callback: (error: NodeJS.ErrnoException | null) => void,
        ) => {
          const error = new Error(
            "EAGAIN: resource temporarily unavailable, fork",
          ) as NodeJS.ErrnoException;
          error.code = "EAGAIN";
          callback(error);
        },
      };
    });
    try {
      const mod = await import("../../src/process-tree.js");
      const snapshot = await mod.snapshotProcessLiveness();
      expect(snapshot).toEqual({ status: "unavailable" });
      // The single-pid convenience wrapper must fail open too: an
      // indeterminate result reads as alive, never as dead.
      expect(await mod.isPidAlive(process.pid)).toBe(true);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

describe("snapshotProcessLiveness bounds", () => {
  it("bounds the liveness ps the same way as enumeration, and a timeout degrades to unavailable", async () => {
    // This runs inside every poll round on pause/complete/kill/restore/
    // relaunch/switchAuth — all daemon request paths — so an unbounded ps
    // would hang the request instead of degrading.
    const snapshot = await snapshotProcessLiveness(async (file, args, options) => {
      expect(file).toBe("ps");
      expect(args).toEqual(["-eo", "pid=,stat="]);
      expect(options).toMatchObject({ encoding: "utf8", timeout: 2_000 });
      expect(options.maxBuffer).toBeGreaterThan(0);
      throw new Error("ps timed out");
    });

    expect(snapshot).toEqual({ status: "unavailable" });
  });
});

describe("snapshotProcesses", () => {
  it("reports unavailable on exec failure while listProcesses degrades to an empty fleet", async () => {
    const failing = async () => {
      throw new Error("ps timed out");
    };

    expect(await snapshotProcesses(failing)).toEqual({ status: "unavailable" });
    expect(await listProcesses(failing)).toEqual([]);
  });
});

describe("listProcesses", () => {
  it("bounds ps enumeration and fails closed on timeout", async () => {
    const processes = await listProcesses(async (file, args, options) => {
      expect(file).toBe("ps");
      expect(args).toEqual(["-eo", "pid=,ppid=,rss=,etime=,args="]);
      expect(options).toMatchObject({ encoding: "utf8", timeout: 2_000 });
      expect(options.maxBuffer).toBeGreaterThan(0);
      throw new Error("ps timed out");
    });

    expect(processes).toEqual([]);
  });
});

describe("killProcessTree", () => {
  it("signals leaves first and skips SIGKILL when a pid identity changes", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const identities = new Map([
      [100, ["root", "root"]],
      [200, ["child", "replacement"]],
      [300, ["leaf", "leaf"]],
    ]);
    const reads = new Map<number, number>();

    await killProcessTree(100, {
      list: async () => [
        { pid: 200, ppid: 100, rssKb: 1000, elapsedSeconds: 10, args: "child" },
        { pid: 300, ppid: 200, rssKb: 1000, elapsedSeconds: 10, args: "leaf" },
      ],
      readIdentity: async (pid) => {
        const index = reads.get(pid) ?? 0;
        reads.set(pid, index + 1);
        return identities.get(pid)?.[index] ?? null;
      },
      signal: (pid, signal) => signals.push([pid, signal]),
      wait: async () => undefined,
    });

    expect(signals).toEqual([
      [300, "SIGTERM"],
      [200, "SIGTERM"],
      [100, "SIGTERM"],
      [300, "SIGKILL"],
      [100, "SIGKILL"],
    ]);
  });
});
