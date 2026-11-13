import {
  type CiStatus,
  type PrCheck,
  type PrReviewRequest,
  type PrReviewers,
  type PrState,
  parseReviewDecision,
} from "@/lib/pr-status-shape";
import {
  type PrStatusResponse,
  cachePrStatusResponse,
  cacheTtlMs,
  errorCacheTtlMs,
  errorResponse,
  recordSuccessfulPrStatus,
} from "@/lib/pr-status-store";
import { githubReviewRequirement, type NativeReviewSource } from "@/lib/github-review-requirement";

// Shared GraphQL selection set for a GitHub pull request. Both the
// single-URL route (one PR per document) and the batch route (one aliased
// `repository { pullRequest { ... } }` block per PR) embed this verbatim so
// there is exactly one definition of "what we ask GitHub for".
export const GITHUB_PR_STATUS_FIELDS =
  "state isDraft merged mergeable mergeStateStatus reviewDecision " +
  "headRefOid baseRefOid baseRefName " +
  "baseRef { target { oid } rules(first:100) { nodes { type parameters { ... on PullRequestParameters { requiredApprovingReviewCount requireCodeOwnerReview requireLastPushApproval requiredReviewers { minimumApprovals filePatterns } } } } pageInfo { hasNextPage } } " +
  "branchProtectionRule { requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews requireLastPushApproval } } " +
  "reviewRequests(first:100) { nodes { asCodeOwner requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } ... on EnterpriseTeam { slug } } } pageInfo { hasNextPage } } " +
  "reviews(last:100) { nodes { state submittedAt authorCanPushToRepository author { login } } pageInfo { hasPreviousPage } } " +
  "reviewThreads(first:100) { nodes { isResolved } } " +
  "commits(last:1) { nodes { commit { statusCheckRollup { state contexts(first:100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }";

export interface GitHubPrNode extends NativeReviewSource {
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviews?: unknown;
  reviewThreads: { nodes: { isResolved: boolean }[] };
  commits: {
    nodes: { commit: { statusCheckRollup?: { state: string; contexts?: unknown } | null } }[];
  };
}

export function isGitHubPrNode(value: unknown): value is GitHubPrNode {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const reviewThreads = v["reviewThreads"];
  const commits = v["commits"];
  return (
    typeof v["state"] === "string" &&
    typeof v["isDraft"] === "boolean" &&
    typeof v["merged"] === "boolean" &&
    (v["mergeable"] === null || typeof v["mergeable"] === "string") &&
    (v["mergeStateStatus"] === null || typeof v["mergeStateStatus"] === "string") &&
    (v["reviewDecision"] === null || typeof v["reviewDecision"] === "string") &&
    typeof reviewThreads === "object" &&
    reviewThreads !== null &&
    Array.isArray((reviewThreads as Record<string, unknown>)["nodes"]) &&
    typeof commits === "object" &&
    commits !== null &&
    Array.isArray((commits as Record<string, unknown>)["nodes"])
  );
}

function normalizeGitHubState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function normalizeGitHubCiStatus(rollupState: string | undefined): CiStatus {
  if (rollupState === "SUCCESS") return "success";
  if (rollupState === "FAILURE" || rollupState === "ERROR") return "failure";
  if (rollupState === "PENDING" || rollupState === "EXPECTED") return "pending";
  return null;
}

