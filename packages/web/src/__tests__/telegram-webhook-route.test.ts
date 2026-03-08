import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { OrchestratorConfig, SessionManager } from "@composio/ao-core";

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

describe("POST /api/integrations/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
