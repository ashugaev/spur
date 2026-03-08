import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AudioTranscriber, OrchestratorConfig, SessionManager } from "@composio/ao-core";

function makeProject(sessionPrefix: string) {
  return {
    name: `${sessionPrefix} project`,
    repo: `acme/${sessionPrefix}`,
    path: `/tmp/${sessionPrefix}`,
    defaultBranch: "main",
    sessionPrefix,
  };
}

const mockSessionManager: SessionManager = {
  list: vi.fn(),
  get: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(),
  cleanup: vi.fn(),
  spawnOrchestrator: vi.fn(),
  restore: vi.fn(),
  send: vi.fn(async () => {}),
};

const mockInboundContextStore = {
  enqueue: vi.fn(async () => ({
    id: "ctx-1",
    sessionId: "app-7",
    source: "telegram",
    text: "hello",
    receivedAt: new Date().toISOString(),
    routing: { chatId: "123456", messageId: 100 },
  })),
  peekNext: vi.fn(),
  ack: vi.fn(),
  listPending: vi.fn(),
};

const mockAudioTranscriber: AudioTranscriber = {
  name: "whisper-cpp",
  transcribeLocalFile: vi.fn(async () => ({
    text: "transcribed voice text",
    language: "auto",
    durationMs: 20,
    backend: "whisper-cpp",
  })),
};

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": makeProject("my-app"),
    other: makeProject("other"),
  },
  notifiers: {
    telegram: {
      plugin: "telegram",
      botToken: "token-1",
      chatId: "123456",
      webhookSecret: "secret-1",
    },
  },
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    sessionManager: mockSessionManager,
    registry: null,
    audioTranscriber: mockAudioTranscriber,
  })),
}));

vi.mock("@composio/ao-core", async () => {
  const actual = await vi.importActual("@composio/ao-core");
  return {
    ...actual,
    createInboundContextStore: vi.fn(() => mockInboundContextStore),
  };
});

