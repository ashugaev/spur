import type {
  TriggerConfig,
  OrchestratorConfig,
  SessionManager,
} from "@composio/ao-core";
import { cronTriggerSource } from "./cron-trigger.js";
import type { TriggerController, TriggerLogger, TriggerSource } from "./types.js";
import type {
  IntegrationHealthReporter,
  IntegrationIdentity,
} from "../integration-health.js";

export interface TriggerGroupController {
  activeTriggers: string[];
  stop(): void;
}

interface StartConfiguredTriggersDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  projectId?: string;
  logger?: TriggerLogger;
  healthReporter?: IntegrationHealthReporter;
}

const sourceRegistry = new Map<string, TriggerSource>();

export function registerTriggerSource(source: TriggerSource): void {
  sourceRegistry.set(source.event, source);
}

// Built-in trigger sources
registerTriggerSource(cronTriggerSource);

function buildHealthIdentity(triggerId: string, trigger: TriggerConfig): IntegrationIdentity {
  return {
    id: `trigger:${triggerId}`,
    label: `Trigger ${triggerId} (${trigger.event})`,
    service: "trigger",
    kind: "trigger",
  };
}

export async function maybeStartConfiguredTriggers(
  deps: StartConfiguredTriggersDeps,
): Promise<TriggerGroupController | null> {
  const logger = deps.logger ?? console;
  const health = deps.healthReporter;

  const triggers: Array<{ triggerId: string; trigger: TriggerConfig; projectId: string }> = [];

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    if (deps.projectId && projectId !== deps.projectId) continue;
    const projectTriggers = project.triggers ?? {};
    for (const [triggerId, trigger] of Object.entries(projectTriggers)) {
      triggers.push({ triggerId, trigger, projectId });
    }
  }

  const controllers: TriggerController[] = [];
  const activeTriggers: string[] = [];
  const activeHealthIdentities: IntegrationIdentity[] = [];

  for (const { triggerId, trigger, projectId } of triggers) {
    const healthIdentity = buildHealthIdentity(triggerId, trigger);
    const project = deps.config.projects[projectId];
    if (!project) continue;

    const source = sourceRegistry.get(trigger.event);
    if (!source) {
      logger.warn(
        `[trigger:${triggerId}] Unknown event "${trigger.event}" — skipping trigger`,
      );
      health?.markInactive(
        healthIdentity,
        `Trigger inactive: unsupported event "${trigger.event}"`,
      );
      continue;
    }

    try {
      health?.markStarting(healthIdentity, "Starting trigger");
      const controller = await source.start({
        config: deps.config,
        triggerId,
        trigger,
        projectId,
        project,
        sessionManager: deps.sessionManager,
        logger,
        healthReporter: health,
        healthIdentity,
      });
      controllers.push(controller);
      activeTriggers.push(triggerId);
      activeHealthIdentities.push(healthIdentity);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[trigger:${triggerId}] Failed to start trigger: ${msg}`);
      health?.markInactive(healthIdentity, `Trigger inactive: failed to start (${msg})`);
    }
  }

  if (controllers.length === 0) return null;

  return {
    activeTriggers,
    stop(): void {
      for (const controller of controllers) {
        try {
          controller.stop();
        } catch {
          // Best effort shutdown
        }
      }
      for (const identity of activeHealthIdentities) {
        health?.markInactive(identity, "Trigger stopped");
      }
    },
  };
}
