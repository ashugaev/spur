import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import { logSpurEvent } from "../event-log.js";
import { resolveWebBaseUrl } from "../ports.js";
import type { AppConfig, ProjectListEntry, SourceConfig, SourceType } from "../types.js";
import { cronSourceModule } from "./cron.js";
import { githubCiSourceModule } from "./github-ci.js";
import { githubSourceModule } from "./github.js";
import { gitlabSourceModule } from "./gitlab.js";
import { jiraSourceModule } from "./jira.js";
import { sentrySourceModule } from "./sentry.js";
import { serviceSourceModule } from "./service.js";
import { telegramSourceModule } from "./telegram.js";
import { webhookSourceModule } from "./webhook.js";
import type {
  SourceGroupController,
  SourceHandle,
  SourceLogger,
  SourceModule,
  SourceProjectListItem,
  SourceSpawnSessionRequest,
  SourceSessionListItem,
  SourceWorkbench,
} from "./types.js";

interface StartConfiguredSourcesDeps {
  config: AppConfig;
  bus: EventBus;
  logger?: SourceLogger;
  listSessions(): Promise<SourceSessionListItem[]>;
  spawnSession?(request: SourceSpawnSessionRequest): Promise<SourceSessionListItem>;
  listProjects?(): Promise<SourceProjectListItem[]>;
  workbench?: SourceWorkbench;
}

/**
 * The spawnable-project list every source's project picker sees: configured
 * projects only, never the shepherd project and never a registry-discovered
 * (unconfigured) one. Pure so it's testable without booting a server.
 */
export function spawnableProjects(entries: ProjectListEntry[]): SourceProjectListItem[] {
  return entries
    .filter((entry) => entry.configured && entry.kind !== "shepherd")
    .map(({ id, name }) => ({ id, name }));
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
  jira: jiraSourceModule,
  sentry: sentrySourceModule,
  service: serviceSourceModule,
  telegram: telegramSourceModule,
  webhook: webhookSourceModule,
} satisfies Record<SourceType, SourceModule>;

// A jira source with no `query` is consumed by the backlog subsystem only,
// not started by the event-source loop (connection-only, no poller).
function isConnectionOnlySource(source: SourceConfig): boolean {
  return source.type === "jira" && source.query === undefined;
}

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

  // Receipt-backed isolated UI can stop or change port; resolve each use.
  // Production and legacy helper results retain successful-resolution cache.
  let cachedWebBaseUrl: string | null = null;
  const resolveWebBaseUrlCached = async (): Promise<string | null> => {
    if (
      process.env["SPUR_SESSION_TOOL_DIR"] &&
      process.env["SPUR_ISOLATED_UI_ENDPOINT_FILE"] !== undefined
    )
      return resolveWebBaseUrl(deps.config.ui.port);
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
        if (isConnectionOnlySource(source)) continue;
        const module = SOURCE_MODULES[source.type] as SourceModule;
        const abortController = new AbortController();
        const handle = await module.start({
          sourceId,
          projectId,
          dataDir: deps.config.dataDir,
          config: source,
          deferInitialSync: true,
          listSessions: deps.listSessions,
          ...(deps.workbench ? { workbench: deps.workbench } : {}),
          ...(deps.spawnSession ? { spawnSession: deps.spawnSession } : {}),
          ...(deps.listProjects ? { listProjects: deps.listProjects } : {}),
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
    clearPollDisabledOverride(
      projectId: string,
      sourceId: string,
      sessionId: string,
    ): number | null {
      const source = startedSources.find(
        (entry) => entry.projectId === projectId && entry.sourceId === sourceId,
      );
      return source?.handle.clearPollDisabledOverride?.(sessionId) ?? null;
    },
  };
}
