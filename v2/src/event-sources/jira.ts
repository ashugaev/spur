import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { fetchJiraIssues } from "../jira.js";
import { replaceAvailableBacklogItems } from "../metadata.js";
import type { JiraSourceConfig } from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

const JIRA_FETCH_LIMIT = 100;

async function pollJira(deps: SourceStartDeps<JiraSourceConfig>): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const issues = await fetchJiraIssues({
    baseUrl: deps.config.baseUrl,
    email: deps.config.email,
    token: deps.config.token,
    jql: deps.config.jql,
    maxResults: JIRA_FETCH_LIMIT,
  });
  replaceAvailableBacklogItems(
    deps.dataDir,
    deps.projectId,
    deps.sourceId,
    issues.map((issue) => ({
      provider: "jira",
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      externalId: issue.id,
      key: issue.key,
      title: issue.title,
      url: issue.url,
      fetchedAt,
    })),
  );
}

async function startJiraSource(deps: SourceStartDeps<JiraSourceConfig>): Promise<SourceHandle> {
  let stopped = false;
  let polling = false;

  const sync = async (): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      await pollJira(deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] Jira poll failed: ${message}`,
      );
      logSpurEvent(deps.dataDir, {
        event: "source.backlog_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `Jira backlog poll failed for ${deps.projectId}/${deps.sourceId}: ${message}`,
      });
    } finally {
      polling = false;
    }
  };

  const timer = startInterval(() => {
    void sync();
  }, deps.config.intervalMs);

  if (!deps.config.runOnStart) {
    if (deps.deferInitialSync) {
      void sync();
    } else {
      await sync();
    }
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    ...(deps.config.runOnStart
      ? {
          runOnStart(): void {
            void sync();
          },
        }
      : {}),
  };
}

export const jiraSourceModule: SourceModule<JiraSourceConfig> = {
  type: "jira",
  start: startJiraSource,
};
