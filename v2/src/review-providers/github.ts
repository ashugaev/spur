import { gh } from "../gh.js";
import { readCommentSeenRegistry, recordCommentSeen } from "../metadata.js";
import { readCurrentBranch } from "../workspace.js";
import type {
  GitHubCheck,
  GitHubPrSummary,
  ReviewEventData,
  ReviewSignal,
  SessionPrBinding,
  SessionRecord,
} from "../types.js";
import {
  hasMergeConflict,
  normalizeReviewDecision,
  normalizeReviewState,
  shortText,
} from "./shared.js";
import type { ReviewProvider } from "./types.js";

export { hasMergeConflict, normalizeReviewDecision, shortText } from "./shared.js";

const FAILING_GITHUB_CI_STATES = new Set([
  "FAILURE",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "CANCELED",
  "ACTION_REQUIRED",
]);
const IGNORED_GITHUB_CI_STATES = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

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

type GitHubPrStatusSummary = GitHubPrSummary & {
  statusCheckRollupState: string;
  draft: boolean;
  state: string;
};

type ReviewEntry = {
  id?: number | string | null;
  state?: string | null;
  user?: { login?: string | null } | null;
};

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readRollupState(value: unknown): string {
  if (Array.isArray(value)) {
    const states = value
      .map(readRollupState)
      .filter((state) => state && !IGNORED_GITHUB_CI_STATES.has(state));
    return states.length > 0 && states.every((state) => state === "SUCCESS") ? "SUCCESS" : "";
  }
  if (!isRecord(value)) return "";
  const state = readString(value.state);
  if (state) return normalizeReviewState(state);
  const conclusion = readString(value.conclusion);
  return conclusion ? normalizeReviewState(conclusion) : "";
}

function readPrStatusSummary(value: unknown): GitHubPrStatusSummary | null {
  if (!isRecord(value)) return null;
  const number = readNumber(value.number);
  const title = readString(value.title);
  if (number === null || title === null) return null;
  const url = readString(value.url);
  return {
    number,
    title,
    url: url ?? "",
    reviewDecision: normalizeReviewDecision(readString(value.reviewDecision)),
    repo: url ? parseRepoFromUrl(url) : "",
    mergeable: readString(value.mergeable) ?? "",
    mergeStateStatus: readString(value.mergeStateStatus) ?? "",
    statusCheckRollupState: readRollupState(value.statusCheckRollup),
    draft: value.isDraft === true,
    state: readString(value.state) ?? "",
  };
}

export function summarizeFailingCi(checks: GitHubCheck[]): string | null {
  const failing = checks.filter((check) => {
    const state = normalizeReviewState(check.conclusion ?? check.state);
    return FAILING_GITHUB_CI_STATES.has(state);
  });
  return failing.length > 0
    ? `CI is failing: ${failing.map((check) => check.name).join(", ")}.`
    : null;
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

export async function resolvePrSummary(
  worktreePath: string,
  branch: string,
): Promise<GitHubPrStatusSummary | null> {
  const raw = await gh(
    worktreePath,
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,title,url,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,state,isDraft",
  );
  const parsed = parseJson(raw);
  const prs = Array.isArray(parsed)
    ? parsed.map(readPrStatusSummary).filter((pr) => pr !== null)
    : [];
  const pr = prs[0];
  if (!pr) return null;

  let mergeable = pr.mergeable;
  let mergeStateStatus = pr.mergeStateStatus;
  if (
    normalizeReviewState(mergeable) === "UNKNOWN" ||
    normalizeReviewState(mergeStateStatus) === "UNKNOWN"
  ) {
    try {
      const rawView = await gh(
        worktreePath,
        "pr",
        "view",
        String(pr.number),
        "--json",
        "mergeable,mergeStateStatus,statusCheckRollup",
      );
      const view = parseJson(rawView);
      if (isRecord(view)) {
        const viewMergeable = readString(view.mergeable);
        const viewMergeStateStatus = readString(view.mergeStateStatus);
        if (viewMergeable) mergeable = viewMergeable;
        if (viewMergeStateStatus) mergeStateStatus = viewMergeStateStatus;
        const statusCheckRollupState = readRollupState(view.statusCheckRollup);
        if (statusCheckRollupState) pr.statusCheckRollupState = statusCheckRollupState;
      }
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
    statusCheckRollupState: pr.statusCheckRollupState,
    draft: pr.draft,
    state: pr.state,
  };
}

export async function resolveBoundPrSummary(
  worktreePath: string,
  pr: SessionPrBinding,
): Promise<GitHubPrStatusSummary> {
  const raw = await gh(
    worktreePath,
    "pr",
    "view",
    String(pr.number),
    "--json",
    "number,title,url,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,state,isDraft",
  );
  const summary = readPrStatusSummary(parseJson(raw));
  if (!summary) {
    throw new Error("invalid GitHub PR summary");
  }
  const url = summary.url || pr.url;
  return {
    number: summary.number,
    title: summary.title,
    url,
    reviewDecision: normalizeReviewDecision(summary.reviewDecision),
    repo: parseRepoFromUrl(url),
    mergeable: summary.mergeable,
    mergeStateStatus: summary.mergeStateStatus,
    statusCheckRollupState: summary.statusCheckRollupState,
    draft: summary.draft,
    state: summary.state,
  };
}

async function fetchChecks(worktreePath: string, prNumber: number): Promise<GitHubCheck[]> {
  try {
    const raw = await gh(worktreePath, "pr", "checks", String(prNumber), "--json", "name,state");
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value): GitHubCheck[] => {
      if (!isRecord(value)) return [];
      const name = readString(value.name);
      const state = readString(value.state);
      if (!name || !state) return [];
      return [{ name, state }];
    });
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
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("invalid GitHub API page");
    }
    const next = parsed as T[];
    items.push(...next);
    if (next.length < 100) return items;
  }
}

