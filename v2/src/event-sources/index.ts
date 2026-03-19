import type { EventBus } from "../event-bus.js";
import type { AppConfig, SourceType } from "../types.js";
import { cronSourceModule } from "./cron.js";
import { githubSourceModule } from "./github.js";
import type { SourceGroupController, SourceHandle, SourceLogger, SourceModule } from "./types.js";

interface StartConfiguredSourcesDeps {
  config: AppConfig;
  bus: EventBus;
  logger?: SourceLogger;
}

interface StartedSource {
  abortController: AbortController;
  handle: SourceHandle;
}

const SOURCE_MODULES = {
  cron: cronSourceModule,
  github: githubSourceModule,
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

export async function startConfiguredSources(
  deps: StartConfiguredSourcesDeps,
): Promise<SourceGroupController> {
  const logger = deps.logger ?? {};
  const startedSources: StartedSource[] = [];

  try {
    for (const [projectId, project] of Object.entries(deps.config.projects)) {
      for (const [sourceId, source] of Object.entries(project.sources)) {
        const module = SOURCE_MODULES[source.type];
        const abortController = new AbortController();
        const handle = await module.start({
          sourceId,
          projectId,
          dataDir: deps.config.dataDir,
          config: source,
          emit(name: string, data?: unknown): void {
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

        startedSources.push({ abortController, handle });
      }
    }

    for (const source of startedSources) {
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
