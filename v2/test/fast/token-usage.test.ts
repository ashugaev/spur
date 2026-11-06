import { describe, expect, it } from "vitest";
import {
  reconcileTokenUsage,
  summarizeTokenUsageWindows,
  sumTokenUsage,
  type TokenUsageActivity,
} from "../../src/token-usage.js";

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

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);
const TODAY = Date.UTC(2026, 10, 6, 0);

function activity(
  provider: "claude" | "codex",
  model: string | null,
  total: number,
  activityMs: number,
): TokenUsageActivity {
  const totals = { inputTokens: total, outputTokens: 0, totalTokens: total };
  return { tokenUsage: { provider, generations: { g: totals }, ...totals }, model, activityMs };
}

describe("sumTokenUsage", () => {
  it("drops optional components when not every snapshot has them", () => {
    const sum = sumTokenUsage([
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadInputTokens: 5 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ]);
    expect(sum).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });
});

describe("summarizeTokenUsageWindows", () => {
  it("buckets by window boundary, provider and model", () => {
    const summary = summarizeTokenUsageWindows(
      [
        activity("claude", "opus", 10, TODAY),
        activity("claude", null, 20, TODAY - 1),
        activity("claude", "opus", 30, NOW - 7 * DAY),
        activity("codex", "gpt", 40, NOW - 7 * DAY - 1),
        activity("codex", "gpt", 50, NOW - 30 * DAY - 1),
        activity("codex", "gpt", 60, Number.NaN),
      ],
      NOW,
      TODAY,
    );
    expect(summary.map((w) => w.window)).toEqual(["today", "7d", "30d"]);
    expect(summary[0]?.byProvider).toHaveLength(1);
    expect(summary[0]?.byProvider[0]?.totals.totalTokens).toBe(10);
    const week = summary[1]?.byProvider;
    expect(week?.map((p) => [p.provider, p.sessionCount, p.totals.totalTokens])).toEqual([
      ["claude", 3, 60],
    ]);
    expect(week?.[0]?.byModel.map((m) => m.model)).toEqual(["opus", null]);
    const month = summary[2]?.byProvider;
    expect(month?.map((p) => [p.provider, p.totals.totalTokens])).toEqual([
      ["claude", 60],
      ["codex", 40],
    ]);
  });
});
