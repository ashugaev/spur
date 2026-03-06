import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorConfig, SessionManager } from "@composio/ao-core";
import { maybeStartTelegramLongPolling } from "../../src/lib/telegram-polling.js";

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    configPath: "/tmp/ao-test/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {},
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

describe("maybeStartTelegramLongPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it("returns null when telegram notifier is not configured", async () => {
    const config = makeConfig({ notifiers: {} });
    const sm = makeSessionManager();
    const fetchImpl = vi.fn();

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(controller).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when webhook is configured", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
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
    });

    expect(controller).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls every 30s and routes valid reply to sessionManager.send", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();

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
    });

    expect(controller).not.toBeNull();

    // Immediate poll
    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).toHaveBeenCalledWith("app-7", "Continue with fix");

    // Next interval poll (30s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalled();

    controller?.stop();
  });

  it("ignores replies from a different chat", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();

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
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();

    controller?.stop();
  });
});
