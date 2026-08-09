import { describe, expect, it } from "vitest";
import {
  canReadProcessTree,
  classifyProcessOwnership,
  collectDescendants,
  killProcessTree,
  listProcesses,
  type PpidReader,
  type ProcessInfo,
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

describe("collectDescendants", () => {
  function proc(pid: number, ppid: number): ProcessInfo {
    return { pid, ppid, args: `proc-${pid}` };
  }

  it("returns root then children in BFS order", () => {
    // 1(root) -> 2,3 ; 2 -> 4
    const processes = [proc(2, 1), proc(3, 1), proc(4, 2), proc(99, 500)];
    expect(collectDescendants(1, processes)).toEqual([1, 2, 3, 4]);
  });

  it("terminates on a cyclic ppid table", () => {
    // 10 <-> 11 form a cycle; must not infinite-loop.
    const processes = [proc(10, 11), proc(11, 10)];
    expect(collectDescendants(10, processes)).toEqual([10, 11]);
  });

  it("returns the root followed by breadth-ordered descendants", () => {
    expect(
      collectDescendants(100, [
        { pid: 200, ppid: 100, args: "child" },
        { pid: 300, ppid: 200, args: "grandchild" },
        { pid: 400, ppid: 100, args: "sibling" },
      ]),
    ).toEqual([100, 200, 400, 300]);
  });
});

describe("listProcesses", () => {
  it("bounds ps enumeration and fails closed (null, never []) on timeout", async () => {
    const processes = await listProcesses(async (file, args, options) => {
      expect(file).toBe("ps");
      expect(args).toEqual(["-eo", "pid=,ppid=,args="]);
      expect(options).toMatchObject({ encoding: "utf8", timeout: 2_000 });
      expect(options.maxBuffer).toBeGreaterThan(0);
      throw new Error("ps timed out");
    });

    expect(processes).toBeNull();
  });

  it("fails closed (null) on a genuinely empty table, distinct from a real listing", async () => {
    const processes = await listProcesses(async () => ({ stdout: "" }));
    expect(processes).toBeNull();
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
        { pid: 200, ppid: 100, args: "child" },
        { pid: 300, ppid: 200, args: "leaf" },
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
