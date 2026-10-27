import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { autoPingRouteFingerprint, type AutoPingService } from "./auto-ping.js";
import { writeStderr } from "./io.js";
import { renderSpawnPrompt } from "./prompt-template.js";
import { logSpurEvent, logUserInputEvent, type SpurLogEntry } from "./event-log.js";
import {
  createSendBatchParser,
  restoreSendBatch,
  type SendBatch,
  type SendBatchItem,
} from "./send-batches.js";
import {
  deletePendingSendBatch,
  readPendingSpawnWork,
  writePendingSpawnWork,
  deletePendingSpawnWork,
  deletePendingSendBatchConditional,
  readPendingSendBatch,
  deleteWorkItemLifecycle,
  readPendingSendBatches,
  readWorkItemLifecycles,
  recordPendingSendBatch,
  updatePendingSendBatchConditional,
  updateWorkItemMembers,
  listSessions,
  readSession,
  writeSession,
} from "./metadata.js";
import {
  isStaleParked,
  WORK_ITEM_NEW_EVENT_NAMES,
  SCRIPT_ITEM_NEW_EVENT,
  DELIVERY_MAX_ATTEMPTS,
  CI_FAILED_MAX_ATTEMPTS,
  type AppConfig,
  type AutoPingDestination,
  type AutoPingRouteDescriptor,
  type SendTriggerConfig,
  type SendBatchRetryEntry,
  type SessionView,
  type SessionRecord,
  type SpawnSessionRequest,
  type TriggerSpawnBlockConfig,
  type SpawnTriggerConfig,
  type WorkItemEventData,
  type WorkItemLifecycleRecord,
  type WorkItemMember,
  type PersistedSpawnWork,
} from "./types.js";
import {
  isWorkItemClaimStale,
  isWorkItemMemberDue,
  WORK_ITEM_RETRY_INTERVAL_MS,
  type WorkItemRecordBase,
} from "./work-item-retry.js";
import type { EventBus } from "./event-bus.js";
import { SessionLifecycleError } from "./session-lifecycle.js";
import {
  getIdleWaitBeforeFlushMs,
  isIdleEnoughToReceive,
  LaunchPromptPendingError,
  SessionAdmissionDeniedError,
  SessionRateLimitedError,
  type SessionService,
} from "./session-service.js";

interface TriggerLogger {
  info?: (message: string) => void;
  warn: (message: string) => void;
}

export interface TriggerGroupController {
  stop(): Promise<void>;
}

interface StartConfiguredTriggersDeps {
  config: AppConfig;
  bus: EventBus;
  sessionService: SessionService;
  autoPing: AutoPingService;
  logger?: TriggerLogger;
  // Read-only predicate for the host-wide memory-guard hold (see
  // session-service.ts's updateMemoryHold). Optional with a default of
  // "never held", the same shape as `logger` above: reached through its own
  // dep field, never `deps.sessionService.memoryHoldEngaged()`, because
  // dozens of fixtures build `sessionService` as `as never` and would pass
  // typecheck while throwing "is not a function" at runtime.
  memoryHoldEngaged?: () => boolean;
}

interface PendingBatch {
  projectId: string;
  triggerId: string;
  sourceId: string;
  eventName: string;
  customPrompt: string | undefined;
  customPromptRecorded: boolean;
  batch: SendBatch;
  notBeforeAt: number;
  routeFingerprint: string;
  destination: AutoPingDestination;
  workId: string;
  revision: number;
  routeLeaseId: string;
  retryAccounting: SendBatchRetryEntry[];
  admissionCapRetryAt?: number | undefined;
  admissionCapDenials?: number | undefined;
}

// Rate-limit suppression is deliberately excluded from the failure/backoff
// path: the target session is still alive and will accept the batch once the
// rate limit clears, so it must not count toward DELIVERY_MAX_ATTEMPTS or
// trigger a drop. A memory-guard denial is the same shape: the host-wide
// hold (memoryHoldEngaged) already stops flushPending/handleSendEvent before
// they reach deliverBatch, but a delivery already in flight when the hold
// engages can still surface the denial here — treated identically to a
// rate limit, never counted as a failed attempt.
type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "suppressed" }
  | { status: "failed"; error: string };

const DEFAULT_TRIGGER_LOGGER: TriggerLogger = {
  warn: writeStderr,
};
const CI_FAILED_RETRY_INTERVAL_MS = 10 * 60_000;
// Bounds for a delivery that keeps throwing (e.g. the target session never
// acknowledges). Without these, the flush loop would retry every 5s forever.
// Start short so a session that was only briefly busy stays responsive, then
// double the backoff on each failure (10s, 20s, 40s, ... 640s) and give up
// after 8 attempts, dropping and logging the batch. Backoff alone sums to
// 1270s; each attempt can also block up to the submit-ack window
// (agents/index.ts DEFAULT_SUBMIT_ACK_WINDOW_MS x (1 + resends)) and, on a
// busy pane, queue behind another send's withPaneWriteLock (session-service.ts),
// so worst case elapsed time is unbounded, not just the backoff sum.
const DELIVERY_RETRY_BASE_MS = 10_000;
// A person is waiting on an interactive batch (Telegram): it waits for the
// agent to be idle this long, not the 30s review window. Two seconds still
// merges a message split into several by the client.
const INTERACTIVE_SEND_WINDOW_MS = 2_000;
// The one-shot flush timer fires just past the gate so the tick is not needed.
const INTERACTIVE_FLUSH_MARGIN_MS = 50;
const WORK_ITEM_AUTO_COMPLETE_MIN_AGE_MS = 5 * 60_000;
const WORK_ITEM_AUTO_COMPLETE_CHECK_INTERVAL_MS = 30_000;
const ACTIVE_WORK_ITEM_STATES = new Set<SessionView["state"]>([
  "working",
  "waiting",
  "needs_input",
]);

// A running session whose live state is "error" is wedged on a transient
// last-turn failure — a Claude server error (session-service.ts's
// reactivation nudge self-clears it once it recovers) or a Cursor
// terminalError record — not actually closed or dead — the same
// "still alive, just blocked" shape as rate_limited. Scoped to
// status === "running" because a genuinely closed session (status stopped,
// errored, or killed) can also carry state "error", and that case IS closed.
function isLiveServerErrorWedge(session: Pick<SessionView, "state" | "status">): boolean {
  return session.status === "running" && session.state === "error";
}

function isWorkItemEventData(data: unknown): data is WorkItemEventData {
  if (!data || typeof data !== "object") return false;
  const record = data as Partial<Record<keyof WorkItemEventData, unknown>>;
  return (
    typeof record.externalId === "string" &&
    typeof record.url === "string" &&
    typeof record.number === "number" &&
    typeof record.title === "string" &&
    typeof record.repo === "string"
  );
}

function isSendTriggerAllowed(session: SessionView, triggerId: string): boolean {
  if (session.allowedTriggers === undefined) {
    return true;
  }
  return session.allowedTriggers.includes(triggerId);
}

function isSessionNotFoundError(message: string): boolean {
  return message.startsWith("Session not found:");
}

// A stale-parked session (status "stopped", stopReason "stale_timeout") is
// still the owner of its work item — it merely went idle and any incoming
// event wakes it silently (session-service.ts parkStaleSession/finishStaleWake).
// Treating it as replaceable here would spawn a second session for the same
// work item on top of the one that is about to be woken.
function sessionAllowsWorkItemReplacement(session: SessionView): boolean {
  if (isStaleParked(session)) {
    return false;
  }
  return (
    session.status === "stopped" ||
    session.status === "errored" ||
    session.status === "killed" ||
    session.state === "stopped" ||
    session.state === "error" ||
    session.state === "killed"
  );
}

type WorkItemSuppressReason =
  | "work_item_pending"
  | "work_item_completed"
  | "work_item_retry_not_due"
  | "not_claimed_by_trigger"
  | "owner_completed"
  | "owner_active"
  | "owner_load_failed";

interface WorkItemSuppressed {
  reason: WorkItemSuppressReason;
  ownerSessionId?: string;
  error?: string;
}

type WorkItemOwnerClass = "completed" | "adopt" | "pending" | "replace";

function isAcceptedWorkItemRecord(record: SessionRecord | null | undefined): boolean {
  return (
    record?.spawnReceipt !== undefined ||
    (record?.triggerBirthKey !== undefined && record.triggerOrigin !== undefined)
  );
}

// The one predicate for every path that finds a session standing for a work
// item: the running-owner check, the pre-retry and post-throw tag scans, and
// the legacy url match. A spawning record can carry a stopped or error state,
// which sessionAllowsWorkItemReplacement alone would call replaceable.
export function classifyWorkItemOwner(
  session: SessionView,
  record?: SessionRecord | null,
  knownRunning = false,
): WorkItemOwnerClass {
  if (record?.spawnIntent) return "pending";
  if (
    isAcceptedWorkItemRecord(record) &&
    record &&
    record.triggerOrigin &&
    (session.status === "spawning" ||
      (session.status === "running" &&
        (!record.agentSessionId ||
          !record.agentLaunchId ||
          (!record.spawnReceipt && !knownRunning))))
  )
    return "pending";
  if (session.status === "completed") return "completed";
  if (session.status === "spawning") return "adopt";
  if (
    session.status === "running" &&
    (ACTIVE_WORK_ITEM_STATES.has(session.state) || isLiveServerErrorWedge(session))
  ) {
    return "adopt";
  }
  return sessionAllowsWorkItemReplacement(session) ? "replace" : "adopt";
}

interface WorkItemClaimContext {
  dataDir: string;
  projectId: string;
  sourceId: string;
  triggerId: string;
  workItem: WorkItemEventData;
  autoComplete: boolean;
  // Every spawn trigger configured for this source; a member whose trigger is
  // not among them belongs to a renamed or removed trigger.
  sourceSpawnTriggerIds: ReadonlySet<string>;
  fencedBlocks: ReadonlySet<number>;
}

interface PlannedSpawnBlock {
  block: TriggerSpawnBlockConfig;
  blockIndex: number;
  // Exact pre-claim members this block's claim replaced, restored on release.
  previous: WorkItemMember[];
  attemptsBefore: number;
  deferralsBefore: number;
  replacesSessionId?: string;
  claimedAt?: string;
}

interface WorkItemClaim {
  planned: PlannedSpawnBlock[];
  claimedAt: string;
  suppressed?: WorkItemSuppressed;
}

function workItemRecordBase(ctx: WorkItemClaimContext): WorkItemRecordBase {
  return { ...ctx.workItem, autoComplete: ctx.autoComplete, createdAt: new Date().toISOString() };
}

function isOwnMember(ctx: WorkItemClaimContext, member: WorkItemMember, blockIndex: number) {
  return member.triggerId === ctx.triggerId && member.blockIndex === blockIndex;
}

// Applies `patch` to this trigger's member for one block in one synchronous
// read-modify-write and returns the resulting member.
function patchWorkItemMember(
  ctx: WorkItemClaimContext,
  blockIndex: number,
  patch: (member: WorkItemMember) => WorkItemMember,
  claimedAt?: string,
): WorkItemMember | undefined {
  let result: WorkItemMember | undefined;
  updateWorkItemMembers(
    ctx.dataDir,
    ctx.projectId,
    ctx.sourceId,
    workItemRecordBase(ctx),
    (members) =>
      members.map((member) => {
        if (!isOwnMember(ctx, member, blockIndex)) return member;
        if (claimedAt !== undefined && member.claimedAt !== claimedAt) return member;
        result = patch(member);
        return result;
      }),
  );
  return result;
}

function settledMember(
  member: WorkItemMember,
  state: "running" | "completed",
  sessionId: string,
): WorkItemMember {
  const {
    nextRetryAt: _nextRetryAt,
    error: _error,
    replacesSessionId: _replaces,
    previousTriggerIds: _previousTriggerIds,
    ...rest
  } = member;
  return { ...rest, state, sessionId, startedAt: new Date().toISOString() };
}

function bindWorkItemSession(
  member: WorkItemMember,
  session: FoundWorkItemSession,
  attempts = member.attempts,
): WorkItemMember {
  const boundAttempts =
    session.outcome === "pending" || session.accepted ? attempts : member.attempts;
  if (session.outcome === "pending") {
    return { ...member, state: "spawning", sessionId: session.sessionId, attempts: boundAttempts };
  }
  return settledMember(
    { ...member, attempts: boundAttempts },
    session.outcome === "completed" ? "completed" : "running",
    session.sessionId,
  );
}

