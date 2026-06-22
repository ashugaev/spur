import type { EventBus } from "../event-bus.js";
import { logSpurEvent } from "../event-log.js";
import type { AppConfig, SourceType } from "../types.js";
import { cronSourceModule } from "./cron.js";
import { githubSourceModule } from "./github.js";
import { gitlabSourceModule } from "./gitlab.js";
import { sentrySourceModule } from "./sentry.js";
import { serviceSourceModule } from "./service.js";
import { telegramSourceModule } from "./telegram.js";
import type {
  SourceGroupController,
  SourceHandle,
  SourceLogger,
  SourceModule,
  SourceSessionListItem,
} from "./types.js";

interface StartConfiguredSourcesDeps {
  config: AppConfig;
  bus: EventBus;
  logger?: SourceLogger;
  listSessions(): Promise<SourceSessionListItem[]>;
}

interface StartedSource {
  abortController: AbortController;
  handle: SourceHandle;
  projectId: string;
  sourceId: string;
  type: SourceType;
}

const SOURCE_MODULES = {
  cron: cronSourceModule,
  github: githubSourceModule,
  gitlab: gitlabSourceModule,
  sentry: sentrySourceModule,
  service: serviceSourceModule,
  telegram: telegramSourceModule,
} satisfies Record<SourceType, SourceModule>;

function stopAll(sources: StartedSource[]): void {
  for (const source of [...sources].reverse()) {
    try {
      source.abortController.abort();
      source.handle.stop();
    } catch {
      // Best effort only.
    }
  }
}

function extractSessionId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const sessionId = (data as Record<string, unknown>)["sessionId"];
  return typeof sessionId === "string" ? sessionId : undefined;
}

export async function startConfiguredSources(
  deps: StartConfiguredSourcesDeps,
): Promise<SourceGroupController> {
  const logger = deps.logger ?? {};
  const startedSources: StartedSource[] = [];

  try {
    for (const [projectId, project] of Object.entries(deps.config.projects)) {
      for (const [sourceId, source] of Object.entries(project.sources)) {
        const module = SOURCE_MODULES[source.type] as SourceModule;
        const abortController = new AbortController();
        const handle = await module.start({
          sourceId,
          projectId,
          dataDir: deps.config.dataDir,
          config: source,
          deferInitialSync: true,
          listSessions: deps.listSessions,
          emit(name: string, data?: unknown): void {
            const sessionId = extractSessionId(data);
            logSpurEvent(deps.config.dataDir, {
              event: "source.event.emitted",
              level: "info",
              projectId,
              sourceId,
              ...(sessionId ? { sessionId } : {}),
              message: `Emitted ${name} from ${projectId}/${sourceId}`,
              details: {
                eventName: name,
                type: source.type,
              },
            });
            deps.bus.emit({
              name,
              projectId,
              sourceId,
              ...(data === undefined ? {} : { data }),
            });
          },
          signal: abortController.signal,
          logger,
        });

        logSpurEvent(deps.config.dataDir, {
          event: "source.started",
          level: "info",
          projectId,
          sourceId,
          message: `Started ${source.type} source ${projectId}/${sourceId}`,
          details: {
            type: source.type,
          },
        });
        startedSources.push({ abortController, handle, projectId, sourceId, type: source.type });
      }
    }

    for (const source of startedSources) {
      if (source.handle.runOnStart) {
        logSpurEvent(deps.config.dataDir, {
          event: "source.run_on_start",
          level: "info",
          projectId: source.projectId,
          sourceId: source.sourceId,
          message: `Running ${source.type} source on startup for ${source.projectId}/${source.sourceId}`,
          details: {
            type: source.type,
          },
        });
      }
      source.handle.runOnStart?.();
    }
  } catch (error) {
    stopAll(startedSources);
    throw error;
  }

  return {
    stop(): void {
      stopAll(startedSources);
    },
  };
}
