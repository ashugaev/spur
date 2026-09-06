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

  it("retains each source baseline when observations alternate", () => {
    const sourceA = reconcileTokenUsage(undefined, {
      provider: "codex",
      sourceId: "a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const sourceB = reconcileTokenUsage(sourceA, {
      provider: "codex",
      sourceId: "b",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });
    const sourceAAgain = reconcileTokenUsage(sourceB, {
      provider: "codex",
      sourceId: "a",
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
    });

    expect(sourceAAgain.totalTokens).toBe(150);
    expect(sourceAAgain.sources).toEqual({
      a: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
      b: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });
  });

  it("reconciles from persisted source baselines after restart", () => {
    const beforeRestart = reconcileTokenUsage(undefined, {
      provider: "codex",
      sourceId: "a",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const restored = JSON.parse(JSON.stringify(beforeRestart)) as typeof beforeRestart;

    expect(
      reconcileTokenUsage(restored, {
        provider: "codex",
        sourceId: "a",
        inputTokens: 85,
        outputTokens: 25,
        totalTokens: 110,
      }).totalTokens,
    ).toBe(110);
  });

  it("keeps lifetime totals but clears incompatible source baselines on provider change", () => {
    const claude = reconcileTokenUsage(undefined, {
      provider: "claude",
      sourceId: "shared-path",
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const codex = reconcileTokenUsage(claude, {
      provider: "codex",
      sourceId: "shared-path",
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
    });

    expect(codex.totalTokens).toBe(140);
    expect(codex.sources).toEqual({
      "shared-path": { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    });
  });
});
