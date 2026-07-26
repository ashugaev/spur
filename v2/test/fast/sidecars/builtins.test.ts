import { describe, expect, it } from "vitest";
import { BUILTIN_SIDECARS } from "../../../src/sidecars/builtins.js";

describe("BUILTIN_SIDECARS", () => {
  it("registers playwright with agent scope, mcp wiring, sweep, and readiness", () => {
    const playwright = BUILTIN_SIDECARS["playwright"];
    expect(playwright).toBeDefined();
    expect(playwright?.config.agents).toEqual(["claude", "codex"]);
    expect(playwright?.config.mcp?.server).toBe("playwright");
    expect(typeof playwright?.sweepLeaked).toBe("function");
    expect(typeof playwright?.readiness).toBe("function");
  });
});
