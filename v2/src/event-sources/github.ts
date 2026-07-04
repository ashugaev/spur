import { existsSync } from "node:fs";
import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { extractGithubErrorText, gh, isGitHubRateLimitError } from "../gh.js";
import {
  GITHUB_PR_LIFECYCLE_KINDS,
  GITHUB_WORK_ITEM_NEW_EVENT,
  type GitHubCheck,
  type GitHubPrSummary,
  type GitHubSourceConfig,
  type ReviewEventData,
  type ReviewSignal,
  type WorkItemEventData,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  deleteReviewSourceSnapshot,
  hasGitHubMergeConflictRestoreReplay,
  listSessions,
  readLifecycleBaselinedSessions,
  readReviewSourceSnapshots,
  readWorkItemRegistry,
  recordLifecycleBaselinedSession,
  removeLifecycleBaselinedSession,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import { reviewProvider } from "../review-providers/index.js";
import { emitWorkItemBacklog } from "./work-item-backlog.js";

export {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
  resolveTrackedBranch,
} from "../review-providers/github.js";

export type { GitHubCheck, GitHubPrSummary };

const LIFECYCLE_KINDS = new Set<string>(GITHUB_PR_LIFECYCLE_KINDS);
const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;

interface GitHubSearchPrItem {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGitHubSearchPrItem(value: unknown): value is GitHubSearchPrItem {
  if (!isRecord(value) || !isRecord(value.repository)) return false;
  return (
    Number.isInteger(value.number) &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.repository.nameWithOwner === "string"
  );
}

function parseGitHubSearchPrItems(raw: string): GitHubSearchPrItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid GitHub search PR JSON: ${message}`, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid GitHub search PR JSON: expected an array");
  }

  return parsed.map((item, index) => {
    if (!isGitHubSearchPrItem(item)) {
      throw new Error(`Invalid GitHub search PR item at index ${index}`);
    }
    return item;
  });
}

function isGitHubBadCredentialsError(text: string): boolean {
  return text.toLowerCase().includes("bad credentials");
}

function parseEpochResetMs(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function parseStringResetMs(value: string): number | null {
  const numeric = Number(value);
  const fromEpoch = parseEpochResetMs(numeric);
  if (fromEpoch !== null) return fromEpoch;
  const fromDate = Date.parse(value);
  return Number.isNaN(fromDate) ? null : fromDate;
}

function findResetMs(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const resetMs = findResetMs(item);
      if (resetMs !== null) return resetMs;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if ("resetAt" in value && typeof value.resetAt === "string") {
    const resetMs = parseStringResetMs(value.resetAt);
    if (resetMs !== null) return resetMs;
  }
  if ("reset_at" in value && typeof value.reset_at === "string") {
    const resetMs = parseStringResetMs(value.reset_at);
    if (resetMs !== null) return resetMs;
  }
  if ("reset" in value) {
    if (typeof value.reset === "number") {
      const resetMs = parseEpochResetMs(value.reset);
      if (resetMs !== null) return resetMs;
    }
    if (typeof value.reset === "string") {
      const resetMs = parseStringResetMs(value.reset);
      if (resetMs !== null) return resetMs;
    }
  }
  if ("x-ratelimit-reset" in value && typeof value["x-ratelimit-reset"] === "string") {
    const resetMs = parseStringResetMs(value["x-ratelimit-reset"]);
    if (resetMs !== null) return resetMs;
  }

  for (const item of Object.values(value)) {
    const resetMs = findResetMs(item);
    if (resetMs !== null) return resetMs;
  }
  return null;
}

function parseResetDeadlineMs(text: string, nowMs: number): number | null {
  const candidates = [
    text.trim(),
    ...text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") || line.startsWith("[")),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const resetMs = findResetMs(parsed);
      if (resetMs !== null && resetMs > nowMs) return resetMs;
    } catch {
      continue;
    }
  }
  return null;
}

function emitSignalsByKind(
  deps: SourceStartDeps<GitHubSourceConfig>,
  data: Omit<ReviewEventData, "signals">,
  signals: ReviewSignal[],
): void {
  const grouped = new Map<ReviewSignal["kind"], ReviewSignal[]>();
  for (const signal of signals) {
    const existing = grouped.get(signal.kind);
    if (existing) {
      existing.push(signal);
      continue;
    }
    grouped.set(signal.kind, [signal]);
  }

  for (const [kind, items] of grouped) {
    deps.emit<ReviewEventData>(`github:${kind}`, {
      ...data,
      signals: items,
    });
  }
}
export function tokenizeSearchQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasContent = false;
  for (const char of query) {
    if (char === '"') {
      inQuotes = !inQuotes;
      hasContent = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

async function pollWorkItems(
  deps: SourceStartDeps<GitHubSourceConfig>,
  query: string,
  seenWorkItems: Set<string>,
) {
  const raw = await gh(
    process.cwd(),
    "search",
    "prs",
    ...tokenizeSearchQuery(query),
    "--state",
    "open",
    "--draft=false",
    "--json",
    "number,title,url,repository",
    "--limit",
    "100",
  );
  const items = parseGitHubSearchPrItems(raw);
  const candidates = items.map((item) => {
    const repo = item.repository.nameWithOwner;
    const data: WorkItemEventData = {
      externalId: `${repo}#${item.number}`,
      url: item.url,
      number: item.number,
      title: item.title,
      repo,
    };
    return { repo, externalId: data.externalId, data };
  });
  emitWorkItemBacklog(deps, GITHUB_WORK_ITEM_NEW_EVENT, seenWorkItems, candidates);
}

