import { EventBus } from "../event-bus.js";
import type { AppConfig, SourceType } from "../types.js";
import { cronSourceModule } from "./cron.js";
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
} satisfies Record<SourceType, SourceModule>;

export async function startConfiguredSources(
  deps: StartConfiguredSourcesDeps,
): Promise<SourceGroupController> {
  const logger = deps.logger ?? console;
  const startedSources: StartedSource[] = [];

  try {
    for (const [projectId, project] of Object.entries(deps.config.projects)) {
      for (const [sourceId, source] of Object.entries(project.sources)) {
        const module = SOURCE_MODULES[source.type];
        const abortController = new AbortController();
        const handle = await module.start({
          sourceId,
          projectId,
          config: source,
          emit(name: string): void {
            deps.bus.emit({
              name,
              projectId,
              sourceId,
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
    for (const source of startedSources.reverse()) {
      try {
        source.abortController.abort();
        source.handle.stop();
      } catch {
        // Best effort rollback during startup failure.
      }
    }
    throw error;
  }

  return {
    stop(): void {
      for (const source of startedSources.reverse()) {
        try {
          source.abortController.abort();
          source.handle.stop();
        } catch {
          // Best effort shutdown.
        }
      }
    },
  };
}
