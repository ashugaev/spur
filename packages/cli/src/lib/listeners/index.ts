import type { ListenerConfig, OrchestratorConfig, SessionManager } from "@composio/ao-core";
import { jiraBacklogSource } from "./jira-backlog-source.js";
import type { ListenerController, ListenerLogger, ListenerSource } from "./types.js";
import type { IntegrationHealthReporter, IntegrationIdentity, IntegrationService } from "../integration-health.js";

export interface ListenerGroupController {
  activeListeners: string[];
  stop(): void;
}

interface StartConfiguredListenersDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  projectId?: string;
  logger?: ListenerLogger;
  healthReporter?: IntegrationHealthReporter;
}

const sourceRegistry = new Map<string, ListenerSource>();

export function registerListenerSource(source: ListenerSource): void {
  sourceRegistry.set(source.source, source);
}

export function getListenerSource(sourceName: string): ListenerSource | undefined {
  return sourceRegistry.get(sourceName);
}

export function unregisterListenerSource(sourceName: string): void {
  sourceRegistry.delete(sourceName);
}

// Built-in sources
registerListenerSource(jiraBacklogSource);

function isEnabled(listener: ListenerConfig): boolean {
  return listener.enabled !== false;
}

function resolveListenerService(listener: ListenerConfig): IntegrationService {
  const source = listener.source.toLowerCase();
  if (source.startsWith("telegram-") || source.includes("telegram")) return "telegram";
  return "jira";
}

function buildHealthIdentity(
  listenerId: string,
  listener: ListenerConfig,
): IntegrationIdentity {
  return {
    id: `listener:${listenerId}`,
    label: `Listener ${listenerId} (${listener.source})`,
    service: resolveListenerService(listener),
    kind: "listener",
  };
}

export async function maybeStartConfiguredListeners(
  deps: StartConfiguredListenersDeps,
): Promise<ListenerGroupController | null> {
  const logger = deps.logger ?? console;
  const health = deps.healthReporter;
  const listeners = deps.config.listeners ?? {};

  const controllers: ListenerController[] = [];
  const activeListeners: string[] = [];
  const activeListenerHealthIdentities: IntegrationIdentity[] = [];

  for (const [listenerId, listener] of Object.entries(listeners)) {
    const healthIdentity = buildHealthIdentity(listenerId, listener);

    if (!isEnabled(listener)) {
      health?.markInactive(healthIdentity, "Listener inactive: disabled in config");
      continue;
    }
    if (deps.projectId && listener.projectId !== deps.projectId) continue;

    const source = getListenerSource(listener.source);
    if (!source) {
      logger.warn(
        `[listener:${listenerId}] Unknown source "${listener.source}" — skipping listener`,
      );
      health?.markInactive(
        healthIdentity,
        `Listener inactive: unsupported source "${listener.source}"`,
      );
      continue;
    }

    const project = deps.config.projects[listener.projectId];
    if (!project) {
      logger.warn(
        `[listener:${listenerId}] Unknown project "${listener.projectId}" — skipping listener`,
      );
      health?.markInactive(
        healthIdentity,
        `Listener inactive: unknown project "${listener.projectId}"`,
      );
      continue;
    }

    try {
      health?.markStarting(healthIdentity, "Starting listener runtime");
      const controller = await source.start({
        config: deps.config,
        listenerId,
        listener,
        projectId: listener.projectId,
        project,
        sessionManager: deps.sessionManager,
        logger,
        healthReporter: health,
        healthIdentity,
      });
      controllers.push(controller);
      activeListeners.push(listenerId);
      activeListenerHealthIdentities.push(healthIdentity);
      health?.markHealthy(
        healthIdentity,
        `Listener active: source "${listener.source}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[listener:${listenerId}] Failed to start listener: ${msg}`);
      health?.markInactive(
        healthIdentity,
        `Listener inactive: failed to start (${msg})`,
      );
    }
  }

  if (controllers.length === 0) return null;

  return {
    activeListeners,
    stop(): void {
      for (const controller of controllers) {
        try {
          controller.stop();
        } catch {
          // Best effort shutdown for all listeners.
        }
      }

      for (const identity of activeListenerHealthIdentities) {
        health?.markInactive(identity, "Listener stopped");
      }
    },
  };
}
