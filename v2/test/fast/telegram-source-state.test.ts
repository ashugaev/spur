import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTelegramReply } from "../../src/telegram-source-state.js";

describe("sendTelegramReply", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("edits the pending Telegram status message when available", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await sendTelegramReply(
      { token: "token-123" },
      { chatId: 123, statusMessageId: 77 },
      "done",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken-123/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          message_id: 77,
          text: "done",
        }),
      }),
    );
  });

  it("creates a forum topic for a group reply before sending to it", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_thread_id: 44 } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })));

    const result = await sendTelegramReply(
      { token: "token-123" },
      { chatId: -1001 },
      "hello",
      { topicName: "🟡 api-1 codex" },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bottoken-123/createForumTopic",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -1001,
          name: "🟡 api-1 codex",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -1001,
          text: "hello",
          message_thread_id: 44,
        }),
      }),
    );
    expect(result).toEqual({ messageThreadId: 44 });
  });
});