function parseGitHubReviews(
  value: unknown,
): { reviewers: PrReviewers; blockingChanges: boolean | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const connection = value as Record<string, unknown>;
  const pageInfo = connection["pageInfo"];
  if (
    typeof pageInfo !== "object" ||
    pageInfo === null ||
    (pageInfo as Record<string, unknown>)["hasPreviousPage"] !== false ||
    !Array.isArray(connection["nodes"])
  ) {
    return null;
  }

  const events: Array<{
    login: string;
    state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
    submittedAt: number;
    canPush: boolean | null;
  }> = [];
  for (const node of connection["nodes"]) {
    if (typeof node !== "object" || node === null) return null;
    const review = node as Record<string, unknown>;
    const state = review["state"];
    if (
      state !== "APPROVED" &&
      state !== "CHANGES_REQUESTED" &&
      state !== "DISMISSED" &&
      state !== "COMMENTED" &&
      state !== "PENDING"
    ) {
      return null;
    }
    const author = review["author"];
    if (author === null) continue;
    if (typeof author !== "object" || author === null) return null;
    const login = (author as Record<string, unknown>)["login"];
    if (typeof login !== "string" || login.length === 0) return null;
    if (state === "COMMENTED" || state === "PENDING") continue;
    const submittedAt = review["submittedAt"];
    if (
      typeof submittedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(submittedAt)
    ) {
      return null;
    }
    const timestamp = Date.parse(submittedAt);
    if (!Number.isFinite(timestamp)) return null;
    events.push({
      login,
      state,
      submittedAt: timestamp,
      canPush:
        typeof review["authorCanPushToRepository"] === "boolean"
          ? review["authorCanPushToRepository"]
          : null,
    });
  }
  const accounts = new Map<
    string,
    { login: string; state: "APPROVED" | "CHANGES_REQUESTED"; canPush: boolean | null }
  >();
  // Stable ordering retains connection order when publication times are equal.
  events.sort((a, b) => a.submittedAt - b.submittedAt);
  for (const { login, state, canPush } of events) {
    const key = login.toLowerCase();
    if (state === "DISMISSED") accounts.delete(key);
    else accounts.set(key, { login, state, canPush });
  }
  const reviewers: PrReviewers = { approved: [], changesRequested: [] };
  let blockingChanges: boolean | null = false;
  for (const { login, state, canPush } of accounts.values()) {
    if (state === "APPROVED") reviewers.approved.push(login);
    if (state === "CHANGES_REQUESTED") {
      reviewers.changesRequested.push(login);
      if (canPush === true) blockingChanges = true;
      else if (canPush === null && blockingChanges !== true) blockingChanges = null;
    }
  }
  reviewers.approved.sort();
  reviewers.changesRequested.sort();
  return { reviewers, blockingChanges };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Fail-closed on pending only: any malformed node omits the list (undefined).
function parseGitHubReviewRequests(value: unknown): PrReviewRequest[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const nodes = (value as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return undefined;
  const pending: PrReviewRequest[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) return undefined;
    const reviewer = (node as Record<string, unknown>)["requestedReviewer"];
    if (reviewer === null) continue;
    if (typeof reviewer !== "object") return undefined;
    const fields = reviewer as Record<string, unknown>;
    const typename = fields["__typename"];
    if (typename === "User" || typename === "Bot" || typename === "Mannequin") {
      if (!nonEmptyString(fields["login"])) return undefined;
      pending.push({ name: fields["login"], team: false });
    } else if (typename === "Team" || typename === "EnterpriseTeam") {
      if (!nonEmptyString(fields["slug"])) return undefined;
      pending.push({ name: fields["slug"], team: true });
    } else {
      return undefined;
    }
  }
  return pending.sort((a, b) => a.name.localeCompare(b.name));
}

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);
const PASSED_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const CHECK_RUN_STATUSES: ReadonlySet<string> = new Set([
  "QUEUED",
  "IN_PROGRESS",
  "COMPLETED",
  "WAITING",
  "PENDING",
  "REQUESTED",
]);

function parseGitHubCheckRun(fields: Record<string, unknown>): PrCheck | null {
  const { name, status, conclusion } = fields;
  if (!nonEmptyString(name) || typeof status !== "string" || !CHECK_RUN_STATUSES.has(status)) {
    return null;
  }
  if (status !== "COMPLETED") return { name, state: "pending" };
  if (conclusion === null) return { name, state: "pending" };
  if (typeof conclusion !== "string") return null;
  if (PASSED_CONCLUSIONS.has(conclusion)) return { name, state: "passed" };
  if (FAILED_CONCLUSIONS.has(conclusion)) return { name, state: "failed" };
  return null;
}

function parseGitHubStatusContext(fields: Record<string, unknown>): PrCheck | null {
  const { context, state } = fields;
  if (!nonEmptyString(context)) return null;
  if (state === "SUCCESS") return { name: context, state: "passed" };
  if (state === "FAILURE" || state === "ERROR") return { name: context, state: "failed" };
  if (state === "PENDING" || state === "EXPECTED") return { name: context, state: "pending" };
  return null;
}

