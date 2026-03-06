import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { OrchestratorConfig, SessionManager } from "@composio/ao-core";

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

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {},
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

    delete process.env["AO_TELEGRAM_CHAT_ID"];
    delete process.env["TELEGRAM_CHAT_ID"];
    delete process.env["TG_CHAT_ID"];
    delete process.env["AO_TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TELEGRAM_WEBHOOK_SECRET"];
    delete process.env["TG_WEBHOOK_SECRET"];
  });

  it("routes valid reply to sessionManager.send", async () => {
    const req = makeRequest(
      {
        update_id: 1,
        message: {
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
  });

  it("returns 503 when inbound chat id is not configured", async () => {
    const notifiers = mockConfig.notifiers as Record<string, Record<string, unknown>>;
    const previousChatId = notifiers["telegram"]?.["chatId"];
    delete notifiers["telegram"]?.["chatId"];

    try {
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

  it("ignores messages that are not replies to session notifications", async () => {
    const req = makeRequest(
      {
        message: {
          text: "hello",
          chat: { id: 123456 },
        },
      },
      { "x-telegram-bot-api-secret-token": "secret-1" },
    );

    const res = await telegramWebhookPOST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ignored).toContain("Not a reply");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("returns 400 for empty reply text after sanitization", async () => {
    const req = makeRequest(
      {
        message: {
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
});
