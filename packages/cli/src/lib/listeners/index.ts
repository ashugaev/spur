import type {
  ListenerConfig,
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
} from "@composio/ao-core";
import { cronSource } from "./cron-source.js";
import { trackerTaskSource } from "./jira-task-source.js";
import type { ListenerController, ListenerLogger, ListenerSource } from "./types.js";
import type {
  IntegrationHealthReporter,
  IntegrationIdentity,
  IntegrationService,
} from "../integration-health.js";

export interface ListenerGroupController {
  activeListeners: string[];
  stop(): void;
}

interface StartConfiguredListenersDeps {
  config: OrchestratorConfig;
  registry?: PluginRegistry;
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
registerListenerSource(trackerTaskSource);
registerListenerSource(cronSource);

function resolveListenerService(listener: ListenerConfig): IntegrationService {
  const source = listener.source.toLowerCase();
  if (source.startsWith("telegram-") || source.includes("telegram")) return "telegram";
  if (source.startsWith("tracker-") || source.includes("tracker")) return "tracker";
  return "jira";
}

function buildHealthIdentity(listenerId: string, listener: ListenerConfig): IntegrationIdentity {
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

  // Collect per-project listeners only. projectId is implicit and injected here.
  // If ids collide across projects, namespace with projectId to avoid overrides.
  const listeners: Record<string, ListenerConfig> = {};
  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    const perProjectListeners =
      (project as { listeners?: Record<string, Omit<ListenerConfig, "projectId">> }).listeners ??
      {};
    for (const [listenerId, listener] of Object.entries(perProjectListeners)) {
      const baseId = listenerId;
      const effectiveId = listenerId in listeners ? `${projectId}:${listenerId}` : listenerId;

      if (effectiveId !== baseId) {
        logger.warn(
          `[listener:${baseId}] Duplicate listener id detected; using namespaced id "${effectiveId}"`,
        );
      }

      listeners[effectiveId] = { ...listener, projectId } as ListenerConfig;
    }
  }

  const controllers: ListenerController[] = [];
  const activeListeners: string[] = [];
  const activeListenerHealthIdentities: IntegrationIdentity[] = [];

  for (const [listenerId, listener] of Object.entries(listeners)) {
    const healthIdentity = buildHealthIdentity(listenerId, listener);

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
        registry: deps.registry,
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
      health?.markHealthy(healthIdentity, `Listener active: source "${listener.source}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[listener:${listenerId}] Failed to start listener: ${msg}`);
      health?.markInactive(healthIdentity, `Listener inactive: failed to start (${msg})`);
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
