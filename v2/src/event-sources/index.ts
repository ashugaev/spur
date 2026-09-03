import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import { logSpurEvent } from "../event-log.js";
import { resolveWebBaseUrl } from "../ports.js";
import type { AppConfig, SourceType } from "../types.js";
import { cronSourceModule } from "./cron.js";
import { githubCiSourceModule } from "./github-ci.js";
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
  SourceSpawnSessionRequest,
  SourceSessionListItem,
} from "./types.js";

interface StartConfiguredSourcesDeps {
  config: AppConfig;
  bus: EventBus;
  logger?: SourceLogger;
  listSessions(): Promise<SourceSessionListItem[]>;
  spawnSession?(request: SourceSpawnSessionRequest): Promise<SourceSessionListItem>;
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
  "github-ci": githubCiSourceModule,
  gitlab: gitlabSourceModule,
  sentry: sentrySourceModule,
  service: serviceSourceModule,
  telegram: telegramSourceModule,
} satisfies Record<Exclude<SourceType, "jira">, SourceModule>;

// Connection-only source types are consumed by the backlog subsystem, not
// started by the event-source loop.
const CONNECTION_SOURCE_TYPES = new Set<SourceType>(["jira"]);

async function stopAll(sources: StartedSource[]): Promise<void> {
  for (const source of [...sources].reverse()) {
    try {
      source.abortController.abort();
      await source.handle.stop();
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

  // Resolved lazily (only when a source calls it — voice transcription
  // today), never at startup: an isolated daemon's own web UI port is
  // genuinely unknown at this point (see resolveWebBaseUrl in ports.ts).
  // Cached after the first SUCCESSFUL resolution only, shared by every
  // source module started below, so a repeat failure (isolated-ui still not
  // reserved) keeps retrying on the next call instead of latching closed
  // forever, while a resolved instance doesn't re-shell out on every message.
  let cachedWebBaseUrl: string | null = null;
  const resolveWebBaseUrlCached = async (): Promise<string | null> => {
    if (cachedWebBaseUrl !== null) return cachedWebBaseUrl;
    const resolved = await resolveWebBaseUrl(deps.config.ui.port);
    if (resolved !== null) cachedWebBaseUrl = resolved;
    return resolved;
  };

  try {
    for (const [projectId, project] of Object.entries(deps.config.projects)) {
      if (!existsSync(project.path)) {
        logSpurEvent(deps.config.dataDir, {
          event: "source.project_path_missing",
          level: "warn",
          projectId,
          message: `Skipping sources for ${projectId}: repo path ${project.path} does not exist`,
          details: {
            path: project.path,
          },
        });
        continue;
      }
      for (const [sourceId, source] of Object.entries(project.sources)) {
        if (CONNECTION_SOURCE_TYPES.has(source.type)) continue;
        const module = SOURCE_MODULES[source.type as Exclude<SourceType, "jira">] as SourceModule;
        const abortController = new AbortController();
        const handle = await module.start({
          sourceId,
          projectId,
          dataDir: deps.config.dataDir,
          config: source,
          deferInitialSync: true,
          listSessions: deps.listSessions,
          ...(deps.spawnSession ? { spawnSession: deps.spawnSession } : {}),
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
              occurrenceId: randomUUID(),
              projectId,
              sourceId,
              ...(data === undefined ? {} : { data }),
            });
          },
          signal: abortController.signal,
          logger,
          resolveWebBaseUrl: resolveWebBaseUrlCached,
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
    await stopAll(startedSources);
    throw error;
  }

  return {
    async stop(): Promise<void> {
      await stopAll(startedSources);
    },
  };
}
