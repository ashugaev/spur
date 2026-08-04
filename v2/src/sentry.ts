export interface SentryIssue {
  shortId: string;
  title: string;
  permalink: string;
}

export interface FetchSentryIssuesOptions {
  token: string;
  baseUrl: string;
  org: string;
  project: string;
  query: string;
  limit: number;
}

const FETCH_TIMEOUT_MS = 5_000;

async function requestBody(url: string, token: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

function narrowIssue(value: unknown): SentryIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const { shortId, title, permalink } = record;
  if (typeof shortId !== "string" || typeof title !== "string" || typeof permalink !== "string") {
    return null;
  }
  return { shortId, title, permalink };
}

export async function fetchSentryIssues(options: FetchSentryIssuesOptions): Promise<SentryIssue[]> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const url =
    `${base}/api/0/organizations/${options.org}/issues/` +
    `?project=${encodeURIComponent(options.project)}` +
    `&query=${encodeURIComponent(options.query)}` +
    `&limit=${options.limit}`;
  const { status, body } = await requestBody(url, options.token);
  if (status !== 200) {
    throw new Error(`Sentry issues request failed with status ${status}: ${body.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Sentry issues response was not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Sentry issues response was not an array");
  }
  return parsed.map(narrowIssue).filter((issue): issue is SentryIssue => issue !== null);
}
