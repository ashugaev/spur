export const PR_STATES = ["draft", "open", "merged", "closed"] as const;
export const CI_STATUSES = ["success", "failure", "pending"] as const;

export type PrState = (typeof PR_STATES)[number];
export type CiStatus = (typeof CI_STATUSES)[number] | null;

export interface PrInfo {
  state: PrState | null;
  ciStatus: CiStatus;
  totalThreads: number;
  unresolvedThreads: number;
  fetchedAt?: number;
  stale?: boolean;
}

const PR_STATE_SET: ReadonlySet<unknown> = new Set(PR_STATES);
const CI_STATUS_SET: ReadonlySet<unknown> = new Set(CI_STATUSES);

export function isPrState(value: unknown): value is PrState {
  return PR_STATE_SET.has(value);
}

export function isCiStatus(value: unknown): value is CiStatus {
  return value === null || CI_STATUS_SET.has(value);
}

export function isPrInfoShape(value: unknown): value is PrInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["state"] === null || isPrState(v["state"])) &&
    isCiStatus(v["ciStatus"]) &&
    typeof v["totalThreads"] === "number" &&
    typeof v["unresolvedThreads"] === "number"
  );
}

export function prInfosEqual(a: PrInfo, b: PrInfo): boolean {
  return (
    a.state === b.state &&
    a.ciStatus === b.ciStatus &&
    a.totalThreads === b.totalThreads &&
    a.unresolvedThreads === b.unresolvedThreads &&
    a.fetchedAt === b.fetchedAt &&
    a.stale === b.stale
  );
}
