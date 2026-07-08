import { fetchJiraIssues } from "../jira.js";
import type { BacklogProviderId, JiraSourceConfig } from "../types.js";

export interface BacklogFetchItem {
  externalId: string;
  key: string;
  title: string;
  url: string;
}

export interface BacklogProvider<TConn> {
  fetch(connection: TConn, query: string, limit: number): Promise<BacklogFetchItem[]>;
}

const jiraBacklogProvider: BacklogProvider<JiraSourceConfig> = {
  async fetch(connection, query, limit): Promise<BacklogFetchItem[]> {
    const issues = await fetchJiraIssues({
      baseUrl: connection.baseUrl,
      email: connection.email,
      token: connection.token,
      jql: query,
      maxResults: limit,
    });
    return issues.map((issue) => ({
      externalId: issue.id,
      key: issue.key,
      title: issue.title,
      url: issue.url,
    }));
  },
};

export const BACKLOG_PROVIDERS: Record<BacklogProviderId, BacklogProvider<JiraSourceConfig>> = {
  jira: jiraBacklogProvider,
};