async function fetchReviewSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
): Promise<ReviewSignal[]> {
  const comments = await fetchPagedArray<PullRequestReviewComment>(
    worktreePath,
    (page) => `repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
  );
  const signals: ReviewSignal[] = [];
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

async function fetchApprovalSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
): Promise<ReviewSignal[]> {
  const reviews = await fetchPagedArray<ReviewEntry>(
    worktreePath,
    (page) => `repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
  );
  const seen = new Set<string>();
  const signals: ReviewSignal[] = [];
  for (const review of reviews) {
    if (review.state !== "APPROVED") continue;
    const login = review.user?.login ?? null;
    const identity = login ?? `deleted-user-${String(review.id ?? "")}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    signals.push({
      key: `approved:${identity}`,
      kind: "approved",
      text: `${login ?? "A former user"} approved this PR.`,
    });
  }
  return signals;
}

async function fetchIssueCommentSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<ReviewSignal[]> {
  const comments = await fetchPagedArray<IssueComment>(
    worktreePath,
    (page) => `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
  );
  const seen = readCommentSeenRegistry(dataDir, projectId, sourceId);
  const signals: ReviewSignal[] = [];
  const emittedIds: string[] = [];
  for (const comment of comments) {
    const id = String(comment.id);
    if (seen.has(id)) continue;
    const author = comment.user?.login ?? "unknown";
    signals.push({
      key: `comment:${id}`,
      kind: "comment",
      text: `New PR comment from ${author}: "${shortText(comment.body)}"`,
    });
    emittedIds.push(id);
  }
  if (emittedIds.length > 0) {
    recordCommentSeen(dataDir, projectId, sourceId, emittedIds);
  }
  return signals;
}

async function collectSignals(
  session: SessionRecord,
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<{ data: ReviewEventData; snapshot: Map<string, ReviewSignal> } | null> {
  const pr = session.pr
    ? await resolveBoundPrSummary(session.worktreePath, session.pr)
    : await resolvePrSummary(
        session.worktreePath,
        await resolveTrackedBranch(session.worktreePath, session.branch),
      );
  if (!pr) return null;

  const [checks, reviewSignals, commentSignals, approvalSignals] = await Promise.all([
    fetchChecks(session.worktreePath, pr.number),
    pr.repo ? fetchReviewSignals(session.worktreePath, pr.repo, pr.number) : Promise.resolve([]),
    pr.repo
      ? fetchIssueCommentSignals(
          session.worktreePath,
          pr.repo,
          pr.number,
          dataDir,
          projectId,
          sourceId,
        )
      : Promise.resolve([]),
    pr.repo && pr.state !== "MERGED" && pr.state !== "CLOSED"
      ? fetchApprovalSignals(session.worktreePath, pr.repo, pr.number)
      : Promise.resolve([]),
  ]);

  const ciText =
    normalizeReviewState(pr.statusCheckRollupState) === "SUCCESS"
      ? null
      : summarizeFailingCi(checks);
  const snapshot = new Map<string, ReviewSignal>();
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
  if (pr.draft === false) {
    snapshot.set("ready_for_review", {
      key: "ready_for_review",
      kind: "ready_for_review",
      text: "PR is ready for review.",
    });
  }
  if (pr.state === "MERGED") {
    snapshot.set("merged", {
      key: "merged",
      kind: "merged",
      text: `PR #${pr.number} was merged.`,
    });
  } else if (pr.state === "CLOSED") {
    snapshot.set("closed", {
      key: "closed",
      kind: "closed",
      text: `PR #${pr.number} was closed without merging.`,
    });
  }

  for (const signal of [...reviewSignals, ...commentSignals, ...approvalSignals]) {
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

export const githubReviewProvider: ReviewProvider = {
  id: "github",
  displayName: "GitHub",
  requestLabel: "PR",
  requestLabelPlural: "PRs",
  instructionsLine: "Review the latest GitHub updates on the active PR and act on them.",
  commandLine:
    "Use `gh pr view --comments` and `gh pr checks`, then fix, push, and reply if needed.",
  async findReviewUrlByBranch(worktreePath, branch) {
    const pr = await resolvePrSummary(worktreePath, branch);
    return pr?.url ?? null;
  },
  collectSignals,
};
