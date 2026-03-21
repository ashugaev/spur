import { writeStderr } from "./io.js";
import { createSendBatchParser, type SendBatch } from "./send-batches.js";
import type {
  AgentName,
  AppConfig,
  SendTriggerConfig,
  SessionView,
  SpawnTriggerConfig,
} from "./types.js";
import type { EventBus } from "./event-bus.js";
import type { SessionService } from "./session-service.js";

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
  batch: SendBatch;
}

interface RetryState {
  attempts: number;
  nextAttemptAt: number | null;
  interrupt: boolean;
}

const DEFAULT_TRIGGER_LOGGER: TriggerLogger = {
  warn: writeStderr,
};
const CI_FAILED_RETRY_INTERVAL_MS = 10 * 60_000;
const CI_FAILED_MAX_ATTEMPTS = 3;

async function runSpawnTrigger(
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  eventName: string,
  triggerPrompt: string,
  agent: AgentName | undefined,
  branch: string | undefined,
  overrides: SpawnTriggerConfig["spawn"]["overrides"],
  logger: TriggerLogger,
): Promise<void> {
  logger.info?.(
    `[trigger:${projectId}/${triggerId}] matched ${eventName} from ${projectId}/${sourceId}`,
  );

  try {
    await service.spawn({
      project: projectId,
      prompt: triggerPrompt,
      ...(agent !== undefined ? { agent } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[trigger:${projectId}/${triggerId}] failed to spawn: ${message}`);
  }
}

function isSendTrigger(
  trigger: SpawnTriggerConfig | SendTriggerConfig,
): trigger is SendTriggerConfig {
  return "send" in trigger;
}

function isDeliverableState(session: SessionView): boolean {
  return session.state === "waiting";
}

function isClosedState(session: SessionView): boolean {
  return session.state === "stopped" || session.state === "error" || session.state === "killed";
}

function createQueueKey(projectId: string, triggerId: string, sessionId: string): string {
  return `${projectId}:${triggerId}:${sessionId}`;
}

function mergeIntoBatch(
  existing: PendingBatch | undefined,
  projectId: string,
  triggerId: string,
  incoming: SendBatch,
): PendingBatch {
  if (existing) {
    existing.batch.merge(incoming);
    return existing;
  }
  return { projectId, triggerId, batch: incoming };
}

export function startConfiguredTriggers(deps: StartConfiguredTriggersDeps): TriggerGroupController {
  const logger = deps.logger ?? DEFAULT_TRIGGER_LOGGER;
  const unsubscribers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  const pendingBatches = new Map<string, PendingBatch>();
  const interruptedKeys = new Set<string>();
  const retryStates = new Map<string, RetryState>();
  const serialByKey = new Map<string, Promise<void>>();
  let flushTimer: NodeJS.Timeout | null = null;
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
    options?: { clearAfter?: boolean; keepRetryState?: boolean },
  ): Promise<void> => {
    if (options?.clearAfter !== false) {
      const clearOptions: { keepInterrupted?: boolean; keepRetryState?: boolean } = {
        keepInterrupted: interrupt,
      };
      if (options?.keepRetryState !== undefined) {
        clearOptions.keepRetryState = options.keepRetryState;
      }
      clearBatch(queueKey, clearOptions);
    }
    try {
      await deps.sessionService.deliver(batch.batch.sessionId, batch.batch.format(), { interrupt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

    if (isClosedState(session)) {
      clearBatch(queueKey);
      logger.warn(
        `[trigger:${batch.projectId}/${batch.triggerId}] dropped queued updates for ${session.state} session ${batch.batch.sessionId}`,
      );
      return;
    }

    batch.batch.prune(deps.config.dataDir);
    if (batch.batch.isEmpty()) {
      clearBatch(queueKey);
      return;
    }

    const retry = retryStates.get(queueKey);
    if (retry) {
      if (retry.attempts >= CI_FAILED_MAX_ATTEMPTS) {
        clearBatch(queueKey);
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
        clearAfter: false,
        keepRetryState: true,
      });
      return;
    }

    if (isDeliverableState(session)) {
      interruptedKeys.delete(queueKey);
      await deliverBatch(queueKey, batch, false);
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
    const batch = mergeIntoBatch(pendingBatches.get(queueKey), projectId, triggerId, sendBatch);
    pendingBatches.set(queueKey, batch);
    if (eventName === "github:ci_failed") {
      ensureRetryState(queueKey, trigger.send.interrupt);
    }
    scheduleFlushLoop();

    const session = await loadSessionOrClear(queueKey, batch);
    if (!session) return;

    if (isClosedState(session)) {
      clearBatch(queueKey);
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

    const isWorking = session.state === "working";
    const needsInput = session.state === "needs_input";
    if (!isWorking && !needsInput) return;

    if (needsInput || !trigger.send.interrupt) {
      return;
    }

    if (interruptedKeys.has(queueKey)) return;

    interruptedKeys.add(queueKey);
    await deliverBatch(queueKey, batch, true);
  };

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [triggerId, trigger] of Object.entries(project.triggers)) {
      const source = project.sources[trigger.source];
      if (!source) continue;
      const parseSendBatch = createSendBatchParser(source.type, projectId, trigger.source);
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

        const spawnPromise = runSpawnTrigger(
          deps.sessionService,
          projectId,
          triggerId,
          event.sourceId,
          event.name,
          trigger.spawn.prompt,
          trigger.spawn.agent,
          trigger.spawn.branch,
          trigger.spawn.overrides,
          logger,
        );
        inFlight.add(spawnPromise);
        void spawnPromise.finally(() => {
          inFlight.delete(spawnPromise);
        });
      });

      unsubscribers.push(unsubscribe);
    }
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
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
