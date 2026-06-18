import { existsSync } from "node:fs";
import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { gh } from "../gh.js";
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
import { resolvePrSummary, resolveTrackedBranch } from "../review-providers/github.js";
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

// How often to cheaply re-resolve a terminal session's branch to a new PR.
const TERMINAL_RECHECK_INTERVAL_MS = 600_000;

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
  const items = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
  }>;
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
  const terminalRecheckAt = new Map<string, number>();
  let stopped = false;
  let polling = false;
  let pollingWorkItems = false;

  const pollSignals = async (emitInitial: boolean): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
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
        // A session whose PR is merged/closed is terminal: re-polling its signal
        // fan-out burns the shared gh rate limit. But a long-lived session can open
        // a NEW PR on the same branch, so we cannot skip forever. Skip the expensive
        // fan-out on almost every cycle, and roughly every TERMINAL_RECHECK_INTERVAL_MS
        // do ONE cheap branch->PR resolution; if the branch moved to a different /
        // non-terminal PR, fall through to a full poll that rebinds (collectSignals).
        const existing = snapshots.get(session.id);
        const terminal = existing?.get("merged") ?? existing?.get("closed");
        if (terminal) {
          if (terminal.prNumber === undefined) {
            // Legacy snapshot from before prNumber was recorded: poll once to
            // self-heal (re-records the current PR number / picks up a newer PR).
          } else {
            const now = Date.now();
            const last = terminalRecheckAt.get(session.id) ?? 0;
            if (now - last < TERMINAL_RECHECK_INTERVAL_MS) {
              continue;
            }
            terminalRecheckAt.set(session.id, now);
            const branch = await resolveTrackedBranch(session.worktreePath, session.branch);
            const currentPr = await resolvePrSummary(session.worktreePath, branch);
            if (
              currentPr &&
              currentPr.number === terminal.prNumber &&
              (currentPr.state === "MERGED" || currentPr.state === "CLOSED")
            ) {
              continue;
            }
            // else: a different / non-terminal / newly-opened PR — full poll below.
          }
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
          const message = error instanceof Error ? error.message : String(error);
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

      for (const sessionId of [...terminalRecheckAt.keys()]) {
        if (!currentSessionIds.has(sessionId)) {
          terminalRecheckAt.delete(sessionId);
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
      pollingWorkItems
    ) {
      return;
    }
    pollingWorkItems = true;
    try {
      await pollWorkItems(deps, deps.config.query, seenWorkItems);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  const timer = startInterval(() => {
    void pollSignals(false);
    void syncWorkItems();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void pollSignals(false);
      void syncWorkItems();
    } else {
      await pollSignals(false);
      await syncWorkItems();
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
            void pollSignals(true);
            void syncWorkItems();
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule<GitHubSourceConfig> = {
  type: "github",
  start: startGitHubSource,
};
