import { gh, pollBudgetState, recordGraphqlBudgetFromEnvelope, withGhPollBudget } from "../gh.js";
import {
  readCommentSeenRegistry,
  readGitHubReviewPagination,
  writeGitHubReviewPagination,
} from "../metadata.js";
import { gqlErrorsByAlias, resolvePrLookupRepo } from "../pr-lookup.js";
import {
  clearPrLookupEntry,
  isPrLookupDue,
  markPrLookupMiss,
  markPrLookupTerminal,
  PR_LOOKUP_LIVE_CAP_MS,
  readPrLookupEntry,
  type PrRepoSlug,
} from "../pr-lookup-cache.js";
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
  "ERROR",
  "STARTUP_FAILURE",
]);
const IGNORED_GITHUB_CI_STATES = new Set(["SKIPPED", "NEUTRAL", "STALE"]);
const TERMINAL_GITHUB_CI_STATES = new Set([
  ...FAILING_GITHUB_CI_STATES,
  ...IGNORED_GITHUB_CI_STATES,
  "SUCCESS",
]);

// Review states whose body is unsolicited feedback worth surfacing. APPROVED is
// intentionally absent (see fetchReviewSummarySignals); DISMISSED/PENDING are not
// actionable.
const REVIEW_BODY_FEEDBACK_STATES = new Set(["COMMENTED", "CHANGES_REQUESTED"]);
const GITHUB_REVIEW_BATCH_MAX_TARGETS = 50;
const GITHUB_GRAPHQL_NODE_LIMIT = 500_000;
const GITHUB_REVIEW_THREAD_COUNT = 100;
const GITHUB_CONNECTION_PAGE_SIZE = 100;
const GITHUB_BOUND_PR_NODE_BUDGET =
  1 +
  GITHUB_CONNECTION_PAGE_SIZE +
  GITHUB_REVIEW_THREAD_COUNT * (1 + GITHUB_CONNECTION_PAGE_SIZE) +
  GITHUB_CONNECTION_PAGE_SIZE * 2;
const GITHUB_UNBOUND_PR_CANDIDATES = 5;
const GITHUB_UNBOUND_TARGET_NODE_BUDGET =
  GITHUB_UNBOUND_PR_CANDIDATES * (1 + GITHUB_BOUND_PR_NODE_BUDGET);
const GITHUB_REVIEW_PAGINATION_ALIASES_PER_REQUEST = 100;
const GITHUB_REVIEW_PAGINATION_REQUEST_BUDGET = 10;
const GITHUB_REVIEW_PAGINATION_NODE_BUDGET =
  GITHUB_REVIEW_PAGINATION_ALIASES_PER_REQUEST *
  GITHUB_CONNECTION_PAGE_SIZE *
  GITHUB_REVIEW_PAGINATION_REQUEST_BUDGET;
const GITHUB_REVIEW_THREAD_PAGE_NODE_BUDGET =
  GITHUB_REVIEW_THREAD_COUNT * (1 + GITHUB_CONNECTION_PAGE_SIZE);
const reviewBatchCursor = new Map<string, number>();

export function _resetGitHubReviewBatchForTests(): void {
  reviewBatchCursor.clear();
}

export function reviewCommentSeenKey(id: number | string): string {
  return `review-comment:${id}`;
}

type TerminalLifecycleKind = "merged" | "closed";

function terminalSignalKey(kind: TerminalLifecycleKind, prNumber: number): string {
  return `${kind}:${prNumber}`;
}

