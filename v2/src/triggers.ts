import { randomUUID } from "node:crypto";
import { autoPingRouteFingerprint, type AutoPingService } from "./auto-ping.js";
import { writeStderr } from "./io.js";
import { renderSpawnPrompt } from "./prompt-template.js";
import { logSpurEvent, logUserInputEvent, type SpurLogEntry } from "./event-log.js";
import {
  createSendBatchParser,
  isReviewEventData,
  isTelegramMessageEventData,
  restoreSendBatch,
  type SendBatch,
} from "./send-batches.js";
import {
  deletePendingSendBatch,
  deletePendingSendBatchConditional,
  readPendingSendBatch,
  deleteWorkItemLifecycle,
  readPendingSendBatches,
  readWorkItemLifecycles,
  recordPendingSendBatch,
  updatePendingSendBatchConditional,
  recordWorkItemLifecycle,
} from "./metadata.js";
import {
  isStaleParked,
  WORK_ITEM_NEW_EVENT_NAMES,
  type AppConfig,
  type AutoPingDestination,
  type AutoPingRouteDescriptor,
  type AutoPingThreadTarget,
  type SendTriggerConfig,
  type SessionView,
  type TriggerSpawnBlockConfig,
  type SpawnTriggerConfig,
  type WorkItemEventData,
} from "./types.js";
import type { EventBus } from "./event-bus.js";
import {
  getIdleWaitBeforeFlushMs,
  isIdleEnoughToReceive,
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
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number | null;
  interrupt: boolean;
}

interface DeliveryFailure {
  attempts: number;
  nextAttemptAt: number;
  recordedAt: number;
}

// Rate-limit suppression is deliberately excluded from the failure/backoff
// path: the target session is still alive and will accept the batch once the
// rate limit clears, so it must not count toward DELIVERY_MAX_ATTEMPTS or
// trigger a drop.
type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "suppressed" }
  | { status: "failed"; error: string };

type WorkItemLifecycleBaseDraft = WorkItemEventData & {
  autoComplete: boolean;
  createdAt: string;
};

