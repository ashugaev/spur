import { describe, expect, it } from "vitest";
import { reconcileTokenUsage } from "../../src/token-usage.js";

describe("reconcileTokenUsage", () => {
  it("does not decrease a repeated source sample", () => {
    const first = reconcileTokenUsage(undefined, {
      provider: "codex",
      sourceId: "one",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    expect(
      reconcileTokenUsage(first, {
        provider: "codex",
        sourceId: "one",
        inputTokens: 70,
        outputTokens: 10,
        totalTokens: 80,
      }).totalTokens,
    ).toBe(180);
  });

  it("adds a new native source to the Spur-session lifetime", () => {
    const first = reconcileTokenUsage(undefined, {
      provider: "claude",
      sourceId: "one",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    expect(
      reconcileTokenUsage(first, {
        provider: "claude",
        sourceId: "two",
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
      }).totalTokens,
    ).toBe(140);
  });
});
