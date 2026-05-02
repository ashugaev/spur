import { clearInterval, setInterval as startInterval } from "node:timers";
import { gh } from "../gh.js";
import { readWorkItemRegistry, recordWorkItem } from "../metadata.js";
import {
  GITHUB_WORK_ITEM_NEW_EVENT,
  type GitHubSourceConfig,
  type SessionPrBinding,
} from "../types.js";
import { normalizeReviewDecision, parseRepoFromUrl } from "../review-providers/github.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import { createReviewSourceModule } from "./review-source.js";

export {
  shortText,
  parseRepoFromUrl,
  normalizeReviewDecision,
  summarizeFailingCi,
  hasMergeConflict,
  resolvePrSummary,
  resolveTrackedBranch,
} from "../review-providers/github.js";

export type { GitHubCheck, GitHubPrSummary } from "../types.js";

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
) {
  const raw = await gh(
    process.cwd(),
    "search",
    "prs",
    query,
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
  for (const item of items) {
    const repo = item.repository.nameWithOwner;
    const externalId = `${repo}#${item.number}`;
    if (seenWorkItems.has(externalId)) continue;
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, externalId);
    seenWorkItems.add(externalId);
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
  const reviewHandle = await createReviewSourceModule("github").start(deps);
  const query = deps.config.query;
  if (!query) {
    return reviewHandle;
  }

  const seenWorkItems = readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId);
  let stopped = false;
  let pollingWorkItems = false;

  const syncWorkItems = async (): Promise<void> => {
    if (stopped || deps.signal.aborted || pollingWorkItems) return;
    pollingWorkItems = true;
    try {
      await pollWorkItems(deps, query, seenWorkItems);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] work-item poll failed: ${message}`,
      );
    } finally {
      pollingWorkItems = false;
    }
  };

  const timer = startInterval(() => {
    void syncWorkItems();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void syncWorkItems();
    } else {
      await syncWorkItems();
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
      reviewHandle.stop();
    },
    ...(reviewHandle.runOnStart
      ? {
          runOnStart(): void {
            reviewHandle.runOnStart?.();
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
