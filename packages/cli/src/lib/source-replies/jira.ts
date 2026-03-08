import { isJiraInboundEnvelope, type OrchestratorConfig } from "@composio/ao-core";
import type { SourceReplyAdapter } from "./types.js";

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function resolveJiraBaseUrl(config: OrchestratorConfig): string | undefined {
  for (const project of Object.values(config.projects)) {
    const tracker = project.tracker as Record<string, unknown> | undefined;
    if (tracker?.plugin !== "jira") continue;

    const rawBaseUrl = toNonEmptyString(tracker.baseUrl);
    if (rawBaseUrl) {
      return normalizeBaseUrl(rawBaseUrl);
    }
  }

  const envBaseUrl = env("JIRA_URL", "JIRA_HOST");
  return envBaseUrl ? normalizeBaseUrl(envBaseUrl) : undefined;
}

function resolveJiraCredentials(): { email: string; apiToken: string } | null {
  const email = env("JIRA_EMAIL", "JIRA_USER");
  const apiToken = env("JIRA_API_TOKEN", "JIRA_TOKEN");
  if (!email || !apiToken) return null;
  return { email, apiToken };
}

function toJiraAdf(text: string): Record<string, unknown> {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (paragraphs.length === 0) {
    paragraphs.push(text.trim());
  }

  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    })),
  };
}

async function sendJiraComment(payload: {
  baseUrl: string;
  issueKey: string;
  email: string;
  apiToken: string;
  text: string;
}): Promise<void> {
  const endpoint = `${payload.baseUrl}/rest/api/3/issue/${encodeURIComponent(payload.issueKey)}/comment`;
  const auth = Buffer.from(`${payload.email}:${payload.apiToken}`).toString("base64");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: toJiraAdf(payload.text) }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Jira API failed (${response.status}): ${responseBody}`);
  }
}

export const jiraSourceReplyAdapter: SourceReplyAdapter = {
  source: "jira",

  async sendReply({ config, envelope, message }): Promise<void> {
    const text = message.trim();
    if (!text) {
      throw new Error("Reply message is empty");
    }

    if (!isJiraInboundEnvelope(envelope)) {
      throw new Error("Envelope does not contain valid Jira routing data");
    }

    const baseUrl = resolveJiraBaseUrl(config);
    if (!baseUrl) {
      throw new Error("Jira base URL is not configured");
    }

    const credentials = resolveJiraCredentials();
    if (!credentials) {
      throw new Error("Jira credentials are not configured (JIRA_EMAIL and JIRA_API_TOKEN)");
    }

    const marker = `AO_SESSION:${envelope.sessionId}`;
    const payloadText = text.includes(marker) ? text : `${text}\n\n${marker}`;

    await sendJiraComment({
      baseUrl,
      issueKey: envelope.routing.issueKey,
      email: credentials.email,
      apiToken: credentials.apiToken,
      text: payloadText,
    });
  },
};
