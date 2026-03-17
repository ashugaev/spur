import { EventBus } from "./event-bus.js";
import { SessionService } from "./session-service.js";
import type { AgentName, AppConfig } from "./types.js";

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

async function runSpawnTrigger(
  service: SessionService,
  projectId: string,
  triggerId: string,
  sourceId: string,
  eventName: string,
  triggerPrompt: string,
  agent: AgentName | undefined,
  branch: string | undefined,
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[trigger:${projectId}/${triggerId}] failed to spawn: ${message}`);
  }
}

export function startConfiguredTriggers(
  deps: StartConfiguredTriggersDeps,
): TriggerGroupController {
  const logger = deps.logger ?? console;
  const unsubscribers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [triggerId, trigger] of Object.entries(project.triggers)) {
      const agent = trigger.spawn.agent;
      const branch = trigger.spawn.branch;
      const prompt = trigger.spawn.prompt;

      const unsubscribe = deps.bus.subscribe((event) => {
        if (stopped) return;
        if (event.projectId !== projectId) return;
        if (event.sourceId !== trigger.source) return;
        if (event.name !== trigger.event) return;
        const spawnPromise = runSpawnTrigger(
          deps.sessionService,
          projectId,
          triggerId,
          event.sourceId,
          event.name,
          prompt,
          agent,
          branch,
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
