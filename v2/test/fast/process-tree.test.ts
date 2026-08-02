import { describe, expect, it } from "vitest";
import {
  canReadProcessTree,
  classifyProcessOwnership,
  collectDescendants,
  parseElapsedSeconds,
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
});
