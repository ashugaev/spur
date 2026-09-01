import type { SessionTokenUsageRecord, TokenUsageTotals } from "./types.js";

export interface ProviderTokenUsageSample extends TokenUsageTotals {
  provider: "claude" | "codex";
  sourceId: string;
  observedAtMs?: number;
}

export function reconcileTokenUsage(
  previous: SessionTokenUsageRecord | undefined,
  sample: ProviderTokenUsageSample,
): SessionTokenUsageRecord {
  const sources = previous?.provider === sample.provider ? previous.sources : {};
  const priorSource = sources[sample.sourceId];
  const sourceReset = priorSource !== undefined && sample.totalTokens < priorSource.totalTokens;
  const inputDelta =
    priorSource && !sourceReset
      ? Math.max(0, sample.inputTokens - priorSource.inputTokens)
      : sample.inputTokens;
  const outputDelta =
    priorSource && !sourceReset
      ? Math.max(0, sample.outputTokens - priorSource.outputTokens)
      : sample.outputTokens;
  const totalDelta =
    priorSource && !sourceReset
      ? Math.max(0, sample.totalTokens - priorSource.totalTokens)
      : sample.totalTokens;
  return {
    provider: sample.provider,
    sources: {
      ...sources,
      [sample.sourceId]: {
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        totalTokens: sample.totalTokens,
      },
    },
    inputTokens: (previous?.inputTokens ?? 0) + inputDelta,
    outputTokens: (previous?.outputTokens ?? 0) + outputDelta,
    totalTokens: (previous?.totalTokens ?? 0) + totalDelta,
  };
}
