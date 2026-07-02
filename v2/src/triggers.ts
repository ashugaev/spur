import { writeStderr } from "./io.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { createSendBatchParser, type SendBatch } from "./send-batches.js";
import {
  deleteWorkItemLifecycle,
  readWorkItemLifecycles,
  recordWorkItemLifecycle,
} from "./metadata.js";
import {
  WORK_ITEM_NEW_EVENT_NAMES,
  type AppConfig,
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
  logger?: TriggerLogger;
}

interface PendingBatch {
  projectId: string;
  triggerId: string;
  sourceId: string;
  batch: SendBatch;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number | null;
  interrupt: boolean;
}

type WorkItemLifecycleBaseDraft = WorkItemEventData & {
  autoComplete: boolean;
  createdAt: string;
};

const DEFAULT_TRIGGER_LOGGER: TriggerLogger = {
  warn: writeStderr,
};
const CI_FAILED_RETRY_INTERVAL_MS = 10 * 60_000;
const CI_FAILED_MAX_ATTEMPTS = 3;
const WORK_ITEM_AUTO_COMPLETE_MIN_AGE_MS = 5 * 60_000;
const WORK_ITEM_AUTO_COMPLETE_CHECK_INTERVAL_MS = 30_000;
const PROMPT_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const ACTIVE_WORK_ITEM_STATES = new Set<SessionView["state"]>([
  "working",
  "waiting",
  "needs_input",
]);

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

