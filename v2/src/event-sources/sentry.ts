import { fetchSentryIssues } from "../sentry.js";
import {
  SENTRY_ISSUE_NEW_EVENT,
  type SentrySourceConfig,
  type WorkItemEventData,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import { emitWorkItemBacklog, startWorkItemPoller } from "./work-item-backlog.js";

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
  const candidates = issues.map((issue) => {
    const data: WorkItemEventData = {
      externalId: `${repo}#${issue.shortId}`,
      url: issue.permalink,
      number: issueNumber(issue.shortId),
      title: issue.title,
      repo,
    };
    return { repo, externalId: data.externalId, data };
  });
  emitWorkItemBacklog(deps, SENTRY_ISSUE_NEW_EVENT, seenIssues, candidates);
}

function startSentrySource(deps: SourceStartDeps<SentrySourceConfig>): Promise<SourceHandle> {
  return startWorkItemPoller(
    deps,
    { warn: "issue poll failed", event: "Sentry issue poll failed" },
    pollIssues,
  );
}

export const sentrySourceModule: SourceModule<SentrySourceConfig> = {
  type: "sentry",
  start: startSentrySource,
};
