import { describe, expect, it } from "vitest";
import {
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
    expect(defaultPrompt).toContain("the assigned task is complete");

    const customPrompt = withSelfDestructInstructions("Do work", {
      enabled: true,
      conditions: "tests pass and changes are committed",
    });
    expect(customPrompt).toContain("tests pass and changes are committed");
    expect(withSelfDestructInstructions(customPrompt, { enabled: true })).toBe(customPrompt);
  });
});
