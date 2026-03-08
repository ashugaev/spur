import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundContextStore, OrchestratorConfig, SessionManager } from "@composio/ao-core";
import type { IntegrationHealthReporter } from "../../src/lib/integration-health.js";
import { maybeStartTelegramLongPolling } from "../../src/lib/telegram-polling.js";

function makeProject(sessionPrefix: string) {
  return {
    name: `${sessionPrefix} project`,
    repo: `acme/${sessionPrefix}`,
    path: `/tmp/${sessionPrefix}`,
    defaultBranch: "main",
    sessionPrefix,
  };
}

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-test/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      app: makeProject("app"),
      other: makeProject("other"),
    },
    notifiers: {
      telegram: {
        plugin: "telegram",
        botToken: "token-1",
        chatId: "123456",
      },
    },
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    ...overrides,
  };
}

function makeSessionManager(): SessionManager {
  return {
    list: vi.fn(),
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

function makeInboundContextStore(sessionId = "app-orchestrator"): InboundContextStore {
  return {
    enqueue: vi.fn(async () => ({
      id: "env-1",
      sessionId,
      source: "telegram",
      text: "hello",
      receivedAt: new Date().toISOString(),
      routing: { chatId: "123456", messageId: 200 },
    })),
    peekNext: vi.fn(),
    ack: vi.fn(),
    listPending: vi.fn(),
  };
}

describe("maybeStartTelegramLongPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env["AO_PROJECT_ID"];
  });

  it("returns null when telegram notifier is not configured", async () => {
    const config = makeConfig({ notifiers: {} });
    const sm = makeSessionManager();
    const fetchImpl = vi.fn();
    const healthReporter = makeHealthReporterMock();

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(healthReporter.markInactive).toHaveBeenCalledTimes(1);
  });

  it("returns null when webhook is configured", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "https://example.com/webhook" } }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    expect(controller).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(healthReporter.markStarting).toHaveBeenCalledTimes(1);
    expect(healthReporter.markInactive).toHaveBeenCalledTimes(1);
  });

  it("polls every 2s and routes valid reply to sessionManager.send", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      // getWebhookInfo: no webhook
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      // first getUpdates: one reply
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  text: "Continue with fix",
                  chat: { id: 123456 },
                  reply_to_message: { text: "[URGENT] session.needs_input\nAO_SESSION:app-7" },
                },
              },
            ],
          }),
      })
      // second getUpdates: empty
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    expect(controller).not.toBeNull();

    // Immediate poll
    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("app-7", "Continue with fix");
    expect(healthReporter.markHealthy).toHaveBeenCalled();

    // Next interval poll (2s)
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).toHaveBeenCalled();

    controller?.stop();
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "telegram-polling" }),
      expect.stringContaining("stopped"),
    );
  });

  it("routes non-reply message to fallback orchestrator session", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("my-app-orchestrator");
    (sm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "my-app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date("2026-03-06T00:00:00.000Z"),
        lastActivityAt: new Date("2026-03-06T00:00:00.000Z"),
        metadata: { role: "orchestrator" },
      },
    ]);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 100,
                message: {
                  message_id: 201,
                  text: "run health check",
                  chat: { id: 123456 },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("[SOURCE:telegram] inbound message from connected integration."),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining('ao source-reply my-app-orchestrator "<message>"'),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("\n\nrun health check"),
    );
    controller?.stop();
  });

  it("ignores replies from a different chat", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 101,
                message: {
                  text: "Continue",
                  chat: { id: 999999 },
                  reply_to_message: { text: "AO_SESSION:app-7" },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(healthReporter.markHealthy).toHaveBeenCalled();

    controller?.stop();
  });

  it("marks status degraded when poll cycle throws", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(healthReporter.markDegraded).toHaveBeenCalled();
    controller?.stop();
  });

  it("backs off for 30s when Telegram API responds with rate limit", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    const getUpdatesCallTimes: number[] = [];
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        getUpdatesCallTimes.push(Date.now());
        if (getUpdatesCallTimes.length === 1) {
          return {
            ok: false,
            status: 429,
            json: () =>
              Promise.resolve({
                ok: false,
                description: "Too Many Requests: retry later",
                parameters: { retry_after: 1 },
              }),
          };
        }

        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
    });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(healthReporter.markDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "telegram-polling" }),
      expect.stringContaining("backing off for 30s"),
      expect.any(Error),
    );
    expect(getUpdatesCallTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(28_000);
    expect(getUpdatesCallTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getUpdatesCallTimes.length).toBeGreaterThan(1);

    controller?.stop();
  });

  it("does not route ambiguous non-reply messages when multiple orchestrators are active", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    (sm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "app-orchestrator", status: "working", activity: "active", lastActivityAt: new Date() },
      { id: "other-orchestrator", status: "working", activity: "ready", lastActivityAt: new Date() },
    ]);
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 202,
                message: {
                  message_id: 202,
                  text: "hello",
                  chat: { id: 123456 },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    controller?.stop();
  });

  it("uses AO_PROJECT_ID as strict preferred fallback orchestrator", async () => {
    process.env["AO_PROJECT_ID"] = "app";
    const config = makeConfig();
    const sm = makeSessionManager();
    const inboundContextStore = makeInboundContextStore("app-orchestrator");
    (sm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "app-orchestrator", status: "working", activity: "ready", lastActivityAt: new Date() },
      { id: "other-orchestrator", status: "working", activity: "active", lastActivityAt: new Date() },
    ]);
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 203,
                message: {
                  message_id: 203,
                  text: "deploy",
                  chat: { id: 123456 },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith(
      "app-orchestrator",
      expect.stringContaining("[SOURCE:telegram] inbound message from connected integration."),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "app-orchestrator",
      expect.stringContaining('ao source-reply app-orchestrator "<message>"'),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "app-orchestrator",
      expect.stringContaining("\n\ndeploy"),
    );
    controller?.stop();
  });

  it("marks degraded when fallback session lookup fails", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    (sm.list as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("list failed"));
    const healthReporter = makeHealthReporterMock();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 204,
                message: {
                  message_id: 204,
                  text: "hello",
                  chat: { id: 123456 },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(healthReporter.markDegraded).toHaveBeenCalled();
    controller?.stop();
  });

  it("persists inbound source context when message_id is present", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = {
      enqueue: vi.fn(async () => ({
        id: "env-1",
        sessionId: "app-7",
        source: "telegram",
        text: "Continue",
        receivedAt: new Date().toISOString(),
        routing: { chatId: "123456", messageId: 205 },
      })),
      peekNext: vi.fn(),
      ack: vi.fn(),
      listPending: vi.fn(),
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 205,
                message: {
                  message_id: 205,
                  text: "Continue",
                  chat: { id: 123456 },
                  reply_to_message: { text: "AO_SESSION:app-7" },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(inboundContextStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-7",
        source: "telegram",
      }),
    );
    expect(sm.send).toHaveBeenCalledWith("app-7", "Continue");
    controller?.stop();
  });

  it("keeps routing message to session when context persist fails", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = {
      enqueue: vi.fn(async () => {
        throw new Error("disk unavailable");
      }),
      peekNext: vi.fn(),
      ack: vi.fn(),
      listPending: vi.fn(),
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { url: "" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: [
              {
                update_id: 206,
                message: {
                  message_id: 206,
                  text: "Continue",
                  chat: { id: 123456 },
                  reply_to_message: { text: "AO_SESSION:app-7" },
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("app-7", "Continue");
    expect(healthReporter.markDegraded).toHaveBeenCalled();
    controller?.stop();
  });
});
