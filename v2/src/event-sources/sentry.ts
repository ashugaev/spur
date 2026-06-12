import { clearInterval, setInterval as startInterval } from "node:timers";
import { logSpurEvent } from "../event-log.js";
import { fetchSentryIssues } from "../sentry.js";
import { SENTRY_ISSUE_NEW_EVENT, type SentrySourceConfig, type WorkItemEventData } from "../types.js";
import { readWorkItemRegistry, recordWorkItem } from "../metadata.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

// First-poll emits are capped so an existing backlog of issues cannot spawn an
// unbounded burst of agents. Every fetched issue is still recorded as seen.
const SENTRY_FIRST_POLL_EMIT_CAP = 10;
const SENTRY_FETCH_LIMIT = 100;

function issueNumber(shortId: string): number {
  const match = shortId.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function pollIssues(
  deps: SourceStartDeps<SentrySourceConfig>,
  seenIssues: Set<string>,
): Promise<void> {
  const issues = await fetchSentryIssues({
    token: deps.config.authToken,
    baseUrl: deps.config.baseUrl,
    org: deps.config.org,
    project: deps.config.project,
    query: deps.config.query,
    limit: SENTRY_FETCH_LIMIT,
  });
  const repo = `${deps.config.org}/${deps.config.project}`;
  // When the registry has no prior entries this is the first poll: an existing
  // backlog is recorded as seen but only emitted (up to a cap) if emitExisting.
  const hadSeenEntries = seenIssues.size > 0;
  let firstPollEmits = 0;
  for (const issue of issues) {
    const externalId = `${repo}#${issue.shortId}`;
    if (seenIssues.has(externalId)) continue;
    recordWorkItem(deps.dataDir, deps.projectId, deps.sourceId, externalId);
    seenIssues.add(externalId);
    if (!hadSeenEntries) {
      if (!deps.config.emitExisting) continue;
      if (firstPollEmits >= SENTRY_FIRST_POLL_EMIT_CAP) continue;
      firstPollEmits += 1;
    }
    deps.emit<WorkItemEventData>(SENTRY_ISSUE_NEW_EVENT, {
      externalId,
      url: issue.permalink,
      number: issueNumber(issue.shortId),
      title: issue.title,
      repo,
    });
  }
}

async function startSentrySource(
  deps: SourceStartDeps<SentrySourceConfig>,
): Promise<SourceHandle> {
  const seenIssues = readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId);
  let stopped = false;
  let polling = false;

  const sync = async (): Promise<void> => {
    if (stopped || deps.signal.aborted || polling) return;
    polling = true;
    try {
      await pollIssues(deps, seenIssues);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] issue poll failed: ${message}`,
      );
      logSpurEvent(deps.dataDir, {
        event: "source.work_item_poll.error",
        level: "error",
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        message: `Sentry issue poll failed for ${deps.projectId}/${deps.sourceId}: ${message}`,
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

export const sentrySourceModule: SourceModule<SentrySourceConfig> = {
  type: "sentry",
  start: startSentrySource,
};
