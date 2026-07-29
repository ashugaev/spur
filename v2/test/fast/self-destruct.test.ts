import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELF_DESTRUCT_CONDITION,
  SELF_DESTRUCT_TOOL_NAME,
  normalizeSelfDestructConfig,
  withSelfDestructInstructions,
} from "../../src/self-destruct.js";

describe("self destruct", () => {
  it("normalizes enabled config and trims optional conditions", () => {
    expect(
      normalizeSelfDestructConfig({
        enabled: true,
        conditions: "  after tests pass  ",
      }),
    ).toEqual({
      enabled: true,
      conditions: "after tests pass",
    });

    expect(normalizeSelfDestructConfig({ enabled: false, conditions: "   " })).toEqual({
      enabled: false,
    });
    expect(normalizeSelfDestructConfig(undefined)).toBeUndefined();
  });

  it("rejects invalid config shapes", () => {
    expect(() => normalizeSelfDestructConfig(true)).toThrow("selfDestruct must be an object");
    expect(() => normalizeSelfDestructConfig({})).toThrow("selfDestruct.enabled must be a boolean");
    expect(() => normalizeSelfDestructConfig({ enabled: true, conditions: 42 })).toThrow(
      "selfDestruct.conditions must be a string",
    );
  });

  it("injects default and custom instructions only when enabled", () => {
    expect(withSelfDestructInstructions("Do work", undefined)).toBe("Do work");
    expect(withSelfDestructInstructions("Do work", { enabled: false })).toBe("Do work");

    const defaultPrompt = withSelfDestructInstructions("Do work", { enabled: true });
    expect(defaultPrompt).toContain(SELF_DESTRUCT_TOOL_NAME);
    expect(defaultPrompt).toContain(DEFAULT_SELF_DESTRUCT_CONDITION);

    const customPrompt = withSelfDestructInstructions("Do work", {
      enabled: true,
      conditions: "tests pass and changes are committed",
    });
    expect(customPrompt).toContain("tests pass and changes are committed");
    expect(withSelfDestructInstructions(customPrompt, { enabled: true })).toBe(customPrompt);
  });

  // DEFAULT_SELF_DESTRUCT_CONDITION is hand-mirrored in
  // packages/web/src/lib/self-destruct.ts (web cannot import from v2). The
  // placeholder text and selfDestructLabel fallback are only correct if both
  // copies stay identical.
  it("stays byte-identical to the web mirror", () => {
    const source = readFileSync(
      new URL("../../../packages/web/src/lib/self-destruct.ts", import.meta.url),
      "utf8",
    );
    const match = source.match(/export const DEFAULT_SELF_DESTRUCT_CONDITION = "([^"]*)";/);
    if (!match) throw new Error("DEFAULT_SELF_DESTRUCT_CONDITION not found in web mirror");
    expect(match[1]).toBe(DEFAULT_SELF_DESTRUCT_CONDITION);
  });
});
