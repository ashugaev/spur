import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundContextStore, OrchestratorConfig, SessionManager } from "@composio/ao-core";
import type { IntegrationHealthReporter } from "../../src/lib/integration-health.js";
import { maybeStartJiraCommentPolling } from "../../src/lib/jira-comment-polling.js";

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-test/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      int: {
        name: "Test",
        repo: "org/repo",
        path: "/tmp/repo",
        defaultBranch: "main",
        sessionPrefix: "test",
        tracker: { plugin: "jira", baseUrl: "https://test.atlassian.net" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...overrides,
  };
}

function makeSessionManager(
  sessions: Array<{ id: string; status: string; issueId: string | null }> = [],
): SessionManager {
  return {
    list: vi.fn(async () => sessions),
    get: vi.fn(),
    spawn: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    send: vi.fn(async () => {}),
  };
}

function makeHealthReporterMock(): IntegrationHealthReporter {
  return {
    snapshotPath: "/tmp/ao-test/integration-health.json",
    upsert: vi.fn(),
    markStarting: vi.fn(),
    markHealthy: vi.fn(),
    markDegraded: vi.fn(),
    markInactive: vi.fn(),
    getSnapshot: vi.fn(() => ({
      version: 1,
      projectId: "test",
      updatedAt: new Date(0).toISOString(),
      entries: [],
    })),
  };
}

function makeInboundContextStore(): InboundContextStore {
  return {
    enqueue: vi.fn(async () => ({
      id: "env-1",
      sessionId: "test-1",
      source: "jira",
      text: "hello",
      receivedAt: new Date().toISOString(),
      routing: { issueKey: "INT-100", commentId: "10002" },
    })),
    peekNext: vi.fn(),
    ack: vi.fn(),
    listPending: vi.fn(),
  };
}