// Reads the record, decides which blocks to spawn, and writes every planned
// block as spawning in one call. No await between the read and the write: a
// second controller or an overlapping event sees the claim, never the gap.
function claimWorkItemBlocks(
  ctx: WorkItemClaimContext,
  blocks: TriggerSpawnBlockConfig[],
): WorkItemClaim {
  const nowMs = Date.now();
  const claimedAt = new Date(nowMs).toISOString();
  const record = readWorkItemLifecycles(ctx.dataDir, ctx.projectId, ctx.sourceId).get(
    ctx.workItem.externalId,
  );
  const members = record?.members ?? [];
  const isOrphan = (member: WorkItemMember): boolean =>
    member.triggerId !== undefined &&
    member.triggerId !== ctx.triggerId &&
    !ctx.sourceSpawnTriggerIds.has(member.triggerId);
  const ownMembers = members.filter((member) => member.triggerId === ctx.triggerId);
  // Members of a renamed or removed trigger pass to the trigger that claims
  // next, like a pre-upgrade member.
  const adoptsOrphans = ownMembers.length === 0 && members.some(isOrphan);
  const own = adoptsOrphans ? members.filter(isOrphan) : ownMembers;
  // Preserve every unresolved namespace through takeovers and reclaims.
  const previousTriggerIdsOf = (previous: WorkItemMember[]): { previousTriggerIds?: string[] } => {
    const previousTriggerIds = [
      ...new Set(
        previous.flatMap((member) => [
          ...(member.previousTriggerIds ?? []),
          ...(adoptsOrphans && isOrphan(member) && member.triggerId !== undefined
            ? [member.triggerId]
            : []),
        ]),
      ),
    ].filter((id) => id !== ctx.triggerId);
    return previousTriggerIds.length > 0 ? { previousTriggerIds } : {};
  };
  const legacy = members.find((member) => member.triggerId === undefined);
  if (record && own.length === 0 && !legacy) {
    return { planned: [], claimedAt, suppressed: { reason: "not_claimed_by_trigger" } };
  }
  // A pre-upgrade member stands for every block of the first trigger to claim.
  const consumesLegacy = own.length === 0 && legacy !== undefined;
  const planned: PlannedSpawnBlock[] = [];
  const skips: WorkItemSuppressed[] = [];
  const isRetryable = (member: WorkItemMember | undefined): boolean =>
    member === undefined ||
    (member.state !== "running" &&
      member.state !== "completed" &&
      isWorkItemMemberDue(member, nowMs));
  // A retry spawns only the missing or due blocks; a block that reached
  // running is never re-claimed alongside them. While any member of the item is
  // failed or spawning, a trigger with nothing missing or due of its own leaves
  // its running members alone too: no cross-trigger replacement of an owner.
  const retryOnly =
    !consumesLegacy &&
    own.length > 0 &&
    (own.some((member) => member.endedReason !== undefined) ||
      members.some((member) => member.state === "spawning" || member.state === "failed") ||
      blocks.some((_, blockIndex) => isRetryable(own.find((m) => m.blockIndex === blockIndex))));
  for (const [blockIndex, block] of blocks.entries()) {
    if (ctx.fencedBlocks.has(blockIndex)) {
      skips.push({ reason: "work_item_pending" });
      continue;
    }
    const existing = consumesLegacy
      ? legacy
      : own.find((member) => member.blockIndex === blockIndex);
    if (existing === undefined) {
      planned.push({ block, blockIndex, previous: [], attemptsBefore: 0, deferralsBefore: 0 });
      continue;
    }
    if (existing.state === "completed") {
      skips.push({
        reason: "work_item_completed",
        ...(existing.sessionId !== undefined ? { ownerSessionId: existing.sessionId } : {}),
      });
      continue;
    }
    if (existing.state === "running" && retryOnly) {
      skips.push({ reason: "work_item_pending" });
      continue;
    }
    const replacesSessionId = existing.sessionId ?? existing.replacesSessionId;
    if (existing.state !== "running" && !isWorkItemMemberDue(existing, nowMs)) {
      skips.push({
        reason:
          existing.state === "spawning" && !isWorkItemClaimStale(existing, nowMs)
            ? "work_item_pending"
            : "work_item_retry_not_due",
      });
      continue;
    }
    planned.push({
      block,
      blockIndex,
      previous: [existing],
      attemptsBefore: existing.attempts,
      deferralsBefore: existing.deferrals,
      ...(replacesSessionId !== undefined ? { replacesSessionId } : {}),
    });
  }
  const plannedIndexes = new Set(planned.map((entry) => entry.blockIndex));
  if (planned.length === 0) {
    return { planned, claimedAt, ...(skips[0] ? { suppressed: skips[0] } : {}) };
  }
  for (const entry of planned) entry.claimedAt = claimedAt;
  updateWorkItemMembers(
    ctx.dataDir,
    ctx.projectId,
    ctx.sourceId,
    workItemRecordBase(ctx),
    (current) => [
      ...current
        .map((member) => {
          if (!adoptsOrphans || !isOrphan(member)) return member;
          const { previousTriggerIds: _previousTriggerIds, ...rest } = member;
          return {
            ...rest,
            triggerId: ctx.triggerId,
            ...(member.state === "spawning" || member.state === "failed"
              ? previousTriggerIdsOf([member])
              : {}),
          };
        })
        .filter(
          (member) =>
            !(consumesLegacy && member.triggerId === undefined) &&
            !(member.triggerId === ctx.triggerId && plannedIndexes.has(member.blockIndex)),
        ),
      ...planned.map(
        (entry): WorkItemMember => ({
          triggerId: ctx.triggerId,
          blockIndex: entry.blockIndex,
          state: "spawning",
          claimedAt,
          attempts: entry.attemptsBefore + 1,
          deferrals: entry.deferralsBefore,
          ...(entry.previous[0]?.sessionId !== undefined
            ? { sessionId: entry.previous[0].sessionId }
            : {}),
          ...(entry.replacesSessionId !== undefined
            ? { replacesSessionId: entry.replacesSessionId }
            : {}),
          ...previousTriggerIdsOf(entry.previous),
        }),
      ),
    ],
  );
  return { planned, claimedAt };
}

// Restores pre-claim state and budget without undoing a rename takeover.
function releaseWorkItemClaim(ctx: WorkItemClaimContext, entries: PlannedSpawnBlock[]): void {
  updateWorkItemMembers(
    ctx.dataDir,
    ctx.projectId,
    ctx.sourceId,
    workItemRecordBase(ctx),
    (current) => {
      const owned = entries.filter((entry) =>
        current.some(
          (member) =>
            isOwnMember(ctx, member, entry.blockIndex) && member.claimedAt === entry.claimedAt,
        ),
      );
      const indexes = new Set(owned.map((entry) => entry.blockIndex));
      const restored = new Set(owned.flatMap((entry) => entry.previous));
      return [
        ...current.filter(
          (member) => !(member.triggerId === ctx.triggerId && indexes.has(member.blockIndex)),
        ),
        ...[...restored].map((member) => {
          const { previousTriggerIds: _previousTriggerIds, ...settled } = member;
          const previousState = member.state === "running" ? settled : member;
          if (member.triggerId === undefined || member.triggerId === ctx.triggerId)
            return previousState;
          const claimed = current.find(
            (candidate) =>
              candidate.triggerId === ctx.triggerId && candidate.blockIndex === member.blockIndex,
          );
          return claimed === undefined
            ? previousState
            : {
                ...previousState,
                triggerId: ctx.triggerId,
                ...(member.state !== "running" && claimed.previousTriggerIds !== undefined
                  ? { previousTriggerIds: claimed.previousTriggerIds }
                  : {}),
              };
        }),
      ];
    },
  );
}

function logWorkItemSuppressed(
  ctx: WorkItemClaimContext,
  eventName: string,
  suppressed: WorkItemSuppressed,
  logger: TriggerLogger,
): void {
  logTriggerEvent(ctx.dataDir, "trigger.spawn.suppressed", {
    level: suppressed.reason === "owner_load_failed" ? "warn" : "info",
    ...(suppressed.ownerSessionId !== undefined ? { sessionId: suppressed.ownerSessionId } : {}),
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    triggerId: ctx.triggerId,
    message: `Suppressed work item ${ctx.workItem.externalId}: ${suppressed.reason}`,
    details: {
      eventName,
      externalId: ctx.workItem.externalId,
      reason: suppressed.reason,
      ...(suppressed.error !== undefined ? { error: suppressed.error } : {}),
    },
  });
  if (suppressed.reason === "owner_load_failed") {
    logger.warn(
      `[trigger:${ctx.projectId}/${ctx.triggerId}] suppressed work item ${ctx.workItem.externalId}: ${suppressed.error}`,
    );
  }
}

function logWorkItemAdopted(
  ctx: WorkItemClaimContext,
  eventName: string,
  blockIndex: number,
  sessionId: string,
  outcome: "adopt" | "completed" | "pending",
): void {
  logTriggerEvent(ctx.dataDir, "trigger.spawn.adopted", {
    level: "info",
    sessionId,
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    triggerId: ctx.triggerId,
    message: `Adopted ${sessionId} for work item ${ctx.workItem.externalId} block ${blockIndex}`,
    details: { eventName, externalId: ctx.workItem.externalId, blockIndex, outcome },
  });
}

// Checks the running owners a claim would replace. Completed owners settle
// their blocks, live owners get their blocks released, replaceable or missing
// owners stay planned. Returns the blocks still to spawn.
async function resolveClaimedOwners(
  ctx: WorkItemClaimContext,
  service: SessionService,
  eventName: string,
  planned: PlannedSpawnBlock[],
  logger: TriggerLogger,
): Promise<PlannedSpawnBlock[]> {
  const ownerIds = new Set<string>();
  for (const entry of planned) {
    if (entry.replacesSessionId !== undefined) ownerIds.add(entry.replacesSessionId);
  }
  const remaining = new Set(planned);
  for (const ownerId of ownerIds) {
    const entries = planned.filter((entry) => entry.replacesSessionId === ownerId);
    let suppressed: WorkItemSuppressed | undefined;
    try {
      const owner = await service.get(ownerId);
      const record = readSession(ctx.dataDir, ownerId);
      const outcome = classifyWorkItemOwner(
        owner,
        record,
        entries.some((entry) =>
          entry.previous.some(
            (member) => member.state === "running" && member.sessionId === ownerId,
          ),
        ),
      );
      if (outcome === "completed") {
        for (const entry of entries) {
          patchWorkItemMember(
            ctx,
            entry.blockIndex,
            (member) => settledMember(member, "completed", ownerId),
            entry.claimedAt,
          );
        }
        suppressed = { reason: "owner_completed", ownerSessionId: ownerId };
      } else if (outcome === "pending") {
        for (const entry of entries) {
          patchWorkItemMember(
            ctx,
            entry.blockIndex,
            (member) =>
              bindWorkItemSession(
                member,
                { sessionId: ownerId, outcome, accepted: isAcceptedWorkItemRecord(record) },
                entry.attemptsBefore,
              ),
            entry.claimedAt,
          );
        }
        suppressed = { reason: "work_item_pending", ownerSessionId: ownerId };
      } else if (outcome === "adopt") {
        const previousRunning = entries.filter((entry) =>
          entry.previous.some((member) => member.state === "running"),
        );
        releaseWorkItemClaim(ctx, previousRunning);
        for (const entry of entries.filter((entry) => !previousRunning.includes(entry))) {
          patchWorkItemMember(
            ctx,
            entry.blockIndex,
            (member) =>
              bindWorkItemSession(
                member,
                { sessionId: ownerId, outcome, accepted: isAcceptedWorkItemRecord(record) },
                entry.attemptsBefore,
              ),
            entry.claimedAt,
          );
        }
        suppressed = { reason: "owner_active", ownerSessionId: ownerId };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isSessionNotFoundError(message)) {
        releaseWorkItemClaim(ctx, entries);
        suppressed = { reason: "owner_load_failed", ownerSessionId: ownerId, error: message };
      }
    }
    if (suppressed) {
      for (const entry of entries) remaining.delete(entry);
      logWorkItemSuppressed(ctx, eventName, suppressed, logger);
    }
  }
  return planned.filter((entry) => remaining.has(entry));
}

// A session record that vanished is absent, not an error; any other load
// failure propagates so the caller can release its claim.
async function getWorkItemSessionIfPresent(
  service: SessionService,
  sessionId: string,
): Promise<SessionView | undefined> {
  try {
    return await service.get(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isSessionNotFoundError(message)) return undefined;
    throw error;
  }
}

interface FoundWorkItemSession {
  sessionId: string;
  outcome: "adopt" | "completed" | "pending";
  accepted?: boolean;
}

