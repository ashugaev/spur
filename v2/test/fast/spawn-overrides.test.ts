import { describe, expect, it } from "vitest";
import { parseSpawnOverrides } from "../../src/spawn-overrides.js";

describe("parseSpawnOverrides", () => {
  it("returns undefined for undefined input", () => {
    expect(parseSpawnOverrides(undefined, "trigger")).toBeUndefined();
  });

  it("returns an empty object for an empty object input", () => {
    expect(parseSpawnOverrides({}, "trigger")).toEqual({});
  });

  it("throws on unknown key", () => {
    expect(() => parseSpawnOverrides({ foo: 1 }, "trigger")).toThrow(
      /trigger uses unsupported override "foo"/,
    );
  });

  it("throws on non-boolean worktree", () => {
    expect(() => parseSpawnOverrides({ worktree: "yes" }, "trigger")).toThrow(
      /trigger\.worktree must be a boolean/,
    );
  });

  it("throws on non-string defaultBranch", () => {
    expect(() => parseSpawnOverrides({ defaultBranch: 1 }, "trigger")).toThrow(
      /trigger\.defaultBranch must be a non-empty string/,
    );
  });

  it("throws on blank defaultBranch", () => {
    expect(() => parseSpawnOverrides({ defaultBranch: "   " }, "trigger")).toThrow(
      /trigger\.defaultBranch must be a non-empty string/,
    );
  });

  it("round-trips worktree and defaultBranch, trimming the branch", () => {
    expect(parseSpawnOverrides({ worktree: true, defaultBranch: "  main  " }, "trigger")).toEqual({
      worktree: true,
      defaultBranch: "main",
    });
  });
});
