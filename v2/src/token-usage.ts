import type { SessionTokenUsageRecord, TokenUsageTotals } from "./types.js";

export interface ProviderTokenUsageSample extends TokenUsageTotals {
  provider: "claude" | "codex" | "cursor" | "opencode";
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

export function sumTokenUsage(snapshots: readonly TokenUsageTotals[]): TokenUsageTotals {
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
  return totals;
}

export function aggregateTokenUsage(
  provider: SessionTokenUsageRecord["provider"],
  generations: Record<string, TokenUsageTotals>,
): SessionTokenUsageRecord {
  return { provider, generations, ...sumTokenUsage(Object.values(generations)) };
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

export type TokenUsageWindow = "today" | "7d" | "30d";

export interface TokenUsageBucket {
  sessionCount: number;
  totals: TokenUsageTotals;
}

export interface ModelTokenUsage extends TokenUsageBucket {
  model: string | null;
}

export interface ProviderTokenUsage extends TokenUsageBucket {
  provider: SessionTokenUsageRecord["provider"];
  byModel: ModelTokenUsage[];
}

export interface TokenUsageWindowSummary {
  window: TokenUsageWindow;
  since: string;
  byProvider: ProviderTokenUsage[];
}

export interface TokenUsageActivity {
  tokenUsage: SessionTokenUsageRecord;
  model: string | null;
  activityMs: number;
}

const DAY_MS = 86_400_000;

function bucketOf(entries: readonly TokenUsageActivity[]): TokenUsageBucket {
  return { sessionCount: entries.length, totals: sumTokenUsage(entries.map((e) => e.tokenUsage)) };
}

function compareModel(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function summarizeTokenUsageWindows(
  sessions: readonly TokenUsageActivity[],
  nowMs: number,
  todayStartMs: number,
): TokenUsageWindowSummary[] {
  const windows: Array<[TokenUsageWindow, number]> = [
    ["today", todayStartMs],
    ["7d", nowMs - 7 * DAY_MS],
    ["30d", nowMs - 30 * DAY_MS],
  ];
  return windows.map(([window, sinceMs]) => {
    const inWindow = sessions.filter((s) => Number.isFinite(s.activityMs) && s.activityMs >= sinceMs);
    const providers = [...new Set(inWindow.map((s) => s.tokenUsage.provider))].sort();
    const byProvider = providers.map((provider) => {
      const entries = inWindow.filter((s) => s.tokenUsage.provider === provider);
      const models = [...new Set(entries.map((s) => s.model))].sort(compareModel);
      return {
        provider,
        ...bucketOf(entries),
        byModel: models.map((model) => ({
          model,
          ...bucketOf(entries.filter((s) => s.model === model)),
        })),
      };
    });
    return { window, since: new Date(sinceMs).toISOString(), byProvider };
  });
}
