import { gh } from "../gh.js";
import { readCurrentBranch } from "../workspace.js";
import type {
  GitHubCheck,
  GitHubPrSummary,
  ReviewEventData,
  ReviewSignal,
  SessionRecord,
} from "../types.js";
import { hasMergeConflict, normalizeReviewDecision, normalizeReviewState, shortText, summarizeFailingCi } from "./shared.js";
import type { ReviewProvider } from "./types.js";

export { hasMergeConflict, normalizeReviewDecision, shortText, summarizeFailingCi } from "./shared.js";

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

async function fetchIssueCommentSignals(
  worktreePath: string,
  repo: string,
  prNumber: number,
): Promise<ReviewSignal[]> {
  const comments = await fetchPagedArray<IssueComment>(
    worktreePath,
    (page) => `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
  );
  const signals: ReviewSignal[] = [];
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
): Promise<{ data: ReviewEventData; snapshot: Map<string, ReviewSignal> } | null> {
  const branch = await resolveTrackedBranch(session.worktreePath, session.branch);
  const pr = await resolvePrSummary(session.worktreePath, branch);
  if (!pr) return null;

  const [checks, reviewSignals, commentSignals] = await Promise.all([
    fetchChecks(session.worktreePath, pr.number),
    pr.repo ? fetchReviewSignals(session.worktreePath, pr.repo, pr.number) : Promise.resolve([]),
    pr.repo ? fetchIssueCommentSignals(session.worktreePath, pr.repo, pr.number) : Promise.resolve([]),
  ]);

  const ciText = summarizeFailingCi(checks);
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

export const githubReviewProvider: ReviewProvider = {
  id: "github",
  displayName: "GitHub",
  requestLabel: "PR",
  requestLabelPlural: "PRs",
  instructionsLine: "Review the latest GitHub updates on the active PR and act on them.",
  commandLine: "Use `gh pr view --comments` and `gh pr checks`, then fix, push, and reply if needed.",
  async findReviewUrlByBranch(worktreePath, branch) {
    const pr = await resolvePrSummary(worktreePath, branch);
    return pr?.url ?? null;
  },
  collectSignals,
};
