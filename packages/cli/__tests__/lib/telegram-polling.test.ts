import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AudioTranscriber,
  InboundContextStore,
  OrchestratorConfig,
  SessionManager,
} from "@composio/ao-core";
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

function parseFetchBody(callArgs: unknown[]): Record<string, unknown> {
  const init = callArgs[1] as { body?: unknown } | undefined;
  if (!init || typeof init.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
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

  it("sends /project picker with inline keyboard and active-project hint", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    let updatesCalls = 0;
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 210,
                    message: {
                      message_id: 210,
                      text: "/project",
                      chat: { id: 123456 },
                    },
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 999 } }),
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

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(sendMessageBodies).toHaveLength(1);
    expect(sendMessageBodies[0]).toMatchObject({ chat_id: "123456" });
    expect(String(sendMessageBodies[0]?.["text"] ?? "")).toContain(
      "Current active project: none (fallback routing).",
    );
    const inlineKeyboard = (
      sendMessageBodies[0]?.["reply_markup"] as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      }
    )?.inline_keyboard;
    const callbackData = (inlineKeyboard ?? []).flat().map((button) => button.callback_data);
    expect(callbackData).toEqual(expect.arrayContaining(["AO_PROJECT:app", "AO_PROJECT:other"]));
    controller?.stop();
  });

  it("supports /projects as an alias for the project picker", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    const sendMessageBodies: Record<string, unknown>[] = [];
    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 2101,
                    message: {
                      message_id: 2101,
                      text: "/projects",
                      chat: { id: 123456 },
                    },
                  },
                ],
              }),
          };
        }

        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 10000 } }),
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

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(sendMessageBodies).toHaveLength(1);
    expect(sendMessageBodies[0]).toMatchObject({ chat_id: "123456" });
    expect(String(sendMessageBodies[0]?.["text"] ?? "")).toContain(
      "Current active project: none (fallback routing).",
    );
    controller?.stop();
  });

  it("shows selected project as active hint when /projects is used after callback selection", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    let updatesCalls = 0;
    const answerCallbackBodies: Record<string, unknown>[] = [];
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 2102,
                    callback_query: {
                      id: "cbq-1b",
                      data: "AO_PROJECT:other",
                      message: {
                        message_id: 2102,
                        chat: { id: 123456 },
                        message_thread_id: 79,
                      },
                    },
                  },
                  {
                    update_id: 2103,
                    message: {
                      message_id: 2103,
                      text: "/projects",
                      chat: { id: 123456 },
                      message_thread_id: 79,
                    },
                  },
                ],
              }),
          };
        }

        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/answerCallbackQuery")) {
        answerCallbackBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: true }),
        };
      }

      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 10000 } }),
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

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(answerCallbackBodies).toEqual([{ callback_query_id: "cbq-1b" }]);
    expect(sendMessageBodies).toHaveLength(2);
    expect(String(sendMessageBodies[1]?.["text"] ?? "")).toContain("Current active project: other.");
    controller?.stop();
  });

  it("keeps AO_SESSION reply routing precedence over /project command text", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    let updatesCalls = 0;
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls > 1) {
          return {
            ok: true,
            json: () => Promise.resolve({ ok: true, result: [] }),
          };
        }
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: [
                {
                  update_id: 2110,
                  message: {
                    text: "/project",
                    chat: { id: 123456 },
                    reply_to_message: { text: "[ACTION] session.needs_input\nAO_SESSION:app-7" },
                  },
                },
              ],
            }),
        };
      }

      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 10001 } }),
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

    await vi.runOnlyPendingTimersAsync();
    expect(sendMessageBodies).toHaveLength(0);
    expect(sm.send).toHaveBeenCalledWith("app-7", "/project");
    controller?.stop();
  });

  it("acknowledges project picker callbacks and confirms scoped selection", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();

    let updatesCalls = 0;
    const answerCallbackBodies: Record<string, unknown>[] = [];
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 211,
                    callback_query: {
                      id: "cbq-1",
                      data: "AO_PROJECT:app",
                      message: {
                        message_id: 301,
                        chat: { id: 123456 },
                        message_thread_id: 77,
                      },
                    },
                  },
                  {
                    update_id: 212,
                    message: {
                      message_id: 302,
                      text: "/project",
                      chat: { id: 123456 },
                      message_thread_id: 77,
                    },
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/answerCallbackQuery")) {
        answerCallbackBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: true }),
        };
      }

      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 1000 } }),
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

    await vi.runOnlyPendingTimersAsync();
    expect(sm.send).not.toHaveBeenCalled();
    expect(answerCallbackBodies).toEqual([{ callback_query_id: "cbq-1" }]);
    expect(sendMessageBodies).toHaveLength(2);
    expect(String(sendMessageBodies[0]?.["text"] ?? "")).toContain(
      "Active project for this chat/thread scope is now: app.",
    );
    expect(String(sendMessageBodies[1]?.["text"] ?? "")).toContain(
      "Current active project: app.",
    );
    expect(sendMessageBodies[1]).toMatchObject({ message_thread_id: 77 });
    controller?.stop();
  });

  it("routes non-reply messages to selected project orchestrator when available", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-orchestrator");
    (sm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "app-orchestrator", status: "working", activity: "active", lastActivityAt: new Date() },
      { id: "other-orchestrator", status: "working", activity: "ready", lastActivityAt: new Date() },
    ]);

    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 213,
                    callback_query: {
                      id: "cbq-2",
                      data: "AO_PROJECT:app",
                      message: {
                        message_id: 303,
                        chat: { id: 123456 },
                        message_thread_id: 88,
                      },
                    },
                  },
                  {
                    update_id: 214,
                    message: {
                      message_id: 304,
                      text: "route to selected project",
                      chat: { id: 123456 },
                      message_thread_id: 88,
                    },
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/answerCallbackQuery")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: true }),
        };
      }

      if (url.includes("/sendMessage")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 1001 } }),
        };
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
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
        sessionId: "app-orchestrator",
        source: "telegram",
      }),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "app-orchestrator",
      expect.stringContaining("\n\nroute to selected project"),
    );
    controller?.stop();
  });

  it("falls back to existing routing when selected project session is unavailable", async () => {
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("other-orchestrator");
    (sm.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "other-orchestrator", status: "working", activity: "active", lastActivityAt: new Date() },
    ]);

    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 215,
                    callback_query: {
                      id: "cbq-3",
                      data: "AO_PROJECT:app",
                      message: {
                        message_id: 305,
                        chat: { id: 123456 },
                        message_thread_id: 99,
                      },
                    },
                  },
                  {
                    update_id: 216,
                    message: {
                      message_id: 306,
                      text: "route with fallback",
                      chat: { id: 123456 },
                      message_thread_id: 99,
                    },
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/answerCallbackQuery")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: true }),
        };
      }

      if (url.includes("/sendMessage")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 1002 } }),
        };
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
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
        sessionId: "other-orchestrator",
      }),
    );
    expect(sm.send).toHaveBeenCalledWith(
      "other-orchestrator",
      expect.stringContaining("\n\nroute with fallback"),
    );
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

  it("transcribes voice replies when audio transcriber is available", async () => {
    vi.useRealTimers();
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-7");
    const audioTranscriber: AudioTranscriber = {
      name: "whisper-cpp",
      transcribeLocalFile: vi.fn(async () => ({
        text: "Voice transcript from whisper",
        language: "auto",
        durationMs: 25,
        backend: "whisper-cpp",
      })),
    };

    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 220,
                    message: {
                      message_id: 220,
                      chat: { id: 123456 },
                      voice: { file_id: "voice-file-1", duration: 3 },
                      reply_to_message: { text: "AO_SESSION:app-7" },
                    },
                  },
                ],
              }),
          };
        }

        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_1.oga", file_size: 42 },
            }),
        };
      }

      if (url.includes("/file/bot")) {
        const bytes = new TextEncoder().encode("voice-bytes");
        return {
          ok: true,
          arrayBuffer: () => Promise.resolve(bytes.buffer),
        };
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
    });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      audioTranscriber,
      healthReporter,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/getFile")),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/file/bot")),
    ).toBe(true);
    expect(sm.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Transcribed voice message]"),
    );
    controller?.stop();
  });

  it("rejects oversized voice files before file download", async () => {
    vi.useRealTimers();
    const config = makeConfig({
      services: {
        transcriber: {
          plugin: "whisper-cpp",
          binaryPath: "/opt/whisper.cpp/build/bin/whisper-cli",
          modelPath: "/opt/whisper.cpp/models/ggml-base.bin",
          maxAudioBytes: 16,
        },
      },
    });
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-7");
    const audioTranscriber: AudioTranscriber = {
      name: "whisper-cpp",
      transcribeLocalFile: vi.fn(async () => ({
        text: "should not be called",
        language: "auto",
        durationMs: 1,
        backend: "whisper-cpp",
      })),
    };

    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 2210,
                    message: {
                      message_id: 2210,
                      chat: { id: 123456 },
                      voice: { file_id: "voice-oversized", duration: 3 },
                      reply_to_message: { text: "AO_SESSION:app-7" },
                    },
                  },
                ],
              }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_oversized.oga", file_size: 128 },
            }),
        };
      }

      if (url.includes("/file/bot")) {
        throw new Error("file download should not be attempted for oversized voice");
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
    });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      audioTranscriber,
      healthReporter,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sm.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Telegram voice transcription failed] Audio is too large"),
    );
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/file/bot")),
    ).toBe(false);
    expect(audioTranscriber.transcribeLocalFile).not.toHaveBeenCalled();
    controller?.stop();
  });

  it("routes oversized voice transcripts as system messages instead of dropping them", async () => {
    vi.useRealTimers();
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-7");
    const oversizedTranscript = "a".repeat(10_050);
    const audioTranscriber: AudioTranscriber = {
      name: "whisper-cpp",
      transcribeLocalFile: vi.fn(async () => ({
        text: oversizedTranscript,
        language: "auto",
        durationMs: 30,
        backend: "whisper-cpp",
      })),
    };

    let updatesCalls = 0;
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getWebhookInfo")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { url: "" } }),
        };
      }

      if (url.includes("/getUpdates")) {
        updatesCalls += 1;
        if (updatesCalls === 1) {
          return {
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                result: [
                  {
                    update_id: 222,
                    message: {
                      message_id: 222,
                      chat: { id: 123456 },
                      voice: { file_id: "voice-file-oversized", duration: 6 },
                      reply_to_message: { text: "AO_SESSION:app-7" },
                    },
                  },
                ],
              }),
          };
        }

        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: [] }),
        };
      }

      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_oversized.oga", file_size: 32 },
            }),
        };
      }

      if (url.includes("/file/bot")) {
        const bytes = new TextEncoder().encode("voice-bytes");
        return {
          ok: true,
          arrayBuffer: () => Promise.resolve(bytes.buffer),
        };
      }

      throw new Error(`Unexpected Telegram API URL: ${url}`);
    });

    const controller = await maybeStartTelegramLongPolling({
      config,
      sessionManager: sm,
      inboundContextStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      audioTranscriber,
      healthReporter,
    });

    await vi.waitFor(
      () =>
        expect(sm.send).toHaveBeenCalledWith(
          "app-7",
          expect.stringContaining(
            "[Telegram voice transcription failed] transcript exceeds 10000 characters",
          ),
        ),
      { timeout: 2000 },
    );
    controller?.stop();
  });

  it("routes voice transcription failures as system messages", async () => {
    vi.useRealTimers();
    const config = makeConfig({
      services: {
        transcriber: {
          plugin: "whisper-cpp",
          binaryPath: "/opt/whisper.cpp/build/bin/whisper-cli",
          modelPath: "/opt/whisper.cpp/models/ggml-base.bin",
        },
      },
    });
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-7");

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
                update_id: 221,
                message: {
                  message_id: 221,
                  chat: { id: 123456 },
                  voice: { file_id: "voice-file-2", duration: 5 },
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
      audioTranscriber: null,
      healthReporter,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sm.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Telegram voice transcription failed]"),
    );
    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/getFile")),
    ).toBe(false);
    expect(healthReporter.markDegraded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "telegram-polling" }),
      expect.stringContaining("voice transcription failed"),
      expect.any(Error),
    );
    expect(healthReporter.markHealthy).not.toHaveBeenCalled();
    controller?.stop();
  });

  it("truncates oversized voice transcription error details before routing", async () => {
    vi.useRealTimers();
    const config = makeConfig();
    const sm = makeSessionManager();
    const healthReporter = makeHealthReporterMock();
    const inboundContextStore = makeInboundContextStore("app-7");
    const longError = "whisper failure ".repeat(1_000);
    const audioTranscriber: AudioTranscriber = {
      name: "whisper-cpp",
      transcribeLocalFile: vi.fn(async () => {
        throw new Error(longError);
      }),
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
                update_id: 223,
                message: {
                  message_id: 223,
                  chat: { id: 123456 },
                  voice: { file_id: "voice-file-long-error", duration: 4 },
                  reply_to_message: { text: "AO_SESSION:app-7" },
                },
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ok: true,
            result: { file_path: "voice/file_long_error.oga", file_size: 64 },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("voice-bytes").buffer),
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
      audioTranscriber,
      healthReporter,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const routedMessage = (sm.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(typeof routedMessage).toBe("string");
    expect(routedMessage).toContain("[Telegram voice transcription failed]");
    expect((routedMessage as string).length).toBeLessThanOrEqual(700);
    expect(routedMessage).not.toContain("transcript exceeds 10000 characters");
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