describe("maybeStartJiraCommentPolling", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    process.env["JIRA_EMAIL"] = "user@test.com";
    process.env["JIRA_API_TOKEN"] = "tok-123";
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("returns null when no project uses jira tracker", async () => {
    const config = makeConfig({ projects: {} });
    const sm = makeSessionManager();
    const fetchImpl = vi.fn();
    const healthReporter = makeHealthReporterMock();

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(healthReporter.markInactive).toHaveBeenCalledTimes(1);
  });

  it("returns null when jira credentials are missing", async () => {
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];
    const config = makeConfig();
    const sm = makeSessionManager();
    const fetchImpl = vi.fn();
    const healthReporter = makeHealthReporterMock();

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(healthReporter.markInactive).toHaveBeenCalledTimes(1);
  });

  it("normalizes host URLs and falls back to default interval for invalid env values", async () => {
    delete process.env["JIRA_URL"];
    process.env["JIRA_HOST"] = "test.atlassian.net/";
    process.env["AO_JIRA_POLL_INTERVAL_MS"] = "-10";

    const config = makeConfig();
    config.projects.int = {
      ...config.projects.int!,
      tracker: { plugin: "jira" },
    };
    const sm = makeSessionManager([{ id: "test-1", status: "working", issueId: "INT-100" }]);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ comments: [] }),
    });

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter: makeHealthReporterMock(),
    });

    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("https://test.atlassian.net/rest/api/3/issue/INT-100/comment"),
      expect.any(Object),
    );

    fetchImpl.mockClear();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalled();

    controller?.stop();
  });

  it("polls and routes reply to AO_SESSION comment", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([
      { id: "test-1", status: "working", issueId: "INT-100" },
    ]);

    const commentsFirstPoll = [
      {
        id: "10001",
        created: "2026-03-01T00:00:00.000Z",
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "[URGENT] ci_failed\nAO_SESSION:test-1" }] }] },
        author: { emailAddress: "bot@test.com" },
      },
    ];

    const commentsSecondPoll = [
      ...commentsFirstPoll,
      {
        id: "10002",
        created: "2026-03-01T00:01:00.000Z",
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Please retry with --fix flag" }] }] },
        author: { emailAddress: "human@test.com" },
      },
    ];

    const fetchImpl = vi
      .fn()
      // first poll
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsFirstPoll }),
      })
      // second poll
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll }),
      })
      // subsequent polls
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll }),
      });

    const logger = { warn: vi.fn() };
    const healthReporter = makeHealthReporterMock();

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
      healthReporter,
    });

    expect(controller).not.toBeNull();

    // Immediate pollOnce() seeds seen comments (first mock),
    // then the interval fires and sees the new comment (second mock).
    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("test-1", "Please retry with --fix flag");
    expect(healthReporter.markHealthy).toHaveBeenCalled();

    // Next poll — same comments, should not re-send
    (sm.send as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sm.send).not.toHaveBeenCalled();

    controller?.stop();
    expect(healthReporter.markInactive).toHaveBeenCalled();
  });

  it("marks cycle degraded when reply forwarding fails", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([{ id: "test-1", status: "working", issueId: "INT-100" }]);
    (sm.send as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("session send failed"));

    const commentsFirstPoll = [
      {
        id: "10001",
        created: "2026-03-01T00:00:00.000Z",
        body: "Marker AO_SESSION:test-1",
        author: { emailAddress: "bot@test.com" },
      },
    ];
    const commentsSecondPoll = [
      ...commentsFirstPoll,
      {
        id: "10002",
        created: "2026-03-01T00:01:00.000Z",
        body: "Please retry",
        author: { emailAddress: "human@test.com" },
      },
    ];

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsFirstPoll, total: 1, maxResults: 100 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll, total: 2, maxResults: 100 }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll, total: 2, maxResults: 100 }),
      });

    const healthReporter = makeHealthReporterMock();
    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("test-1", "Please retry");
    expect(healthReporter.markDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "jira-comment-polling" }),
      expect.stringContaining("one or more issue errors"),
    );

    controller?.stop();
  });

  it("paginates Jira comments fetch safely", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([{ id: "test-1", status: "working", issueId: "INT-100" }]);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [{ id: "10001", created: "2026-03-01T00:00:00.000Z", body: "Marker AO_SESSION:test-1", author: {} }],
            total: 2,
            maxResults: 1,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [{ id: "10002", created: "2026-03-01T00:01:00.000Z", body: "No-op", author: {} }],
            total: 2,
            maxResults: 1,
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ comments: [], total: 2, maxResults: 1 }),
      });

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter: makeHealthReporterMock(),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("startAt=0");
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("maxResults=100");
    expect(fetchImpl.mock.calls[1]?.[0]).toContain("startAt=1");

    controller?.stop();
  });

  it("ignores comments that contain AO_SESSION marker", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([
      { id: "test-1", status: "working", issueId: "INT-100" },
    ]);

    const commentsFirstPoll = [
      {
        id: "10001",
        created: "2026-03-01T00:00:00.000Z",
        body: "Some context AO_SESSION:test-1",
        author: { emailAddress: "bot@test.com" },
      },
    ];

    const commentsSecondPoll = [
      ...commentsFirstPoll,
      {
        id: "10002",
        created: "2026-03-01T00:01:00.000Z",
        body: "Another marker AO_SESSION:test-1",
        author: { emailAddress: "bot@test.com" },
      },
    ];

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsFirstPoll }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ comments: commentsSecondPoll }),
      });

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter: makeHealthReporterMock(),
    });

    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sm.send).not.toHaveBeenCalled();

    controller?.stop();
  });

  it("skips sessions that are killed or done", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([
      { id: "test-1", status: "killed", issueId: "INT-100" },
      { id: "test-2", status: "done", issueId: "INT-101" },
    ]);

    const fetchImpl = vi.fn();

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter: makeHealthReporterMock(),
    });

    await vi.runOnlyPendingTimersAsync();
    // No fetch calls for comments because all sessions are killed/done
    expect(fetchImpl).not.toHaveBeenCalled();

    controller?.stop();
  });

  it("marks degraded when Jira API request fails", async () => {
    const config = makeConfig();
    const sm = makeSessionManager([{ id: "test-1", status: "working", issueId: "INT-100" }]);
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal error"),
    });

    const controller = await maybeStartJiraCommentPolling({
      config,
      sessionManager: sm,
      inboundContextStore: makeInboundContextStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: { warn: vi.fn() },
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(healthReporter.markDegraded).toHaveBeenCalled();
    controller?.stop();
  });
});