function renderSpawnPrompt(template: string, data: unknown): string {
  return template.replace(PROMPT_PLACEHOLDER_RE, (match, key: string) => {
    if (!data || typeof data !== "object") {
      throw new Error(`Cannot render prompt placeholder ${match}: event data is unavailable`);
    }
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    throw new Error(`Cannot render prompt placeholder ${match}: event data.${key} is unavailable`);
  });
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

function sessionAllowsWorkItemReplacement(session: SessionView): boolean {
  return (
    session.status === "stopped" ||
    session.status === "errored" ||
    session.status === "killed" ||
    session.state === "stopped" ||
    session.state === "error" ||
    session.state === "killed"
  );
}

function sessionLaunchFailed(session: SessionView): boolean {
  return session.status === "errored" || session.state === "error";
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
      if (session.status === "running" && ACTIVE_WORK_ITEM_STATES.has(session.state)) {
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
  deskGroup: boolean | undefined,
  eventData: unknown,
  logger: TriggerLogger,
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
    for (const [blockIndex, block] of blocks.entries()) {
      if (deskGroup === true && blockIndex > 0 && anchorSessionId === undefined) {
        logger.warn(
          `[trigger:${projectId}/${triggerId}] skipping desk-group spawn blocks: anchor session failed`,
        );
        break;
      }
      try {
        const renderedPrompt = renderSpawnPrompt(block.prompt, eventData);
        const session = await service.spawnInBackground(
          {
            project: projectId,
            prompt: renderedPrompt,
            ...(block.steps !== undefined ? { steps: block.steps } : {}),
            ...(block.agent !== undefined ? { agent: block.agent } : {}),
            ...(block.branch !== undefined ? { branch: block.branch } : {}),
            ...(block.overrides !== undefined ? { overrides: block.overrides } : {}),
            ...(block.selfDestruct !== undefined ? { selfDestruct: block.selfDestruct } : {}),
            ...(workItemData ? { slots: { links: [{ label: "pr", url: workItemData.url }] } } : {}),
            ...(deskGroup === true && anchorSessionId !== undefined
              ? { reuseWorkspaceSessionId: anchorSessionId }
              : {}),
          },
          {
            onSettled: (settled) => {
              if (sessionLaunchFailed(settled)) {
                const message = settled.error ?? "background spawn failed";
                if (workItemData) {
                  recordWorkItemLifecycle(dataDir, projectId, sourceId, {
                    ...createWorkItemLifecycleBase(workItemData, autoComplete === true),
                    state: "failed",
                    error: message,
                  });
                }
                logTriggerEvent(dataDir, "trigger.spawn.failed", {
                  level: "error",
                  sessionId: settled.id,
                  projectId,
                  sourceId,
                  triggerId,
                  message: `Spawn trigger ${projectId}/${triggerId} failed: ${message}`,
                  details: {
                    eventName,
                    agent: block.agent ?? null,
                    background: true,
                    ...(deskGroup === true && blockIndex === 0 ? { deskGroup: true } : {}),
                  },
                });
                logger.warn(
                  block.agent
                    ? `[trigger:${projectId}/${triggerId}] failed to spawn ${block.agent}: ${message}`
                    : `[trigger:${projectId}/${triggerId}] failed to spawn: ${message}`,
                );
                return;
              }
              if (workItemData) {
                recordWorkItemLifecycle(dataDir, projectId, sourceId, {
                  ...createWorkItemLifecycleBase(workItemData, autoComplete === true),
                  state: "running",
                  sessionId: settled.id,
                });
              }
              logTriggerEvent(dataDir, "trigger.spawn.completed", {
                level: "info",
                sessionId: settled.id,
                projectId,
                sourceId,
                triggerId,
                message:
                  deskGroup === true && blockIndex === 0
                    ? `Spawn trigger ${projectId}/${triggerId} created desk anchor ${settled.id}`
                    : `Spawn trigger ${projectId}/${triggerId} created ${settled.id}`,
                details: {
                  eventName,
                  agent: block.agent ?? null,
                  background: true,
                  ...(deskGroup === true && blockIndex === 0 ? { deskGroup: true } : {}),
                },
              });
            },
          },
        );
        if (deskGroup === true && anchorSessionId === undefined) {
          anchorSessionId = session.id;
        }
        logTriggerEvent(dataDir, "trigger.spawn.queued", {
          level: "info",
          sessionId: session.id,
          projectId,
          sourceId,
          triggerId,
          message:
            deskGroup === true && blockIndex === 0
              ? `Spawn trigger ${projectId}/${triggerId} queued desk anchor ${session.id}`
              : `Spawn trigger ${projectId}/${triggerId} queued ${session.id}`,
          details: {
            eventName,
            agent: block.agent ?? null,
            background: true,
            ...(deskGroup === true && blockIndex === 0 ? { deskGroup: true } : {}),
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
    session.state === "waiting" &&
    isIdleEnoughToReceive(session.lastActivityAt, getIdleWaitBeforeFlushMs())
  );
}

function isClosedState(state: SessionView["state"]): boolean {
  return state === "stopped" || state === "error" || state === "killed";
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
  incoming: SendBatch,
): PendingBatch {
  if (existing) {
    existing.batch.merge(incoming);
    return existing;
  }
  return { projectId, triggerId, sourceId, batch: incoming };
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
  const unsubscribers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  const pendingBatches = new Map<string, PendingBatch>();
  const interruptedKeys = new Map<string, number>();
  const retryStates = new Map<string, RetryState>();
  const serialByKey = new Map<string, Promise<void>>();
  const autoCompleteChecks: Array<() => void> = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let autoCompleteTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const clearBatch = (
    queueKey: string,
    options?: { keepInterrupted?: boolean; keepRetryState?: boolean },
  ): void => {
    pendingBatches.delete(queueKey);
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

  const deliverBatch = async (
    queueKey: string,
    batch: PendingBatch,
    interrupt: boolean,
    options?: { attempt?: number; clearAfter?: boolean; keepRetryState?: boolean },
  ): Promise<void> => {
    try {
      await deps.sessionService.deliver(batch.batch.sessionId, batch.batch.format(), { interrupt });
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
        const clearOptions: { keepInterrupted?: boolean; keepRetryState?: boolean } = {
          keepInterrupted: interrupt,
        };
        if (options?.keepRetryState !== undefined) {
          clearOptions.keepRetryState = options.keepRetryState;
        }
        clearBatch(queueKey, clearOptions);
      }
    } catch (error) {
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
    }
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
      clearBatch(queueKey);
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

  const flushPending = async (queueKey: string, batch: PendingBatch): Promise<void> => {
    if (!pendingBatches.has(queueKey)) return;

    const session = await loadSessionOrClear(queueKey, batch);
    if (!session) return;

    if (isClosedState(session.state)) {
      clearBatch(queueKey);
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

    batch.batch.prune(deps.config.dataDir);
    if (batch.batch.isEmpty()) {
      clearBatch(queueKey);
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

    const retry = retryStates.get(queueKey);
    if (retry) {
      if (retry.attempts >= CI_FAILED_MAX_ATTEMPTS) {
        clearBatch(queueKey);
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

      if (!retry.interrupt && !isDeliverableState(session)) {
        return;
      }

      const now = Date.now();
      if (retry.nextAttemptAt !== null && now < retry.nextAttemptAt) {
        return;
      }

      retry.attempts += 1;
      retry.nextAttemptAt =
        retry.attempts < CI_FAILED_MAX_ATTEMPTS ? now + CI_FAILED_RETRY_INTERVAL_MS : null;
      await deliverBatch(queueKey, batch, retry.interrupt && !isDeliverableState(session), {
        attempt: retry.attempts,
        clearAfter: false,
        keepRetryState: true,
      });
      return;
    }

    if (isDeliverableState(session)) {
      interruptedKeys.delete(queueKey);
      await deliverBatch(queueKey, batch, false);
      return;
    }

    // Pending interrupt batch whose previous delivery failed: retry while the
    // session is still working. `clearBatch` only runs on success, so reaching
    // here means the prior deliverBatch threw.
    if (session.state === "working" && interruptedKeys.has(queueKey)) {
      await deliverBatch(queueKey, batch, true);
    }
  };

  const handleSendEvent = async (
    projectId: string,
    triggerId: string,
    eventName: string,
    trigger: SendTriggerConfig,
    sendBatch: SendBatch,
  ): Promise<void> => {
    const queueKey = createQueueKey(projectId, triggerId, sendBatch.sessionId);
    const merged = pendingBatches.has(queueKey);
    const batch = mergeIntoBatch(
      pendingBatches.get(queueKey),
      projectId,
      triggerId,
      trigger.source,
      sendBatch,
    );
    pendingBatches.set(queueKey, batch);
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

    if (isClosedState(session.state)) {
      clearBatch(queueKey);
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

    if (retryStates.has(queueKey)) {
      await flushPending(queueKey, batch);
      return;
    }

    if (isDeliverableState(session)) {
      await deliverBatch(queueKey, batch, false);
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
    await deliverBatch(queueKey, batch, true);
  };

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
            await handleSendEvent(projectId, triggerId, event.name, trigger, sendBatch);
          });
          return;
        }

        const workItemData =
          WORK_ITEM_NEW_EVENT_NAMES.has(event.name) && isWorkItemEventData(event.data)
            ? event.data
            : null;
        const runSpawn = async (): Promise<void> => {
          await runSpawnTrigger(
            deps.config.dataDir,
            deps.sessionService,
            projectId,
            triggerId,
            event.sourceId,
            event.name,
            trigger.spawn.blocks,
            trigger.spawn.autoComplete,
            trigger.spawnDeskGroup,
            event.data,
            logger,
          );
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

      if (inFlight.size === 0) return;
      await Promise.allSettled([...inFlight]);
    },
  };
}
