import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTelegramTopic,
  editTelegramTopic,
  sendTelegramReply,
} from "../../src/telegram-source-state.js";

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

    const result = await sendTelegramReply(
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
    expect(result).toEqual({ statusMessageIdConsumed: true });
  });

  it("falls back to a fresh message when editing the pending status fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: "Bad Request: message to edit not found",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })),
      );

    const result = await sendTelegramReply(
      { token: "token-123" },
      { chatId: 123, statusMessageId: 77 },
      "done",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: "done",
        }),
      }),
    );
    expect(result).toEqual({ statusMessageIdConsumed: true });
  });

  it("chunks Telegram replies longer than one message", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 56 } })),
      );
    const text = `${"a".repeat(4096)}b`;

    await sendTelegramReply({ token: "token-123" }, { chatId: 123 }, text);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: "a".repeat(4096),
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: "b",
        }),
      }),
    );
  });

  it("puts the inline keyboard on the last chunk only", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 56 } })),
      );

    await sendTelegramReply({ token: "token-123" }, { chatId: 123 }, `${"a".repeat(4096)}b`, {
      buttons: [
        { text: "Yes", callbackData: "spur_choice:t0" },
        { text: "No", callbackData: "spur_choice:t1" },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({ chat_id: 123, text: "a".repeat(4096) }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: "b",
          reply_markup: {
            inline_keyboard: [
              [{ text: "Yes", callback_data: "spur_choice:t0" }],
              [{ text: "No", callback_data: "spur_choice:t1" }],
            ],
          },
        }),
      }),
    );
  });

  it("keeps the keyboard when the reply edits a pending status message", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await sendTelegramReply({ token: "token-123" }, { chatId: 123, statusMessageId: 77 }, "Pick", {
      buttons: [{ text: "Yes", callbackData: "spur_choice:t0" }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken-123/editMessageText",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          message_id: 77,
          text: "Pick",
          reply_markup: {
            inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:t0" }]],
          },
        }),
      }),
    );
  });

  it("honors Telegram retry_after before retrying a rate limit", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          }),
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })),
      );

    await sendTelegramReply({ token: "token-123" }, { chatId: 123 }, "done");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed successful Telegram responses", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    await expect(
      sendTelegramReply({ token: "token-123" }, { chatId: 123 }, "done"),
    ).rejects.toThrow("Telegram reply failed");
  });

  it("creates a forum topic for a group reply before sending to it", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_thread_id: 44 } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 55 } })),
      );

    const result = await sendTelegramReply({ token: "token-123" }, { chatId: -1001 }, "hello", {
      topicName: "🟡 api-1 codex",
    });

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

describe("editTelegramTopic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts editForumTopic with name and swallows failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await editTelegramTopic({ token: "token-123" }, -1001, 22, "🟡 api-1 codex");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken-123/editForumTopic",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -1001,
          message_thread_id: 22,
          name: "🟡 api-1 codex",
        }),
      }),
    );
  });

  it("swallows a non-ok editForumTopic response without throwing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "topic not found" }), {
        status: 400,
      }),
    );

    await expect(
      editTelegramTopic({ token: "token-123" }, -1001, 22, "🟡 api-1 codex"),
    ).resolves.toBeUndefined();
  });
});

describe("closeTelegramTopic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts closeForumTopic and swallows failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await closeTelegramTopic({ token: "token-123" }, -1001, 22);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken-123/closeForumTopic",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -1001,
          message_thread_id: 22,
        }),
      }),
    );
  });

  it("swallows a non-ok closeForumTopic response without throwing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "topic not found" }), {
        status: 400,
      }),
    );

    await expect(closeTelegramTopic({ token: "token-123" }, -1001, 22)).resolves.toBeUndefined();
  });
});
