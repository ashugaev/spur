export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export const CI_STATUSES = ["success", "failure", "pending"] as const;
export const REVIEW_DECISIONS = ["approved", "changes_requested", "review_required"] as const;

export type PrState = (typeof PR_STATES)[number];
export type CiStatus = (typeof CI_STATUSES)[number] | null;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number] | null;
type ReviewDecisionValue = Exclude<ReviewDecision, null>;

export interface PrInfo {
  state: PrState | null;
  reviewDecision: ReviewDecision;
  ciStatus: CiStatus;
  totalThreads: number;
  unresolvedThreads: number;
  fetchedAt?: number;
  stale?: boolean;
}

const PR_STATE_SET: ReadonlySet<unknown> = new Set(PR_STATES);
const CI_STATUS_SET: ReadonlySet<unknown> = new Set(CI_STATUSES);
const REVIEW_DECISION_SET: ReadonlySet<unknown> = new Set(REVIEW_DECISIONS);
const REVIEW_DECISION_ALIASES: Record<string, ReviewDecisionValue> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

export function isPrState(value: unknown): value is PrState {
  return PR_STATE_SET.has(value);
}

export function isCiStatus(value: unknown): value is CiStatus {
  return value === null || CI_STATUS_SET.has(value);
}

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === null || REVIEW_DECISION_SET.has(value);
}

export function parseReviewDecision(value: unknown): ReviewDecision {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return REVIEW_DECISION_ALIASES[value] ?? (isReviewDecision(value) ? value : null);
}

export function isPrInfoShape(value: unknown): value is PrInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["state"] === null || isPrState(v["state"])) &&
    isReviewDecision(v["reviewDecision"]) &&
    isCiStatus(v["ciStatus"]) &&
    typeof v["totalThreads"] === "number" &&
    typeof v["unresolvedThreads"] === "number"
  );
}

export function prInfosEqual(a: PrInfo, b: PrInfo): boolean {
  return (
    a.state === b.state &&
    a.reviewDecision === b.reviewDecision &&
    a.ciStatus === b.ciStatus &&
    a.totalThreads === b.totalThreads &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.fetchedAt === b.fetchedAt &&
    a.stale === b.stale
  );
}
