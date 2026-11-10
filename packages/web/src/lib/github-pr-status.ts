import {
  type CiStatus,
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
  "reviewRequests(first:100) { nodes { asCodeOwner } pageInfo { hasNextPage } } " +
  "reviews(last:100) { nodes { state submittedAt authorCanPushToRepository author { login } } pageInfo { hasPreviousPage } } " +
  "reviewThreads(first:100) { nodes { isResolved } } " +
  "commits(last:1) { nodes { commit { statusCheckRollup { state } } } }";

export interface GitHubPrNode extends NativeReviewSource {
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviews?: unknown;
  reviewThreads: { nodes: { isResolved: boolean }[] };
  commits: { nodes: { commit: { statusCheckRollup?: { state: string } } }[] };
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
  const response = recordSuccessfulPrStatus(cacheKey, {
    state,
    reviewDecision: parseReviewDecision(node.reviewDecision),
    reviewers: reviews?.reviewers ?? null,
    reviewRequirement,
    ciStatus: normalizeGitHubCiStatus(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
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