// A session tagged with this exact block of the item by one of `triggerIds`
// that still stands for it. With `discardErrored`, errored records of the block are discarded when none
// stands (the pre-spawn scan: they are about to be replaced).
async function findTaggedWorkItemSession(
  ctx: WorkItemClaimContext,
  service: SessionService,
  blockIndex: number,
  triggerIds: readonly string[],
  discardErrored = false,
): Promise<FoundWorkItemSession | undefined> {
  const tagged = listSessions(ctx.dataDir).filter(
    (session) =>
      session.project === ctx.projectId &&
      session.triggerOrigin !== undefined &&
      triggerIds.includes(session.triggerOrigin.triggerId) &&
      session.triggerOrigin.sourceId === ctx.sourceId &&
      session.triggerOrigin.externalId === ctx.workItem.externalId &&
      session.triggerOrigin.blockIndex === blockIndex,
  );
  const erroredIds: string[] = [];
  const candidates: FoundWorkItemSession[] = [];
  for (const session of tagged) {
    const view = await getWorkItemSessionIfPresent(service, session.id);
    if (!view) continue;
    const record = readSession(ctx.dataDir, session.id);
    const outcome = classifyWorkItemOwner(view, record);
    if (outcome !== "replace")
      candidates.push({
        sessionId: session.id,
        outcome,
        accepted: isAcceptedWorkItemRecord(record),
      });
    if (view.status === "errored") erroredIds.push(session.id);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous accepted sessions for work item ${ctx.workItem.externalId} block ${blockIndex}`,
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (discardErrored) {
    for (const sessionId of erroredIds) {
      try {
        await service.discardFailedSpawn(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logTriggerEvent(ctx.dataDir, "trigger.spawn.discard_failed", {
          level: "warn",
          sessionId,
          projectId: ctx.projectId,
          sourceId: ctx.sourceId,
          triggerId: ctx.triggerId,
          message: `Could not discard failed spawn ${sessionId}: ${message}`,
        });
      }
    }
  }
  return undefined;
}

// Pre-upgrade sessions carry no tag: match them by the item url and fill the
// blocks one to one, explicit-agent blocks first, so a legacy partial desk
// spawns only the blocks nobody holds.
async function fillLegacyWorkItemBlocks(
  ctx: WorkItemClaimContext,
  service: SessionService,
  planned: PlannedSpawnBlock[],
): Promise<Map<number, FoundWorkItemSession>> {
  const candidates: Array<FoundWorkItemSession & { agent: string; model: string | undefined }> = [];
  const matches = listSessions(ctx.dataDir)
    .filter(
      (session) =>
        session.project === ctx.projectId &&
        session.slots?.links.some((link) => link.url === ctx.workItem.url),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const match of matches) {
    const session = await getWorkItemSessionIfPresent(service, match.id);
    if (!session) continue;
    const outcome = classifyWorkItemOwner(session, readSession(ctx.dataDir, session.id));
    if (outcome !== "replace") {
      candidates.push({
        sessionId: session.id,
        outcome,
        agent: session.agent,
        model: session.model,
      });
    }
  }
  const filled = new Map<number, FoundWorkItemSession>();
  const used = new Set<string>();
  const take = (entry: PlannedSpawnBlock, accepts: (c: (typeof candidates)[number]) => boolean) => {
    const found = candidates.find(
      (candidate) => !used.has(candidate.sessionId) && accepts(candidate),
    );
    if (!found) return;
    used.add(found.sessionId);
    filled.set(entry.blockIndex, { sessionId: found.sessionId, outcome: found.outcome });
  };
  for (const entry of planned) {
    const { agent, model } = entry.block;
    if (agent === undefined) continue;
    take(
      entry,
      (candidate) =>
        candidate.agent === agent && (model === undefined || candidate.model === model),
    );
  }
  for (const entry of planned) {
    if (entry.block.agent === undefined) take(entry, () => true);
  }
  return filled;
}

// Looks for sessions a lost or failed earlier spawn left behind, records them
// on their members, and returns the blocks that still need a spawn.
async function adoptExistingWorkItemSessions(
  ctx: WorkItemClaimContext,
  service: SessionService,
  eventName: string,
  planned: PlannedSpawnBlock[],
): Promise<PlannedSpawnBlock[]> {
  const scanned = planned.filter((entry) =>
    entry.previous.some((member) => member.state !== "running"),
  );
  if (scanned.length === 0) return planned;
  const found = new Map<number, FoundWorkItemSession>();
  const legacyBlocks: PlannedSpawnBlock[] = [];
  for (const entry of scanned) {
    if (entry.previous.some((member) => member.triggerId === undefined)) {
      legacyBlocks.push(entry);
      continue;
    }
    // A takeover rewrote orphan members to this trigger; a session they
    // launched still carries the orphaned trigger id.
    const triggerIds = [
      ...new Set([
        ctx.triggerId,
        ...entry.previous
          .flatMap((member) => [member.triggerId, ...(member.previousTriggerIds ?? [])])
          .filter(
            (id): id is string =>
              id !== undefined && id !== ctx.triggerId && !ctx.sourceSpawnTriggerIds.has(id),
          ),
      ]),
    ];
    const tagged = await findTaggedWorkItemSession(
      ctx,
      service,
      entry.blockIndex,
      triggerIds,
      true,
    );
    if (tagged) found.set(entry.blockIndex, tagged);
  }
  if (legacyBlocks.length > 0) {
    for (const [blockIndex, session] of await fillLegacyWorkItemBlocks(
      ctx,
      service,
      legacyBlocks,
    )) {
      found.set(blockIndex, session);
    }
  }
  for (const [blockIndex, session] of found) {
    patchWorkItemMember(
      ctx,
      blockIndex,
      (member) =>
        bindWorkItemSession(
          member,
          session,
          planned.find((entry) => entry.blockIndex === blockIndex)?.attemptsBefore,
        ),
      planned.find((entry) => entry.blockIndex === blockIndex)?.claimedAt,
    );
    logWorkItemAdopted(ctx, eventName, blockIndex, session.sessionId, session.outcome);
  }
  return planned.filter((entry) => !found.has(entry.blockIndex));
}

// The desk anchor is this trigger's lowest-index running member.
function workItemAnchorSessionId(ctx: WorkItemClaimContext): string | undefined {
  const members =
    readWorkItemLifecycles(ctx.dataDir, ctx.projectId, ctx.sourceId).get(ctx.workItem.externalId)
      ?.members ?? [];
  return members
    .filter((member) => member.triggerId === ctx.triggerId && member.state === "running")
    .sort((left, right) => left.blockIndex - right.blockIndex)[0]?.sessionId;
}

// A desk retry joins the live anchor. When the anchor completed or its
// session is no longer live, the retried members end as exhausted (never due
// again) and nothing spawns: only a failed or never-spawned anchor is retried.
async function endDeskRetryWithoutLiveAnchor(
  ctx: WorkItemClaimContext,
  service: SessionService,
  planned: PlannedSpawnBlock[],
): Promise<PlannedSpawnBlock[]> {
  const retrying = planned.filter((entry) =>
    entry.previous.some((member) => member.state !== "running"),
  );
  if (retrying.length === 0) return planned;
  const plannedIndexes = new Set(planned.map((entry) => entry.blockIndex));
  const anchor = (
    readWorkItemLifecycles(ctx.dataDir, ctx.projectId, ctx.sourceId).get(ctx.workItem.externalId)
      ?.members ?? []
  )
    .filter(
      (member) =>
        member.triggerId === ctx.triggerId &&
        !plannedIndexes.has(member.blockIndex) &&
        (member.state === "running" || member.state === "completed"),
    )
    .sort((left, right) => left.blockIndex - right.blockIndex)[0];
  if (anchor?.sessionId === undefined) return planned;
  if (anchor.state === "running") {
    const session = await getWorkItemSessionIfPresent(service, anchor.sessionId);
    if (session) {
      const outcome = classifyWorkItemOwner(session, readSession(ctx.dataDir, session.id), true);
      if (outcome === "adopt") return planned;
      if (outcome === "pending") {
        patchWorkItemMember(
          ctx,
          anchor.blockIndex,
          (member) =>
            member.state === "running" && member.sessionId === session.id
              ? bindWorkItemSession(member, { sessionId: session.id, outcome })
              : member,
          anchor.claimedAt,
        );
        releaseWorkItemClaim(ctx, planned);
        return [];
      }
    }
  }
  for (const entry of retrying) {
    patchWorkItemMember(ctx, entry.blockIndex, (member) => {
      const { nextRetryAt: _nextRetryAt, replacesSessionId: _replaces, ...rest } = member;
      return {
        ...rest,
        state: "failed",
        attempts: entry.attemptsBefore,
        endedReason: "anchor_not_live",
        error: "desk anchor is not live",
      };
    });
    logTriggerEvent(ctx.dataDir, "trigger.spawn.retry_ended", {
      level: "info",
      sessionId: anchor.sessionId,
      projectId: ctx.projectId,
      sourceId: ctx.sourceId,
      triggerId: ctx.triggerId,
      message: `trigger.spawn.retry_ended for work item ${ctx.workItem.externalId} block ${entry.blockIndex}`,
      details: {
        externalId: ctx.workItem.externalId,
        blockIndex: entry.blockIndex,
        cause: "anchor_not_live",
      },
    });
  }
  return planned.filter((entry) => !retrying.includes(entry));
}

// Records a failed block and logs how it will be retried. An admission denial
// is a deferral: the attempt counted at claim is refunded.
function recordWorkItemSpawnFailure(
  ctx: WorkItemClaimContext,
  entry: PlannedSpawnBlock,
  error: unknown,
  message: string,
): void {
  const denied = error instanceof SessionAdmissionDeniedError;
  const nextRetryAt = new Date(Date.now() + WORK_ITEM_RETRY_INTERVAL_MS).toISOString();
  const member = patchWorkItemMember(
    ctx,
    entry.blockIndex,
    (current) => {
      const { replacesSessionId: _replaces, ...rest } = current;
      return {
        ...rest,
        state: "failed",
        attempts: denied ? entry.attemptsBefore : current.attempts,
        deferrals: denied ? entry.deferralsBefore + 1 : current.deferrals,
        nextRetryAt,
        error: message,
      };
    },
    entry.claimedAt,
  );
  if (!member) return;
  const event = denied ? "trigger.spawn.retry_deferred" : "trigger.spawn.retry_scheduled";
  logTriggerEvent(ctx.dataDir, event, {
    level: "info",
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    triggerId: ctx.triggerId,
    message: `${event} for work item ${ctx.workItem.externalId} block ${entry.blockIndex}`,
    details: {
      externalId: ctx.workItem.externalId,
      blockIndex: entry.blockIndex,
      attempts: member.attempts,
      deferrals: member.deferrals,
      nextRetryAt,
      ...(denied ? { reason: error.reason } : {}),
    },
  });
}

async function reconcileLegacyWorkItemJournal(
  config: AppConfig,
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  trigger: SpawnTriggerConfig,
  item: WorkItemEventData,
  controllerCurrent: () => boolean,
): Promise<ReadonlySet<number> | null> {
  if (!controllerCurrent()) return null;
  const original = readWorkItemLifecycles(config.dataDir, projectId, sourceId).get(item.externalId);
  if (!original?.spawnWorkId) return new Set();
  const all = new Set(trigger.spawn.blocks.map((_, index) => index));
  const snapshot = structuredClone(original);
  const existingWork = readPendingSpawnWork(config.dataDir).get(original.spawnWorkId);
  if (!existingWork) {
    if (
      !trigger.spawn.blocks.every((_, index) =>
        snapshot.members.some(
          (member) => member.triggerId === triggerId && member.blockIndex === index,
        ),
      )
    )
      return all;
    updateWorkItemMembers(
      config.dataDir,
      projectId,
      sourceId,
      { ...snapshot, spawnWorkId: null },
      (members) => members,
    );
    return new Set();
  }
  const time = Date.parse(snapshot.createdAt);
  if (
    !Number.isFinite(time) ||
    existingWork.projectId !== projectId ||
    existingWork.sourceId !== sourceId ||
    existingWork.triggerId !== triggerId ||
    existingWork.eventName !== trigger.event ||
    existingWork.workId !==
      JSON.stringify([projectId, sourceId, triggerId, existingWork.occurrenceId]) ||
    existingWork.routeFingerprint !==
      spawnRouteFingerprint(config, projectId, triggerId, trigger) ||
    existingWork.blocks.length !== trigger.spawn.blocks.length ||
    !isWorkItemEventData(existingWork.eventData) ||
    existingWork.eventData.externalId !== item.externalId
  )
    return all;
  const work = { ...existingWork, revision: existingWork.revision + 1 };
  if (!writePendingSpawnWork(config.dataDir, work, existingWork.revision)) return null;
  const owns = (): boolean =>
    controllerCurrent() &&
    readPendingSpawnWork(config.dataDir).get(work.workId)?.revision === work.revision &&
    isDeepStrictEqual(
      readWorkItemLifecycles(config.dataDir, projectId, sourceId).get(item.externalId),
      snapshot,
    );
  const desired: WorkItemMember[] = snapshot.members.filter(
    (member) => member.triggerId !== undefined,
  );
  const fenced = new Set<number>();
  const retryAt = new Date(time + WORK_ITEM_RETRY_INTERVAL_MS).toISOString();
  for (const [index, block] of work.blocks.entries()) {
    if (!owns()) return null;
    const previous = desired.find(
      (member) => member.triggerId === triggerId && member.blockIndex === index,
    );
    if (
      previous &&
      (previous.sessionId !== undefined ||
        previous.state === "running" ||
        previous.state === "completed" ||
        previous.claimedAt !== snapshot.createdAt ||
        previous.attempts !== 0 ||
        previous.deferrals !== 0 ||
        previous.startedAt !== undefined)
    )
      continue;
    const base: WorkItemMember = previous ?? {
      triggerId,
      blockIndex: index,
      state: "spawning",
      claimedAt: snapshot.createdAt,
      attempts: 0,
      deferrals: 0,
    };
    let next: WorkItemMember;
    if (block.state === "pending" && index > work.nextBlockIndex) {
      next = { ...base, state: "spawning" };
    } else {
      const spawnBlock = trigger.spawn.blocks[index];
      if (!spawnBlock) throw new Error("Legacy spawn route block is missing");
      const request = triggerSpawnRequest(
        projectId,
        spawnBlock,
        work.eventName,
        work.eventData,
        trigger.spawn.restrictWrites,
        trigger.spawn.allowedTriggers,
        trigger.spawnDeskGroup,
        work.anchorSessionId,
      );
      try {
        const birth = service.getTriggerBirth(projectId, block.birthKey, request);
        if (block.state === "succeeded" && birth?.id !== block.sessionId)
          throw new Error("Legacy accepted birth is unresolved");
        if (
          block.state === "failed" &&
          block.sessionId !== undefined &&
          birth?.id !== block.sessionId
        )
          throw new Error("Legacy failed birth is unresolved");
        if (birth) {
          const view = await service.get(birth.id);
          if (!owns()) return null;
          const current = service.getTriggerBirth(projectId, block.birthKey, request);
          if (!current || current.id !== birth.id) throw new Error("Legacy accepted birth changed");
          const origin = { triggerId, sourceId, externalId: item.externalId, blockIndex: index };
          if (current.triggerOrigin && !isDeepStrictEqual(current.triggerOrigin, origin))
            throw new Error("Legacy accepted origin is ambiguous");
          const tagged = current.triggerOrigin ? current : { ...current, triggerOrigin: origin };
          if (!current.triggerOrigin) writeSession(config.dataDir, tagged);
          const outcome = classifyWorkItemOwner(view, tagged);
          next =
            outcome === "replace"
              ? {
                  ...base,
                  state: "failed",
                  sessionId: birth.id,
                  nextRetryAt: retryAt,
                  error:
                    current.error ??
                    (block.state === "failed" ? block.error : "Accepted launch is no longer live"),
                }
              : {
                  ...base,
                  state:
                    outcome === "pending"
                      ? "spawning"
                      : outcome === "completed"
                        ? "completed"
                        : "running",
                  sessionId: birth.id,
                };
        } else if (block.state === "failed") {
          next = { ...base, state: "failed", error: block.error, nextRetryAt: retryAt };
        } else {
          next = { ...base, state: "spawning" };
        }
      } catch {
        if (!owns()) return null;
        fenced.add(index);
        next = { ...base, state: "spawning" };
      }
    }
    const position = desired.findIndex(
      (member) => member.triggerId === triggerId && member.blockIndex === index,
    );
    if (position < 0) desired.push(next);
    else desired[position] = next;
  }
  if (!owns()) return null;
  updateWorkItemMembers(
    config.dataDir,
    projectId,
    sourceId,
    { ...snapshot, spawnWorkId: work.workId },
    () => desired,
  );
  if (fenced.size === 0 && deletePendingSpawnWork(config.dataDir, work.workId, work.revision)) {
    const transferred = readWorkItemLifecycles(config.dataDir, projectId, sourceId).get(
      item.externalId,
    );
    if (transferred?.spawnWorkId === work.workId)
      updateWorkItemMembers(
        config.dataDir,
        projectId,
        sourceId,
        { ...transferred, spawnWorkId: null },
        (members) => members,
      );
  }
  return fenced;
}

function triggerSpawnRequest(
  projectId: string,
  block: TriggerSpawnBlockConfig,
  eventName: string,
  eventData: unknown,
  restrictWrites: boolean | undefined,
  allowedTriggers: string[] | undefined,
  deskGroup: boolean | undefined,
  anchorSessionId: string | undefined,
): SpawnSessionRequest {
  const item =
    WORK_ITEM_NEW_EVENT_NAMES.has(eventName) && isWorkItemEventData(eventData) ? eventData : null;
  const blockRestrictWrites = block.restrictWrites ?? restrictWrites;
  return {
    project: projectId,
    prompt: renderSpawnPrompt(block.prompt, eventData),
    ...(block.steps !== undefined ? { steps: block.steps } : {}),
    ...(block.agent !== undefined ? { agent: block.agent } : {}),
    ...(block.model !== undefined ? { model: block.model } : {}),
    ...(block.reasoningEffort !== undefined ? { reasoningEffort: block.reasoningEffort } : {}),
    ...(block.mode !== undefined ? { mode: block.mode } : {}),
    ...(block.branch !== undefined ? { branch: block.branch } : {}),
    ...(block.overrides !== undefined ? { overrides: block.overrides } : {}),
    ...(block.selfDestruct !== undefined ? { selfDestruct: block.selfDestruct } : {}),
    ...(blockRestrictWrites === true ? { restrictWrites: true } : {}),
    ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
    ...(item && (eventName !== SCRIPT_ITEM_NEW_EVENT || item.url !== "")
      ? { slots: { links: [{ label: "pr", url: item.url }] } }
      : {}),
    ...(deskGroup === true && anchorSessionId !== undefined
      ? { reuseWorkspaceSessionId: anchorSessionId }
      : {}),
  };
}

async function runSpawnTrigger(
  dataDir: string,
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  eventName: string,
  blocks: TriggerSpawnBlockConfig[],
  autoComplete: boolean | undefined,
  restrictWrites: boolean | undefined,
  allowedTriggers: string[] | undefined,
  deskGroup: boolean | undefined,
  eventData: unknown,
  sourceSpawnTriggerIds: ReadonlySet<string>,
  logger: TriggerLogger,
  queue?: { work: PersistedSpawnWork; current(): boolean; save(): boolean },
  fencedBlocks: ReadonlySet<number> = new Set(),
): Promise<void> {
  const work = queue?.work;
  logTriggerEvent(dataDir, "trigger.spawn.matched", {
    level: "info",
    projectId,
    sourceId,
    triggerId,
    message: `Matched ${eventName} for ${projectId}/${triggerId}`,
    details: {
      eventName,
      agents: blocks.map((block) => block.agent ?? null),
      branch: blocks[0]?.branch ?? null,
      worktree: blocks[0]?.overrides?.worktree ?? null,
      defaultBranch: blocks[0]?.overrides?.defaultBranch ?? null,
    },
  });
  logger.info?.(
    `[trigger:${projectId}/${triggerId}] matched ${eventName} from ${projectId}/${sourceId}`,
  );

  const workItemData =
    WORK_ITEM_NEW_EVENT_NAMES.has(eventName) && isWorkItemEventData(eventData) ? eventData : null;
  const ctx: WorkItemClaimContext | null = workItemData
    ? {
        dataDir,
        projectId,
        sourceId,
        triggerId,
        workItem: workItemData,
        autoComplete: autoComplete === true,
        sourceSpawnTriggerIds,
        fencedBlocks,
      }
    : null;

  try {
    if (autoComplete && !workItemData) {
      throw new Error(`Cannot auto-complete ${eventName}: incompatible work-item payload`);
    }
    let planned: PlannedSpawnBlock[] = blocks.map((block, blockIndex) => ({
      block,
      blockIndex,
      previous: [],
      attemptsBefore: 0,
      deferralsBefore: 0,
    }));
    let claimedAt = "";
    if (ctx) {
      const claim = claimWorkItemBlocks(ctx, blocks);
      if (claim.planned.length === 0) {
        if (claim.suppressed) logWorkItemSuppressed(ctx, eventName, claim.suppressed, logger);
        return;
      }
      claimedAt = claim.claimedAt;
      planned = await resolveClaimedOwners(ctx, service, eventName, claim.planned, logger);
      try {
        planned = await adoptExistingWorkItemSessions(ctx, service, eventName, planned);
        if (deskGroup === true) {
          const members =
            readWorkItemLifecycles(ctx.dataDir, ctx.projectId, ctx.sourceId).get(
              ctx.workItem.externalId,
            )?.members ?? [];
          if (
            workItemAnchorSessionId(ctx) === undefined &&
            members.some(
              (member) =>
                member.triggerId === ctx.triggerId &&
                member.state === "spawning" &&
                member.sessionId !== undefined,
            )
          ) {
            releaseWorkItemClaim(ctx, planned);
            return;
          }
          planned = await endDeskRetryWithoutLiveAnchor(ctx, service, planned);
        }
      } catch (error) {
        // Nothing settled yet: free the claim now instead of leaving it
        // spawning until it goes stale.
        releaseWorkItemClaim(ctx, planned);
        throw error;
      }
    }

    if (work) planned = planned.filter((entry) => entry.blockIndex >= work.nextBlockIndex);
    let anchorSessionId = ctx ? workItemAnchorSessionId(ctx) : work?.anchorSessionId;
    for (const entry of planned) {
      const { block, blockIndex } = entry;
      if (queue && !queue.current()) return;
      if (queue && anchorSessionId !== undefined) {
        const anchor = await service.get(anchorSessionId);
        if (!queue.current()) return;
        if (anchor.status !== "running" || !anchor.workspaceExists)
          throw new Error(`Desk anchor unavailable: ${anchorSessionId}`);
      }
      const isAnchorBlock = deskGroup === true && anchorSessionId === undefined;
      if (isAnchorBlock && blockIndex > 0) {
        logger.warn(
          `[trigger:${projectId}/${triggerId}] promoting spawn block ${blockIndex} to desk anchor: no earlier block holds a running desk anchor`,
        );
      }
      try {
        const spawnRequest = triggerSpawnRequest(
          projectId,
          block,
          eventName,
          eventData,
          restrictWrites,
          allowedTriggers,
          deskGroup,
          anchorSessionId,
        );
        let spawning: Promise<SessionView>;
        if (ctx) {
          // Refresh this block's claim only while it is still this run's: an
          // earlier slow block must not make it look stale, and a member
          // another controller took is not spawned twice. No await between
          // the refresh and the spawn call.
          const refreshedAt = new Date().toISOString();
          const refreshed = patchWorkItemMember(
            ctx,
            blockIndex,
            (member) =>
              member.state === "spawning" && member.claimedAt === claimedAt
                ? { ...member, claimedAt: refreshedAt }
                : member,
            entry.claimedAt,
          );
          if (refreshed?.state !== "spawning" || refreshed.claimedAt !== refreshedAt) continue;
          entry.claimedAt = refreshedAt;
          spawning = service.spawn(spawnRequest, {
            acceptQueued: true,
            triggerOrigin: { triggerId, sourceId, externalId: ctx.workItem.externalId, blockIndex },
          });
        } else if (queue && work) {
          const birthKey = `${work.workId}:${blockIndex}`;
          spawning = service
            .spawn(spawnRequest, { triggerBirthKey: birthKey })
            .catch(async (error: unknown) => {
              const birth = service.getTriggerBirth(projectId, birthKey, spawnRequest);
              if (!birth) throw error;
              return service.get(birth.id);
            });
        } else {
          spawning = service.spawn(spawnRequest);
        }
        const session = await spawning;
        if (queue && !queue.current()) return;
        const outcome = ctx
          ? classifyWorkItemOwner(session, readSession(ctx.dataDir, session.id))
          : "adopt";
        if (ctx && outcome === "pending") {
          const bound = patchWorkItemMember(
            ctx,
            blockIndex,
            (member) => bindWorkItemSession(member, { sessionId: session.id, outcome }),
            entry.claimedAt,
          );
          if (!bound) {
            releaseWorkItemClaim(
              ctx,
              planned.filter((candidate) => candidate.blockIndex > blockIndex),
            );
            return;
          }
          logWorkItemAdopted(ctx, eventName, blockIndex, session.id, outcome);
          if (deskGroup === true && isAnchorBlock) {
            releaseWorkItemClaim(
              ctx,
              planned.filter((candidate) => candidate.blockIndex > blockIndex),
            );
            return;
          }
          continue;
        }
        if (ctx) {
          if (outcome === "replace") throw new Error(`Spawn ${session.id} did not launch`);
          const bound = patchWorkItemMember(
            ctx,
            blockIndex,
            (member) => bindWorkItemSession(member, { sessionId: session.id, outcome }),
            entry.claimedAt,
          );
          if (!bound) {
            releaseWorkItemClaim(
              ctx,
              planned.filter((candidate) => candidate.blockIndex > blockIndex),
            );
            return;
          }
        }
        if (work) {
          work.blocks[blockIndex] = {
            birthKey: `${work.workId}:${blockIndex}`,
            state: "succeeded",
            sessionId: session.id,
          };
          work.nextBlockIndex = blockIndex + 1;
          work.lastSessionId = session.id;
        }
        if (isAnchorBlock) {
          anchorSessionId = session.id;
          if (work) work.anchorSessionId = session.id;
        }
        if (queue && !queue.save()) return;
        logTriggerEvent(dataDir, "trigger.spawn.completed", {
          level: "info",
          sessionId: session.id,
          projectId,
          sourceId,
          triggerId,
          message: isAnchorBlock
            ? `Spawn trigger ${projectId}/${triggerId} created desk anchor ${session.id}`
            : `Spawn trigger ${projectId}/${triggerId} created ${session.id}`,
          details: {
            eventName,
            agent: block.agent ?? null,
            ...(isAnchorBlock ? { deskGroup: true } : {}),
          },
        });
        if (work && work.admissionDenials > 0) return;
      } catch (error) {
        if (queue && !queue.current()) return;
        if (queue && work && error instanceof SessionAdmissionDeniedError) {
          work.admissionDenials = Math.min(work.admissionDenials + 1, DELIVERY_MAX_ATTEMPTS - 1);
          work.notBeforeAt =
            Date.now() +
            DELIVERY_RETRY_BASE_MS *
              2 ** Math.min(work.admissionDenials - 1, DELIVERY_MAX_ATTEMPTS - 2);
          queue.save();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (ctx) {
          // The spawn can throw after the session exists (a launched agent
          // retained with its error): adopt it instead of scheduling a retry.
          const survivor =
            error instanceof SessionAdmissionDeniedError
              ? undefined
              : await findTaggedWorkItemSession(ctx, service, blockIndex, [ctx.triggerId]);
          if (survivor) {
            patchWorkItemMember(
              ctx,
              blockIndex,
              (member) => bindWorkItemSession(member, survivor),
              entry.claimedAt,
            );
            logWorkItemAdopted(ctx, eventName, blockIndex, survivor.sessionId, survivor.outcome);
            if (isAnchorBlock && survivor.outcome === "adopt") anchorSessionId = survivor.sessionId;
            if (isAnchorBlock && survivor.outcome === "pending") {
              releaseWorkItemClaim(
                ctx,
                planned.filter((candidate) => candidate.blockIndex > blockIndex),
              );
              return;
            }
          } else {
            recordWorkItemSpawnFailure(ctx, entry, error, message);
          }
        }
        if (queue && work) {
          work.blocks[blockIndex] = {
            birthKey: `${work.workId}:${blockIndex}`,
            state: "failed",
            error: message,
          };
          work.nextBlockIndex = blockIndex + 1;
          work.failures.push(message);
          if (!queue.save()) return;
        }
        logTriggerEvent(dataDir, "trigger.spawn.failed", {
          level: "error",
          projectId,
          sourceId,
          triggerId,
          message: `Spawn trigger ${projectId}/${triggerId} failed: ${message}`,
          details: {
            eventName,
            agent: block.agent ?? null,
          },
        });
        logger.warn(
          block.agent
            ? `[trigger:${projectId}/${triggerId}] failed to spawn ${block.agent}: ${message}`
            : `[trigger:${projectId}/${triggerId}] failed to spawn: ${message}`,
        );
      }
    }
  } catch (error) {
    if (queue && !queue.current()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (queue && work) {
      for (let index = work.nextBlockIndex; index < work.blocks.length; index += 1)
        work.blocks[index] = {
          birthKey: `${work.workId}:${index}`,
          state: "failed",
          error: message,
        };
      work.nextBlockIndex = work.blocks.length;
      work.failures.push(message);
      if (!queue.save()) return;
    }
    logTriggerEvent(dataDir, "trigger.spawn.failed", {
      level: "error",
      projectId,
      sourceId,
      triggerId,
      message: `Spawn trigger ${projectId}/${triggerId} failed: ${message}`,
      details: {
        eventName,
      },
    });
    logger.warn(`[trigger:${projectId}/${triggerId}] failed to spawn: ${message}`);
  }
}

// Completes the members that hold the record's owner session; sibling members
// keep their own state, so the record turns completed only when all are.
function markWorkItemOwnerCompleted(
  dataDir: string,
  projectId: string,
  sourceId: string,
  lifecycle: Extract<WorkItemLifecycleRecord, { state: "running" }>,
): void {
  updateWorkItemMembers(dataDir, projectId, sourceId, lifecycle, (members) =>
    members.map((member) =>
      member.state === "running" && member.sessionId === lifecycle.sessionId
        ? { ...member, state: "completed" }
        : member,
    ),
  );
}

async function runWorkItemAutoCompleteTrigger(
  dataDir: string,
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  logger: TriggerLogger,
): Promise<void> {
  const lifecycles = readWorkItemLifecycles(dataDir, projectId, sourceId);
  const now = Date.now();

  for (const lifecycle of lifecycles.values()) {
    if (lifecycle.state !== "running" || !lifecycle.autoComplete) {
      continue;
    }
    // Age counts from the owner's spawn result; legacy members have none.
    const owner = lifecycle.members.find(
      (member) => member.state === "running" && member.sessionId === lifecycle.sessionId,
    );
    const startedAt = Date.parse(owner?.startedAt ?? lifecycle.createdAt);
    if (!Number.isFinite(startedAt)) {
      deleteWorkItemLifecycle(dataDir, projectId, sourceId, lifecycle.externalId);
      logTriggerEvent(dataDir, "trigger.work_item_auto_complete.noop", {
        level: "info",
        sessionId: lifecycle.sessionId,
        projectId,
        sourceId,
        triggerId,
        message: `Cleared work item ${lifecycle.externalId}: invalid lifecycle timestamp`,
        details: {
          externalId: lifecycle.externalId,
        },
      });
      continue;
    }

    if (now - startedAt < WORK_ITEM_AUTO_COMPLETE_MIN_AGE_MS) {
      continue;
    }

    try {
      const session = await service.get(lifecycle.sessionId);
      if (session.status === "completed") {
        markWorkItemOwnerCompleted(dataDir, projectId, sourceId, lifecycle);
        logTriggerEvent(dataDir, "trigger.work_item_auto_complete.noop", {
          level: "info",
          sessionId: lifecycle.sessionId,
          projectId,
          sourceId,
          triggerId,
          message: `Cleared work item ${lifecycle.externalId}: session already ${session.status}`,
          details: {
            externalId: lifecycle.externalId,
          },
        });
        continue;
      }
      if (session.status !== "running" || session.state !== "waiting") {
        continue;
      }

      await service.complete(lifecycle.sessionId, { prAction: "leave_open" });
      markWorkItemOwnerCompleted(dataDir, projectId, sourceId, lifecycle);
      logTriggerEvent(dataDir, "trigger.work_item_auto_complete.completed", {
        level: "info",
        sessionId: lifecycle.sessionId,
        projectId,
        sourceId,
        triggerId,
        message: `Auto-completed work item ${lifecycle.externalId}`,
        details: {
          externalId: lifecycle.externalId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSessionNotFoundError(message)) {
        const remaining = updateWorkItemMembers(
          dataDir,
          projectId,
          sourceId,
          lifecycle,
          (members) =>
            members.filter(
              (member) => !(member.state === "running" && member.sessionId === lifecycle.sessionId),
            ),
        );
        if (remaining.members.length === 0) {
          deleteWorkItemLifecycle(dataDir, projectId, sourceId, lifecycle.externalId);
        }
        logTriggerEvent(dataDir, "trigger.work_item_auto_complete.noop", {
          level: "info",
          sessionId: lifecycle.sessionId,
          projectId,
          sourceId,
          triggerId,
          message: `Cleared work item ${lifecycle.externalId}: session not found`,
          details: {
            externalId: lifecycle.externalId,
          },
        });
        continue;
      }
      logTriggerEvent(dataDir, "trigger.work_item_auto_complete.failed", {
        level: "error",
        sessionId: lifecycle.sessionId,
        projectId,
        sourceId,
        triggerId,
        message: `Failed to auto-complete work item ${lifecycle.externalId}: ${message}`,
        details: {
          externalId: lifecycle.externalId,
        },
      });
      logger.warn(
        `[trigger:${projectId}/${triggerId}] failed to auto-complete work item: ${message}`,
      );
    }
  }
}

function isSendTrigger(
  trigger: SpawnTriggerConfig | SendTriggerConfig,
): trigger is SendTriggerConfig {
  return "send" in trigger;
}

/** Send window for a batch: the idle wait, capped for interactive batches. */
function sendWindowMs(batch: SendBatch): number {
  const idleWaitMs = getIdleWaitBeforeFlushMs();
  return batch.interactive ? Math.min(idleWaitMs, INTERACTIVE_SEND_WINDOW_MS) : idleWaitMs;
}

function isDeliverableState(session: SessionView, windowMs: number): boolean {
  return (
    session.state === "stale" ||
    (session.state === "waiting" && isIdleEnoughToReceive(session.lastActivityAt, windowMs))
  );
}

// "stale" is deliberately never closed: a parked session has no live agent to
// interrupt, so it must stay deliverable rather than dropping the batch.
function isClosedState(state: SessionView["state"]): boolean {
  return state === "stopped" || state === "error" || state === "killed";
}

/**
 * True when a queued send to this session is dropped instead of delivered.
 * A live server-error wedge and a stop written by the memory shed are exempt:
 * the shed's own pause must not destroy the batch it exists to cover.
 */
export function dropsQueuedSend(
  session: Pick<SessionView, "state" | "status" | "stopReason">,
): boolean {
  return (
    isClosedState(session.state) &&
    !isLiveServerErrorWedge(session) &&
    !(session.state === "stopped" && session.stopReason === "memory_shed")
  );
}

// The rate-limit reactivation wakeup and the server-error reactivation wakeup
// (both in session-service.ts's processScheduledWakes) call
// SessionService.send() directly and never flow through this
// handleSendEvent/flushPending queue, so a blanket block here is already
// correct — no whitelist exception is needed to let either through.
function isBlockedAwaitingRecovery(session: SessionView): boolean {
  return session.state === "rate_limited" || isLiveServerErrorWedge(session);
}

// Detects a restart (e.g. `service.restore`) since the last interrupt delivery,
// so the trigger runtime delivers again instead of dropping as a duplicate.
function sessionRestartedSince(session: SessionView, sinceMs: number): boolean {
  const history = session.stateHistory;
  if (!history) return false;
  for (const entry of history) {
    if (!isClosedState(entry.state)) continue;
    const transitionMs = Date.parse(entry.at);
    if (Number.isFinite(transitionMs) && transitionMs >= sinceMs) {
      return true;
    }
  }
  return false;
}

function createQueueKey(projectId: string, triggerId: string, sessionId: string): string {
  return `${projectId}:${triggerId}:${sessionId}`;
}

function mergeIntoBatch(
  existing: PendingBatch | undefined,
  projectId: string,
  triggerId: string,
  sourceId: string,
  eventName: string,
  customPrompt: string | undefined,
  incoming: SendBatch,
  policy: {
    routeFingerprint: string;
    destination: AutoPingDestination;
    routeLeaseId: string;
  },
): PendingBatch {
  if (existing) {
    const replaced = existing.batch.merge(incoming);
    if (replaced) {
      existing.admissionCapRetryAt = undefined;
      existing.admissionCapDenials = undefined;
      existing.retryAccounting = existing.retryAccounting.filter(
        (entry) => !entry.itemKey.startsWith(replaced.retiredItemPrefix),
      );
    }
    existing.retryAccounting = reconcileRetryAccounting(existing.batch, existing.retryAccounting);
    return existing;
  }
  return {
    projectId,
    triggerId,
    sourceId,
    eventName,
    customPrompt,
    customPromptRecorded: false,
    batch: incoming,
    notBeforeAt: Date.now() + sendWindowMs(incoming),
    routeFingerprint: policy.routeFingerprint,
    destination: policy.destination,
    workId: randomUUID(),
    revision: 1,
    routeLeaseId: policy.routeLeaseId,
    retryAccounting: reconcileRetryAccounting(incoming, []),
  };
}

function reconcileRetryAccounting(
  batch: SendBatch,
  prior: readonly SendBatchRetryEntry[],
): SendBatchRetryEntry[] {
  const entries = new Map(prior.map((entry) => [entry.itemKey, { ...entry }]));
  for (const item of batch.retryItems()) {
    if (entries.get(item.itemKey)?.fingerprint === item.fingerprint) continue;
    entries.set(item.itemKey, {
      itemKey: item.itemKey,
      fingerprint: item.fingerprint,
      deliveryAttempts: 0,
      ciAttempts: 0,
      nextAttemptAt: 0,
    });
  }
  return [...entries.values()];
}

function exhausted(entry: SendBatchRetryEntry): boolean {
  return (
    entry.deliveryAttempts >= DELIVERY_MAX_ATTEMPTS || entry.ciAttempts >= CI_FAILED_MAX_ATTEMPTS
  );
}

function buildAutoPingRoute(
  config: AppConfig,
  projectId: string,
  triggerId: string,
  trigger: SendTriggerConfig,
  destination: AutoPingDestination,
): AutoPingRouteDescriptor | null {
  const source = config.projects[projectId]?.sources[trigger.source];
  if (!source) return null;
  return {
    version: 1,
    projectId,
    triggerId,
    sourceId: trigger.source,
    sourceType: source.type,
    eventName: trigger.event,
    actionKind: "send",
    destination,
    spawnDeskGroup: false,
  };
}

function logTriggerEvent(
  dataDir: string,
  event: string,
  entry: Omit<SpurLogEntry, "timestamp" | "event">,
): void {
  logSpurEvent(dataDir, { event, ...entry });
}

function spawnRouteFingerprint(
  config: AppConfig,
  projectId: string,
  triggerId: string,
  trigger: SpawnTriggerConfig,
): string {
  return JSON.stringify({
    projectId,
    sourceId: trigger.source,
    sourceType: config.projects[projectId]?.sources[trigger.source]?.type,
    triggerId,
    trigger,
  });
}

export function startConfiguredTriggers(deps: StartConfiguredTriggersDeps): TriggerGroupController {
  const logger = deps.logger ?? DEFAULT_TRIGGER_LOGGER;
  const autoPing = deps.autoPing;
  const memoryHoldEngaged = deps.memoryHoldEngaged ?? (() => false);
  const unsubscribers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  const pendingBatches = new Map<string, PendingBatch>();
  const pendingSpawns = new Map(
    [...readPendingSpawnWork(deps.config.dataDir)].filter(
      ([, work]) =>
        !(WORK_ITEM_NEW_EVENT_NAMES.has(work.eventName) && isWorkItemEventData(work.eventData)),
    ),
  );
  const interruptedKeys = new Map<string, number>();
  const serialByKey = new Map<string, Promise<void>>();
  const tickFlushQueued = new Set<string>();
  const routeLeases = new Map<string, string>();
  const occurrenceReferencesByQueue = new Map<string, Set<string>>();
  const autoCompleteChecks: Array<() => void> = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let autoCompleteTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const interactiveFlushTimers = new Set<NodeJS.Timeout>();

  const leaseForRoute = (
    routeFingerprint: string,
    descriptor?: AutoPingRouteDescriptor,
  ): string => {
    const existing = routeLeases.get(routeFingerprint);
    if (existing) return existing;
    const leaseId = autoPing.registerRoute(routeFingerprint, descriptor);
    routeLeases.set(routeFingerprint, leaseId);
    return leaseId;
  };

  // Clears the work `batch` owns. Another controller's replacement generation
  // can already hold this queue key on disk, so the persisted record is deleted
  // by `workId`, never by queue key.
  const clearBatch = (
    queueKey: string,
    batch: PendingBatch,
    options?: {
      keepInterrupted?: boolean;
      deletePersisted?: boolean;
    },
  ): void => {
    const current = pendingBatches.get(queueKey);
    const references = occurrenceReferencesByQueue.get(queueKey);
    if (references && current) {
      for (const occurrenceId of references) {
        autoPing.releaseOccurrenceReference(current.routeFingerprint, occurrenceId);
      }
    }
    occurrenceReferencesByQueue.delete(queueKey);
    pendingBatches.delete(queueKey);
    if (options?.deletePersisted !== false) {
      deletePendingSendBatchConditional(deps.config.dataDir, { workId: batch.workId });
    }
    if (!options?.keepInterrupted) {
      interruptedKeys.delete(queueKey);
    }
    if (flushTimer && pendingBatches.size === 0 && pendingSpawns.size === 0) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  };

  const syncBatchOccurrenceReferences = (queueKey: string, batch: PendingBatch): void => {
    const next = new Set(
      Object.values(batch.batch.serialize().autoPing?.items ?? {}).map((item) => item.occurrenceId),
    );
    const prior = occurrenceReferencesByQueue.get(queueKey) ?? new Set<string>();
    for (const occurrenceId of next) {
      if (!prior.has(occurrenceId)) {
        autoPing.addOccurrenceReference(batch.routeFingerprint, occurrenceId);
      }
    }
    for (const occurrenceId of prior) {
      if (!next.has(occurrenceId)) {
        autoPing.releaseOccurrenceReference(batch.routeFingerprint, occurrenceId);
      }
    }
    occurrenceReferencesByQueue.set(queueKey, next);
  };

  const deliverBatch = async (
    queueKey: string,
    batch: PendingBatch,
    interrupt: boolean,
    session: SessionView,
  ): Promise<DeliveryOutcome> => {
    return autoPing.withRouteLock(batch.routeFingerprint, async () => {
      const persisted = readPendingSendBatch(deps.config.dataDir, batch.workId);
      if (!persisted) return { status: "suppressed" };
      if (
        persisted.claim &&
        persisted.claim.routeLeaseId !== batch.routeLeaseId &&
        autoPing.isRouteLeaseActive(persisted.claim.routeLeaseId)
      ) {
        return { status: "suppressed" };
      }
      const authoritativeBatch = restoreSendBatch(persisted.batch);
      if (!authoritativeBatch || authoritativeBatch.sessionId !== batch.batch.sessionId) {
        return { status: "suppressed" };
      }
      batch.batch = authoritativeBatch;
      batch.admissionCapRetryAt = persisted.admissionCapRetryAt;
      batch.admissionCapDenials = persisted.admissionCapDenials;
      const now = Date.now();
      if (batch.admissionCapRetryAt !== undefined && now < batch.admissionCapRetryAt) {
        return { status: "suppressed" };
      }
      batch.admissionCapRetryAt = undefined;
      batch.batch.prune(deps.config.dataDir);
      const snapshotPruned = batch.batch.isEmpty();
      let livePruned = false;
      batch.revision = persisted.revision ?? 0;
      batch.retryAccounting = reconcileRetryAccounting(
        batch.batch,
        persisted.retryAccounting ?? [],
      );
      batch.batch.filterAutoPing((occurrenceId, threadTarget) =>
        autoPing.isSuppressed(
          batch.routeFingerprint,
          batch.destination,
          occurrenceId,
          threadTarget,
        ),
      );
      syncBatchOccurrenceReferences(queueKey, batch);
      const beforeAttempt = batch.retryAccounting.map((entry) => ({ ...entry }));
      const accounting = new Map(batch.retryAccounting.map((entry) => [entry.itemKey, entry]));
      const submission = restoreSendBatch(structuredClone(batch.batch.serialize()));
      if (!submission) return { status: "suppressed" };
      submission.filterItems((item) => {
        const entry = accounting.get(item.itemKey);
        if (!entry || exhausted(entry)) return false;
        const delay = item.ciReminder
          ? CI_FAILED_RETRY_INTERVAL_MS
          : DELIVERY_RETRY_BASE_MS * 2 ** (entry.deliveryAttempts - 1);
        if (
          entry.nextAttemptAt > now &&
          sessionRestartedSince(session, entry.nextAttemptAt - delay)
        )
          entry.nextAttemptAt = 0;
        return entry.nextAttemptAt <= now;
      });
      const selectedComments = new Set(
        submission
          .retryItems()
          .filter((item) => item.refreshComment)
          .slice(0, 4)
          .map((item) => item.itemKey),
      );
      submission.filterItems((item) => !item.refreshComment || selectedComments.has(item.itemKey));
      const originalItems = submission.retryItems();
      const conflictClaims: string[] = [];
      const allTerminal = (): boolean =>
        batch.batch.retryItems().every((item) => {
          const entry = accounting.get(item.itemKey);
          return !entry || exhausted(entry);
        });
      const dropTerminal = (claim?: { revision: number; claimId: string }): void => {
        const attempts = Math.max(
          0,
          ...batch.retryAccounting.map((entry) => entry.deliveryAttempts),
        );
        const deleted = deletePendingSendBatchConditional(deps.config.dataDir, {
          workId: batch.workId,
          ...claim,
        });
        if (!deleted) return;
        clearBatch(queueKey, batch, {
          keepInterrupted: interrupt && !batch.batch.isEmpty(),
          deletePersisted: false,
        });
        if (!batch.batch.isEmpty() || snapshotPruned || livePruned) {
          logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
            level: "warn",
            sessionId: batch.batch.sessionId,
            projectId: batch.projectId,
            sourceId: batch.sourceId,
            triggerId: batch.triggerId,
            message: `Dropped queued trigger update for ${batch.batch.sessionId} after ${attempts} attempts`,
            details: {
              reason: snapshotPruned
                ? "snapshot_pruned"
                : livePruned && batch.batch.isEmpty()
                  ? "live_pruned"
                  : "retry_exhausted",
              attempts,
              interrupt,
            },
          });
        }
      };
      if (submission.isEmpty()) {
        if (allTerminal()) dropTerminal();
        return { status: "suppressed" };
      }
      const charge = (item: SendBatchItem): void => {
        const entry = accounting.get(item.itemKey);
        if (!entry) return;
        entry.deliveryAttempts += 1;
        if (item.ciReminder) entry.ciAttempts += 1;
        entry.nextAttemptAt =
          now +
          (item.ciReminder
            ? CI_FAILED_RETRY_INTERVAL_MS
            : DELIVERY_RETRY_BASE_MS * 2 ** (entry.deliveryAttempts - 1));
      };
      for (const item of originalItems) {
        if (selectedComments.has(item.itemKey)) charge(item);
      }
      const claimId = randomUUID();
      let claimedRevision = (persisted.revision ?? 0) + 1;
      let claimed = {
        ...persisted,
        admissionCapRetryAt: batch.admissionCapRetryAt,
        admissionCapDenials: batch.admissionCapDenials,
        batch: batch.batch.serialize(),
        retryAccounting: batch.retryAccounting,
        revision: claimedRevision,
        claim: {
          controllerId: batch.routeLeaseId,
          routeLeaseId: batch.routeLeaseId,
          claimId,
          claimedAt: new Date().toISOString(),
        },
      };
      if (
        !updatePendingSendBatchConditional(
          deps.config.dataDir,
          { workId: batch.workId, revision: persisted.revision ?? 0 },
          claimed,
        )
      ) {
        return { status: "suppressed" };
      }
      batch.revision = claimedRevision;
      const persistResult = (suppressedHoldAt?: string): void => {
        const { claim: _claim, ...unclaimed } = claimed;
        void _claim;
        const record = {
          ...unclaimed,
          admissionCapRetryAt: batch.admissionCapRetryAt,
          admissionCapDenials: batch.admissionCapDenials,
          revision: claimedRevision + 1,
          batch: batch.batch.serialize(),
          retryAccounting: batch.retryAccounting,
          ...(suppressedHoldAt !== undefined ? { suppressedHoldAt } : {}),
        };
        updatePendingSendBatchConditional(
          deps.config.dataDir,
          { workId: batch.workId, revision: claimedRevision, claimId },
          record,
        );
        batch.revision = claimedRevision + 1;
        syncBatchOccurrenceReferences(queueKey, batch);
      };
      if (selectedComments.size > 0 && submission.refresh) {
        const results = await submission.refresh(deps.config.dataDir, session.pr);
        const deleted = new Set(
          results.filter((result) => result.status === "deleted").map((result) => result.key),
        );
        livePruned = deleted.size > 0;
        const deletedKeys = new Set(
          batch.batch
            .retryItems()
            .filter((item) => deleted.has(item.key))
            .map((item) => item.itemKey),
        );
        batch.batch.filterItems((item) => !deleted.has(item.key));
        batch.retryAccounting = batch.retryAccounting.filter(
          (entry) => !deletedKeys.has(entry.itemKey),
        );
        for (const key of deletedKeys) accounting.delete(key);
        const refreshedState = submission.serialize();
        if (refreshedState.kind === "review" && refreshedState.prUrl) {
          const recovered = restoreSendBatch({
            ...batch.batch.serialize(),
            prUrl: refreshedState.prUrl,
            repo: refreshedState.repo,
          });
          if (recovered) batch.batch = recovered;
        }
        syncBatchOccurrenceReferences(queueKey, batch);
        for (const result of results) {
          if (result.status !== "failed") continue;
          logTriggerEvent(deps.config.dataDir, "trigger.send.failed", {
            level: "error",
            sessionId: batch.batch.sessionId,
            projectId: batch.projectId,
            sourceId: batch.sourceId,
            triggerId: batch.triggerId,
            message: `Failed to resolve queued feedback ${result.key}: ${result.error}`,
            details: { interrupt },
          });
        }
      }
      submission.filterItems((item) => {
        if (!item.mergeConflict) return true;
        const accepted = autoPing.claimMergeConflict(
          batch.routeFingerprint,
          item.mergeConflict.prNumber,
          `${item.itemKey}:${item.fingerprint}`,
          item.mergeConflict.clearId,
        );
        if (accepted) conflictClaims.push(item.itemKey);
        else batch.batch.filterItems((retained) => retained.itemKey !== item.itemKey);
        return accepted;
      });
      const submittedKeys = new Set(submission.retryItems().map((item) => item.itemKey));
      const submitted = new Map(
        originalItems
          .filter((item) => submittedKeys.has(item.itemKey))
          .map((item) => [item.itemKey, item]),
      );
      if (submission.isEmpty()) {
        if (allTerminal()) dropTerminal({ revision: claimedRevision, claimId });
        else persistResult();
        return { status: "suppressed" };
      }
      for (const item of submitted.values()) {
        if (!selectedComments.has(item.itemKey)) charge(item);
      }
      const updatedClaim = {
        ...claimed,
        revision: claimedRevision + 1,
        batch: batch.batch.serialize(),
        retryAccounting: batch.retryAccounting,
      };
      if (
        !updatePendingSendBatchConditional(
          deps.config.dataDir,
          { workId: batch.workId, revision: claimedRevision, claimId },
          updatedClaim,
        )
      ) {
        if (conflictClaims.length > 0) autoPing.refundMergeConflict(batch.routeFingerprint);
        return { status: "suppressed" };
      }
      claimed = updatedClaim;
      claimedRevision = updatedClaim.revision;
      batch.revision = claimedRevision;
      const refundSubmitted = (): void => {
        const original = new Map(beforeAttempt.map((entry) => [entry.itemKey, entry]));
        batch.retryAccounting = batch.retryAccounting.map((entry) =>
          submitted.has(entry.itemKey) ? { ...(original.get(entry.itemKey) ?? entry) } : entry,
        );
      };
      try {
        await deps.sessionService.deliver(submission.sessionId, submission.format(), {
          interrupt,
          sensitivePromptSuffix: submission.formatAutoPingControls(),
        });
        batch.admissionCapRetryAt = undefined;
        batch.admissionCapDenials = undefined;
        if (batch.customPrompt !== undefined && !batch.customPromptRecorded) {
          logUserInputEvent(deps.config.dataDir, {
            sessionId: batch.batch.sessionId,
            projectId: batch.projectId,
            sourceId: batch.sourceId,
            triggerId: batch.triggerId,
            kind: "trigger_send_prompt",
            source: "trigger",
            text: batch.customPrompt,
            details: { eventName: batch.eventName },
          });
          batch.customPromptRecorded = true;
        }
        logTriggerEvent(deps.config.dataDir, "trigger.send.delivered", {
          level: "info",
          sessionId: batch.batch.sessionId,
          projectId: batch.projectId,
          sourceId: batch.sourceId,
          triggerId: batch.triggerId,
          message: `Delivered queued trigger update to ${batch.batch.sessionId}`,
          details: {
            interrupt,
            attempt: Math.max(...batch.retryAccounting.map((entry) => entry.deliveryAttempts)),
          },
        });
        batch.batch.filterItems((item) => !submitted.has(item.itemKey) || item.ciReminder);
        batch.retryAccounting = batch.retryAccounting.filter(
          (entry) => !submitted.has(entry.itemKey) || submitted.get(entry.itemKey)?.ciReminder,
        );
        if (allTerminal()) dropTerminal({ revision: claimedRevision, claimId });
        else persistResult();
        return { status: "delivered" };
      } catch (error) {
        if (error instanceof SessionRateLimitedError) {
          if (conflictClaims.length > 0) autoPing.refundMergeConflict(batch.routeFingerprint);
          logTriggerEvent(deps.config.dataDir, "trigger.send.suppressed_rate_limited", {
            level: "info",
            sessionId: batch.batch.sessionId,
            projectId: batch.projectId,
            sourceId: batch.sourceId,
            triggerId: batch.triggerId,
            message: `Suppressed queued trigger update to ${batch.batch.sessionId} while rate limited`,
            details: {
              interrupt,
              attempt: null,
            },
          });
          refundSubmitted();
          persistResult();
          return { status: "suppressed" };
        }
        // Same shape as a rate limit: the session is alive and takes the batch
        // once its last prompt is confirmed, so no attempt is spent. Logged
        // once per hold: the persisted batch remembers the hold it logged.
        if (error instanceof LaunchPromptPendingError) {
          if (conflictClaims.length > 0) autoPing.refundMergeConflict(batch.routeFingerprint);
          const holdAt = error.submitUnconfirmedAt;
          if (holdAt === undefined || persisted.suppressedHoldAt !== holdAt) {
            logTriggerEvent(deps.config.dataDir, "trigger.send.suppressed_launch_pending", {
              level: "info",
              sessionId: batch.batch.sessionId,
              projectId: batch.projectId,
              sourceId: batch.sourceId,
              triggerId: batch.triggerId,
              message: `Suppressed queued trigger update to ${batch.batch.sessionId}: last prompt not confirmed`,
              details: {
                interrupt,
                attempt: null,
                ...(holdAt !== undefined ? { submitUnconfirmedAt: holdAt } : {}),
              },
            });
          }
          refundSubmitted();
          persistResult(holdAt);
          return { status: "suppressed" };
        }
        if (error instanceof SessionAdmissionDeniedError) {
          if (conflictClaims.length > 0) autoPing.refundMergeConflict(batch.routeFingerprint);
          logTriggerEvent(
            deps.config.dataDir,
            error.reason === "memory_guard"
              ? "trigger.send.suppressed_memory_guard"
              : "trigger.send.suppressed_admission",
            {
              level: "info",
              sessionId: batch.batch.sessionId,
              projectId: batch.projectId,
              sourceId: batch.sourceId,
              triggerId: batch.triggerId,
              message: `Suppressed queued trigger update to ${batch.batch.sessionId}: ${error.message}`,
              details: {
                interrupt,
                attempt: null,
              },
            },
          );
          refundSubmitted();
          if (error.reason === "cap") {
            batch.admissionCapDenials = Math.min(
              (batch.admissionCapDenials ?? 0) + 1,
              DELIVERY_MAX_ATTEMPTS - 1,
            );
            batch.admissionCapRetryAt =
              Date.now() + DELIVERY_RETRY_BASE_MS * 2 ** (batch.admissionCapDenials - 1);
          }
          persistResult();
          return { status: "suppressed" };
        }
        const message = error instanceof Error ? error.message : String(error);
        logTriggerEvent(deps.config.dataDir, "trigger.send.failed", {
          level: "error",
          sessionId: batch.batch.sessionId,
          projectId: batch.projectId,
          sourceId: batch.sourceId,
          triggerId: batch.triggerId,
          message: `Failed to deliver queued trigger update to ${batch.batch.sessionId}: ${message}`,
          details: {
            interrupt,
            attempt: Math.max(...batch.retryAccounting.map((entry) => entry.deliveryAttempts)),
          },
        });
        logger.warn(
          `[trigger:${batch.projectId}/${batch.triggerId}] failed to deliver queued updates: ${message}`,
        );
        const current = await loadSessionOrClear(queueKey, batch, "after_delivery_failure");
        if (current && isClosedState(current.state)) {
          for (const entry of batch.retryAccounting) {
            if (submitted.has(entry.itemKey)) entry.nextAttemptAt = 0;
          }
        }
        if (allTerminal()) dropTerminal({ revision: claimedRevision, claimId });
        else persistResult();
        return { status: "failed", error: message };
      }
    });
  };

  const scheduleFlushLoop = (): void => {
    if (flushTimer || (pendingBatches.size === 0 && pendingSpawns.size === 0) || stopped) return;
    flushTimer = setInterval(() => {
      for (const work of pendingSpawns.values())
        enqueue(spawnQueueKey(work), () => flushSpawn(work));
      for (const [queueKey, batch] of pendingBatches) {
        // One tick flush per key in flight: the batch stays pending, so a
        // skipped tick only delays delivery to the next one.
        if (tickFlushQueued.has(queueKey)) continue;
        tickFlushQueued.add(queueKey);
        enqueue(queueKey, async () => {
          try {
            await flushPending(queueKey, batch);
          } finally {
            tickFlushQueued.delete(queueKey);
          }
        });
      }
    }, 5_000);
  };

  const enqueue = (queueKey: string, task: () => Promise<void>): void => {
    const next = (serialByKey.get(queueKey) ?? Promise.resolve())
      .catch(() => {
        // Keep the chain alive after earlier failures.
      })
      .then(task)
      .finally(() => {
        if (serialByKey.get(queueKey) === next) {
          serialByKey.delete(queueKey);
        }
      });
    serialByKey.set(queueKey, next);
    inFlight.add(next);
    void next.finally(() => {
      inFlight.delete(next);
    });
  };

  const spawnQueueKey = (work: PersistedSpawnWork): string => {
    const data = work.eventData;
    return WORK_ITEM_NEW_EVENT_NAMES.has(work.eventName) && isWorkItemEventData(data)
      ? `${work.projectId}:${work.triggerId}:${work.sourceId}:work-item:${data.externalId}`
      : `spawn:${work.workId}`;
  };
  const flushSpawn = async (work: PersistedSpawnWork): Promise<void> => {
    if (WORK_ITEM_NEW_EVENT_NAMES.has(work.eventName) && isWorkItemEventData(work.eventData))
      return;
    const current = (): boolean =>
      !stopped &&
      pendingSpawns.get(work.workId) === work &&
      readPendingSpawnWork(deps.config.dataDir).get(work.workId)?.revision === work.revision;
    if (!current() || work.notBeforeAt > Date.now() || memoryHoldEngaged()) return;
    const trigger = deps.config.projects[work.projectId]?.triggers[work.triggerId];
    if (
      !trigger ||
      isSendTrigger(trigger) ||
      trigger.source !== work.sourceId ||
      trigger.event !== work.eventName ||
      spawnRouteFingerprint(deps.config, work.projectId, work.triggerId, trigger) !==
        work.routeFingerprint ||
      trigger.spawn.blocks.length !== work.blocks.length
    ) {
      deletePendingSpawnWork(deps.config.dataDir, work.workId, work.revision);
      pendingSpawns.delete(work.workId);
      return;
    }
    const save = (): boolean => {
      if (!current()) return false;
      const revision = work.revision;
      work.revision += 1;
      return writePendingSpawnWork(deps.config.dataDir, work, revision);
    };
    await runSpawnTrigger(
      deps.config.dataDir,
      deps.sessionService,
      work.projectId,
      work.triggerId,
      work.sourceId,
      work.eventName,
      trigger.spawn.blocks,
      trigger.spawn.autoComplete,
      trigger.spawn.restrictWrites,
      trigger.spawn.allowedTriggers,
      trigger.spawnDeskGroup,
      work.eventData,
      new Set(),
      logger,
      { work, current, save },
    );
    if (current() && work.nextBlockIndex === work.blocks.length) {
      deletePendingSpawnWork(deps.config.dataDir, work.workId, work.revision);
      pendingSpawns.delete(work.workId);
    }
  };

  // One timer per new interactive batch: flush as soon as the send window and
  // the agent's idle gate allow, instead of waiting for the 5s tick. Claim and
  // attempt accounting stay in flushPending, so a timer and a tick that both
  // fire deliver once. Never reschedules; a closed gate is left to the tick.
  const scheduleInteractiveFlush = (
    queueKey: string,
    batch: PendingBatch,
    session: SessionView,
  ): void => {
    const gateOpensAt = Math.max(
      batch.notBeforeAt,
      Date.parse(session.lastActivityAt) + sendWindowMs(batch.batch),
    );
    const delayMs = Math.max(0, gateOpensAt - Date.now() + INTERACTIVE_FLUSH_MARGIN_MS);
    const workId = batch.workId;
    const timer = setTimeout(() => {
      interactiveFlushTimers.delete(timer);
      if (stopped) return;
      const current = pendingBatches.get(queueKey);
      if (current?.workId !== workId) return;
      enqueue(queueKey, async () => {
        await flushPending(queueKey, current);
      });
    }, delayMs);
    timer.unref();
    interactiveFlushTimers.add(timer);
  };

  const loadSessionOrClear = async (
    queueKey: string,
    batch: PendingBatch,
    purpose: "before_delivery" | "after_delivery_failure",
  ): Promise<SessionView | null> => {
    try {
      return await deps.sessionService.get(batch.batch.sessionId);
    } catch (error) {
      if (
        purpose === "before_delivery" &&
        error instanceof SessionLifecycleError &&
        error.statusCode === 503 &&
        error.payload.code === "session_lifecycle_snapshot_changed"
      )
        return null;
      clearBatch(queueKey, batch);
      const message = error instanceof Error ? error.message : String(error);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: batch.batch.sessionId,
        projectId: batch.projectId,
        sourceId: batch.sourceId,
        triggerId: batch.triggerId,
        message: `Dropped queued trigger update for ${batch.batch.sessionId}: ${message}`,
        details: {
          reason: "session_lookup_failed",
        },
      });
      logger.warn(
        `[trigger:${batch.projectId}/${batch.triggerId}] failed to load ${batch.batch.sessionId}: ${message}`,
      );
      return null;
    }
  };

  const flushPending = async (queueKey: string, batch: PendingBatch): Promise<void> => {
    if (!pendingBatches.has(queueKey)) return;

    const session = await loadSessionOrClear(queueKey, batch, "before_delivery");
    if (!session) return;

    // The memory shed pauses a session by writing status "stopped" with
    // stopReason "memory_shed"; dropsQueuedSend exempts exactly that marker so
    // the shed's own pause does not destroy the batch.
    if (dropsQueuedSend(session)) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: batch.batch.sessionId,
        projectId: batch.projectId,
        sourceId: batch.sourceId,
        triggerId: batch.triggerId,
        message: `Dropped queued trigger update for closed session ${batch.batch.sessionId}`,
        details: {
          reason: "closed_session",
          sessionState: session.state,
        },
      });
      logger.warn(
        `[trigger:${batch.projectId}/${batch.triggerId}] dropped queued updates for ${session.state} session ${batch.batch.sessionId}`,
      );
      return;
    }

    if (isBlockedAwaitingRecovery(session)) {
      return; // stays queued; delivered later once the session leaves rate_limited/error
    }

    // Holds precede persisted attempt claims.
    if (memoryHoldEngaged()) {
      return;
    }

    if (!isSendTriggerAllowed(session, batch.triggerId)) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: batch.batch.sessionId,
        projectId: batch.projectId,
        sourceId: batch.sourceId,
        triggerId: batch.triggerId,
        message: `Dropped queued trigger update for ${batch.batch.sessionId}: trigger ${batch.triggerId} is not allowed`,
        details: {
          reason: "trigger_not_allowed",
        },
      });
      logger.warn(
        `[trigger:${batch.projectId}/${batch.triggerId}] dropped queued update: trigger not allowed for ${batch.batch.sessionId}`,
      );
      return;
    }

    const deliverable = isDeliverableState(session, sendWindowMs(batch.batch));
    if (batch.eventName.endsWith(":ci_failed")) {
      const trigger = deps.config.projects[batch.projectId]?.triggers[batch.triggerId];
      const interrupt =
        !!trigger &&
        isSendTrigger(trigger) &&
        trigger.send.interrupt &&
        session.state === "working";
      if (!deliverable && !interrupt) {
        return;
      }
      // Escalation (interrupt=true, working) bypasses the window gate.
      if (!interrupt && Date.now() < batch.notBeforeAt) {
        return;
      }
      await deliverBatch(queueKey, batch, interrupt, session);
      return;
    }

    if (deliverable) {
      if (!isStaleParked(session) && Date.now() < batch.notBeforeAt) return;
      interruptedKeys.delete(queueKey);
      await deliverBatch(queueKey, batch, false, session);
      return;
    }

    // Pending interrupt batch whose previous delivery failed: retry while the
    // session is still working. `clearBatch` only runs on success, so reaching
    // here means the prior deliverBatch threw.
    if (session.state === "working" && interruptedKeys.has(queueKey)) {
      await deliverBatch(queueKey, batch, true, session);
    }
  };

  const handleSendEvent = async (
    projectId: string,
    triggerId: string,
    eventName: string,
    occurrenceId: string,
    trigger: SendTriggerConfig,
    sendBatch: SendBatch,
  ): Promise<void> => {
    const queueKey = createQueueKey(projectId, triggerId, sendBatch.sessionId);
    const destination = { kind: "session" as const, sessionId: sendBatch.sessionId };
    const route = buildAutoPingRoute(deps.config, projectId, triggerId, trigger, destination);
    if (!route) return;
    const routeFingerprint = autoPingRouteFingerprint(route);
    const routeLeaseId = leaseForRoute(routeFingerprint, route);
    let batch: PendingBatch | undefined;
    let merged = false;
    await autoPing.withRouteLock(routeFingerprint, async () => {
      const cached = pendingBatches.get(queueKey);
      const persisted = readPendingSendBatches(deps.config.dataDir).get(queueKey);
      if (cached && !persisted) {
        clearBatch(queueKey, cached, { deletePersisted: false });
      } else if (persisted && (!cached || persisted.workId !== cached.workId)) {
        return;
      } else if (cached && persisted && persisted.workId === cached.workId) {
        const authoritativeBatch = restoreSendBatch(persisted.batch);
        if (authoritativeBatch && authoritativeBatch.sessionId === cached.batch.sessionId) {
          cached.batch = authoritativeBatch;
          cached.admissionCapRetryAt = persisted.admissionCapRetryAt;
          cached.admissionCapDenials = persisted.admissionCapDenials;
          cached.revision = persisted.revision ?? 0;
          cached.retryAccounting = reconcileRetryAccounting(
            cached.batch,
            persisted.retryAccounting ?? [],
          );
          syncBatchOccurrenceReferences(queueKey, cached);
        }
      }
      merged = pendingBatches.has(queueKey);
      if (autoPing.isSuppressed(routeFingerprint, destination, occurrenceId)) return;
      sendBatch.attachAutoPing({
        occurrenceId,
        routeFingerprint,
        destination,
        createGrant: (scope, target) =>
          autoPing.createGrant({
            scope,
            routeFingerprint,
            destination,
            target,
            actorSessionId: sendBatch.sessionId,
          }).handle,
      });
      sendBatch.filterAutoPing((itemOccurrenceId, threadTarget) =>
        autoPing.isSuppressed(routeFingerprint, destination, itemOccurrenceId, threadTarget),
      );
      if (sendBatch.isEmpty()) return;
      batch = mergeIntoBatch(
        pendingBatches.get(queueKey),
        projectId,
        triggerId,
        trigger.source,
        eventName,
        trigger.send.prompt,
        sendBatch,
        { routeFingerprint, destination, routeLeaseId },
      );
      batch.revision += merged ? 1 : 0;
      pendingBatches.set(queueKey, batch);
      syncBatchOccurrenceReferences(queueKey, batch);
      recordPendingSendBatch(deps.config.dataDir, {
        queueKey,
        workId: batch.workId,
        revision: batch.revision,
        projectId,
        triggerId,
        sourceId: trigger.source,
        batch: batch.batch.serialize(),
        retryAccounting: batch.retryAccounting,
        admissionCapRetryAt:
          batch.admissionCapRetryAt !== undefined && batch.admissionCapRetryAt > Date.now()
            ? batch.admissionCapRetryAt
            : undefined,
        admissionCapDenials: batch.admissionCapDenials,
        ...(persisted?.suppressedHoldAt !== undefined
          ? { suppressedHoldAt: persisted.suppressedHoldAt }
          : {}),
      });
    });
    if (!batch) return;
    logTriggerEvent(deps.config.dataDir, "trigger.send.queued", {
      level: "info",
      sessionId: sendBatch.sessionId,
      projectId,
      sourceId: trigger.source,
      triggerId,
      message: `Queued ${eventName} for ${sendBatch.sessionId}`,
      details: {
        eventName,
        interrupt: trigger.send.interrupt,
        merged,
      },
    });
    scheduleFlushLoop();

    const session = await loadSessionOrClear(queueKey, batch, "before_delivery");
    if (!session) return;
    // Revision 1 is a new batch; a merge bumps it, and adds no second timer.
    if (batch.revision === 1 && sendBatch.interactive) {
      scheduleInteractiveFlush(queueKey, batch, session);
    }

    // Same shed-pause exemption as flushPending: a memory_shed session is
    // deferred, not dropped.
    if (dropsQueuedSend(session)) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: sendBatch.sessionId,
        projectId,
        sourceId: trigger.source,
        triggerId,
        message: `Dropped queued trigger update for closed session ${sendBatch.sessionId}`,
        details: {
          reason: "closed_session",
          sessionState: session.state,
        },
      });
      logger.warn(
        `[trigger:${projectId}/${triggerId}] dropped queued update for ${session.state} session ${sendBatch.sessionId}`,
      );
      return;
    }

    if (isBlockedAwaitingRecovery(session)) {
      return; // batch already queued above; explicitly deferred
    }

    // Same position as flushPending's hold: after isBlockedAwaitingRecovery,
    // before any attempt accounting. The batch is already persisted above
    // and the flush loop already scheduled, so the hold loses nothing.
    if (memoryHoldEngaged()) {
      return;
    }

    if (!isSendTriggerAllowed(session, triggerId)) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: sendBatch.sessionId,
        projectId,
        sourceId: trigger.source,
        triggerId,
        message: `Dropped queued trigger update for ${sendBatch.sessionId}: trigger ${triggerId} is not allowed`,
        details: {
          reason: "trigger_not_allowed",
        },
      });
      logger.warn(
        `[trigger:${projectId}/${triggerId}] dropped queued update: trigger not allowed for ${sendBatch.sessionId}`,
      );
      return;
    }

    if (batch.eventName.endsWith(":ci_failed")) {
      await flushPending(queueKey, batch);
      return;
    }

    if (isStaleParked(session)) {
      await deliverBatch(queueKey, batch, false, session);
      return;
    }

    if (session.state !== "working" && session.state !== "needs_input") return;
    if (session.state === "needs_input" || !trigger.send.interrupt) return;

    const interruptedAt = interruptedKeys.get(queueKey);
    if (interruptedAt !== undefined) {
      if (!sessionRestartedSince(session, interruptedAt)) return;
      interruptedKeys.delete(queueKey);
    }

    interruptedKeys.set(queueKey, Date.now());
    await deliverBatch(queueKey, batch, true, session);
  };

  // Reloads batches persisted by earlier `recordPendingSendBatch` calls (see
  // `handleSendEvent`) so an hourly daemon restart no longer silently drops
  // queued trigger notifications. Runs once at startup, before the flush loop
  // takes over normal delivery.
  const reloadPendingBatches = (): void => {
    const persisted = readPendingSendBatches(deps.config.dataDir);
    if (persisted.size === 0) return;

    for (const record of persisted.values()) {
      const project = deps.config.projects[record.projectId];
      const trigger = project?.triggers[record.triggerId];
      const sendTrigger =
        trigger && isSendTrigger(trigger) && trigger.source === record.sourceId ? trigger : null;
      const batch = sendTrigger ? restoreSendBatch(record.batch) : null;

      if (!sendTrigger || !batch) {
        const reason = sendTrigger ? "invalid_payload" : "trigger_missing_or_changed";
        deletePendingSendBatch(deps.config.dataDir, record.queueKey);
        logTriggerEvent(deps.config.dataDir, "trigger.send.restore_skipped", {
          level: "warn",
          sessionId: record.batch.sessionId,
          projectId: record.projectId,
          sourceId: record.sourceId,
          triggerId: record.triggerId,
          message: `Skipped restoring persisted trigger update ${record.queueKey}: ${reason === "trigger_missing_or_changed" ? "trigger missing or changed" : "invalid payload"}`,
          details: {
            queueKey: record.queueKey,
            reason,
          },
        });
        continue;
      }

      const destination = { kind: "session" as const, sessionId: batch.sessionId };
      const route = buildAutoPingRoute(
        deps.config,
        record.projectId,
        record.triggerId,
        sendTrigger,
        destination,
      );
      if (!route) {
        deletePendingSendBatch(deps.config.dataDir, record.queueKey);
        continue;
      }
      const routeFingerprint = autoPingRouteFingerprint(route);
      const storedPolicy = batch.serialize().autoPing;
      if (
        storedPolicy &&
        (storedPolicy.routeFingerprint !== routeFingerprint ||
          storedPolicy.destination.sessionId !== batch.sessionId)
      ) {
        deletePendingSendBatch(deps.config.dataDir, record.queueKey);
        logTriggerEvent(deps.config.dataDir, "trigger.send.restore_skipped", {
          level: "warn",
          sessionId: batch.sessionId,
          projectId: record.projectId,
          sourceId: record.sourceId,
          triggerId: record.triggerId,
          message: `Skipped restoring persisted trigger update ${record.queueKey}: route changed`,
          details: { reason: "route_changed", queueKey: record.queueKey },
        });
        continue;
      }
      const routeLeaseId = leaseForRoute(routeFingerprint, route);
      const needsMigration =
        !record.batch.autoPing || record.workId === undefined || record.revision === undefined;
      if (!record.batch.autoPing) {
        const occurrenceId = randomUUID();
        batch.attachAutoPing({
          occurrenceId,
          routeFingerprint,
          destination,
          createGrant: (scope, target) =>
            autoPing.createGrant({
              scope,
              routeFingerprint,
              destination,
              target,
              actorSessionId: batch.sessionId,
            }).handle,
        });
      }
      const workId = record.workId ?? randomUUID();
      const revision = needsMigration ? (record.revision ?? 0) + 1 : (record.revision ?? 1);
      if (needsMigration) {
        recordPendingSendBatch(deps.config.dataDir, {
          ...record,
          workId,
          revision,
          batch: batch.serialize(),
        });
      }

      pendingBatches.set(record.queueKey, {
        projectId: record.projectId,
        triggerId: record.triggerId,
        sourceId: record.sourceId,
        eventName: sendTrigger.event,
        customPrompt: sendTrigger.send.prompt,
        customPromptRecorded: false,
        batch,
        notBeforeAt: Date.now() + sendWindowMs(batch),
        routeFingerprint,
        destination,
        workId,
        revision,
        routeLeaseId,
        retryAccounting: reconcileRetryAccounting(batch, record.retryAccounting ?? []),
        admissionCapRetryAt: record.admissionCapRetryAt,
        admissionCapDenials: record.admissionCapDenials,
      });
      const restored = pendingBatches.get(record.queueKey);
      if (restored) syncBatchOccurrenceReferences(record.queueKey, restored);
      logTriggerEvent(deps.config.dataDir, "trigger.send.restored", {
        level: "info",
        sessionId: batch.sessionId,
        projectId: record.projectId,
        sourceId: record.sourceId,
        triggerId: record.triggerId,
        message: `Restored persisted trigger update ${record.queueKey} from disk`,
        details: {
          queueKey: record.queueKey,
        },
      });
    }

    scheduleFlushLoop();
  };

  const configuredRouteAuthorities: AutoPingRouteDescriptor[] = [];
  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [triggerId, trigger] of Object.entries(project.triggers)) {
      if (!isSendTrigger(trigger)) continue;
      const route = buildAutoPingRoute(deps.config, projectId, triggerId, trigger, {
        kind: "session",
        sessionId: "*",
      });
      if (!route) continue;
      configuredRouteAuthorities.push(route);
    }
  }
  autoPing.setConfiguredRouteAuthorities(configuredRouteAuthorities);
  reloadPendingBatches();
  for (const work of pendingSpawns.values()) enqueue(spawnQueueKey(work), () => flushSpawn(work));
  scheduleFlushLoop();

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [triggerId, trigger] of Object.entries(project.triggers)) {
      const source = project.sources[trigger.source];
      if (!source) continue;
      const parseSendBatch = createSendBatchParser(
        source.type,
        projectId,
        trigger.source,
        "send" in trigger ? trigger.send.prompt : undefined,
      );
      const sourceSpawnTriggerIds = new Set(
        Object.entries(project.triggers)
          .filter(([, other]) => !isSendTrigger(other) && other.source === trigger.source)
          .map(([otherId]) => otherId),
      );
      const unsubscribe = deps.bus.subscribe((event) => {
        if (stopped) return;
        if (event.projectId !== projectId) return;
        if (event.sourceId !== trigger.source) return;
        if (event.name !== trigger.event) return;

        if (isSendTrigger(trigger)) {
          // Keep this runtime source-agnostic. Source-specific batching,
          // formatting, and stale pruning live beside the source payload.
          const sendBatch = parseSendBatch(event.data);
          if (!sendBatch) {
            logTriggerEvent(deps.config.dataDir, "trigger.send.ignored", {
              level: "warn",
              projectId,
              sourceId: event.sourceId,
              triggerId,
              message: `Ignored ${event.name} for ${projectId}/${triggerId}: incompatible payload`,
            });
            logger.warn(
              `[trigger:${projectId}/${triggerId}] ignored ${event.name} without compatible send payload`,
            );
            return;
          }
          const queueKey = createQueueKey(projectId, triggerId, sendBatch.sessionId);
          enqueue(queueKey, async () => {
            await handleSendEvent(
              projectId,
              triggerId,
              event.name,
              event.occurrenceId,
              trigger,
              sendBatch,
            );
          });
          return;
        }

        const workItemData =
          WORK_ITEM_NEW_EVENT_NAMES.has(event.name) && isWorkItemEventData(event.data)
            ? event.data
            : null;
        if (workItemData) {
          const queueKey = `${projectId}:${triggerId}:${event.sourceId}:work-item:${workItemData.externalId}`;
          enqueue(queueKey, async () => {
            const fenced = await reconcileLegacyWorkItemJournal(
              deps.config,
              deps.sessionService,
              projectId,
              triggerId,
              event.sourceId,
              trigger,
              workItemData,
              () => !stopped,
            );
            if (fenced === null || stopped) return;
            await runSpawnTrigger(
              deps.config.dataDir,
              deps.sessionService,
              projectId,
              triggerId,
              event.sourceId,
              event.name,
              trigger.spawn.blocks,
              trigger.spawn.autoComplete,
              trigger.spawn.restrictWrites,
              trigger.spawn.allowedTriggers,
              trigger.spawnDeskGroup,
              event.data,
              sourceSpawnTriggerIds,
              logger,
              undefined,
              fenced,
            );
          });
          return;
        }
        const workId = JSON.stringify([projectId, event.sourceId, triggerId, event.occurrenceId]);
        if (pendingSpawns.has(workId)) return;
        const work: PersistedSpawnWork = {
          workId,
          revision: 0,
          projectId,
          triggerId,
          sourceId: event.sourceId,
          eventName: event.name,
          occurrenceId: event.occurrenceId,
          routeFingerprint: spawnRouteFingerprint(deps.config, projectId, triggerId, trigger),
          eventData: structuredClone(event.data),
          createdAt: new Date().toISOString(),
          nextBlockIndex: 0,
          failures: [],
          admissionDenials: 0,
          notBeforeAt: 0,
          blocks: trigger.spawn.blocks.map((_, index) => ({
            birthKey: `${workId}:${index}`,
            state: "pending",
          })),
        };
        if (!writePendingSpawnWork(deps.config.dataDir, work)) return;
        pendingSpawns.set(workId, work);
        enqueue(spawnQueueKey(work), () => flushSpawn(work));
        scheduleFlushLoop();
      });

      unsubscribers.push(unsubscribe);

      if (!isSendTrigger(trigger) && trigger.spawn.autoComplete === true) {
        autoCompleteChecks.push(() => {
          const queueKey = `${projectId}:${triggerId}:${trigger.source}:work-item-auto-complete`;
          enqueue(queueKey, async () => {
            await runWorkItemAutoCompleteTrigger(
              deps.config.dataDir,
              deps.sessionService,
              projectId,
              triggerId,
              trigger.source,
              logger,
            );
          });
        });
      }
    }
  }

  if (autoCompleteChecks.length > 0) {
    for (const check of autoCompleteChecks) {
      check();
    }
    autoCompleteTimer = setInterval(() => {
      if (stopped) return;
      for (const check of autoCompleteChecks) {
        check();
      }
    }, WORK_ITEM_AUTO_COMPLETE_CHECK_INTERVAL_MS);
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      for (const [queueKey, batch] of pendingBatches) {
        logTriggerEvent(deps.config.dataDir, "trigger.send.persisted_on_stop", {
          level: "info",
          sessionId: batch.batch.sessionId,
          projectId: batch.projectId,
          sourceId: batch.sourceId,
          triggerId: batch.triggerId,
          message: `Trigger runtime stopping with a persisted pending update for ${batch.batch.sessionId}`,
          details: {
            queueKey,
          },
        });
      }
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      for (const timer of interactiveFlushTimers) clearTimeout(timer);
      interactiveFlushTimers.clear();
      if (autoCompleteTimer) {
        clearInterval(autoCompleteTimer);
        autoCompleteTimer = null;
      }
      for (let index = unsubscribers.length - 1; index >= 0; index -= 1) {
        try {
          unsubscribers[index]?.();
        } catch {
          // Best effort shutdown.
        }
      }

      if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      for (const [queueKey, batch] of pendingBatches) {
        clearBatch(queueKey, batch, { deletePersisted: false });
      }
      for (const leaseId of routeLeases.values()) autoPing.releaseRoute(leaseId);
      routeLeases.clear();
    },
  };
}
