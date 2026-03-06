import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig, SessionManager } from "@composio/ao-core";
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

  it("polls every 30s and routes valid reply to sessionManager.send", async () => {
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

    // Next interval poll (30s)
    await vi.advanceTimersByTimeAsync(30_000);
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("my-app-orchestrator", "run health check");
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("app-orchestrator", "deploy");
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
});
