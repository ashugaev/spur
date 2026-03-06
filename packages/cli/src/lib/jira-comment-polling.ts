import type { OrchestratorConfig, SessionManager, Session } from "@composio/ao-core";
import type { IntegrationHealthReporter, IntegrationIdentity } from "./integration-health.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_COMMENT_LENGTH = 10_000;
const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JiraCommentPollingController {
  stop(): void;
}

interface JiraPollingConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  intervalMs: number;
}

interface JiraComment {
  id: string;
  created: string;
  body: unknown; // ADF or string
  author: {
    emailAddress?: string;
    displayName?: string;
  };
}

interface JiraCommentsResponse {
  comments?: JiraComment[];
  total?: number;
  startAt?: number;
  maxResults?: number;
}

interface LoggerLike {
  warn: (message: string) => void;
}

interface StartJiraCommentPollingDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
  healthReporter?: IntegrationHealthReporter;
}

const JIRA_COMMENT_POLLING_HEALTH: IntegrationIdentity = {
  id: "jira-comment-polling",
  label: "Jira Comment Polling",
  service: "jira",
  kind: "polling",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Simple recursive ADF (Atlassian Document Format) to plain text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adfToPlainText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";

  if (Array.isArray(node.content)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: string[] = node.content.map((child: any) => adfToPlainText(child));
    switch (node.type) {
      case "paragraph":
      case "heading":
      case "blockquote":
        return parts.join("") + "\n";
      case "listItem":
        return "- " + parts.join("") + "\n";
      case "codeBlock":
        return "```\n" + parts.join("") + "\n```\n";
      default:
        return parts.join("");
    }
  }
  return "";
}

function commentBodyToText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") return adfToPlainText(body).trim();
  return "";
}

function resolvePollingConfig(config: OrchestratorConfig): JiraPollingConfig | null {
  // Find any project that uses tracker: jira — grab baseUrl from there
  let baseUrl: string | undefined;
  for (const project of Object.values(config.projects)) {
    const tracker = project.tracker as Record<string, unknown> | undefined;
    if (tracker?.plugin === "jira") {
      baseUrl = toStringOrUndefined(tracker.baseUrl);
      break;
    }
  }
  baseUrl = baseUrl || env("JIRA_URL", "JIRA_HOST");
  if (!baseUrl) return null;
  baseUrl = normalizeBaseUrl(baseUrl);

  const email = env("JIRA_EMAIL", "JIRA_USER");
  const apiToken = env("JIRA_API_TOKEN", "JIRA_TOKEN");
  if (!email || !apiToken) return null;

  const intervalMs =
    toPositiveNumber(env("AO_JIRA_POLL_INTERVAL_MS", "JIRA_POLL_INTERVAL_MS")) ??
    DEFAULT_POLL_INTERVAL_MS;

  return { baseUrl, email, apiToken, intervalMs };
}

function hasJiraTrackerProject(config: OrchestratorConfig): boolean {
  return Object.values(config.projects).some(
    (p) => (p.tracker as Record<string, unknown> | undefined)?.plugin === "jira",
  );
}

// ---------------------------------------------------------------------------
// Core polling logic
// ---------------------------------------------------------------------------