// Single place the terminal-key format is spelled: `<merged|closed>:<prNumber>`.
// A session's snapshot authorizes a poll-skip only when it holds the terminal
// key for the PR the session is *currently* bound to (`session.pr.number`) —
// never for a stale, previously-closed PR the session has since rebound away
// from.
export function hasTerminalSignal(signals: Map<string, ReviewSignal>, prNumber: number): boolean {
  return (
    signals.has(terminalSignalKey("merged", prNumber)) ||
    signals.has(terminalSignalKey("closed", prNumber))
  );
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

type GitHubPrStatusSummary = GitHubPrSummary & {
  statusCheckRollupState: string;
  draft: boolean;
  state: string;
};

type ReviewEntry = {
  id?: number | string | null;
  state?: string | null;
  body?: string | null;
  user?: { login?: string | null } | null;
};

export type GitHubCollectedSignals = {
  data: ReviewEventData;
  snapshot: Map<string, ReviewSignal>;
  ciActive: boolean;
  ciCheckFetchFailed: boolean;
};

export type GitHubSignalBatchResult =
  | { status: "ok"; collected: GitHubCollectedSignals | null }
  | { status: "skipped"; reason: "budget" | "cached" | "capacity" | "repo_unresolved" }
  | { status: "error"; error: unknown };

interface GitHubBatchTarget {
  session: SessionRecord;
  slug: PrRepoSlug;
  branch: string | null;
  number: number | null;
}

interface GitHubBatchAlias {
  alias: string;
  target: GitHubBatchTarget;
}

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

function connectionNodes(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
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

export function hasActiveChecks(checks: GitHubCheck[]): boolean {
  return checks.some(
    (check) =>
      !TERMINAL_GITHUB_CI_STATES.has(normalizeReviewState(check.conclusion ?? check.state)),
  );
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

// A branch with `--state all` can list several PRs (e.g. an old closed one
// plus the current open one). Picking `prs[0]` trusted `gh`'s ordering, which
// is not a documented contract. Deterministic rule instead: the
// highest-numbered OPEN PR wins (the branch's live PR); if none is open, fall
// back to the highest-numbered PR overall so a fully-closed/merged branch
// still resolves to its most recent history.
function selectPrSummary(prs: GitHubPrStatusSummary[]): GitHubPrStatusSummary | null {
  const open = prs.filter((pr) => pr.state === "OPEN");
  const pool = open.length > 0 ? open : prs;
  return pool.reduce<GitHubPrStatusSummary | null>(
    (highest, pr) => (!highest || pr.number > highest.number ? pr : highest),
    null,
  );
}

const GITHUB_REVIEW_THREAD_FIELDS = `id isResolved comments(last:100){nodes{databaseId body path line author{login}} pageInfo{hasPreviousPage startCursor}}`;
const GITHUB_REVIEW_BATCH_PR_FIELDS = `id number title url reviewDecision mergeable mergeStateStatus isDraft state
  commits(last:1){nodes{commit{statusCheckRollup{contexts(last:100){nodes{
    ... on CheckRun{name conclusion status}
    ... on StatusContext{context state}
  }}}}}}
  reviewThreads(last:100){nodes{${GITHUB_REVIEW_THREAD_FIELDS}} pageInfo{hasPreviousPage startCursor}}
  reviews(last:100){nodes{databaseId state body author{login}}}
  comments(last:100){nodes{databaseId body author{login}}}`;

function reviewBatchTargetLimit(bound: boolean): number {
  const nodesPerTarget = bound ? GITHUB_BOUND_PR_NODE_BUDGET : GITHUB_UNBOUND_TARGET_NODE_BUDGET;
  return Math.min(
    GITHUB_REVIEW_BATCH_MAX_TARGETS,
    Math.floor(GITHUB_GRAPHQL_NODE_LIMIT / nodesPerTarget),
  );
}

function buildGitHubReviewBatchQuery(targets: GitHubBatchTarget[]): {
  query: string;
  aliases: GitHubBatchAlias[];
} {
  const aliases: GitHubBatchAlias[] = [];
  const declarations = ["$owner:String!", "$name:String!"];
  const fields: string[] = [];
  for (const [index, target] of targets.entries()) {
    const alias = `a${index}`;
    aliases.push({ alias, target });
    if (target.number !== null) {
      declarations.push(`$n${index}:Int!`);
      fields.push(`${alias}:pullRequest(number:$n${index}){${GITHUB_REVIEW_BATCH_PR_FIELDS}}`);
    } else {
      declarations.push(`$b${index}:String!`);
      fields.push(
        `${alias}:pullRequests(headRefName:$b${index},first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${GITHUB_REVIEW_BATCH_PR_FIELDS}}}`,
      );
    }
  }
  return {
    query: `query(${declarations.join(",")}){rateLimit{cost remaining resetAt} r:repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
    aliases,
  };
}

function checksFromPrNode(value: Record<string, unknown>): GitHubCheck[] {
  const commit = connectionNodes(value.commits).at(-1);
  if (!isRecord(commit) || !isRecord(commit.commit) || !isRecord(commit.commit.statusCheckRollup)) {
    return [];
  }
  return connectionNodes(commit.commit.statusCheckRollup.contexts).flatMap((raw): GitHubCheck[] => {
    if (!isRecord(raw)) return [];
    const name = readString(raw.name) ?? readString(raw.context);
    const state = readString(raw.conclusion) ?? readString(raw.state) ?? readString(raw.status);
    return name && state ? [{ name, state }] : [];
  });
}

function reviewCommentsFromPrNode(value: Record<string, unknown>): PullRequestReviewComment[] {
  const comments: PullRequestReviewComment[] = [];
  for (const rawThread of connectionNodes(value.reviewThreads)) {
    if (!isRecord(rawThread)) continue;
    for (const raw of connectionNodes(rawThread.comments)) {
      if (!isRecord(raw)) continue;
      const id = readNumber(raw.databaseId);
      const body = readString(raw.body);
      if (id === null || body === null) continue;
      const author = isRecord(raw.author) ? readString(raw.author.login) : null;
      comments.push({
        id,
        body,
        path: readString(raw.path),
        line: readNumber(raw.line),
        user: { login: author },
      });
    }
  }
  return comments;
}

function reviewsFromPrNode(value: Record<string, unknown>): ReviewEntry[] {
  return connectionNodes(value.reviews).flatMap((raw): ReviewEntry[] => {
    if (!isRecord(raw)) return [];
    const author = isRecord(raw.author) ? readString(raw.author.login) : null;
    return [
      {
        id: readNumber(raw.databaseId),
        state: readString(raw.state),
        body: readString(raw.body),
        user: { login: author },
      },
    ];
  });
}

function issueCommentsFromPrNode(value: Record<string, unknown>): IssueComment[] {
  return connectionNodes(value.comments).flatMap((raw): IssueComment[] => {
    if (!isRecord(raw)) return [];
    const id = readNumber(raw.databaseId);
    const body = readString(raw.body);
    if (id === null || body === null) return [];
    const author = isRecord(raw.author) ? readString(raw.author.login) : null;
    return [{ id, body, user: { login: author } }];
  });
}

function summaryAndNode(
  value: unknown,
): { summary: GitHubPrStatusSummary; node: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const checks = checksFromPrNode(value);
  const summary = readPrStatusSummary({ ...value, statusCheckRollup: checks });
  return summary ? { summary, node: value } : null;
}

function selectSummaryAndNode(value: unknown, bound: boolean) {
  if (bound) return summaryAndNode(value);
  const candidates = connectionNodes(value)
    .map(summaryAndNode)
    .filter((entry) => entry !== null);
  const selected = selectPrSummary(candidates.map((entry) => entry.summary));
  return selected
    ? (candidates.find((entry) => entry.summary.number === selected.number) ?? null)
    : null;
}

function isValidUnboundConnection(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false;
  return value.nodes.every((node) => summaryAndNode(node) !== null);
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
  const pr = selectPrSummary(prs);
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

function reviewSignalsFromComments(
  comments: PullRequestReviewComment[],
  dataDir: string,
  projectId: string,
  sourceId: string,
): ReviewSignal[] {
  const seen = readCommentSeenRegistry(dataDir, projectId, sourceId);
  const signals: ReviewSignal[] = [];
  for (const comment of comments) {
    if (seen.has(reviewCommentSeenKey(comment.id))) continue;
    const author = comment.user?.login ?? "unknown";
    const location = comment.path
      ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ""}`
      : "";
    signals.push({
      key: reviewCommentSeenKey(comment.id),
      kind: "comment",
      text: `New review comment from ${author}${location}: "${shortText(comment.body)}"`,
    });
  }
  return signals;
}

function reviewSummarySignalsFromReviews(reviews: ReviewEntry[]): ReviewSignal[] {
  const approvedIdentities = new Set<string>();
  const signals: ReviewSignal[] = [];
  for (const review of reviews) {
    const login = review.user?.login ?? null;
    // A review submitted as COMMENTED/CHANGES_REQUESTED with substance only in the
    // body (no inline comments) is otherwise invisible: it is not an issue comment,
    // not an inline review comment, and COMMENTED does not move reviewDecision. Surface
    // the body as a comment signal, deduped by review id through the persisted snapshot
    // (same path as inline review comments — never marked seen before delivery).
    //
    // Restricted to the two unsolicited-feedback states. APPROVED bodies are excluded
    // so the approval stays conveyed only by the baseline-suppressed `approved`
    // lifecycle signal; emitting a non-lifecycle `comment` for it would re-surface a
    // stale, pre-existing approval on a session's first poll. DISMISSED/PENDING are
    // excluded as not-actionable. State is kept out of the dedup-bearing text so a later
    // transition (e.g. dismissal) cannot re-fire the same review id.
    const body = typeof review.body === "string" ? review.body.trim() : "";
    if (body && REVIEW_BODY_FEEDBACK_STATES.has(normalizeReviewState(review.state))) {
      signals.push({
        key: `review:${String(review.id ?? "")}`,
        kind: "comment",
        text: `New review from ${login ?? "a former user"}: "${shortText(body)}"`,
      });
    }
    if (review.state === "APPROVED") {
      const identity = login ?? `deleted-user-${String(review.id ?? "")}`;
      if (approvedIdentities.has(identity)) continue;
      approvedIdentities.add(identity);
      signals.push({
        key: `approved:${identity}`,
        kind: "approved",
        text: `${login ?? "A former user"} approved this PR.`,
      });
    }
  }
  return signals;
}

function issueCommentSignalsFromComments(comments: IssueComment[]): ReviewSignal[] {
  // Dedup is handled by the persisted snapshot diff, not by marking comments seen
  // here. Recording seen at generation time dropped the comment from the next poll's
  // snapshot, so the trigger's retry prune() discarded it whenever the worker was busy
  // at first delivery — silently losing the comment. Mirror the inline-comment path.
  return comments.map((comment) => {
    const author = comment.user?.login ?? "unknown";
    return {
      key: `comment:${String(comment.id)}`,
      kind: "comment",
      text: `New PR comment from ${author}: "${shortText(comment.body)}"`,
    };
  });
}

function collectSignalsFromNode(
  session: SessionRecord,
  pr: GitHubPrStatusSummary,
  node: Record<string, unknown>,
  dataDir: string,
  projectId: string,
  sourceId: string,
): GitHubCollectedSignals {
  const checks = checksFromPrNode(node);
  const reviewSignals = reviewSignalsFromComments(
    reviewCommentsFromPrNode(node),
    dataDir,
    projectId,
    sourceId,
  );
  const commentSignals = issueCommentSignalsFromComments(issueCommentsFromPrNode(node));
  const approvalSignals =
    pr.state === "MERGED" || pr.state === "CLOSED"
      ? []
      : reviewSummarySignalsFromReviews(reviewsFromPrNode(node));
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
    const key = terminalSignalKey("merged", pr.number);
    snapshot.set(key, {
      key,
      kind: "merged",
      text: `PR #${pr.number} was merged.`,
    });
  } else if (pr.state === "CLOSED") {
    const key = terminalSignalKey("closed", pr.number);
    snapshot.set(key, {
      key,
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
    ciActive: hasActiveChecks(checks),
    ciCheckFetchFailed: false,
  };
}

function parseRepoName(repo: string): { owner: string; name: string } | null {
  const [owner, name, extra] = repo.split("/");
  return owner && name && extra === undefined ? { owner, name } : null;
}

function boundRepoSlug(session: SessionRecord): PrRepoSlug | null {
  if (!session.pr) return null;
  const repo = parseRepoName(session.pr.repo);
  if (!repo) return null;
  try {
    return { host: new URL(session.pr.url).hostname.toLowerCase(), ...repo };
  } catch {
    return { host: "github.com", ...repo };
  }
}

async function targetForSession(
  session: SessionRecord,
  dataDir: string,
): Promise<GitHubBatchTarget | "cached" | null> {
  if (session.pr) {
    const slug = boundRepoSlug(session);
    return slug ? { session, slug, branch: null, number: session.pr.number } : null;
  }
  const slug = await resolvePrLookupRepo(session.worktreePath);
  if (!slug) return null;
  const branch = session.branch;
  if (!isPrLookupDue(readPrLookupEntry(dataDir, slug, branch), PR_LOOKUP_LIVE_CAP_MS)) {
    return "cached";
  }
  return {
    session,
    slug,
    branch,
    number: null,
  };
}

function readGraphqlEnvelope(raw: string): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  return isRecord(parsed) ? parsed : null;
}

function graphqlEnvelopeFromError(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || typeof error.stdout !== "string") return null;
  return readGraphqlEnvelope(error.stdout);
}

async function requestGraphqlEnvelope(
  cwd: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const requestedAtMs = Date.now();
  let envelope: Record<string, unknown> | null;
  try {
    envelope = readGraphqlEnvelope(await gh(cwd, ...args));
  } catch (error) {
    envelope = graphqlEnvelopeFromError(error);
    if (!envelope) throw error;
  }
  if (!envelope) throw new Error("invalid GitHub GraphQL response");
  recordGraphqlBudgetFromEnvelope(envelope, requestedAtMs);
  return envelope;
}

interface ReviewThreadPage {
  thread: Record<string, unknown>;
  id: string;
  pullRequestId: string;
  before: string;
}

interface PullRequestThreadPage {
  pullRequest: Record<string, unknown>;
  id: string;
  before: string;
}

const REVIEW_THREAD_CURSOR_PREFIX = "review-thread:";

function reviewThreadCursorKey(pullRequestId: string, threadId: string): string {
  return `${REVIEW_THREAD_CURSOR_PREFIX}${encodeURIComponent(pullRequestId)}:${encodeURIComponent(threadId)}`;
}

function parseReviewThreadCursorKey(
  key: string,
): { pullRequestId: string; threadId: string } | null {
  if (!key.startsWith(REVIEW_THREAD_CURSOR_PREFIX)) return null;
  const parts = key.slice(REVIEW_THREAD_CURSOR_PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return {
      pullRequestId: decodeURIComponent(parts[0]),
      threadId: decodeURIComponent(parts[1]),
    };
  } catch {
    return null;
  }
}

function pullRequestThreadPageToFetch(
  pullRequest: Record<string, unknown>,
  resumeBefore?: string,
): PullRequestThreadPage | null {
  const id = readString(pullRequest.id);
  const threads = isRecord(pullRequest.reviewThreads) ? pullRequest.reviewThreads : null;
  const pageInfo = threads && isRecord(threads.pageInfo) ? threads.pageInfo : null;
  const before = resumeBefore ?? (pageInfo ? readString(pageInfo.startCursor) : null);
  if (!id || !threads || pageInfo?.hasPreviousPage !== true || !before) return null;
  return { pullRequest, id, before };
}

async function paginateReviewThreads(
  targets: GitHubBatchTarget[],
  aliases: GitHubBatchAlias[],
  repository: Record<string, unknown>,
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<void> {
  const cursors = readGitHubReviewPagination(dataDir, projectId, sourceId);
  const resumedPullRequests = new Set(
    [...cursors.keys()].filter((key) => key.startsWith("pull-request:")),
  );
  const pullRequestsWithResumedThreads = new Set(
    [...cursors.keys()].flatMap((key) => {
      const parsed = parseReviewThreadCursorKey(key);
      return parsed ? [parsed.pullRequestId] : [];
    }),
  );
  const pending = aliases.flatMap(({ alias, target }) => {
    const selected = selectSummaryAndNode(repository[alias], target.number !== null);
    if (!selected) return [];
    const id = readString(selected.node.id);
    const cursorKey = id ? `pull-request:${id}` : "";
    if (id && !cursors.has(cursorKey) && pullRequestsWithResumedThreads.has(id)) return [];
    const page = pullRequestThreadPageToFetch(
      selected.node,
      cursorKey ? cursors.get(cursorKey) : undefined,
    );
    return page ? [page] : [];
  });
  pending.sort(
    (left, right) =>
      Number(resumedPullRequests.has(`pull-request:${right.id}`)) -
      Number(resumedPullRequests.has(`pull-request:${left.id}`)),
  );
  for (const page of pending) cursors.set(`pull-request:${page.id}`, page.before);
  let requests = 0;
  let nodes = 0;
  const aliasesPerRequest = Math.floor(
    GITHUB_GRAPHQL_NODE_LIMIT / GITHUB_REVIEW_THREAD_PAGE_NODE_BUDGET,
  );
  while (pending.length > 0) {
    if (
      pollBudgetState().blocked ||
      requests >= GITHUB_REVIEW_PAGINATION_REQUEST_BUDGET ||
      nodes + GITHUB_REVIEW_THREAD_PAGE_NODE_BUDGET > GITHUB_REVIEW_PAGINATION_NODE_BUDGET
    ) {
      break;
    }
    const remainingPages = Math.floor(
      (GITHUB_REVIEW_PAGINATION_NODE_BUDGET - nodes) / GITHUB_REVIEW_THREAD_PAGE_NODE_BUDGET,
    );
    const pages = pending.splice(0, Math.min(pending.length, aliasesPerRequest, remainingPages));
    const declarations: string[] = [];
    const fields: string[] = [];
    const args = ["api", "--hostname", targets[0]?.slug.host ?? "", "graphql"];
    for (const [index, page] of pages.entries()) {
      declarations.push(`$id${index}:ID!`, `$before${index}:String!`);
      fields.push(
        `p${index}:node(id:$id${index}){... on PullRequest{reviewThreads(last:100,before:$before${index}){nodes{${GITHUB_REVIEW_THREAD_FIELDS}} pageInfo{hasPreviousPage startCursor}}}}`,
      );
      args.push("-f", `id${index}=${page.id}`, "-f", `before${index}=${page.before}`);
    }
    const query = `query(${declarations.join(",")}){rateLimit{cost remaining resetAt} ${fields.join(" ")}}`;
    args.splice(4, 0, "-f", `query=${query}`);
    const envelope = await requestGraphqlEnvelope(targets[0]?.session.worktreePath ?? "", args);
    const data = isRecord(envelope.data) ? envelope.data : null;
    if (!data) throw new Error("invalid GitHub review thread pagination response");
    requests += 1;
    nodes += pages.length * GITHUB_REVIEW_THREAD_PAGE_NODE_BUDGET;
    for (const [index, page] of pages.entries()) {
      const value = data[`p${index}`];
      const threads = isRecord(value) && isRecord(value.reviewThreads) ? value.reviewThreads : null;
      const currentThreads = isRecord(page.pullRequest.reviewThreads)
        ? page.pullRequest.reviewThreads
        : null;
      if (!threads || !currentThreads) throw new Error("invalid GitHub review thread page");
      currentThreads.nodes = [...connectionNodes(threads), ...connectionNodes(currentThreads)];
      currentThreads.pageInfo = threads.pageInfo;
      const nextPage = pullRequestThreadPageToFetch({ id: page.id, reviewThreads: threads });
      const key = `pull-request:${page.id}`;
      if (nextPage) {
        const next = { ...nextPage, pullRequest: page.pullRequest };
        cursors.set(key, next.before);
        pending.push(next);
      } else {
        cursors.delete(key);
      }
    }
  }
  writeGitHubReviewPagination(dataDir, projectId, sourceId, cursors);
}

function threadPageToFetch(
  thread: Record<string, unknown>,
  seen: ReadonlySet<string>,
  pullRequestId: string,
  resumeBefore?: string,
): ReviewThreadPage | null {
  const id = readString(thread.id);
  const comments = isRecord(thread.comments) ? thread.comments : null;
  const pageInfo = comments && isRecord(comments.pageInfo) ? comments.pageInfo : null;
  const before = resumeBefore ?? (pageInfo ? readString(pageInfo.startCursor) : null);
  if (!id || !comments || pageInfo?.hasPreviousPage !== true || !before) return null;
  const reachedSeenComment = connectionNodes(comments).some((raw) => {
    if (!isRecord(raw)) return false;
    const databaseId = readNumber(raw.databaseId);
    return databaseId !== null && seen.has(reviewCommentSeenKey(databaseId));
  });
  return reachedSeenComment && resumeBefore === undefined
    ? null
    : {
        thread,
        id,
        pullRequestId,
        before,
      };
}

async function paginateReviewThreadComments(
  targets: GitHubBatchTarget[],
  aliases: GitHubBatchAlias[],
  repository: Record<string, unknown>,
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<void> {
  const seen = readCommentSeenRegistry(dataDir, projectId, sourceId);
  const cursors = readGitHubReviewPagination(dataDir, projectId, sourceId);
  const pullRequests = new Map<string, Record<string, unknown>>();
  for (const { alias, target } of aliases) {
    const selected = selectSummaryAndNode(repository[alias], target.number !== null);
    if (!selected) continue;
    const id = readString(selected.node.id);
    if (id) pullRequests.set(id, selected.node);
  }
  for (const [key, before] of cursors) {
    const persisted = parseReviewThreadCursorKey(key);
    if (!persisted) continue;
    const pullRequest = pullRequests.get(persisted.pullRequestId);
    if (!pullRequest) continue;
    const threads = isRecord(pullRequest.reviewThreads) ? pullRequest.reviewThreads : null;
    if (!threads) continue;
    const existing = connectionNodes(threads).some(
      (thread) => isRecord(thread) && readString(thread.id) === persisted.threadId,
    );
    if (existing) continue;
    threads.nodes = [
      ...connectionNodes(threads),
      {
        id: persisted.threadId,
        comments: {
          nodes: [],
          pageInfo: { hasPreviousPage: true, startCursor: before },
        },
      },
    ];
  }
  const pendingByKey = new Map<string, ReviewThreadPage>();
  for (const [pullRequestId, pullRequest] of pullRequests) {
    for (const raw of connectionNodes(pullRequest.reviewThreads)) {
      if (!isRecord(raw)) continue;
      const id = readString(raw.id);
      if (!id) continue;
      const cursorKey = reviewThreadCursorKey(pullRequestId, id);
      const legacyCursor = cursors.get(id);
      const resumeBefore = cursors.get(cursorKey) ?? legacyCursor;
      const page = threadPageToFetch(raw, seen, pullRequestId, resumeBefore);
      if (legacyCursor !== undefined) {
        cursors.delete(id);
        if (page) cursors.set(cursorKey, page.before);
      }
      if (page) pendingByKey.set(cursorKey, page);
    }
  }
  const resumedThreads = new Set(
    [...cursors.keys()].filter((key) => parseReviewThreadCursorKey(key) !== null),
  );
  const pending = [...pendingByKey.values()];
  pending.sort(
    (left, right) =>
      Number(resumedThreads.has(reviewThreadCursorKey(right.pullRequestId, right.id))) -
      Number(resumedThreads.has(reviewThreadCursorKey(left.pullRequestId, left.id))),
  );
  for (const page of pending) {
    cursors.set(reviewThreadCursorKey(page.pullRequestId, page.id), page.before);
  }
  let requests = 0;
  let nodes = 0;
  while (pending.length > 0) {
    if (
      pollBudgetState().blocked ||
      requests >= GITHUB_REVIEW_PAGINATION_REQUEST_BUDGET ||
      nodes + GITHUB_CONNECTION_PAGE_SIZE > GITHUB_REVIEW_PAGINATION_NODE_BUDGET
    ) {
      break;
    }
    const remainingNodePages = Math.floor(
      (GITHUB_REVIEW_PAGINATION_NODE_BUDGET - nodes) / GITHUB_CONNECTION_PAGE_SIZE,
    );
    const pageCount = Math.min(
      pending.length,
      GITHUB_REVIEW_PAGINATION_ALIASES_PER_REQUEST,
      remainingNodePages,
    );
    const pages = pending.splice(0, pageCount);
    const declarations: string[] = [];
    const fields: string[] = [];
    const args = ["api", "--hostname", targets[0]?.slug.host ?? "", "graphql"];
    for (const [index, page] of pages.entries()) {
      declarations.push(`$id${index}:ID!`, `$before${index}:String!`);
      fields.push(
        `t${index}:node(id:$id${index}){... on PullRequestReviewThread{comments(last:100,before:$before${index}){nodes{databaseId body path line author{login}} pageInfo{hasPreviousPage startCursor}}}}`,
      );
      args.push("-f", `id${index}=${page.id}`, "-f", `before${index}=${page.before}`);
    }
    const query = `query(${declarations.join(",")}){rateLimit{cost remaining resetAt} ${fields.join(" ")}}`;
    args.splice(4, 0, "-f", `query=${query}`);
    const envelope = await requestGraphqlEnvelope(targets[0]?.session.worktreePath ?? "", args);
    const data = isRecord(envelope.data) ? envelope.data : null;
    if (!data) throw new Error("invalid GitHub review comment pagination response");
    requests += 1;
    nodes += pages.length * GITHUB_CONNECTION_PAGE_SIZE;
    for (const [index, page] of pages.entries()) {
      const value = data[`t${index}`];
      const comments = isRecord(value) && isRecord(value.comments) ? value.comments : null;
      const currentComments = isRecord(page.thread.comments) ? page.thread.comments : null;
      if (!comments || !currentComments) {
        throw new Error("invalid GitHub review comment page");
      }
      currentComments.nodes = [...connectionNodes(comments), ...connectionNodes(currentComments)];
      currentComments.pageInfo = comments.pageInfo;
      const nextPage = threadPageToFetch({ id: page.id, comments }, seen, page.pullRequestId);
      const next = nextPage ? { ...nextPage, thread: page.thread } : null;
      const cursorKey = reviewThreadCursorKey(page.pullRequestId, page.id);
      if (next) {
        cursors.set(cursorKey, next.before);
        pending.push(next);
      } else {
        cursors.delete(cursorKey);
      }
    }
  }
  writeGitHubReviewPagination(dataDir, projectId, sourceId, cursors);
}

async function runReviewRepoBatch(
  targets: GitHubBatchTarget[],
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<Map<string, GitHubSignalBatchResult>> {
  const results = new Map<string, GitHubSignalBatchResult>();
  const slug = targets[0]?.slug;
  if (!slug) return results;
  const uniqueTargets = [
    ...new Map(
      targets.map((target) => [
        target.number === null ? `branch:${target.branch ?? ""}` : `number:${target.number}`,
        target,
      ]),
    ).values(),
  ];
  const bound = uniqueTargets[0]?.number !== null;
  if (uniqueTargets.some((target) => (target.number !== null) !== bound)) {
    throw new Error("GitHub review batch mixed bound and unbound targets");
  }
  const targetLimit = reviewBatchTargetLimit(bound);
  if (uniqueTargets.length > targetLimit) {
    throw new Error(`GitHub review batch exceeds ${targetLimit}-target node budget`);
  }
  const { query, aliases } = buildGitHubReviewBatchQuery(uniqueTargets);
  const args = [
    "api",
    "--hostname",
    slug.host,
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${slug.owner}`,
    "-f",
    `name=${slug.name}`,
  ];
  for (const [index, target] of uniqueTargets.entries()) {
    if (target.number !== null) {
      args.push("-F", `n${index}=${target.number}`);
    } else {
      args.push("-f", `b${index}=${target.branch ?? ""}`);
    }
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = await requestGraphqlEnvelope(targets[0]?.session.worktreePath ?? "", args);
  } catch (error) {
    for (const target of targets) results.set(target.session.id, { status: "error", error });
    return results;
  }
  const data = isRecord(envelope.data) ? envelope.data : null;
  if (!data || !isRecord(data.r)) {
    const error = new Error(
      `invalid GitHub review batch for ${slug.host}/${slug.owner}/${slug.name}`,
    );
    for (const target of targets) results.set(target.session.id, { status: "error", error });
    return results;
  }
  const repository = data.r;
  const aliasErrors = gqlErrorsByAlias(
    envelope.errors,
    new Set(aliases.map((entry) => entry.alias)),
  );
  const invalidAliases = new Set(
    aliases
      .filter(
        ({ alias, target }) =>
          target.number === null && !isValidUnboundConnection(repository[alias]),
      )
      .map(({ alias }) => alias),
  );
  const pageableAliases = aliases.filter(
    ({ alias }) => !aliasErrors.has(alias) && !invalidAliases.has(alias),
  );
  try {
    await paginateReviewThreads(targets, pageableAliases, repository, dataDir, projectId, sourceId);
    await paginateReviewThreadComments(
      targets,
      pageableAliases,
      repository,
      dataDir,
      projectId,
      sourceId,
    );
  } catch (error) {
    for (const target of targets) results.set(target.session.id, { status: "error", error });
    return results;
  }
  for (const { alias, target } of aliases) {
    const matchingTargets = targets.filter(
      (candidate) => candidate.number === target.number && candidate.branch === target.branch,
    );
    const aliasError = aliasErrors.get(alias);
    if (aliasError) {
      for (const matching of matchingTargets) {
        results.set(matching.session.id, { status: "error", error: new Error(aliasError) });
      }
      continue;
    }
    if (invalidAliases.has(alias)) {
      const error = new Error(`invalid GitHub pullRequests payload for ${alias}`);
      for (const matching of matchingTargets) {
        results.set(matching.session.id, { status: "error", error });
      }
      continue;
    }
    const selected = selectSummaryAndNode(repository[alias], target.number !== null);
    if (target.branch !== null) {
      if (!selected) {
        markPrLookupMiss(dataDir, target.slug, target.branch);
      } else if (selected.summary.state === "CLOSED" || selected.summary.state === "MERGED") {
        markPrLookupTerminal(dataDir, target.slug, target.branch, {
          number: selected.summary.number,
          state: selected.summary.state,
        });
      } else {
        clearPrLookupEntry(dataDir, target.slug, target.branch);
      }
    }
    if (!selected) {
      for (const matching of matchingTargets) {
        results.set(matching.session.id, { status: "ok", collected: null });
      }
      continue;
    }
    for (const matching of matchingTargets) {
      results.set(matching.session.id, {
        status: "ok",
        collected: collectSignalsFromNode(
          matching.session,
          selected.summary,
          selected.node,
          dataDir,
          projectId,
          sourceId,
        ),
      });
    }
  }
  return results;
}

export async function collectGitHubSignalsBatch(
  sessions: SessionRecord[],
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<Map<string, GitHubSignalBatchResult>> {
  const results = new Map<string, GitHubSignalBatchResult>();
  const byRepo = new Map<string, GitHubBatchTarget[]>();
  for (const session of sessions) {
    const target = await targetForSession(session, dataDir);
    if (target === "cached") {
      results.set(session.id, { status: "skipped", reason: "cached" });
      continue;
    }
    if (!target) {
      results.set(session.id, { status: "skipped", reason: "repo_unresolved" });
      continue;
    }
    const repoKey = `${target.slug.host}/${target.slug.owner}/${target.slug.name}`;
    const group = byRepo.get(repoKey) ?? [];
    group.push(target);
    byRepo.set(repoKey, group);
  }
  for (const [repoKey, targets] of byRepo) {
    if (pollBudgetState().blocked) {
      for (const target of targets) {
        results.set(target.session.id, { status: "skipped", reason: "budget" });
      }
      continue;
    }
    const targetsByKey = new Map<string, GitHubBatchTarget[]>();
    for (const target of targets) {
      const key =
        target.number === null ? `branch:${target.branch ?? ""}` : `number:${target.number}`;
      const grouped = targetsByKey.get(key) ?? [];
      grouped.push(target);
      targetsByKey.set(key, grouped);
    }
    for (const bound of [true, false]) {
      const groupedTargets = [...targetsByKey.values()].filter(
        (group) => (group[0]?.number !== null) === bound,
      );
      if (groupedTargets.length === 0) continue;
      if (pollBudgetState().blocked) {
        for (const group of groupedTargets) {
          for (const target of group) {
            results.set(target.session.id, { status: "skipped", reason: "budget" });
          }
        }
        continue;
      }
      const cursorKey = `${repoKey}:${bound ? "bound" : "unbound"}`;
      const start = (reviewBatchCursor.get(cursorKey) ?? 0) % groupedTargets.length;
      const limit = reviewBatchTargetLimit(bound);
      const selectedGroups = Array.from(
        { length: Math.min(limit, groupedTargets.length) },
        (_, offset) => groupedTargets[(start + offset) % groupedTargets.length] ?? [],
      );
      const selected = selectedGroups.flat();
      const selectedIds = new Set(selected.map((target) => target.session.id));
      for (const group of groupedTargets) {
        for (const target of group) {
          if (!selectedIds.has(target.session.id)) {
            results.set(target.session.id, { status: "skipped", reason: "capacity" });
          }
        }
      }
      reviewBatchCursor.set(cursorKey, (start + limit) % groupedTargets.length);
      const admission = await withGhPollBudget(() =>
        runReviewRepoBatch(selected, dataDir, projectId, sourceId),
      );
      const batch =
        admission.status === "blocked"
          ? new Map(
              selected.map((target) => [
                target.session.id,
                { status: "skipped", reason: "budget" } satisfies GitHubSignalBatchResult,
              ]),
            )
          : admission.value;
      for (const [sessionId, result] of batch) {
        results.set(sessionId, result);
      }
    }
  }
  return results;
}

async function collectSignals(
  session: SessionRecord,
  dataDir: string,
  projectId: string,
  sourceId: string,
): Promise<GitHubCollectedSignals | null> {
  const result = (await collectGitHubSignalsBatch([session], dataDir, projectId, sourceId)).get(
    session.id,
  );
  if (!result || result.status === "skipped") return null;
  if (result.status === "error") throw result.error;
  return result.collected;
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
