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
    reactions: {
      "tracker-comment": {
        auto: true,
        action: "send-to-agent",
        kind: "reply",
      },
    },
    ...overrides,
  };
}

function makeSessionManager(
  sessions: Array<{ id: string; status: string; issueId: string | null; projectId?: string }> = [],
): SessionManager {
  // Default projectId to "int" so sessions match the default config project
  const sessionsWithProject = sessions.map((s) => ({
    ...s,
    projectId: s.projectId ?? "int",
  }));
  return {
    list: vi.fn(async () => sessionsWithProject),
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

  // ---------------------------------------------------------------------------
  // New tests for per-project Jira connection config
  // ---------------------------------------------------------------------------

  it("per-project auth overrides env vars", async () => {
    const config = makeConfig({
      projects: {
        int: {
          name: "Test",
          repo: "org/repo",
          path: "/tmp/repo",
          defaultBranch: "main",
          sessionPrefix: "test",
          tracker: {
            plugin: "jira",
            baseUrl: "https://project.atlassian.net",
            email: "project-user@example.com",
            apiToken: "project-token-xyz",
          },
        },
      },
    });
    // Env vars have different values — they should NOT be used
    process.env["JIRA_EMAIL"] = "env-user@example.com";
    process.env["JIRA_API_TOKEN"] = "env-token-abc";

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

    expect(controller).not.toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalled();

    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://project.atlassian.net");
    // Authorization header should use project-level credentials
    const expectedAuth = `Basic ${btoa("project-user@example.com:project-token-xyz")}`;
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(expectedAuth);

    controller?.stop();
  });

  it("multiple Jira instances — each project fetched with correct URL and Authorization", async () => {
    const config = makeConfig({
      projects: {
        proj_a: {
          name: "Project A",
          repo: "org/repo-a",
          path: "/tmp/repo-a",
          defaultBranch: "main",
          sessionPrefix: "a",
          tracker: {
            plugin: "jira",
            baseUrl: "https://project-a.atlassian.net",
            email: "user-a@example.com",
            apiToken: "token-a",
          },
        },
        proj_b: {
          name: "Project B",
          repo: "org/repo-b",
          path: "/tmp/repo-b",
          defaultBranch: "main",
          sessionPrefix: "b",
          tracker: {
            plugin: "jira",
            baseUrl: "https://project-b.atlassian.net",
            email: "user-b@example.com",
            apiToken: "token-b",
          },
        },
      },
    });

    const sm = makeSessionManager([
      { id: "a-1", status: "working", issueId: "A-100", projectId: "proj_a" },
      { id: "b-1", status: "working", issueId: "B-200", projectId: "proj_b" },
    ]);

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

    expect(controller).not.toBeNull();
    // runOnlyPendingTimersAsync flushes the initial pollOnce AND the first interval tick;
    // both polls produce 2 fetch calls (one per project) each → up to 4 calls total is fine.
    await vi.runOnlyPendingTimersAsync();

    const callUrls = fetchImpl.mock.calls.map((c: unknown[]) => c[0] as string);
    const callAuths = fetchImpl.mock.calls.map(
      (c: unknown[]) =>
        ((c[1] as RequestInit).headers as Record<string, string>)["Authorization"],
    );

    // Both Jira instances should have been called at least once
    const aCall = callUrls.findIndex((u) => u.includes("project-a.atlassian.net"));
    const bCall = callUrls.findIndex((u) => u.includes("project-b.atlassian.net"));
    expect(aCall).toBeGreaterThanOrEqual(0);
    expect(bCall).toBeGreaterThanOrEqual(0);

    expect(callAuths[aCall]).toBe(`Basic ${btoa("user-a@example.com:token-a")}`);
    expect(callAuths[bCall]).toBe(`Basic ${btoa("user-b@example.com:token-b")}`);

    controller?.stop();
  });

  it("env var fallback — tracker has baseUrl but no email/apiToken, env vars supply them", async () => {
    const config = makeConfig({
      projects: {
        int: {
          name: "Test",
          repo: "org/repo",
          path: "/tmp/repo",
          defaultBranch: "main",
          sessionPrefix: "test",
          tracker: {
            plugin: "jira",
            baseUrl: "https://fallback.atlassian.net",
            // no email or apiToken — should fall back to env vars
          },
        },
      },
    });
    process.env["JIRA_EMAIL"] = "fallback-user@example.com";
    process.env["JIRA_API_TOKEN"] = "fallback-token";

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

    expect(controller).not.toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchImpl).toHaveBeenCalled();

    const [url, opts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://fallback.atlassian.net");
    const expectedAuth = `Basic ${btoa("fallback-user@example.com:fallback-token")}`;
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(expectedAuth);

    controller?.stop();
  });

  it("skips incomplete projects — project missing credentials is skipped, complete project still works", async () => {
    delete process.env["JIRA_EMAIL"];
    delete process.env["JIRA_API_TOKEN"];

    const config = makeConfig({
      projects: {
        incomplete: {
          name: "Incomplete",
          repo: "org/incomplete",
          path: "/tmp/incomplete",
          defaultBranch: "main",
          sessionPrefix: "inc",
          tracker: {
            plugin: "jira",
            baseUrl: "https://incomplete.atlassian.net",
            // no email or apiToken and no env vars → should be skipped
          },
        },
        complete: {
          name: "Complete",
          repo: "org/complete",
          path: "/tmp/complete",
          defaultBranch: "main",
          sessionPrefix: "cpl",
          tracker: {
            plugin: "jira",
            baseUrl: "https://complete.atlassian.net",
            email: "user@complete.com",
            apiToken: "complete-token",
          },
        },
      },
    });

    const sm = makeSessionManager([
      { id: "inc-1", status: "working", issueId: "INC-100", projectId: "incomplete" },
      { id: "cpl-1", status: "working", issueId: "CPL-200", projectId: "complete" },
    ]);

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

    // Should not be null — complete project is valid
    expect(controller).not.toBeNull();
    await vi.runOnlyPendingTimersAsync();

    // Only the complete project's issue should have been fetched
    expect(fetchImpl).toHaveBeenCalled();
    const allUrls = fetchImpl.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(allUrls.every((u) => u.includes("complete.atlassian.net"))).toBe(true);
    expect(allUrls.some((u) => u.includes("incomplete.atlassian.net"))).toBe(false);

    controller?.stop();
  });

  it("minimum interval — multiple projects with different pollIntervalMs uses the minimum", async () => {
    const config = makeConfig({
      projects: {
        fast: {
          name: "Fast",
          repo: "org/fast",
          path: "/tmp/fast",
          defaultBranch: "main",
          sessionPrefix: "fast",
          tracker: {
            plugin: "jira",
            baseUrl: "https://fast.atlassian.net",
            email: "user@fast.com",
            apiToken: "token-fast",
            pollIntervalMs: 15_000,
          },
        },
        slow: {
          name: "Slow",
          repo: "org/slow",
          path: "/tmp/slow",
          defaultBranch: "main",
          sessionPrefix: "slow",
          tracker: {
            plugin: "jira",
            baseUrl: "https://slow.atlassian.net",
            email: "user@slow.com",
            apiToken: "token-slow",
            pollIntervalMs: 120_000,
          },
        },
      },
    });

    const sm = makeSessionManager([
      { id: "fast-1", status: "working", issueId: "FAST-1", projectId: "fast" },
    ]);

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

    expect(controller).not.toBeNull();
    // Initial poll
    await vi.runOnlyPendingTimersAsync();
    fetchImpl.mockClear();

    // Advance by 14 seconds — should NOT fire yet (interval is 15s)
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetchImpl).not.toHaveBeenCalled();

    // Advance 1 more second to hit 15s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalled();

    controller?.stop();
  });

  it("isolates seen-comment state by project when issue keys match", async () => {
    const config = makeConfig({
      projects: {
        proj_a: {
          name: "Project A",
          repo: "org/repo-a",
          path: "/tmp/repo-a",
          defaultBranch: "main",
          sessionPrefix: "a",
          tracker: {
            plugin: "jira",
            baseUrl: "https://project-a.atlassian.net",
            email: "user-a@example.com",
            apiToken: "token-a",
          },
        },
        proj_b: {
          name: "Project B",
          repo: "org/repo-b",
          path: "/tmp/repo-b",
          defaultBranch: "main",
          sessionPrefix: "b",
          tracker: {
            plugin: "jira",
            baseUrl: "https://project-b.atlassian.net",
            email: "user-b@example.com",
            apiToken: "token-b",
          },
        },
      },
    });

    const sm = makeSessionManager([
      { id: "a-1", status: "working", issueId: "INT-100", projectId: "proj_a" },
      { id: "b-1", status: "working", issueId: "INT-100", projectId: "proj_b" },
    ]);

    let aPoll = 0;
    let bPoll = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("project-a.atlassian.net")) {
        aPoll += 1;
        if (aPoll === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                comments: [{ id: "a-1", created: "2026-03-01", body: "AO_SESSION:a-1", author: {} }],
              }),
          };
        }
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              comments: [
                { id: "a-1", created: "2026-03-01", body: "AO_SESSION:a-1", author: {} },
                { id: "a-2", created: "2026-03-01", body: "please update", author: {} },
              ],
            }),
        };
      }

      bPoll += 1;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [{ id: "b-1", created: "2026-03-01", body: "AO_SESSION:b-1", author: {} }],
          }),
      };
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
    expect(aPoll).toBeGreaterThanOrEqual(1);
    expect(bPoll).toBeGreaterThanOrEqual(1);
    expect(sm.send).toHaveBeenCalledWith("a-1", "please update");
    expect(sm.send).not.toHaveBeenCalledWith("b-1", "please update");

    controller?.stop();
  });

  it("supports tracker-comment reaction with tagged kind and custom message", async () => {
    const config = makeConfig({
      reactions: {
        "tracker-comment": {
          auto: true,
          action: "send-to-agent",
          kind: "tagged",
          message: "Please handle tracker feedback.",
        },
      },
    });

    const sm = makeSessionManager([{ id: "test-1", status: "working", issueId: "INT-100" }]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [{ id: "10001", created: "2026-03-01", body: "AO_SESSION:test-1", author: {} }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [
              { id: "10001", created: "2026-03-01", body: "AO_SESSION:test-1", author: {} },
              { id: "10002", created: "2026-03-01", body: "please update this flow", author: {} },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            comments: [
              { id: "10001", created: "2026-03-01", body: "AO_SESSION:test-1", author: {} },
              { id: "10002", created: "2026-03-01", body: "please update this flow", author: {} },
              { id: "10003", created: "2026-03-01", body: "@ao please update this flow", author: {} },
            ],
          }),
      })
      .mockResolvedValue({
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
    expect(sm.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sm.send).toHaveBeenCalledWith("test-1", "Please handle tracker feedback.");

    controller?.stop();
  });
});
