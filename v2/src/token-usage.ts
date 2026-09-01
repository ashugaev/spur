import type { SessionTokenUsageRecord, TokenUsageTotals } from "./types.js";

export interface ProviderTokenUsageSample extends TokenUsageTotals {
  provider: "claude" | "codex";
  sourceId: string;
}

export function reconcileTokenUsage(
  previous: SessionTokenUsageRecord | undefined,
  sample: ProviderTokenUsageSample,
): SessionTokenUsageRecord {
  const sameSource =
    previous?.provider === sample.provider && previous.sourceId === sample.sourceId;
  const sourceReset = sameSource && sample.totalTokens < previous.sourceTotalTokens;
  const baseInput = previous
    ? previous.inputTokens - (sameSource && !sourceReset ? previous.sourceInputTokens : 0)
    : 0;
  const baseOutput = previous
    ? previous.outputTokens - (sameSource && !sourceReset ? previous.sourceOutputTokens : 0)
    : 0;
  const baseTotal = previous
    ? previous.totalTokens - (sameSource && !sourceReset ? previous.sourceTotalTokens : 0)
    : 0;
  return {
    provider: sample.provider,
    sourceId: sample.sourceId,
    inputTokens: Math.max(previous?.inputTokens ?? 0, baseInput + sample.inputTokens),
    outputTokens: Math.max(previous?.outputTokens ?? 0, baseOutput + sample.outputTokens),
    totalTokens: Math.max(previous?.totalTokens ?? 0, baseTotal + sample.totalTokens),
    sourceInputTokens: sample.inputTokens,
    sourceOutputTokens: sample.outputTokens,
    sourceTotalTokens: sample.totalTokens,
  };
}
