import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig } from "@composio/ao-core";
import { jiraSourceReplyAdapter } from "../../src/lib/source-replies/jira.js";

function makeConfig(): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-test/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      app: {
        name: "App",
        repo: "acme/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        tracker: {
          plugin: "jira",
          baseUrl: "https://test.atlassian.net",
        },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
}

describe("jiraSourceReplyAdapter", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env["JIRA_EMAIL"] = "agent@test.com";
    process.env["JIRA_API_TOKEN"] = "secret-token";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("posts reply to Jira issue and appends AO_SESSION marker", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "",
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await jiraSourceReplyAdapter.sendReply({
      config: makeConfig(),
      envelope: {
        id: "env-1",
        sessionId: "app-orchestrator",
        source: "jira",
        text: "Incoming question",
        receivedAt: new Date().toISOString(),
        routing: {
          issueKey: "INT-123",
          commentId: "10001",
        },
      },
      message: "Acknowledged. Working on it.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/api/3/issue/INT-123/comment");
    const body = JSON.parse(String(request.body));
    const content = body.body?.content as Array<{ content?: Array<{ text?: string }> }>;
    const texts = content.flatMap((paragraph) =>
      (paragraph.content ?? []).map((node) => node.text ?? ""),
    );
    expect(texts.join("\n")).toContain("Acknowledged. Working on it.");
    expect(texts.join("\n")).toContain("AO_SESSION:app-orchestrator");
  });
});
