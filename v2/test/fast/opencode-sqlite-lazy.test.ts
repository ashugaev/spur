import { describe, expect, it, vi } from "vitest";

// Node 22 prints an ExperimentalWarning when node:sqlite loads, and every CLI
// run imports the agent adapters; only the opencode.db read may load it.
const sqliteLoads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:sqlite", () => {
  sqliteLoads.count += 1;
  return { DatabaseSync: vi.fn() };
});

describe("opencode adapter sqlite loading", () => {
  it("does not load node:sqlite when the adapter module is imported", async () => {
    await import("../../src/agents/index.js");
    await import("../../src/agents/opencode.js");
    expect(sqliteLoads.count).toBe(0);
  });
});
