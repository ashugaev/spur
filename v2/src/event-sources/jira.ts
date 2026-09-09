import { fetchJiraIssues } from "../jira.js";
import {
  JIRA_WORK_ITEM_NEW_EVENT,
  type JiraSourceConfig,
  type JiraWorkItemEventData,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import { emitWorkItemBacklog, startWorkItemPoller } from "./work-item-backlog.js";

function issueNumber(key: string): number {
  const match = key.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function issueProjectPrefix(key: string): string {
  return key.split("-")[0] ?? key;
}

async function pollIssues(
  deps: SourceStartDeps<JiraSourceConfig>,
  seenIssues: Set<string>,
): Promise<void> {
  if (deps.config.query === undefined) {
    throw new Error(
      `jira source ${deps.projectId}/${deps.sourceId} has no query; it should have been skipped as connection-only`,
    );
  }
  const issues = await fetchJiraIssues({
    baseUrl: deps.config.baseUrl,
    email: deps.config.email,
    token: deps.config.token,
    jql: deps.config.query,
    maxResults: deps.config.maxResults,
  });
  const candidates = issues.map((issue) => {
    const repo = issueProjectPrefix(issue.key);
    const data: JiraWorkItemEventData = {
      externalId: `${repo}#${issue.key}`,
      url: issue.url,
      number: issueNumber(issue.key),
      title: issue.title,
      repo,
      key: issue.key,
    };
    return { repo, externalId: data.externalId, data };
  });
  emitWorkItemBacklog(deps, JIRA_WORK_ITEM_NEW_EVENT, seenIssues, candidates);
}

function startJiraSource(deps: SourceStartDeps<JiraSourceConfig>): Promise<SourceHandle> {
  return startWorkItemPoller(
    deps,
    { warn: "issue poll failed", event: "Jira issue poll failed" },
    pollIssues,
  );
}

export const jiraSourceModule: SourceModule<JiraSourceConfig> = {
  type: "jira",
  start: startJiraSource,
};
