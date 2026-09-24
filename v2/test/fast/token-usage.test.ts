import { describe, expect, it } from "vitest";
import { reconcileTokenUsage } from "../../src/token-usage.js";

describe("reconcileTokenUsage", () => {
  it("does not decrease a repeated generation sample", () => {
    const first = reconcileTokenUsage(undefined, {
      provider: "codex",
      generationId: "one",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    expect(
      reconcileTokenUsage(first, {
        provider: "codex",
        generationId: "one",
        inputTokens: 70,
        outputTokens: 10,
        totalTokens: 80,
      }),
    ).toEqual(first);
  });

  it("adds a new native generation to the Spur-session lifetime", () => {
    const first = reconcileTokenUsage(undefined, {
      provider: "claude",
      generationId: "one",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    expect(
      reconcileTokenUsage(first, {
        provider: "claude",
        generationId: "two",
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
      }).totalTokens,
    ).toBe(140);
  });

  it("retains generation baselines when observations alternate", () => {
    const generationA = reconcileTokenUsage(undefined, {
      provider: "codex",
      generationId: "a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const generationB = reconcileTokenUsage(generationA, {
      provider: "codex",
      generationId: "b",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });
    const generationAAgain = reconcileTokenUsage(generationB, {
      provider: "codex",
      generationId: "a",
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
    });

    expect(generationAAgain.totalTokens).toBe(150);
    expect(generationAAgain.generations).toEqual({
      a: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
      b: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });
  });

  it("preserves unknown versus measured-zero component completeness", () => {
    const first = reconcileTokenUsage(undefined, {
      provider: "claude",
      generationId: "a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cacheReadInputTokens: 0,
    });
    expect(first.cacheReadInputTokens).toBe(0);

    const incomplete = reconcileTokenUsage(first, {
      provider: "claude",
      generationId: "b",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });
    expect(incomplete).not.toHaveProperty("cacheReadInputTokens");
  });

  it("reconciles from persisted generation baselines after restart", () => {
    const beforeRestart = reconcileTokenUsage(undefined, {
      provider: "codex",
      generationId: "a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const restored = JSON.parse(JSON.stringify(beforeRestart)) as typeof beforeRestart;

    expect(
      reconcileTokenUsage(restored, {
        provider: "codex",
        generationId: "a",
        inputTokens: 85,
        outputTokens: 25,
        totalTokens: 110,
      }).totalTokens,
    ).toBe(110);
  });

  it("drops incompatible lifetime totals on provider change", () => {
    const claude = reconcileTokenUsage(undefined, {
      provider: "claude",
      generationId: "claude-generation",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const codex = reconcileTokenUsage(claude, {
      provider: "codex",
      generationId: "codex-generation",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });

    expect(codex.totalTokens).toBe(40);
    expect(codex.generations).toEqual({
      "codex-generation": { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });
  });
});
