import { existsSync } from "node:fs";
import { clearInterval, setInterval as startInterval } from "node:timers";
import { gh } from "../gh.js";
import {
  GITHUB_WORK_ITEM_NEW_EVENT,
  type GitHubCheck,
  type GitHubPrSummary,
  type GitHubSourceConfig,
  type ReviewEventData,
  type ReviewSignal,
  type ReviewSignalKind,
  type SessionPrBinding,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  deleteReviewSourceSnapshot,
  hasGitHubMergeConflictRestoreReplay,
  listSessions,
  readSession,
  readReviewSourceSnapshots,
  readWorkItemRegistry,
  recordWorkItem,
  writeReviewSourceSnapshot,
} from "../metadata.js";
import { reviewProvider } from "../review-providers/index.js";
import { normalizeReviewDecision, parseRepoFromUrl } from "../review-providers/github.js";

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
function emitSignalsByKind(
  deps: SourceStartDeps<GitHubSourceConfig>,
  data: Omit<ReviewEventData, "signals">,
  signals: ReviewSignal[],
): void {
  const grouped = new Map<ReviewSignalKind, ReviewSignal[]>();
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
export async function resolveBoundPrSummary(worktreePath: string, pr: SessionPrBinding) {
  const raw = await gh(
    worktreePath,
    "pr",
    "view",
    String(pr.number),
    "--json",
    "number,title,url,reviewDecision,mergeable,mergeStateStatus",
  );
  const summary = JSON.parse(raw) as {
    number: number;
    title: string;
    url?: string | null;
    reviewDecision?: string | null;
    mergeable?: string | null;
    mergeStateStatus?: string | null;
  };
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url ?? pr.url,
    reviewDecision: normalizeReviewDecision(summary.reviewDecision),
    repo: parseRepoFromUrl(summary.url ?? pr.url),
    mergeable: summary.mergeable ?? "",
    mergeStateStatus: summary.mergeStateStatus ?? "",
  };
}
async function pollWorkItems(
  deps: SourceStartDeps<GitHubSourceConfig>,
  query: string,
  seenWorkItems: Set<string>,
  seedOnly: boolean,
) {
  const raw = await gh(
    process.cwd(),
    "search",
    "prs",
    ...query.split(/\s+/).filter(Boolean),
    "--json",
    "number,title,url,repository,state",
    "--limit",
    "100",
  );
  const items = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    url: string;
    repository: { nameWithOwner: string };
    state: string;
  }>;
  for (const item of items) {
    if (item.state !== "open") continue;
    const repo = item.repository.nameWithOwner;
    const externalId = `${repo}#${item.number}`;
    if (seenWorkItems.has(externalId)) continue;
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, externalId);
    seenWorkItems.add(externalId);
    if (seedOnly) continue;
    deps.emit(GITHUB_WORK_ITEM_NEW_EVENT, {
      externalId,
      url: item.url,
      number: item.number,
      title: item.title,
      repo,
    });
  }
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
        try {
          const restoreReplayRequested = hasGitHubMergeConflictRestoreReplay(
            deps.dataDir,
            deps.projectId,
            deps.sourceId,
            session.id,
          );
          const collected = await provider.collectSignals(session);
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

          if ((previous && changed.length > 0) || (!previous && emitInitial && next.size > 0)) {
            emitSignalsByKind(deps, collected.data, previous ? changed : [...next.values()]);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.warn?.(
            `[source:${deps.projectId}/${deps.sourceId}] failed to poll ${session.id}: ${message}`,
          );
        }
      }

      for (const sessionId of [...snapshots.keys()]) {
        if (!currentSessionIds.has(sessionId)) {
          const latestSession = readSession(deps.dataDir, sessionId);
          if (
            latestSession &&
            latestSession.status !== "completed" &&
            latestSession.status !== "killed" &&
            Boolean(latestSession.worktreePath) &&
            existsSync(latestSession.worktreePath)
          ) {
            continue;
          }
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
        }
      }
    } finally {
      polling = false;
    }
  };

  const syncWorkItems = async (seedOnly: boolean): Promise<void> => {
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
      await pollWorkItems(deps, deps.config.query, seenWorkItems, seedOnly);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] work-item poll failed: ${message}`,
      );
    } finally {
      pollingWorkItems = false;
    }
  };

  let firstWorkItemSync = true;
  const nextSyncWorkItems = (): Promise<void> => {
    const seed = firstWorkItemSync && !deps.config.emitExisting;
    firstWorkItemSync = false;
    return syncWorkItems(seed);
  };

  const timer = startInterval(() => {
    void pollSignals(false);
    void nextSyncWorkItems();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void pollSignals(false);
      void nextSyncWorkItems();
    } else {
      await pollSignals(false);
      await nextSyncWorkItems();
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
            void nextSyncWorkItems();
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule<GitHubSourceConfig> = {
  type: "github",
  start: startGitHubSource,
};