async function startGitHubSource(deps: SourceStartDeps<GitHubSourceConfig>): Promise<SourceHandle> {
  const provider = reviewProvider("github");
  const snapshots = readReviewSourceSnapshots(
    deps.dataDir,
    "github",
    deps.projectId,
    deps.sourceId,
  );
  const seenWorkItems = deps.config.query
    ? readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId)
    : null;
  const lifecycleBaselined = readLifecycleBaselinedSessions(
    deps.dataDir,
    deps.projectId,
    deps.sourceId,
  );
  let stopped = false;
  let polling = false;
  let pollingWorkItems = false;
  let pollingCycle = false;
  let cooldownUntilMs = 0;
  let rateLimitFailures = 0;
  let authDisabled = false;
  let authWarned = false;

  const shouldSkipGitHubCalls = (): boolean => authDisabled || Date.now() < cooldownUntilMs;

  const handleGitHubSuppressionError = (error: unknown): boolean => {
    const message = extractGithubErrorText(error);
    if (isGitHubBadCredentialsError(message)) {
      authDisabled = true;
      if (!authWarned) {
        authWarned = true;
        deps.logger.warn?.(
          `[source:${deps.projectId}/${deps.sourceId}] GitHub polling disabled: Bad credentials`,
        );
        logSpurEvent(deps.dataDir, {
          event: "source.auth.disabled",
          level: "error",
          projectId: deps.projectId,
          sourceId: deps.sourceId,
          message: `GitHub polling disabled for ${deps.projectId}/${deps.sourceId}: Bad credentials`,
        });
      }
      return true;
    }
    if (!isGitHubRateLimitError(message)) {
      return false;
    }

    rateLimitFailures += 1;
    const nowMs = Date.now();
    const resetMs = parseResetDeadlineMs(message, nowMs);
    const fallbackMs = Math.min(
      RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (rateLimitFailures - 1),
      RATE_LIMIT_BACKOFF_MAX_MS,
    );
    cooldownUntilMs = resetMs ?? nowMs + fallbackMs;
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] GitHub rate limit hit; polling paused until ${new Date(
        cooldownUntilMs,
      ).toISOString()}`,
    );
    return true;
  };

  const pollSignals = async (emitInitial: boolean): Promise<void> => {
    if (stopped || deps.signal.aborted || polling || shouldSkipGitHubCalls()) return;
    polling = true;
    try {
      const sessions = listSessions(deps.dataDir).filter(
        (session) =>
          session.project === deps.projectId &&
          session.status === "running" &&
          Boolean(session.worktreePath) &&
          existsSync(session.worktreePath),
      );
      const currentSessionIds = new Set<string>();

      for (const session of sessions) {
        currentSessionIds.add(session.id);
        // Skip sessions whose PR is already merged/closed: terminal state, no new
        // signals possible, and re-polling them burns the shared gh rate limit. The
        // snapshot key persists on disk and reloads at startup so the skip is sticky.
        // Caveat: a CLOSED PR later reopened won't be re-detected until daemon restart
        // (no `reopened` lifecycle kind exists). MERGED is unconditionally terminal.
        const existing = snapshots.get(session.id);
        if (existing && (existing.has("merged") || existing.has("closed"))) {
          continue;
        }
        try {
          const restoreReplayRequested = hasGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            session.id,
          );
          const collected = await provider.collectSignals(
            session,
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
          );
          if (!collected) {
            snapshots.delete(session.id);
            deleteReviewSourceSnapshot(
              deps.dataDir,
              "github",
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            if (restoreReplayRequested) {
              clearGitHubMergeConflictRestoreReplay(
                deps.dataDir,
                deps.projectId,
                deps.sourceId,
                session.id,
              );
            }
            continue;
          }

          const previous = snapshots.get(session.id);
          const next = collected.snapshot;
          const changed = [...next.values()].filter((signal) => {
            const prior = previous?.get(signal.key);
            return !prior || prior.text !== signal.text;
          });

          snapshots.set(session.id, next);
          writeReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            session.id,
            next,
          );

          if (restoreReplayRequested) {
            const mergeConflictSignal = next.get("merge_conflict");
            if (mergeConflictSignal) {
              emitSignalsByKind(deps, collected.data, [mergeConflictSignal]);
            }
            clearGitHubMergeConflictRestoreReplay(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            continue;
          }

          const baselined = lifecycleBaselined.has(session.id);
          if (!baselined) {
            recordLifecycleBaselinedSession(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
            lifecycleBaselined.add(session.id);
          }
          const candidates = previous ? changed : emitInitial ? [...next.values()] : [];
          const toEmit = baselined
            ? candidates
            : candidates.filter((signal) => !LIFECYCLE_KINDS.has(signal.kind));
          if (toEmit.length > 0) {
            emitSignalsByKind(deps, collected.data, toEmit);
          }
        } catch (error) {
          if (handleGitHubSuppressionError(error)) return;
          const message = extractGithubErrorText(error);
          deps.logger.warn?.(
            `[source:${deps.projectId}/${deps.sourceId}] failed to poll ${session.id}: ${message}`,
          );
          logSpurEvent(deps.dataDir, {
            event: "source.poll.error",
            level: "error",
            projectId: deps.projectId,
            sourceId: deps.sourceId,
            sessionId: session.id,
            message: `Signal poll failed for ${deps.projectId}/${deps.sourceId}/${session.id}: ${message}`,
          });
        }
      }

      for (const sessionId of [...snapshots.keys()]) {
        if (!currentSessionIds.has(sessionId)) {
          snapshots.delete(sessionId);
          deleteReviewSourceSnapshot(
            deps.dataDir,
            "github",
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          clearGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            sessionId,
          );
          removeLifecycleBaselinedSession(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
          lifecycleBaselined.delete(sessionId);
        }
      }
    } finally {
      polling = false;
    }
  };

  const syncWorkItems = async (): Promise<void> => {
    if (
      !deps.config.query ||
      !seenWorkItems ||
      stopped ||
      deps.signal.aborted ||
      pollingWorkItems ||
      shouldSkipGitHubCalls()
    ) {
      return;
    }
    pollingWorkItems = true;
    try {
      await pollWorkItems(deps, deps.config.query, seenWorkItems);
    } catch (error) {
      if (handleGitHubSuppressionError(error)) return;
      const message = extractGithubErrorText(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] work-item poll failed: ${message}`,
      );
      logSpurEvent(deps.dataDir, {
        event: "source.work_item_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `Work-item poll failed for ${deps.projectId}/${deps.sourceId}: ${message}`,
      });
    } finally {
      pollingWorkItems = false;
    }
  };

  const pollCycle = async (emitInitial: boolean): Promise<void> => {
    if (pollingCycle) return;
    pollingCycle = true;
    try {
      await pollSignals(emitInitial);
      if (shouldSkipGitHubCalls()) return;
      await syncWorkItems();
      if (!shouldSkipGitHubCalls()) {
        rateLimitFailures = 0;
      }
    } finally {
      pollingCycle = false;
    }
  };

  const timer = startInterval(() => {
    void pollCycle(false);
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void pollCycle(false);
    } else {
      await pollCycle(false);
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void pollCycle(true);
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule<GitHubSourceConfig> = {
  type: "github",
  start: startGitHubSource,
};
