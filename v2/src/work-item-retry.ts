import type { WorkItemEventData, WorkItemLifecycleRecord, WorkItemMember } from "./types.js";

export const WORK_ITEM_RETRY_INTERVAL_MS = 45 * 60_000;
// 24 failed attempts at one per interval is about 18 h.
export const WORK_ITEM_RETRY_MAX_ATTEMPTS = 24;
// Admission denials (memory guard, session cap) defer without spending an
// attempt; 96 deferrals is about 72 h.
export const WORK_ITEM_RETRY_MAX_DEFERRALS = 96;
export const WORK_ITEM_RETRY_EMIT_CAP = 2;

export type WorkItemRecordBase = WorkItemEventData & {
  autoComplete: boolean;
  createdAt: string;
  lastRetryEmitAt?: string;
};

export function isWorkItemMemberExhausted(member: WorkItemMember): boolean {
  return (
    member.attempts >= WORK_ITEM_RETRY_MAX_ATTEMPTS ||
    member.deferrals >= WORK_ITEM_RETRY_MAX_DEFERRALS
  );
}

// A claim older than the interval is stale: the controller that wrote it
// crashed or was abandoned by a reload before recording an outcome.
export function isWorkItemClaimStale(member: WorkItemMember, nowMs: number): boolean {
  return nowMs - Date.parse(member.claimedAt) >= WORK_ITEM_RETRY_INTERVAL_MS;
}

export function isWorkItemMemberDue(member: WorkItemMember, nowMs: number): boolean {
  if (isWorkItemMemberExhausted(member)) return false;
  if (member.state === "spawning") return isWorkItemClaimStale(member, nowMs);
  if (member.state === "failed") {
    return member.nextRetryAt === undefined || nowMs >= Date.parse(member.nextRetryAt);
  }
  return false;
}

export function isWorkItemRecordDue(
  record: Pick<WorkItemLifecycleRecord, "members">,
  nowMs: number,
): boolean {
  return record.members.some((member) => isWorkItemMemberDue(member, nowMs));
}

// Due and not re-emitted in the last interval, so a record no trigger claims
// cannot hold the per-poll emit slots.
export function isWorkItemRecordEmitDue(
  record: Pick<WorkItemLifecycleRecord, "members" | "lastRetryEmitAt">,
  nowMs: number,
): boolean {
  if (!isWorkItemRecordDue(record, nowMs)) return false;
  return (
    record.lastRetryEmitAt === undefined ||
    nowMs - Date.parse(record.lastRetryEmitAt) >= WORK_ITEM_RETRY_INTERVAL_MS
  );
}

function earliestDueAt(record: Pick<WorkItemLifecycleRecord, "members">): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const member of record.members) {
    const at = Date.parse(member.nextRetryAt ?? member.claimedAt);
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return earliest;
}

// Least recently re-emitted first (never emitted first), then oldest due.
export function compareWorkItemRetryOrder(
  left: Pick<WorkItemLifecycleRecord, "members" | "lastRetryEmitAt">,
  right: Pick<WorkItemLifecycleRecord, "members" | "lastRetryEmitAt">,
): number {
  const leftEmitted = left.lastRetryEmitAt === undefined ? -1 : Date.parse(left.lastRetryEmitAt);
  const rightEmitted = right.lastRetryEmitAt === undefined ? -1 : Date.parse(right.lastRetryEmitAt);
  if (leftEmitted !== rightEmitted) return leftEmitted - rightEmitted;
  return earliestDueAt(left) - earliestDueAt(right);
}

function compareMembers(left: WorkItemMember, right: WorkItemMember): number {
  return left.blockIndex - right.blockIndex;
}

// Record-level state is derived, never written independently. The record
// sessionId is the desk anchor: the lowest-blockIndex running member.
export function buildWorkItemRecord(
  base: WorkItemRecordBase,
  members: WorkItemMember[],
  nowIso: string,
): WorkItemLifecycleRecord {
  const sorted = [...members].sort(compareMembers);
  // Named fields only: a caller may pass a whole previous record as `base`.
  const full = {
    externalId: base.externalId,
    url: base.url,
    number: base.number,
    title: base.title,
    repo: base.repo,
    autoComplete: base.autoComplete,
    createdAt: base.createdAt,
    ...(base.lastRetryEmitAt !== undefined ? { lastRetryEmitAt: base.lastRetryEmitAt } : {}),
    members: sorted,
  };
  const running = sorted.find((member) => member.state === "running" && member.sessionId);
  if (running?.sessionId !== undefined) {
    return { ...full, state: "running", sessionId: running.sessionId };
  }
  if (sorted.some((member) => member.state === "spawning")) {
    return { ...full, state: "pending" };
  }
  const completed = sorted.find((member) => member.state === "completed" && member.sessionId);
  if (
    completed?.sessionId !== undefined &&
    sorted.every((member) => member.state === "completed")
  ) {
    return { ...full, state: "completed", sessionId: completed.sessionId, completedAt: nowIso };
  }
  const failed = sorted.find((member) => member.state === "failed");
  return { ...full, state: "failed", error: failed?.error ?? "spawn failed" };
}