import { POST as telegramWebhookPOST } from "@/app/api/integrations/telegram/route";

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/integrations/telegram"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function parseFetchBody(callArgs: unknown[]): Record<string, unknown> {
  const init = callArgs[1] as { body?: unknown } | undefined;
  if (!init || typeof init.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("POST /api/integrations/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "my-app-orchestrator", status: "working", activity: "active" },
    ]);
    mockInboundContextStore.enqueue.mockResolvedValue({
      id: "ctx-1",
      sessionId: "app-7",
      source: "telegram",
      text: "hello",
      receivedAt: new Date().toISOString(),
      routing: { chatId: "123456", messageId: 100 },
    });

    delete process.env["AO_TELEGRAM_CHAT_ID"];
    delete process.env["TELEGRAM_CHAT_ID"];
    delete process.env["TG_CHAT_ID"];
    delete process.env["AO_TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TG_WEBHOOK_SECRET"];
    delete process.env["AO_PROJECT_ID"];
  });

  it("routes valid reply to sessionManager.send", async () => {
    const req = makeRequest(
      {
        update_id: 1,
        message: {
          message_id: 100,
          text: "Continue and fix the flaky test",
          chat: { id: 123456 },
          reply_to_message: {
            text: "[URGENT] session.needs_input\nAO_SESSION:app-7",
          },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-7", "Continue and fix the flaky test");
    expect(mockInboundContextStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-7",
        source: "telegram",
      }),
    );
  });

  it("transcribes Telegram voice replies and routes transcript", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_1.oga", file_size: 128 },
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
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = makeRequest(
      {
        update_id: 11,
        message: {
          message_id: 112,
          chat: { id: 123456 },
          voice: { file_id: "voice-file-1", duration: 4 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockAudioTranscriber.transcribeLocalFile).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Transcribed voice message]"),
    );
  });

  it("routes voice transcription errors as system messages", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_2.oga", file_size: 64 },
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
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    (mockAudioTranscriber.transcribeLocalFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("model file missing"),
    );

    const req = makeRequest(
      {
        update_id: 12,
        message: {
          message_id: 113,
          chat: { id: 123456 },
          voice: { file_id: "voice-file-2", duration: 4 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Telegram voice transcription failed]"),
    );
  });

  it("truncates oversized voice transcription error details before routing", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_long_error.oga", file_size: 64 },
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
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const longError = "decoder failed ".repeat(1_000);
    (mockAudioTranscriber.transcribeLocalFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(longError),
    );

    const req = makeRequest(
      {
        update_id: 121,
        message: {
          message_id: 121,
          chat: { id: 123456 },
          voice: { file_id: "voice-file-long-error", duration: 4 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    const routedMessage = (mockSessionManager.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(typeof routedMessage).toBe("string");
    expect(routedMessage).toContain("[Telegram voice transcription failed]");
    expect((routedMessage as string).length).toBeLessThanOrEqual(700);
    expect(routedMessage).not.toContain("transcript exceeds 10000 characters");
  });

  it("routes oversized voice transcripts as system messages instead of returning 400", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_3.oga", file_size: 96 },
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
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    (mockAudioTranscriber.transcribeLocalFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "x".repeat(10_050),
      language: "auto",
      durationMs: 44,
      backend: "whisper-cpp",
    });

    const req = makeRequest(
      {
        update_id: 13,
        message: {
          message_id: 114,
          chat: { id: 123456 },
          voice: { file_id: "voice-file-3", duration: 4 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-7",
      expect.stringContaining("[Telegram voice transcription failed] transcript exceeds 10000 characters"),
    );
  });

  it("rejects oversized voice files before file download", async () => {
    const previousServices = mockConfig.services;
    mockConfig.services = {
      transcriber: {
        plugin: "whisper-cpp",
        maxAudioBytes: 16,
      },
    };

    try {
      const fetchMock = vi.fn(async (...args: unknown[]) => {
        const url = String(args[0] ?? "");
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
        throw new Error(`Unexpected URL: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const req = makeRequest(
        {
          update_id: 131,
          message: {
            message_id: 131,
            chat: { id: 123456 },
            voice: { file_id: "voice-file-oversized", duration: 4 },
            reply_to_message: { text: "AO_SESSION:app-7" },
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      );

      const res = await telegramWebhookPOST(req);
      expect(res.status).toBe(200);
      expect(mockSessionManager.send).toHaveBeenCalledWith(
        "app-7",
        expect.stringContaining("[Telegram voice transcription failed] Audio is too large"),
      );
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes("/file/bot")),
      ).toBe(false);
      expect(mockAudioTranscriber.transcribeLocalFile).not.toHaveBeenCalled();
    } finally {
      mockConfig.services = previousServices;
    }
  });

  it("returns 503 when inbound chat id is not configured", async () => {
    const notifiers = mockConfig.notifiers as Record<string, Record<string, unknown>>;
    const previousChatId = notifiers["telegram"]?.["chatId"];
    delete notifiers["telegram"]?.["chatId"];

    try {
      const req = makeRequest(
        {
          message: {
            message_id: 101,
            text: "continue",
            chat: { id: 123456 },
            reply_to_message: { text: "AO_SESSION:app-7" },
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      );

      const res = await telegramWebhookPOST(req);
      expect(res.status).toBe(503);
      expect(mockSessionManager.send).not.toHaveBeenCalled();
    } finally {
      notifiers["telegram"] = {
        ...notifiers["telegram"],
        chatId: previousChatId,
      };
    }
  });

  it("returns 401 on invalid secret", async () => {
    const req = makeRequest(
      {
        message: {
          message_id: 102,
          text: "continue",
          chat: { id: 123456 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "bad-secret" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(401);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("returns 403 for disallowed chat", async () => {
    const req = makeRequest(
      {
        message: {
          message_id: 103,
          text: "continue",
          chat: { id: 999999 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(403);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("returns 400 when chat id is missing", async () => {
    const req = makeRequest(
      {
        message: {
          message_id: 104,
          text: "continue",
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/chat id is missing/i);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("sends /project picker with inline keyboard for the current thread scope", async () => {
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 2000 } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = makeRequest(
      {
        update_id: 2000,
        message: {
          message_id: 2000,
          text: "/project",
          chat: { id: 123456 },
          message_thread_id: 61,
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(mockInboundContextStore.enqueue).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.handled).toBe("project-picker");
    expect(sendMessageBodies).toHaveLength(1);
    expect(sendMessageBodies[0]).toMatchObject({
      chat_id: "123456",
      message_thread_id: 61,
    });
    expect(String(sendMessageBodies[0]?.["text"] ?? "")).toContain(
      "Current active project: none (fallback routing).",
    );
    const inlineKeyboard = (
      sendMessageBodies[0]?.["reply_markup"] as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>;
      }
    )?.inline_keyboard;
    const callbackData = (inlineKeyboard ?? []).flat().map((button) => button.callback_data);
    expect(callbackData).toEqual(expect.arrayContaining(["AO_PROJECT:my-app", "AO_PROJECT:other"]));
  });

  it("supports /projects as a project picker alias", async () => {
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/sendMessage")) {
        sendMessageBodies.push(parseFetchBody(args));
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 2001 } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = makeRequest(
      {
        update_id: 2001,
        message: {
          message_id: 2001,
          text: "/projects",
          chat: { id: 123456 },
          message_thread_id: 62,
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(sendMessageBodies).toHaveLength(1);
  });

  it("shows selected project as active hint when /projects is used after callback selection", async () => {
    const answerCallbackBodies: Record<string, unknown>[] = [];
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
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
          json: () => Promise.resolve({ ok: true, result: { message_id: 2011 } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackRes = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 2010,
          callback_query: {
            id: "cbq-web-alias-1",
            data: "AO_PROJECT:other",
            message: {
              message_id: 2010,
              chat: { id: 123456 },
              message_thread_id: 62,
            },
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(callbackRes.status).toBe(200);
    expect(answerCallbackBodies).toEqual([{ callback_query_id: "cbq-web-alias-1" }]);

    const pickerRes = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 2011,
          message: {
            message_id: 2011,
            text: "/projects",
            chat: { id: 123456 },
            message_thread_id: 62,
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(pickerRes.status).toBe(200);
    expect(sendMessageBodies).toHaveLength(2);
    expect(String(sendMessageBodies[1]?.["text"] ?? "")).toContain("Current active project: other.");
  });

  it("keeps AO_SESSION reply routing precedence over /projects command text", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const req = makeRequest(
      {
        update_id: 2002,
        message: {
          message_id: 2002,
          text: "/projects",
          chat: { id: 123456 },
          reply_to_message: { text: "[ACTION] session.needs_input\nAO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-7", "/projects");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges callback selection and routes thread-scoped non-reply messages to selected project", async () => {
    process.env["AO_PROJECT_ID"] = "my-app";
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "my-app-orchestrator", status: "working", activity: "ready" },
      { id: "other-orchestrator", status: "working", activity: "active" },
    ]);

    const answerCallbackBodies: Record<string, unknown>[] = [];
    const sendMessageBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
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
          json: () => Promise.resolve({ ok: true, result: { message_id: 3001 } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackRes = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 3000,
          callback_query: {
            id: "cbq-web-1",
            data: "AO_PROJECT:other",
            message: {
              message_id: 300,
              chat: { id: 123456 },
              message_thread_id: 77,
            },
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(callbackRes.status).toBe(200);
    expect(answerCallbackBodies).toEqual([{ callback_query_id: "cbq-web-1" }]);
    expect(String(sendMessageBodies[0]?.["text"] ?? "")).toContain(
      "Active project for this chat/thread scope is now: other.",
    );

    const selectedThreadResponse = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 3001,
          message: {
            message_id: 301,
            text: "route selected thread",
            chat: { id: 123456 },
            message_thread_id: 77,
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(selectedThreadResponse.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "other-orchestrator",
      expect.stringContaining("\n\nroute selected thread"),
    );
    expect(mockInboundContextStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "other-orchestrator",
        routing: expect.objectContaining({ projectId: "other", threadId: 77 }),
      }),
    );

    const otherThreadResponse = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 3002,
          message: {
            message_id: 302,
            text: "route fallback thread",
            chat: { id: 123456 },
            message_thread_id: 78,
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(otherThreadResponse.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("\n\nroute fallback thread"),
    );
  });

  it("falls back when selected project orchestrator is unavailable", async () => {
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "my-app-orchestrator", status: "working", activity: "active" },
    ]);

    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/answerCallbackQuery")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: true }),
        };
      }
      if (url.includes("/sendMessage")) {
        return {
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 3002 } }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const callbackRes = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 3010,
          callback_query: {
            id: "cbq-web-2",
            data: "AO_PROJECT:other",
            message: {
              message_id: 310,
              chat: { id: 123456 },
              message_thread_id: 91,
            },
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(callbackRes.status).toBe(200);

    const msgRes = await telegramWebhookPOST(
      makeRequest(
        {
          update_id: 3011,
          message: {
            message_id: 311,
            text: "route via fallback when selected project unavailable",
            chat: { id: 123456 },
            message_thread_id: 91,
          },
        },
        { "x-telegram-bot-api-secret-token": "secret-1" },
      ),
    );
    expect(msgRes.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("\n\nroute via fallback when selected project unavailable"),
    );
    expect(mockInboundContextStore.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "my-app-orchestrator",
        routing: expect.objectContaining({ projectId: "other", threadId: 91 }),
      }),
    );
  });

  it("routes non-reply messages to fallback orchestrator session", async () => {
    const req = makeRequest(
      {
        message: {
          message_id: 105,
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining(
        "[SOURCE:telegram] inbound message from connected integration.",
      ),
    );
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining('ao source-reply my-app-orchestrator "<message>"'),
    );
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("\n\nhello"),
    );
  });

  it("ignores message when no reply marker and no fallback session", async () => {
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const req = makeRequest(
      {
        message: {
          message_id: 106,
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toContain("No target session found");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("skips voice download/transcription when no target session is resolved", async () => {
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const req = makeRequest(
      {
        update_id: 1061,
        message: {
          message_id: 1061,
          chat: { id: 123456 },
          voice: { file_id: "voice-no-target", duration: 5 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toContain("No target session found");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAudioTranscriber.transcribeLocalFile).not.toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("ignores ambiguous non-reply fallback when multiple orchestrators are active", async () => {
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "my-app-orchestrator", status: "working", activity: "active" },
      { id: "other-orchestrator", status: "working", activity: "active" },
    ]);

    const req = makeRequest(
      {
        message: {
          message_id: 107,
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toContain("No target session found");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("honors AO_PROJECT_ID as a strict orchestrator pin", async () => {
    process.env["AO_PROJECT_ID"] = "my-app";
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "my-app-orchestrator", status: "working", activity: "ready" },
      { id: "other-orchestrator", status: "working", activity: "active" },
    ]);

    const req = makeRequest(
      {
        message: {
          message_id: 108,
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining(
        "[SOURCE:telegram] inbound message from connected integration.",
      ),
    );
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining('ao source-reply my-app-orchestrator "<message>"'),
    );
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "my-app-orchestrator",
      expect.stringContaining("\n\nhello"),
    );
  });

  it("returns 503 when fallback session resolution fails", async () => {
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("list failed"),
    );

    const req = makeRequest(
      {
        message: {
          message_id: 109,
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(503);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("returns 400 for empty reply text after sanitization", async () => {
    const req = makeRequest(
      {
        message: {
          message_id: 110,
          text: "\u0000\u0001",
          chat: { id: 123456 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(400);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("returns 400 when message id is missing", async () => {
    const req = makeRequest(
      {
        message: {
          text: "continue",
          chat: { id: 123456 },
          reply_to_message: { text: "AO_SESSION:app-7" },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/message id is missing/i);
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("continues routing when inbound context persist fails", async () => {
    mockInboundContextStore.enqueue.mockRejectedValueOnce(new Error("disk unavailable"));

    const req = makeRequest(
      {
        message: {
          message_id: 111,
          text: "Continue and fix the flaky test",
          chat: { id: 123456 },
          reply_to_message: {
            text: "[URGENT] session.needs_input\nAO_SESSION:app-7",
          },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-7", "Continue and fix the flaky test");
    const body = await res.json();
    expect(body.warning).toMatch(/disk unavailable/i);
  });
});
