import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { replaceAvailableBacklogItems } from "../metadata.js";
import type { AppConfig, BacklogConfig, JiraSourceConfig } from "../types.js";
import { BACKLOG_PROVIDERS } from "./providers.js";

const BACKLOG_FETCH_LIMIT = 100;

interface BacklogLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface StartConfiguredBacklogsDeps {
  config: AppConfig;
  logger?: BacklogLogger;
}

export interface BacklogGroupController {
  stop(): void;
}

interface StartedBacklog {
  stop(): void;
}

function startBacklogPoller(
  config: AppConfig,
  projectId: string,
  backlogId: string,
  binding: BacklogConfig,
  connection: JiraSourceConfig,
  logger: BacklogLogger,
): StartedBacklog {
  const provider = BACKLOG_PROVIDERS[binding.provider];
  let stopped = false;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const fetchedAt = new Date().toISOString();
      const items = await provider.fetch(connection, binding.query, BACKLOG_FETCH_LIMIT);
      replaceAvailableBacklogItems(
        config.dataDir,
        projectId,
        backlogId,
        items.map((item) => ({
          provider: binding.provider,
          projectId,
          backlogId,
          externalId: item.externalId,
          key: item.key,
          title: item.title,
          url: item.url,
          fetchedAt,
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn?.(`[backlog:${projectId}/${backlogId}] poll failed: ${message}`);
      logSpurEvent(config.dataDir, {
        event: "source.backlog_poll.error",
        level: "error",
        projectId,
        sourceId: backlogId,
        message: `Backlog poll failed for ${projectId}/${backlogId}: ${message}`,
      });
    } finally {
      polling = false;
    }
  };

  const timer = startInterval(() => {
    void poll();
  }, binding.intervalMs);

  if (binding.runOnStart) {
    void poll();
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function startConfiguredBacklogs(deps: StartConfiguredBacklogsDeps): BacklogGroupController {
  const logger = deps.logger ?? {};
  const started: StartedBacklog[] = [];

  for (const [projectId, project] of Object.entries(deps.config.projects)) {
    for (const [backlogId, binding] of Object.entries(project.backlog)) {
      const connection = project.sources[binding.source];
      if (!connection || connection.type !== "jira") continue;
      started.push(
        startBacklogPoller(deps.config, projectId, backlogId, binding, connection, logger),
      );
    }
  }

  return {
    stop(): void {
      for (const backlog of [...started].reverse()) {
        try {
          backlog.stop();
        } catch {
          // Best effort only.
        }
      }
    },
  };
}
