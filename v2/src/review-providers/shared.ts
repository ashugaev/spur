import type { ReviewCheck, ReviewDecision, ReviewRequestSummary } from "../types.js";

const FAILING_CI_STATES = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  "FAILED",
  "CANCELED",
  "SKIPPED",
]);

export function shortText(value: string, limit = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

export function normalizeReviewDecision(value: string | null | undefined): ReviewDecision {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "pending";
  return "none";
}

export function normalizeReviewState(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function summarizeFailingCi(checks: ReviewCheck[]): string | null {
  const failing = checks.filter((check) => FAILING_CI_STATES.has(check.state.toUpperCase()));
  return failing.length > 0
    ? `CI is failing: ${failing.map((check) => check.name).join(", ")}.`
    : null;
}

export function hasMergeConflict(review: ReviewRequestSummary): boolean {
  return (
    normalizeReviewState(review.mergeable) === "CONFLICTING" ||
    normalizeReviewState(review.mergeStateStatus) === "DIRTY" ||
    normalizeReviewState(review.mergeStateStatus) === "CANNOT_BE_MERGED"
  );
}
