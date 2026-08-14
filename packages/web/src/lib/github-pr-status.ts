import { type CiStatus, type PrState, parseReviewDecision } from "@/lib/pr-status-shape";
import {
  type PrStatusResponse,
  cachePrStatusResponse,
  cacheTtlMs,
  errorCacheTtlMs,
  errorResponse,
  recordSuccessfulPrStatus,
} from "@/lib/pr-status-store";

// Shared GraphQL selection set for a GitHub pull request. Both the
// single-URL route (one PR per document) and the batch route (one aliased
// `repository { pullRequest { ... } }` block per PR) embed this verbatim so
// there is exactly one definition of "what we ask GitHub for".
export const GITHUB_PR_STATUS_FIELDS =
  "state isDraft merged mergeable mergeStateStatus reviewDecision " +
  "reviewThreads(first:100) { nodes { isResolved } } " +
  "commits(last:1) { nodes { commit { statusCheckRollup { state } } } }";

export interface GitHubPrNode {
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
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

// Normalizes a resolved PR node into the store's PrInfo shape, writes it
// through recordSuccessfulPrStatus (last-good snapshot) and caches the
// response — the same store path used by both route surfaces. A resolved
// node can still arrive alongside a partial GraphQL `errors[]` entry (e.g.
// a rate-limited sub-field); when `error` is set the payload carries it and
// is cached with the shorter error TTL instead of the normal success TTL.
export function recordGitHubPrNode(
  cacheKey: string,
  node: GitHubPrNode,
  error?: string,
): PrStatusResponse {
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

  const response = recordSuccessfulPrStatus(cacheKey, {
    state,
    reviewDecision: parseReviewDecision(node.reviewDecision),
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
