import { describe, expect, it } from "vitest";
import {
  canReadProcessTree,
  isProcessDescendantOf,
  type PpidReader,
} from "../../src/process-tree.js";

// tree: 100(root) -> 200 -> 300; 400 is unrelated (parent 1)
const tree: Record<number, number> = { 200: 100, 300: 200, 400: 1 };
const reader: PpidReader = async (pid) => tree[pid] ?? null;

describe("isProcessDescendantOf", () => {
  it("matches the ancestor itself", async () => {
    expect(await isProcessDescendantOf(100, 100, reader)).toBe(true);
  });

  it("matches a direct and a transitive descendant", async () => {
    expect(await isProcessDescendantOf(200, 100, reader)).toBe(true);
    expect(await isProcessDescendantOf(300, 100, reader)).toBe(true);
  });

  it("rejects an unrelated process", async () => {
    expect(await isProcessDescendantOf(400, 100, reader)).toBe(false);
  });

  it("stops when ancestry is unreadable", async () => {
    expect(await isProcessDescendantOf(999, 100, reader)).toBe(false);
  });

  it("bounds the walk against cycles", async () => {
    const cyclic: PpidReader = async () => 500;
    expect(await isProcessDescendantOf(500, 100, cyclic, 5)).toBe(false);
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