// Fail-closed on checks only: any malformed or unknown node yields null.
function parseGitHubChecks(rollup: { contexts?: unknown } | null | undefined): PrCheck[] | null {
  if (!rollup) return [];
  const contexts = rollup.contexts;
  if (typeof contexts !== "object" || contexts === null) return null;
  const nodes = (contexts as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return null;
  const checks: PrCheck[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) return null;
    const fields = node as Record<string, unknown>;
    const typename = fields["__typename"];
    let check: PrCheck | null;
    if (typename === "CheckRun") check = parseGitHubCheckRun(fields);
    else if (typename === "StatusContext") check = parseGitHubStatusContext(fields);
    else check = null;
    if (!check) return null;
    checks.push(check);
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name));
}

// Normalizes a resolved PR node into the store's PrInfo shape, writes it
// through recordSuccessfulPrStatus (last-good snapshot) and caches the
// response — the same store path used by both route surfaces. A resolved
// node can still arrive alongside a partial GraphQL `errors[]` entry (e.g.
// a rate-limited sub-field); when `error` is set the payload carries it and
// is cached with the shorter error TTL instead of the normal success TTL.
export async function recordGitHubPrNode(
  cacheKey: string,
  node: GitHubPrNode,
  error?: string,
): Promise<PrStatusResponse> {
  let state: PrState;
  if (node.merged) state = "merged";
  else if (node.state === "CLOSED") state = "closed";
  else if (node.isDraft) state = "draft";
  else state = "open";

  const totalThreads = node.reviewThreads.nodes.length;
  const unresolvedThreads = node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length;
  const mergeable = normalizeGitHubState(node.mergeable);
  const mergeStateStatus = normalizeGitHubState(node.mergeStateStatus);
  const canMerge = state === "open" && mergeable === "MERGEABLE" && mergeStateStatus === "CLEAN";
  const mergeConflict =
    mergeable === "CONFLICTING" ||
    mergeStateStatus === "DIRTY" ||
    mergeStateStatus === "CANNOT_BE_MERGED";

  const reviews = parseGitHubReviews(node.reviews);
  const [owner, repo] = cacheKey.split("/");
  const reviewRequirement =
    !owner || !repo
      ? "unavailable"
      : await githubReviewRequirement(
          node,
          reviews?.blockingChanges ?? null,
          owner,
          repo,
          Boolean(error),
        );
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
  const pending = parseGitHubReviewRequests(node.reviewRequests);
  const response = recordSuccessfulPrStatus(cacheKey, {
    state,
    reviewDecision: parseReviewDecision(node.reviewDecision),
    reviewers: reviews ? { ...reviews.reviewers, ...(pending ? { pending } : {}) } : null,
    checks: parseGitHubChecks(rollup),
    reviewRequirement,
    ciStatus: normalizeGitHubCiStatus(rollup?.state),
    canMerge,
    mergeConflict,
    totalThreads,
    unresolvedThreads,
  });
  const payload = error ? { ...response, error } : response;
  cachePrStatusResponse(cacheKey, payload, error ? errorCacheTtlMs() : cacheTtlMs());
  return payload;
}

// No GraphQL error and no PR node: the PR simply doesn't exist (deleted
// repo/PR, bad number). Recorded as a successful "empty" snapshot, not an
// error — matches the pre-refactor `handleGitHubStatus` behavior.
export function recordGitHubPrAbsent(cacheKey: string): PrStatusResponse {
  const response = recordSuccessfulPrStatus(cacheKey, {
    state: null,
    reviewDecision: null,
    reviewers: null,
    checks: null,
    reviewRequirement: "unavailable",
    ciStatus: null,
    canMerge: false,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
  });
  cachePrStatusResponse(cacheKey, response, cacheTtlMs());
  return response;
}

export function recordGitHubPrError(cacheKey: string, message: string): PrStatusResponse {
  const response = errorResponse(cacheKey, message);
  cachePrStatusResponse(cacheKey, response, errorCacheTtlMs());
  return response;
}