export async function maybeStartJiraCommentPolling(
  deps: StartJiraCommentPollingDeps,
): Promise<JiraCommentPollingController | null> {
  const health = deps.healthReporter;
  if (!hasJiraTrackerProject(deps.config)) {
    health?.markInactive(
      JIRA_COMMENT_POLLING_HEALTH,
      "Jira polling inactive: no project configured with Jira tracker",
    );
    return null;
  }

  const cfg = resolvePollingConfig(deps.config);
  if (!cfg) {
    health?.markInactive(
      JIRA_COMMENT_POLLING_HEALTH,
      "Jira polling inactive: base URL, JIRA_EMAIL, or JIRA_API_TOKEN is missing",
    );
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? console;
  const { baseUrl, email, apiToken } = cfg;
  health?.markStarting(JIRA_COMMENT_POLLING_HEALTH, "Starting Jira comment polling runtime");

  // Track last seen comment ID per issue to avoid re-processing
  const seenCommentIds = new Map<string, Set<string>>();

  let stopped = false;
  let inFlight = false;

  async function fetchComments(issueKey: string): Promise<JiraComment[]> {
    const collected: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 100;
    const maxPages = 50;

    for (let page = 0; page < maxPages; page += 1) {
      const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?orderBy=created&startAt=${startAt}&maxResults=${maxResults}`;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${btoa(`${email}:${apiToken}`)}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Jira API ${response.status}: ${await response.text()}`);
      }

      const payload = (await response.json()) as JiraCommentsResponse;
      const pageComments = Array.isArray(payload.comments) ? payload.comments : [];
      collected.push(...pageComments);

      const total =
        typeof payload.total === "number" && Number.isFinite(payload.total)
          ? payload.total
          : collected.length;
      const returned =
        typeof payload.maxResults === "number" && payload.maxResults > 0
          ? payload.maxResults
          : pageComments.length;

      if (pageComments.length === 0 || collected.length >= total || returned <= 0) {
        break;
      }

      startAt += returned;
    }

    return collected;
  }

  /**
   * For a given issue's comments, find new human replies to AO_SESSION comments.
   *
   * Logic:
   * 1. Walk comments in order
   * 2. Track the latest AO_SESSION:xxx marker seen so far
   * 3. Any NEW comment (not seen before, no AO_SESSION marker itself) after a
   *    marker comment is a human reply → route to that session
   */
  function findNewReplies(
    issueKey: string,
    comments: JiraComment[],
  ): Array<{ sessionId: string; text: string }> {
    const seen = seenCommentIds.get(issueKey);
    const nowSeen = new Set<string>();
    const replies: Array<{ sessionId: string; text: string }> = [];

    let activeSessionId: string | null = null;

    for (const comment of comments) {
      const id = comment.id;
      nowSeen.add(id);

      const text = commentBodyToText(comment.body);
      const markerMatch = text.match(SESSION_MARKER_REGEX);

      if (markerMatch) {
        activeSessionId = markerMatch[1];
        continue;
      }

      // New comment (not seen in previous poll), after a marker, no marker itself
      if (activeSessionId && seen && !seen.has(id)) {
        const sanitized = text.trim();
        if (sanitized.length > 0 && sanitized.length <= MAX_COMMENT_LENGTH) {
          replies.push({ sessionId: activeSessionId, text: sanitized });
        }
      }
    }

    seenCommentIds.set(issueKey, nowSeen);
    return replies;
  }

  async function pollOnce(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    let cycleHadErrors = false;
    let cycleIssueCount = 0;

    try {
      const sessions = await deps.sessionManager.list();
      const activeSessions = sessions.filter(
        (s: Session) =>
          s.issueId &&
          s.status !== "killed" &&
          s.status !== "done",
      );

      // Deduplicate by issueId (multiple sessions could share an issue)
      const issueToSessions = new Map<string, string[]>();
      for (const session of activeSessions) {
        if (!session.issueId) continue;
        const existing = issueToSessions.get(session.issueId);
        if (existing) {
          existing.push(session.id);
        } else {
          issueToSessions.set(session.issueId, [session.id]);
        }
      }

      for (const [issueKey] of issueToSessions) {
        cycleIssueCount += 1;
        try {
          const comments = await fetchComments(issueKey);
          const replies = findNewReplies(issueKey, comments);

          for (const reply of replies) {
            try {
              await deps.sessionManager.send(reply.sessionId, reply.text);
            } catch (err) {
              cycleHadErrors = true;
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn(
                `[jira-polling] Failed to send to session ${reply.sessionId}: ${msg}`,
              );
            }
          }
        } catch (err) {
          cycleHadErrors = true;
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[jira-polling] Failed to fetch comments for ${issueKey}: ${msg}`);
        }
      }

      if (cycleHadErrors) {
        health?.markDegraded(
          JIRA_COMMENT_POLLING_HEALTH,
          "Jira poll cycle completed with one or more issue errors",
        );
      } else {
        health?.markHealthy(
          JIRA_COMMENT_POLLING_HEALTH,
          `Polling active; cycle completed (${cycleIssueCount} issues checked)`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[jira-polling] Poll cycle failed: ${msg}`);
      health?.markDegraded(JIRA_COMMENT_POLLING_HEALTH, `Poll cycle failed: ${msg}`, err);
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void pollOnce();
  }, cfg.intervalMs);

  // Initial poll
  void pollOnce();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      health?.markInactive(JIRA_COMMENT_POLLING_HEALTH, "Jira comment polling stopped");
    },
  };
}
