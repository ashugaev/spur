import { existsSync } from "node:fs";
import { setInterval as startInterval, clearInterval } from "node:timers";
import { gh } from "../gh.js";
import {
  clearGitHubMergeConflictRestoreReplay,
  deleteGitHubSourceSnapshot,
  hasGitHubMergeConflictRestoreReplay,
  listSessions,
  readGitHubSourceSnapshots,
  writeGitHubSourceSnapshot,
} from "../metadata.js";
import type {
  GitHubEventData,
  GitHubSignalKind,
  GitHubReviewDecision,
  GitHubSignal,
  GitHubSourceConfig,
  SessionRecord,
} from "../types.js";
import { readCurrentBranch } from "../workspace.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

export interface GitHubPrSummary {
  number: number;
  title: string;
  url: string;
  reviewDecision: GitHubReviewDecision;
  repo: string;
  mergeable: string;
  mergeStateStatus: string;
}

export interface GitHubCheck {
  name: string;
  state: string;
}

type IssueComment = {
  id: number;
  body: string;
  user?: { login?: string | null } | null;
};

type PullRequestReviewComment = {
  id: number;
  body: string;
  path?: string | null;
  line?: number | null;
  user?: { login?: string | null } | null;
};

export function shortText(value: string, limit = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

export function parseRepoFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+/);
    if (!match) return "";
    return `${match[1]}/${match[2]}`;
  } catch {
    return "";
  }
}

export function normalizeReviewDecision(value: string | null | undefined): GitHubReviewDecision {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "pending";
  return "none";
}

export function summarizeFailingCi(checks: GitHubCheck[]): string | null {
  const failing = checks.filter((check) =>
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(
      check.state.toUpperCase(),
    ),
  );
  return failing.length > 0
    ? `CI is failing: ${failing.map((check) => check.name).join(", ")}.`
    : null;
}

function normalizeGitHubState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function hasMergeConflict(pr: GitHubPrSummary): boolean {
  return (
    normalizeGitHubState(pr.mergeable) === "CONFLICTING" ||
    normalizeGitHubState(pr.mergeStateStatus) === "DIRTY"
  );
}

export async function resolvePrSummary(
  worktreePath: string,
  branch: string,
): Promise<GitHubPrSummary | null> {
  const raw = await gh(
    worktreePath,
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,title,url,reviewDecision,mergeable,mergeStateStatus",
  );
  const prs: Array<{
    number: number;
    title: string;
    url: string;
    reviewDecision?: string | null;
    mergeable?: string | null;
    mergeStateStatus?: string | null;
  }> = JSON.parse(raw);
  const pr = prs[0];
  if (!pr) return null;

  let mergeable = pr.mergeable ?? "";
  let mergeStateStatus = pr.mergeStateStatus ?? "";
  // `gh pr list` returns `UNKNOWN` until GitHub finishes computing mergeability;
  // `gh pr view` forces the compute so merge_conflict signals are not silently dropped.
  if (
    normalizeGitHubState(mergeable) === "UNKNOWN" ||
    normalizeGitHubState(mergeStateStatus) === "UNKNOWN"
  ) {
    try {
      const rawView = await gh(
        worktreePath,
        "pr",
        "view",
        String(pr.number),
        "--json",
        "mergeable,mergeStateStatus",
      );
      const view = JSON.parse(rawView) as {
        mergeable?: string | null;
        mergeStateStatus?: string | null;
      };
      if (view.mergeable) mergeable = view.mergeable;
      if (view.mergeStateStatus) mergeStateStatus = view.mergeStateStatus;
    } catch {
      // Leave UNKNOWN; next poll retries.
    }
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    reviewDecision: normalizeReviewDecision(pr.reviewDecision),
    repo: parseRepoFromUrl(pr.url),
    mergeable,
    mergeStateStatus,
  };
}

export async function resolveTrackedBranch(
  worktreePath: string,
  sessionBranch: string,
): Promise<string> {
  try {
    const currentBranch = (await readCurrentBranch(worktreePath)).trim();
    if (currentBranch && currentBranch !== "HEAD") {
      return currentBranch;
    }
  } catch {
    // Fall back to persisted metadata when the worktree is unavailable.
  }
  return sessionBranch;
}

async function fetchChecks(worktreePath: string, prNumber: number): Promise<GitHubCheck[]> {
  try {
    const raw = await gh(worktreePath, "pr", "checks", String(prNumber), "--json", "name,state");
    return JSON.parse(raw) as GitHubCheck[];
  } catch {
    return [];
  }
}

async function fetchPagedArray<T>(
  cwd: string,
  pathBuilder: (page: number) => string,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const raw = await gh(cwd, "api", pathBuilder(page));
    const next = JSON.parse(raw) as T[];
    items.push(...next);
    if (next.length < 100) return items;
  }
}

