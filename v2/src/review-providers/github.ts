import { gh, noteGraphqlCost, pollBudgetState, recordGraphqlBudget } from "../gh.js";
import { readCommentSeenRegistry } from "../metadata.js";
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

// At the 50-target batch cap, 20 threads × 100 comments bounds nested review
// comment nodes at 100,000 while retaining the newest same-thread activity.
const GITHUB_REVIEW_BATCH_PR_FIELDS = `number title url reviewDecision mergeable mergeStateStatus isDraft state
  commits(last:1){nodes{commit{statusCheckRollup{contexts(last:100){nodes{
    ... on CheckRun{name conclusion status}
    ... on StatusContext{context state}
  }}}}}}
  reviewThreads(last:20){nodes{isResolved comments(last:100){nodes{databaseId body path line author{login}}}}}
  reviews(last:100){nodes{databaseId state body author{login}}}
  comments(last:100){nodes{databaseId body author{login}}}`;

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

function recordBatchBudget(data: Record<string, unknown>): void {
  if (!isRecord(data.rateLimit)) return;
  const cost = readNumber(data.rateLimit.cost);
  if (cost !== null) noteGraphqlCost(cost);
  const remaining = readNumber(data.rateLimit.remaining);
  if (remaining === null) return;
  const resetAt = readString(data.rateLimit.resetAt);
  const parsedReset = resetAt ? Date.parse(resetAt) : Number.NaN;
  recordGraphqlBudget(remaining, Number.isFinite(parsedReset) ? parsedReset : null);
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

  let envelope: Record<string, unknown> | null;
  try {
    envelope = readGraphqlEnvelope(await gh(targets[0]?.session.worktreePath ?? "", ...args));
  } catch (error) {
    envelope = graphqlEnvelopeFromError(error);
    if (!envelope) {
      for (const target of targets) results.set(target.session.id, { status: "error", error });
      return results;
    }
  }
  const data = envelope && isRecord(envelope.data) ? envelope.data : null;
  if (!data || !isRecord(data.r)) {
    const error = new Error(
      `invalid GitHub review batch for ${slug.host}/${slug.owner}/${slug.name}`,
    );
    for (const target of targets) results.set(target.session.id, { status: "error", error });
    return results;
  }
  recordBatchBudget(data);
  const aliasErrors = gqlErrorsByAlias(
    envelope?.errors,
    new Set(aliases.map((entry) => entry.alias)),
  );
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
    const selected = selectSummaryAndNode(data.r[alias], target.number !== null);
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
    const groupedTargets = [...targetsByKey.values()];
    const start = (reviewBatchCursor.get(repoKey) ?? 0) % groupedTargets.length;
    const selectedGroups = Array.from(
      { length: Math.min(GITHUB_REVIEW_BATCH_MAX_TARGETS, groupedTargets.length) },
      (_, offset) => groupedTargets[(start + offset) % groupedTargets.length] ?? [],
    );
    const selected = selectedGroups.flat();
    const selectedIds = new Set(selected.map((target) => target.session.id));
    for (const target of targets) {
      if (!selectedIds.has(target.session.id)) {
        results.set(target.session.id, { status: "skipped", reason: "capacity" });
      }
    }
    reviewBatchCursor.set(
      repoKey,
      (start + GITHUB_REVIEW_BATCH_MAX_TARGETS) % groupedTargets.length,
    );
    const batch = await runReviewRepoBatch(selected, dataDir, projectId, sourceId);
    for (const [sessionId, result] of batch) {
      results.set(sessionId, result);
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
