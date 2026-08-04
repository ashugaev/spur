export interface JiraIssue {
  id: string;
  key: string;
  title: string;
  url: string;
}

export interface FetchJiraIssuesOptions {
  baseUrl: string;
  email: string;
  token: string;
  jql: string;
  maxResults: number;
}

const JIRA_SEARCH_MAX_RESULTS = 100;
const FETCH_TIMEOUT_MS = 5_000;

async function requestBody(
  url: URL,
  email: string,
  token: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function issueTitle(fields: unknown): string | null {
  if (!isRecord(fields)) return null;
  const summary = fields["summary"];
  return typeof summary === "string" && summary.trim() ? summary.trim() : null;
}

function narrowIssue(value: unknown, baseUrl: string): JiraIssue | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const key = value["key"];
  const title = issueTitle(value["fields"]);
  if (typeof id !== "string" || typeof key !== "string" || title === null) {
    return null;
  }
  return {
    id,
    key,
    title,
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`,
  };
}

export async function fetchJiraIssues(options: FetchJiraIssuesOptions): Promise<JiraIssue[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/rest/api/3/search/jql`);
  url.searchParams.set("jql", options.jql);
  url.searchParams.set("fields", "summary");
  url.searchParams.set("maxResults", String(Math.min(options.maxResults, JIRA_SEARCH_MAX_RESULTS)));
  const { status, body } = await requestBody(url, options.email, options.token);
  if (status !== 200) {
    throw new Error(`Jira search request failed with status ${status}: ${body.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Jira search response was not valid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["issues"])) {
    throw new Error("Jira search response did not include issues");
  }
  return parsed["issues"]
    .map((issue) => narrowIssue(issue, baseUrl))
    .filter((issue): issue is JiraIssue => issue !== null);
}