async function fetchReviewSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
): Promise<GitHubSignal[]> {
  const comments = await fetchPagedArray<PullRequestReviewComment>(
    worktreePath,
    (page) => `repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
  );
  const signals: GitHubSignal[] = [];
  for (const comment of comments) {
    const author = comment.user?.login ?? "unknown";
    const location = comment.path
      ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}`
      : "";
    signals.push({
      key: `review-comment:${String(comment.id)}`,
      kind: "comment",
      text: `New review comment from ${author}${location}: "${shortText(comment.body)}"`,
    });
  }
  return signals;
}

async function fetchIssueCommentSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
): Promise<GitHubSignal[]> {
  const comments = await fetchPagedArray<IssueComment>(
    worktreePath,
    (page) => `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
  );
  const signals: GitHubSignal[] = [];
  for (const comment of comments) {
    const author = comment.user?.login ?? "unknown";
    signals.push({
      key: `comment:${comment.id}`,
      kind: "comment",
      text: `New PR comment from ${author}: "${shortText(comment.body)}"`,
    });
  }
  return signals;
}

async function collectSignals(
  session: SessionRecord,
): Promise<{ data: GitHubEventData; snapshot: Map<string, GitHubSignal> } | null> {
  const branch = await resolveTrackedBranch(session.worktreePath, session.branch);
  const pr = await resolvePrSummary(session.worktreePath, branch);
  if (!pr) return null;

  const [checks, reviewSignals, commentSignals] = await Promise.all([
    fetchChecks(session.worktreePath, pr.number),
    pr.repo ? fetchReviewSignals(session.worktreePath, pr.repo, pr.number) : Promise.resolve([]),
    pr.repo
      ? fetchIssueCommentSignals(session.worktreePath, pr.repo, pr.number)
      : Promise.resolve([]),
  ]);

  const ciText = summarizeFailingCi(checks);
  const snapshot = new Map<string, GitHubSignal>();
  if (pr.reviewDecision === "changes_requested") {
    snapshot.set("changes_requested", {
      key: "changes_requested",
      kind: "changes_requested",
      text: "Changes requested in review.",
    });
  }
  if (ciText) {
    snapshot.set("ci_failed", {
      key: "ci_failed",
      kind: "ci_failed",
      text: ciText,
    });
  }
  if (hasMergeConflict(pr)) {
    snapshot.set("merge_conflict", {
      key: "merge_conflict",
      kind: "merge_conflict",
      text: "Merge conflicts are blocking this PR.",
    });
  }

  for (const signal of [...reviewSignals, ...commentSignals]) {
    snapshot.set(signal.key, signal);
  }

  return {
    data: {
      sessionId: session.id,
      prNumber: pr.number,
      prTitle: pr.title,
      signals: [],
    },
    snapshot,
  };
}

function emitSignalsByKind(
  deps: SourceStartDeps<GitHubSourceConfig>,
  data: Omit<GitHubEventData, "signals">,
  signals: GitHubSignal[],
): void {
  const grouped = new Map<GitHubSignalKind, GitHubSignal[]>();
  for (const signal of signals) {
    const existing = grouped.get(signal.kind);
    if (existing) {
      existing.push(signal);
      continue;
    }
    grouped.set(signal.kind, [signal]);
  }

  for (const [kind, items] of grouped) {
    deps.emit<GitHubEventData>(`github:${kind}`, {
      ...data,
      signals: items,
    });
  }
}

async function startGitHubSource(deps: SourceStartDeps<GitHubSourceConfig>): Promise<SourceHandle> {
  const snapshots = readGitHubSourceSnapshots(deps.dataDir, deps.projectId, deps.sourceId);
  let stopped = false;
  let polling = false;

  const poll = async (emitInitial: boolean): Promise<void> => {
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
          const collected = await collectSignals(session);
          if (!collected) {
            snapshots.delete(session.id);
            deleteGitHubSourceSnapshot(deps.dataDir, deps.projectId, deps.sourceId, session.id);
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
          writeGitHubSourceSnapshot(deps.dataDir, deps.projectId, deps.sourceId, session.id, next);
          if (restoreReplayRequested) {
            const mergeConflictSignal = next.get("merge_conflict");
            if (mergeConflictSignal) {
              emitSignalsByKind(deps, collected.data, [mergeConflictSignal]);
            }
          } else if (
            (previous && changed.length > 0) ||
            (!previous && emitInitial && next.size > 0)
          ) {
            emitSignalsByKind(deps, collected.data, previous ? changed : [...next.values()]);
          }
          if (restoreReplayRequested) {
            clearGitHubMergeConflictRestoreReplay(
              deps.dataDir,
              deps.projectId,
              deps.sourceId,
              session.id,
            );
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
          snapshots.delete(sessionId);
          deleteGitHubSourceSnapshot(deps.dataDir, deps.projectId, deps.sourceId, sessionId);
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

  const timer = startInterval(() => {
    void poll(false);
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void poll(false);
    } else {
      await poll(false);
    }
  }

  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] github started: intervalMs=${deps.config.intervalMs}, events="github:*", runOnStart=${deps.config.runOnStart}`,
  );

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void poll(true);
          },
        }
      : {}),
  };
}

export const githubSourceModule: SourceModule = {
  type: "github",
  start: startGitHubSource,
};