const DEFAULT_TRIGGER_LOGGER: TriggerLogger = {
  warn: writeStderr,
};
const CI_FAILED_RETRY_INTERVAL_MS = 10 * 60_000;
const CI_FAILED_MAX_ATTEMPTS = 3;
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
const DELIVERY_MAX_ATTEMPTS = 8;
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
function isLiveServerErrorWedge(session: SessionView): boolean {
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

function autoPingThreadTargets(data: unknown): AutoPingThreadTarget[] {
  if (isReviewEventData(data)) {
    const targets = data.signals.flatMap((signal) =>
      signal.providerThreadTarget ? [signal.providerThreadTarget] : [],
    );
    return [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()];
  }
  if (isTelegramMessageEventData(data) && data.messageThreadId !== undefined) {
    return [
      {
        kind: "telegram-topic",
        chatId: data.chatId,
        messageThreadId: data.messageThreadId,
      },
    ];
  }
  return [];
}

function createWorkItemLifecycleBase(
  workItemData: WorkItemEventData,
  autoComplete: boolean,
): WorkItemLifecycleBaseDraft {
  return {
    ...workItemData,
    autoComplete,
    createdAt: new Date().toISOString(),
  };
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

async function shouldClaimWorkItemSpawn(
  dataDir: string,
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  workItemData: WorkItemEventData,
  autoComplete: boolean,
  logger: TriggerLogger,
): Promise<boolean> {
  const existing = readWorkItemLifecycles(dataDir, projectId, sourceId).get(
    workItemData.externalId,
  );
  if (existing?.state === "pending" || existing?.state === "completed") {
    return false;
  }
  if (existing?.state === "running") {
    try {
      const session = await service.get(existing.sessionId);
      if (session.status === "completed") {
        recordWorkItemLifecycle(dataDir, projectId, sourceId, {
          ...existing,
          state: "completed",
          completedAt: new Date().toISOString(),
        });
        return false;
      }
      if (
        session.status === "running" &&
        (ACTIVE_WORK_ITEM_STATES.has(session.state) || isLiveServerErrorWedge(session))
      ) {
        return false;
      }
      if (!sessionAllowsWorkItemReplacement(session)) {
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isSessionNotFoundError(message)) {
        logTriggerEvent(dataDir, "trigger.spawn.suppressed", {
          level: "warn",
          sessionId: existing.sessionId,
          projectId,
          sourceId,
          triggerId,
          message: `Suppressed work item ${workItemData.externalId}: failed to load owner ${existing.sessionId}: ${message}`,
          details: {
            externalId: workItemData.externalId,
          },
        });
        logger.warn(
          `[trigger:${projectId}/${triggerId}] suppressed work item ${workItemData.externalId}: ${message}`,
        );
        return false;
      }
    }
  }

  recordWorkItemLifecycle(dataDir, projectId, sourceId, {
    ...createWorkItemLifecycleBase(workItemData, autoComplete),
    state: "pending",
  });
  return true;
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
  logger: TriggerLogger,
  autoPing: AutoPingService,
  routeFingerprint: string,
  destination: AutoPingDestination,
  occurrenceId: string,
): Promise<void> {
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

  try {
    if (autoComplete && !workItemData) {
      throw new Error(`Cannot auto-complete ${eventName}: incompatible work-item payload`);
    }
    if (autoPing.isSuppressed(routeFingerprint, destination, occurrenceId)) {
      return;
    }
    let filteredEventData = eventData;
    if (isReviewEventData(eventData)) {
      const signals = eventData.signals.filter(
        (signal) =>
          !signal.providerThreadTarget ||
          !autoPing.isSuppressed(
            routeFingerprint,
            destination,
            occurrenceId,
            signal.providerThreadTarget,
          ),
      );
      if (signals.length === 0) return;
      filteredEventData = { ...eventData, signals };
    } else {
      const threadTargets = autoPingThreadTargets(eventData);
      if (
        threadTargets.length > 0 &&
        threadTargets.every((target) =>
          autoPing.isSuppressed(routeFingerprint, destination, occurrenceId, target),
        )
      ) {
        return;
      }
    }
    if (
      workItemData &&
      !(await shouldClaimWorkItemSpawn(
        dataDir,
        service,
        projectId,
        triggerId,
        sourceId,
        workItemData,
        autoComplete === true,
        logger,
      ))
    ) {
      logTriggerEvent(dataDir, "trigger.spawn.suppressed", {
        level: "info",
        projectId,
        sourceId,
        triggerId,
        message: `Suppressed duplicate work item ${workItemData.externalId}`,
        details: {
          eventName,
          externalId: workItemData.externalId,
        },
      });
      return;
    }

    let anchorSessionId: string | undefined;
    let controlsAssigned = false;
    const threadTargets = autoPingThreadTargets(filteredEventData);
    for (const [blockIndex, block] of blocks.entries()) {
      const isAnchorBlock = deskGroup === true && anchorSessionId === undefined;
      if (isAnchorBlock && blockIndex > 0) {
        logger.warn(
          `[trigger:${projectId}/${triggerId}] promoting spawn block ${blockIndex} to desk anchor: earlier anchor spawn failed`,
        );
      }
      try {
        const renderedPrompt = renderSpawnPrompt(block.prompt, filteredEventData);
        const grants = controlsAssigned
          ? []
          : [
              {
                scope: "event" as const,
                target: { kind: "occurrence" as const, occurrenceId },
              },
              ...threadTargets.map((target) => ({ scope: "thread" as const, target })),
              { scope: "subscription" as const, target: { kind: "subscription" as const } },
            ].map(({ scope, target }) => ({
              scope,
              ...autoPing.createGrant({ scope, routeFingerprint, destination, target }),
            }));
        const sensitivePromptSuffix =
          grants.length > 0
            ? [
                "Automatic ping controls (handles are session credentials):",
                ...grants.map(
                  (grant) =>
                    `- "$SPUR_SESSION_TOOL_DIR/spur" auto-ping unsubscribe --${grant.scope} ${grant.handle}`,
                ),
                "Grant activation is still finishing. If the command reports grant_not_ready, retry the same command.",
              ].join("\n")
            : undefined;
        const blockRestrictWrites = block.restrictWrites ?? restrictWrites;
        const spawnRequest = {
          project: projectId,
          prompt: renderedPrompt,
          ...(block.steps !== undefined ? { steps: block.steps } : {}),
          ...(block.agent !== undefined ? { agent: block.agent } : {}),
          ...(block.model !== undefined ? { model: block.model } : {}),
          ...(block.mode !== undefined ? { mode: block.mode } : {}),
          ...(block.branch !== undefined ? { branch: block.branch } : {}),
          ...(block.overrides !== undefined ? { overrides: block.overrides } : {}),
          ...(block.selfDestruct !== undefined ? { selfDestruct: block.selfDestruct } : {}),
          ...(blockRestrictWrites === true ? { restrictWrites: true } : {}),
          ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
          ...(workItemData ? { slots: { links: [{ label: "pr", url: workItemData.url }] } } : {}),
          ...(deskGroup === true && anchorSessionId !== undefined
            ? { reuseWorkspaceSessionId: anchorSessionId }
            : {}),
        };
        let session: SessionView;
        try {
          session = sensitivePromptSuffix
            ? await service.spawn(spawnRequest, { sensitivePromptSuffix })
            : await service.spawn(spawnRequest);
        } catch (error) {
          for (const grant of grants) autoPing.revokeGrant(grant.handleHash);
          throw error;
        }
        for (const grant of grants) autoPing.bindGrant(grant.handleHash, session.id);
        if (grants.length > 0) controlsAssigned = true;
        if (isAnchorBlock) {
          anchorSessionId = session.id;
        }
        if (workItemData) {
          recordWorkItemLifecycle(dataDir, projectId, sourceId, {
            ...createWorkItemLifecycleBase(workItemData, autoComplete === true),
            state: "running",
            sessionId: session.id,
          });
        }
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (workItemData) {
          recordWorkItemLifecycle(dataDir, projectId, sourceId, {
            ...createWorkItemLifecycleBase(workItemData, autoComplete === true),
            state: "failed",
            error: message,
          });
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
    const message = error instanceof Error ? error.message : String(error);
    if (workItemData) {
      recordWorkItemLifecycle(dataDir, projectId, sourceId, {
        ...createWorkItemLifecycleBase(workItemData, autoComplete === true),
        state: "failed",
        error: message,
      });
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
    const createdAt = Date.parse(lifecycle.createdAt);
    if (!Number.isFinite(createdAt)) {
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

    if (now - createdAt < WORK_ITEM_AUTO_COMPLETE_MIN_AGE_MS) {
      continue;
    }

    try {
      const session = await service.get(lifecycle.sessionId);
      if (session.status === "completed") {
        recordWorkItemLifecycle(dataDir, projectId, sourceId, {
          ...lifecycle,
          state: "completed",
          completedAt: new Date().toISOString(),
        });
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
      recordWorkItemLifecycle(dataDir, projectId, sourceId, {
        ...lifecycle,
        state: "completed",
        completedAt: new Date().toISOString(),
      });
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
        deleteWorkItemLifecycle(dataDir, projectId, sourceId, lifecycle.externalId);
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

function isDeliverableState(session: SessionView): boolean {
  return (
    session.state === "stale" ||
    (session.state === "waiting" &&
      isIdleEnoughToReceive(session.lastActivityAt, getIdleWaitBeforeFlushMs()))
  );
}

// "stale" is deliberately never closed: a parked session has no live agent to
// interrupt, so it must stay deliverable rather than dropping the batch.
function isClosedState(state: SessionView["state"]): boolean {
  return state === "stopped" || state === "error" || state === "killed";
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
    existing.batch.merge(incoming);
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
    notBeforeAt: Date.now() + getIdleWaitBeforeFlushMs(),
    routeFingerprint: policy.routeFingerprint,
    destination: policy.destination,
    workId: randomUUID(),
    revision: 1,
    routeLeaseId: policy.routeLeaseId,
  };
}

function buildAutoPingRoute(
  config: AppConfig,
  projectId: string,
  triggerId: string,
  trigger: SpawnTriggerConfig | SendTriggerConfig,
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
    actionKind: isSendTrigger(trigger) ? "send" : "spawn",
    destination,
    spawnDeskGroup: "spawn" in trigger && trigger.spawnDeskGroup === true,
  };
}

function logTriggerEvent(
  dataDir: string,
  event: string,
  entry: Omit<SpurLogEntry, "timestamp" | "event">,
): void {
  logSpurEvent(dataDir, { event, ...entry });
}

export function startConfiguredTriggers(deps: StartConfiguredTriggersDeps): TriggerGroupController {
  const logger = deps.logger ?? DEFAULT_TRIGGER_LOGGER;
  const autoPing = deps.autoPing;
  const unsubscribers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  const pendingBatches = new Map<string, PendingBatch>();
  const interruptedKeys = new Map<string, number>();
  const retryStates = new Map<string, RetryState>();
  const deliveryFailures = new Map<string, DeliveryFailure>();
  const serialByKey = new Map<string, Promise<void>>();
  const routeLeases = new Map<string, string>();
  const occurrenceReferencesByQueue = new Map<string, Set<string>>();
  const autoCompleteChecks: Array<() => void> = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let autoCompleteTimer: NodeJS.Timeout | null = null;
  let stopped = false;

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
      keepRetryState?: boolean;
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
    deliveryFailures.delete(queueKey);
    if (options?.deletePersisted !== false) {
      deletePendingSendBatchConditional(deps.config.dataDir, { workId: batch.workId });
    }
    if (!options?.keepInterrupted) {
      interruptedKeys.delete(queueKey);
    }
    if (!options?.keepRetryState) {
      retryStates.delete(queueKey);
    }
    if (flushTimer && pendingBatches.size === 0) {
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
    options?: { attempt?: number; clearAfter?: boolean; keepRetryState?: boolean },
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
      batch.revision = persisted.revision ?? 0;
      syncBatchOccurrenceReferences(queueKey, batch);
      const claimId = randomUUID();
      const claimedRevision = (persisted.revision ?? 0) + 1;
      const claimed = {
        ...persisted,
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
      batch.batch.filterAutoPing((occurrenceId, threadTarget) =>
        autoPing.isSuppressed(
          batch.routeFingerprint,
          batch.destination,
          occurrenceId,
          threadTarget,
        ),
      );
      syncBatchOccurrenceReferences(queueKey, batch);
      if (batch.batch.isEmpty()) {
        const deleted = deletePendingSendBatchConditional(deps.config.dataDir, {
          workId: batch.workId,
          revision: claimedRevision,
          claimId,
        });
        if (deleted) clearBatch(queueKey, batch, { deletePersisted: false });
        return { status: "suppressed" };
      }
      try {
        await deps.sessionService.deliver(batch.batch.sessionId, batch.batch.format(), {
          interrupt,
          sensitivePromptSuffix: batch.batch.formatAutoPingControls(),
        });
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
            attempt: options?.attempt ?? null,
          },
        });
        if (options?.clearAfter !== false) {
          const deleted = deletePendingSendBatchConditional(deps.config.dataDir, {
            workId: batch.workId,
            revision: claimedRevision,
            claimId,
          });
          const clearOptions: { keepInterrupted?: boolean; keepRetryState?: boolean } = {
            keepInterrupted: interrupt,
          };
          if (options?.keepRetryState !== undefined) {
            clearOptions.keepRetryState = options.keepRetryState;
          }
          if (deleted) clearBatch(queueKey, batch, { ...clearOptions, deletePersisted: false });
        }
        return { status: "delivered" };
      } catch (error) {
        if (error instanceof SessionRateLimitedError) {
          logTriggerEvent(deps.config.dataDir, "trigger.send.suppressed_rate_limited", {
            level: "info",
            sessionId: batch.batch.sessionId,
            projectId: batch.projectId,
            sourceId: batch.sourceId,
            triggerId: batch.triggerId,
            message: `Suppressed queued trigger update to ${batch.batch.sessionId} while rate limited`,
            details: {
              interrupt,
              attempt: options?.attempt ?? null,
            },
          });
          const { claim: _claim, ...unclaimed } = claimed;
          void _claim;
          const retryRecord = { ...unclaimed, revision: claimedRevision + 1 };
          updatePendingSendBatchConditional(
            deps.config.dataDir,
            { workId: batch.workId, revision: claimedRevision, claimId },
            retryRecord,
          );
          batch.revision = claimedRevision + 1;
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
            attempt: options?.attempt ?? null,
          },
        });
        logger.warn(
          `[trigger:${batch.projectId}/${batch.triggerId}] failed to deliver queued updates: ${message}`,
        );
        const { claim: _claim, ...unclaimed } = claimed;
        void _claim;
        const retryRecord = {
          ...unclaimed,
          revision: claimedRevision + 1,
        };
        updatePendingSendBatchConditional(
          deps.config.dataDir,
          { workId: batch.workId, revision: claimedRevision, claimId },
          retryRecord,
        );
        batch.revision = claimedRevision + 1;
        return { status: "failed", error: message };
      }
    });
  };

  const scheduleFlushLoop = (): void => {
    if (flushTimer || pendingBatches.size === 0 || stopped) return;
    flushTimer = setInterval(() => {
      for (const [queueKey, batch] of pendingBatches) {
        enqueue(queueKey, async () => {
          await flushPending(queueKey, batch);
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

  const loadSessionOrClear = async (
    queueKey: string,
    batch: PendingBatch,
  ): Promise<SessionView | null> => {
    try {
      return await deps.sessionService.get(batch.batch.sessionId);
    } catch (error) {
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

  const ensureRetryState = (queueKey: string, interrupt: boolean): RetryState => {
    const existing = retryStates.get(queueKey);
    if (existing) return existing;
    const created = { attempts: 0, nextAttemptAt: null, interrupt };
    retryStates.set(queueKey, created);
    return created;
  };

  // Accounts for a delivery that threw. Backs off exponentially and, once the
  // attempt cap is hit, drops the batch and logs it instead of spamming the
  // target forever. The give-up is recorded in the event log (and stderr) so a
  // permanently-failing delivery is visible to an operator.
  const recordDeliveryFailure = (
    queueKey: string,
    batch: PendingBatch,
    interrupt: boolean,
    reason: string,
  ): void => {
    const attempts = (deliveryFailures.get(queueKey)?.attempts ?? 0) + 1;
    if (attempts >= DELIVERY_MAX_ATTEMPTS) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "warn",
        sessionId: batch.batch.sessionId,
        projectId: batch.projectId,
        sourceId: batch.sourceId,
        triggerId: batch.triggerId,
        message: `Dropped queued trigger update for ${batch.batch.sessionId} after ${attempts} failed delivery attempts: ${reason}`,
        details: {
          reason: "retry_exhausted",
          attempts,
          interrupt,
        },
      });
      logger.warn(
        `[trigger:${batch.projectId}/${batch.triggerId}] dropped queued updates for ${batch.batch.sessionId} after ${attempts} attempts: ${reason}`,
      );
      return;
    }
    const now = Date.now();
    const backoff = DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1);
    deliveryFailures.set(queueKey, { attempts, nextAttemptAt: now + backoff, recordedAt: now });
  };

  const isInDeliveryBackoff = (queueKey: string): boolean => {
    const failure = deliveryFailures.get(queueKey);
    return failure !== undefined && Date.now() < failure.nextAttemptAt;
  };

  // Clears a stale delivery-failure entry when the session has restarted since
  // the failure was recorded. A restart invalidates the prior failure context,
  // so backoff should not block the fresh session.
  const clearBackoffIfRestarted = (queueKey: string, session: SessionView): void => {
    const failure = deliveryFailures.get(queueKey);
    if (failure && sessionRestartedSince(session, failure.recordedAt)) {
      deliveryFailures.delete(queueKey);
    }
  };

  // Delivers outside the CI-failed retry path and, on a thrown error, feeds
  // the result into the delivery-failure backoff. Every non-retry call site
  // needs this same branch, so it lives here once.
  const deliverAndTrackFailure = async (
    queueKey: string,
    batch: PendingBatch,
    interrupt: boolean,
  ): Promise<void> => {
    const result = await deliverBatch(queueKey, batch, interrupt);
    if (result.status !== "failed") return;
    // A delivery decided against a live state can still land after a pause or
    // restore has torn the pane down — the send then fails with "can't find
    // session". That is the pane going away mid-flight, not the target
    // rejecting the message, and the backoff it would open (10s, doubling)
    // spans exactly the window the restore replay has to be delivered in.
    // Re-read the state at failure time: a closed session leaves the batch
    // queued for the flush loop instead.
    const current = await loadSessionOrClear(queueKey, batch);
    if (current && isClosedState(current.state)) return;
    recordDeliveryFailure(queueKey, batch, interrupt, result.error);
  };

  const flushPending = async (queueKey: string, batch: PendingBatch): Promise<void> => {
    if (!pendingBatches.has(queueKey)) return;

    const session = await loadSessionOrClear(queueKey, batch);
    if (!session) return;

    if (isClosedState(session.state) && !isLiveServerErrorWedge(session)) {
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

    batch.batch.prune(deps.config.dataDir);
    if (batch.batch.isEmpty()) {
      clearBatch(queueKey, batch);
      logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
        level: "info",
        sessionId: batch.batch.sessionId,
        projectId: batch.projectId,
        sourceId: batch.sourceId,
        triggerId: batch.triggerId,
        message: `Dropped queued trigger update for ${batch.batch.sessionId} after snapshot prune`,
        details: {
          reason: "snapshot_pruned",
        },
      });
      return;
    }

    const deliverable = isDeliverableState(session);
    const retry = retryStates.get(queueKey);
    if (retry) {
      if (retry.attempts >= CI_FAILED_MAX_ATTEMPTS) {
        clearBatch(queueKey, batch);
        logTriggerEvent(deps.config.dataDir, "trigger.send.dropped", {
          level: "warn",
          sessionId: batch.batch.sessionId,
          projectId: batch.projectId,
          sourceId: batch.sourceId,
          triggerId: batch.triggerId,
          message: `Dropped queued trigger update for ${batch.batch.sessionId} after max retries`,
          details: {
            reason: "retry_exhausted",
            attempts: retry.attempts,
          },
        });
        return;
      }

      const interrupt = retry.interrupt && session.state === "working";
      if (!deliverable && !interrupt) {
        return;
      }

      const now = Date.now();
      if (retry.nextAttemptAt !== null && now < retry.nextAttemptAt) {
        return;
      }

      // Escalation (interrupt=true, working) bypasses the window gate.
      if (!interrupt && now < batch.notBeforeAt) {
        return;
      }

      retry.attempts += 1;
      retry.nextAttemptAt =
        retry.attempts < CI_FAILED_MAX_ATTEMPTS ? now + CI_FAILED_RETRY_INTERVAL_MS : null;
      await deliverBatch(queueKey, batch, interrupt, {
        attempt: retry.attempts,
        clearAfter: false,
        keepRetryState: true,
      });
      return;
    }

    clearBackoffIfRestarted(queueKey, session);
    if (isInDeliveryBackoff(queueKey)) return;

    if (deliverable) {
      if (!isStaleParked(session) && Date.now() < batch.notBeforeAt) return;
      interruptedKeys.delete(queueKey);
      await deliverAndTrackFailure(queueKey, batch, false);
      return;
    }

    // Pending interrupt batch whose previous delivery failed: retry while the
    // session is still working. `clearBatch` only runs on success, so reaching
    // here means the prior deliverBatch threw.
    if (session.state === "working" && interruptedKeys.has(queueKey)) {
      await deliverAndTrackFailure(queueKey, batch, true);
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
          cached.revision = persisted.revision ?? 0;
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
    if (eventName.endsWith(":ci_failed")) {
      ensureRetryState(queueKey, trigger.send.interrupt);
    }
    scheduleFlushLoop();

    const session = await loadSessionOrClear(queueKey, batch);
    if (!session) return;

    if (isClosedState(session.state) && !isLiveServerErrorWedge(session)) {
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

    if (retryStates.has(queueKey)) {
      await flushPending(queueKey, batch);
      return;
    }

    // A delivery already failing its backoff window stays queued for the flush
    // loop; a fresh event must not bypass the backoff and re-spam the target.
    // If the session restarted since the failure, the stale backoff is cleared.
    clearBackoffIfRestarted(queueKey, session);
    if (isInDeliveryBackoff(queueKey)) return;

    if (isStaleParked(session)) {
      await deliverAndTrackFailure(queueKey, batch, false);
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
    await deliverAndTrackFailure(queueKey, batch, true);
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
        notBeforeAt: Date.now() + getIdleWaitBeforeFlushMs(),
        routeFingerprint,
        destination,
        workId,
        revision,
        routeLeaseId,
      });
      const restored = pendingBatches.get(record.queueKey);
      if (restored) syncBatchOccurrenceReferences(record.queueKey, restored);
      // Without this, a restored ci_failed batch would skip the retry/backoff
      // branch entirely (no retryStates entry) and deliver once immediately
      // instead of resuming its retry-every-10-minutes/max-3-attempts cadence.
      if (sendTrigger.event.endsWith(":ci_failed")) {
        ensureRetryState(record.queueKey, sendTrigger.send.interrupt);
      }
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
      const route = buildAutoPingRoute(
        deps.config,
        projectId,
        triggerId,
        trigger,
        isSendTrigger(trigger) ? { kind: "session", sessionId: "*" } : { kind: "trigger" },
      );
      if (!route) continue;
      configuredRouteAuthorities.push(route);
      if (!isSendTrigger(trigger)) leaseForRoute(autoPingRouteFingerprint(route), route);
    }
  }
  autoPing.setConfiguredRouteAuthorities(configuredRouteAuthorities);
  reloadPendingBatches();

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [triggerId, trigger] of Object.entries(project.triggers)) {
      const source = project.sources[trigger.source];
      if (!source) continue;
      const spawnDestination = { kind: "trigger" as const };
      const spawnRoute = !isSendTrigger(trigger)
        ? buildAutoPingRoute(deps.config, projectId, triggerId, trigger, spawnDestination)
        : null;
      const spawnRouteFingerprint = spawnRoute ? autoPingRouteFingerprint(spawnRoute) : null;
      if (spawnRouteFingerprint && spawnRoute) leaseForRoute(spawnRouteFingerprint, spawnRoute);
      const parseSendBatch = createSendBatchParser(
        source.type,
        projectId,
        trigger.source,
        "send" in trigger ? trigger.send.prompt : undefined,
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
        const runSpawn = async (): Promise<void> => {
          if (!spawnRouteFingerprint) return;
          autoPing.addOccurrenceReference(spawnRouteFingerprint, event.occurrenceId);
          try {
            await autoPing.withRouteLock(spawnRouteFingerprint, () =>
              runSpawnTrigger(
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
                logger,
                autoPing,
                spawnRouteFingerprint,
                spawnDestination,
                event.occurrenceId,
              ),
            );
          } finally {
            autoPing.releaseOccurrenceReference(spawnRouteFingerprint, event.occurrenceId);
          }
        };
        if (workItemData) {
          const queueKey = `${projectId}:${triggerId}:${event.sourceId}:work-item:${workItemData.externalId}`;
          enqueue(queueKey, runSpawn);
          return;
        }
        const spawnPromise = runSpawn();
        inFlight.add(spawnPromise);
        void spawnPromise.finally(() => {
          inFlight.delete(spawnPromise);
        });
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
      for (const leaseId of routeLeases.values()) autoPing.releaseRoute(leaseId);
      routeLeases.clear();
    },
  };
}
