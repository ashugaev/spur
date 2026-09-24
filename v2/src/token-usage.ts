import type { SessionTokenUsageRecord, TokenUsageTotals } from "./types.js";

export interface ProviderTokenUsageSample extends TokenUsageTotals {
  provider: "claude" | "codex" | "opencode";
  generationId: string;
  observedAtMs?: number;
}

const OPTIONAL_COMPONENTS = [
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
  "cacheWrite5mInputTokens",
  "cacheWrite1hInputTokens",
] as const;

export function aggregateTokenUsage(
  provider: SessionTokenUsageRecord["provider"],
  generations: Record<string, TokenUsageTotals>,
): SessionTokenUsageRecord {
  const snapshots = Object.values(generations);
  const totals: TokenUsageTotals = {
    inputTokens: snapshots.reduce((sum, snapshot) => sum + snapshot.inputTokens, 0),
    outputTokens: snapshots.reduce((sum, snapshot) => sum + snapshot.outputTokens, 0),
    totalTokens: snapshots.reduce((sum, snapshot) => sum + snapshot.totalTokens, 0),
  };
  for (const component of OPTIONAL_COMPONENTS) {
    if (snapshots.length > 0 && snapshots.every((snapshot) => snapshot[component] !== undefined)) {
      totals[component] = snapshots.reduce((sum, snapshot) => sum + (snapshot[component] ?? 0), 0);
    }
  }
  return { provider, generations, ...totals };
}

export function reconcileTokenUsage(
  previous: SessionTokenUsageRecord | undefined,
  sample: ProviderTokenUsageSample,
): SessionTokenUsageRecord {
  const generations = previous?.provider === sample.provider ? previous.generations : {};
  const prior = generations[sample.generationId];
  const next =
    prior && sample.totalTokens < prior.totalTokens
      ? prior
      : (Object.fromEntries(
          Object.entries(sample).filter(
            ([key, value]) =>
              key !== "provider" &&
              key !== "generationId" &&
              key !== "observedAtMs" &&
              value !== undefined,
          ),
        ) as unknown as TokenUsageTotals);
  return aggregateTokenUsage(sample.provider, {
    ...generations,
    [sample.generationId]: next,
  });
}
