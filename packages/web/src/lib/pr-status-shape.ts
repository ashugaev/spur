export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export const CI_STATUSES = ["success", "failure", "pending"] as const;
export const REVIEW_DECISIONS = ["approved", "changes_requested", "review_required"] as const;
export const REVIEW_REQUIREMENTS = ["required", "none", "unavailable"] as const;

export type PrState = (typeof PR_STATES)[number];
export type CiStatus = (typeof CI_STATUSES)[number] | null;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number] | null;
export type ReviewRequirement = (typeof REVIEW_REQUIREMENTS)[number];
type ReviewDecisionValue = Exclude<ReviewDecision, null>;

export const PR_CHECK_STATES = ["failed", "pending", "passed"] as const;

export type PrCheckState = (typeof PR_CHECK_STATES)[number];

export interface PrReviewRequest {
  name: string;
  team: boolean;
}

export interface PrCheck {
  name: string;
  state: PrCheckState;
}

export interface PrReviewers {
  approved: string[];
  changesRequested: string[];
  pending?: PrReviewRequest[];
}

export interface PrInfo {
  state: PrState | null;
  reviewDecision: ReviewDecision;
  ciStatus: CiStatus;
  canMerge: boolean;
  mergeConflict: boolean;
  totalThreads: number;
  unresolvedThreads: number;
  reviewers?: PrReviewers | null;
  checks?: PrCheck[] | null;
  reviewRequirement?: ReviewRequirement;
  fetchedAt?: number;
  stale?: boolean;
}

const PR_STATE_SET: ReadonlySet<unknown> = new Set(PR_STATES);
const CI_STATUS_SET: ReadonlySet<unknown> = new Set(CI_STATUSES);
const REVIEW_DECISION_SET: ReadonlySet<unknown> = new Set(REVIEW_DECISIONS);
const REVIEW_REQUIREMENT_SET: ReadonlySet<unknown> = new Set(REVIEW_REQUIREMENTS);
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

export function isReviewRequirement(value: unknown): value is ReviewRequirement {
  return REVIEW_REQUIREMENT_SET.has(value);
}

export function parseReviewDecision(value: unknown): ReviewDecision {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  return REVIEW_DECISION_ALIASES[value] ?? (isReviewDecision(value) ? value : null);
}

const PR_CHECK_STATE_SET: ReadonlySet<unknown> = new Set(PR_CHECK_STATES);

function isNamedEntry(value: unknown): value is Record<string, unknown> & { name: string } {
  if (typeof value !== "object" || value === null) return false;
  const name = (value as Record<string, unknown>)["name"];
  return typeof name === "string" && name.length > 0;
}

function isPrReviewRequest(value: unknown): value is PrReviewRequest {
  return isNamedEntry(value) && typeof value["team"] === "boolean";
}

export function isPrChecks(value: unknown): value is PrCheck[] {
  return (
    Array.isArray(value) &&
    value.every((check) => isNamedEntry(check) && PR_CHECK_STATE_SET.has(check["state"]))
  );
}

export function isPrReviewers(value: unknown): value is PrReviewers {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const pending = v["pending"];
  return (
    [v["approved"], v["changesRequested"]].every(
      (logins) =>
        Array.isArray(logins) &&
        logins.every((login) => typeof login === "string" && login.length > 0),
    ) &&
    (pending === undefined || (Array.isArray(pending) && pending.every(isPrReviewRequest)))
  );
}

export function isPrInfoShape(value: unknown): value is PrInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["state"] === null || isPrState(v["state"])) &&
    isReviewDecision(v["reviewDecision"]) &&
    isCiStatus(v["ciStatus"]) &&
    typeof v["canMerge"] === "boolean" &&
    typeof v["mergeConflict"] === "boolean" &&
    typeof v["totalThreads"] === "number" &&
    typeof v["unresolvedThreads"] === "number" &&
    (v["reviewers"] === undefined || v["reviewers"] === null || isPrReviewers(v["reviewers"])) &&
    (v["checks"] === undefined || v["checks"] === null || isPrChecks(v["checks"])) &&
    (v["reviewRequirement"] === undefined || isReviewRequirement(v["reviewRequirement"]))
  );
}

// `state === "open"` is deliberately not re-checked: route.ts already folds
// it into `canMerge` (canMerge is only ever true for an open PR). Likewise
// `mergeConflict` is not checked: it is mutually exclusive with `canMerge`
// (a conflicting/dirty PR can never be mergeable), so re-checking it here
// would be dead code.
export function isPrReady(info: PrInfo): boolean {
  return (
    info.canMerge && info.unresolvedThreads === 0 && info.reviewDecision !== "changes_requested"
  );
}

export function prStatusIndicator(
  info: PrInfo,
):
  | { kind: "review"; decision: "approved" | "changes_requested" }
  | { kind: "ci"; status: CiStatus } {
  if (
    info.ciStatus === "success" &&
    (info.reviewDecision === "approved" || info.reviewDecision === "changes_requested")
  )
    return { kind: "review", decision: info.reviewDecision };
  return { kind: "ci", status: info.ciStatus };
}

export function prInfosEqual(a: PrInfo, b: PrInfo): boolean {
  return (
    a.state === b.state &&
    a.reviewDecision === b.reviewDecision &&
    a.ciStatus === b.ciStatus &&
    a.canMerge === b.canMerge &&
    a.mergeConflict === b.mergeConflict &&
    a.totalThreads === b.totalThreads &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.fetchedAt === b.fetchedAt &&
    a.stale === b.stale &&
    (a.reviewRequirement ?? "unavailable") === (b.reviewRequirement ?? "unavailable") &&
    a.reviewers?.approved.join("\n") === b.reviewers?.approved.join("\n") &&
    a.reviewers?.changesRequested.join("\n") === b.reviewers?.changesRequested.join("\n") &&
    pendingKey(a) === pendingKey(b) &&
    checksKey(a) === checksKey(b)
  );
}

function pendingKey(info: PrInfo): string | undefined {
  if (!info.reviewers) return undefined;
  return (info.reviewers.pending ?? []).map((r) => `${r.team ? "t" : "u"}:${r.name}`).join("\n");
}

function checksKey(info: PrInfo): string | undefined {
  if (info.checks === null) return undefined;
  return (info.checks ?? []).map((c) => `${c.state}:${c.name}`).join("\n");
}
