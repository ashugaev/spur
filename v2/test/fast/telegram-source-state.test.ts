import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeTelegramTopic,
  editTelegramTopic,
  sendTelegramChatAction,
  sendTelegramReply,
} from "../../src/telegram-source-state.js";
import { presentConsent, proposeConsent } from "../../src/review-interface-consent.js";

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
          parse_mode: "HTML",
        }),
      }),
    );
    expect(result).toEqual({ statusMessageIdConsumed: true, messageIds: [77] });
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
    expect(result).toEqual({ statusMessageIdConsumed: true, messageIds: [55] });
  });

  it("returns the ids of every sent chunk and the edited status message", async () => {
    const fetchMock = vi.mocked(fetch);
    const okId = (id: number): Response =>
      new Response(JSON.stringify({ ok: true, result: { message_id: id } }));
    const config = { token: "token-123" };
    const long = `${"a".repeat(4096)}b`;

    fetchMock.mockResolvedValueOnce(okId(77)).mockResolvedValueOnce(okId(78));
    const edited = await sendTelegramReply(config, { chatId: 123, statusMessageId: 77 }, long);
    expect(edited.messageIds).toEqual([77, 78]);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "message to edit not found" })),
      )
      .mockResolvedValueOnce(okId(90))
      .mockResolvedValueOnce(okId(91));
    const fallback = await sendTelegramReply(config, { chatId: 123, statusMessageId: 77 }, long);
    expect(fallback.messageIds).toEqual([90, 91]);

    fetchMock.mockResolvedValueOnce(okId(100)).mockResolvedValueOnce(okId(101));
    const fresh = await sendTelegramReply(config, { chatId: 123 }, long);
    expect(fresh.messageIds).toEqual([100, 101]);
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
          parse_mode: "HTML",
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
          parse_mode: "HTML",
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
        body: JSON.stringify({ chat_id: 123, text: "a".repeat(4096), parse_mode: "HTML" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/bottoken-123/sendMessage",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 123,
          text: "b",
          parse_mode: "HTML",
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
          parse_mode: "HTML",
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
      sessionLabel: "api-1 — Task title",
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
          parse_mode: "HTML",
          message_thread_id: 44,
        }),
      }),
    );
    expect(result).toEqual({ messageThreadId: 44, messageIds: [55] });
  });
});

describe("sendTelegramReply formatting", () => {
  const config = { token: "token-123" };
  const okId = (id: number): Response =>
    new Response(JSON.stringify({ ok: true, result: { message_id: id } }));
  const parseError = (): Response =>
    new Response(
      JSON.stringify({
        ok: false,
        description: "Bad Request: can't parse entities: Unsupported start tag",
      }),
      { status: 400 },
    );
  const bodyOf = (fetchMock: ReturnType<typeof vi.mocked<typeof fetch>>, call: number) =>
    JSON.parse(String((fetchMock.mock.calls[call]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends rendered HTML with parse_mode", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55));

    await sendTelegramReply(config, { chatId: 123 }, "a **b** <c> & `d`");

    expect(bodyOf(fetchMock, 0)).toEqual({
      chat_id: 123,
      text: "a <b>b</b> &lt;c&gt; &amp; <code>d</code>",
      parse_mode: "HTML",
    });
  });

  it("bolds the escaped session signature without parsing title markdown", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55));
    await sendTelegramReply(config, { chatId: 123, messageThreadId: 22 }, "\n\nDone **today**", {
      sessionLabel: "api-1 — <checkout> & **literal** `title`",
    });
    expect(bodyOf(fetchMock, 0)).toEqual({
      chat_id: 123,
      text: "<b>api-1 — &lt;checkout&gt; &amp; **literal** `title`</b>\n\nDone <b>today</b>",
      parse_mode: "HTML",
      message_thread_id: 22,
    });
  });

  it.each([undefined, 77])(
    "omits forum signatures for send/edit %s with buttons",
    async (statusMessageId) => {
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(okId(statusMessageId ?? 55));
      await sendTelegramReply(
        config,
        {
          chatId: -1001,
          messageThreadId: 22,
          ...(statusMessageId !== undefined ? { statusMessageId } : {}),
        },
        "Done **today**",
        {
          sessionLabel: "api-1 — Task title",
          buttons: [{ text: "Yes", callbackData: "spur_choice:t0" }],
        },
      );
      expect(bodyOf(fetchMock, 0)).toMatchObject({
        text: "Done <b>today</b>",
        reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:t0" }]] },
      });
    },
  );

  it("keeps the group-main signature when topic creation fails", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "not a forum" }), { status: 400 }),
      )
      .mockResolvedValueOnce(okId(55));
    await sendTelegramReply(config, { chatId: -1001 }, "Done", {
      sessionLabel: "api-1 — Task title",
      topicName: "Task title — api-1 codex",
    });
    expect(bodyOf(fetchMock, 1)).toMatchObject({ text: "<b>api-1 — Task title</b>\n\nDone" });
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty("message_thread_id");
  });

  it("omits forum signatures on chunking and plain parse-error fallback", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(parseError())
      .mockResolvedValueOnce(okId(55))
      .mockResolvedValueOnce(okId(56));
    await sendTelegramReply(config, { chatId: -1001, messageThreadId: 22 }, "x".repeat(4097), {
      sessionLabel: "api-1",
    });
    expect(bodyOf(fetchMock, 1)).toMatchObject({ text: "x".repeat(4096), message_thread_id: 22 });
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty("parse_mode");
    expect(bodyOf(fetchMock, 2)).toMatchObject({ text: "x", message_thread_id: 22 });
  });

  it("keeps one empty line after an id-only signature when editing a placeholder with buttons", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(77));
    const result = await sendTelegramReply(config, { chatId: 123, statusMessageId: 77 }, "Pick", {
      sessionLabel: "api-1",
      buttons: [{ text: "Yes", callbackData: "spur_choice:t0" }],
    });
    expect(bodyOf(fetchMock, 0)).toMatchObject({
      message_id: 77,
      text: "<b>api-1</b>\n\nPick",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:t0" }]] },
    });
    expect(result).toEqual({ statusMessageIdConsumed: true, messageIds: [77] });
  });
  it.each([
    { mode: "outside forum", chatId: 123, statusMessageId: undefined },
    { mode: "forum send", chatId: -1001, statusMessageId: undefined },
    { mode: "forum placeholder edit", chatId: -1001, statusMessageId: 55 },
  ])(
    "renders consent once with purpose keyboard/thread in $mode",
    async ({ chatId, statusMessageId }) => {
      const record = proposeConsent(
        {
          session: "api-1",
          repository: "owner/repo",
          branch: "feature/change",
          baseBranch: "main",
          projectId: "api",
          sourceId: "telegram",
          chatId,
          approverUserId: 7,
          manifest: {
            version: 1,
            repository: "owner/repo",
            baseBranch: "main",
            surfaces: [
              {
                kind: "CLI",
                id: "run",
                before: ["no flag"],
                after: ["--dry-run"],
                constraints: ["no process created"],
              },
            ],
          },
        },
        null,
      );
      const fetchMock = vi.mocked(fetch);
      fetchMock.mockResolvedValueOnce(okId(55));
      await sendTelegramReply(
        config,
        { chatId, messageThreadId: 22, ...(statusMessageId ? { statusMessageId } : {}) },
        `Approve scope\n\n${presentConsent(record)}`,
        {
          sessionLabel: "api-1 — Scope <review>",
          buttons: [
            { text: "Approve interface", callbackData: "spur_choice:approve" },
            { text: "Reject", callbackData: "spur_choice:reject" },
            { text: "Revoke", callbackData: "spur_choice:revoke" },
          ],
        },
      );
      const payload = bodyOf(fetchMock, 0);
      expect(payload).toMatchObject({
        chat_id: chatId,
        ...(statusMessageId ? { message_id: statusMessageId } : { message_thread_id: 22 }),
        reply_markup: {
          inline_keyboard: [
            [{ text: "Approve interface", callback_data: "spur_choice:approve" }],
            [{ text: "Reject", callback_data: "spur_choice:reject" }],
            [{ text: "Revoke", callback_data: "spur_choice:revoke" }],
          ],
        },
      });
      if (typeof payload.text !== "string") throw new Error("missing Telegram text");
      if (chatId > 0) {
        expect(payload.text).toContain("<b>api-1 — Scope &lt;review&gt;</b>\n\nApprove scope");
        expect(payload.text.match(/api-1/g)).toHaveLength(1);
      } else {
        expect(payload.text).toMatch(/^Approve scope/);
        expect(payload.text).not.toContain("api-1");
        expect(payload.text).not.toContain("Scope &lt;review&gt;");
      }
      for (const clause of ["Approve scope", "no flag", "--dry-run", "no process created"]) {
        expect(payload.text.split(clause)).toHaveLength(2);
      }
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(
        statusMessageId ? /\/editMessageText$/ : /\/sendMessage$/,
      );
      expect(record.decision).toBe("pending");
    },
  );

  it("includes the signature in the first chunk limit without repeating it on continuation", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55)).mockResolvedValueOnce(okId(56));
    await sendTelegramReply(config, { chatId: 123 }, "x".repeat(4096), { sessionLabel: "api-1" });
    expect(bodyOf(fetchMock, 0)["text"]).toBe(`<b>api-1</b>\n\n${"x".repeat(4089)}`);
    expect(bodyOf(fetchMock, 1)["text"]).toBe("x".repeat(7));
  });

  it("keeps the literal signature and separator on plain parse-error fallback", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(okId(56));
    await sendTelegramReply(config, { chatId: 123 }, "Done **today**", {
      sessionLabel: "api-1 — <checkout>",
    });
    expect(bodyOf(fetchMock, 1)["text"]).toBe("api-1 — <checkout>\n\nDone **today**");
    expect(bodyOf(fetchMock, 1)).not.toHaveProperty("parse_mode");
  });

  it("resends one chunk as plain text when Telegram cannot parse entities", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(okId(56));

    const result = await sendTelegramReply(config, { chatId: 123 }, "a **b**", {
      buttons: [{ text: "Yes", callbackData: "spur_choice:t0" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyOf(fetchMock, 1);
    expect(retry["text"]).toBe("a **b**");
    expect(retry).not.toHaveProperty("parse_mode");
    expect(retry["reply_markup"]).toEqual(bodyOf(fetchMock, 0)["reply_markup"]);
    expect(result.messageIds).toEqual([56]);
  });

  it("does not treat a non-400 rejection as a parse error", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Forbidden: can't parse entities" }), {
        status: 403,
      }),
    );

    await expect(sendTelegramReply(config, { chatId: 123 }, "a **b**")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not loop when the plain resend is rejected too", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(parseError());

    await expect(sendTelegramReply(config, { chatId: 123 }, "a **b**")).rejects.toThrow(
      "can't parse entities",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a placeholder edit as plain text before sending new", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(parseError())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    const result = await sendTelegramReply(config, { chatId: 123, statusMessageId: 77 }, "a **b**");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0)["parse_mode"]).toBe("HTML");
    expect(bodyOf(fetchMock, 1)).toEqual({ chat_id: 123, message_id: 77, text: "a **b**" });
    expect(result.messageIds).toEqual([77]);
  });

  it("falls to a plain new message when the plain edit retry fails too", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(parseError())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, description: "message to edit not found" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(okId(90));

    const result = await sendTelegramReply(config, { chatId: 123, statusMessageId: 77 }, "a **b**");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const created = bodyOf(fetchMock, 2);
    expect(created["text"]).toBe("a **b**");
    expect(created).not.toHaveProperty("parse_mode");
    expect(result.messageIds).toEqual([90]);
  });

  it("sends a pane tail escaped inside one pre, never parsed", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55));

    await sendTelegramReply(config, { chatId: 123 }, "api-1 needs input", {
      preformatted: "x ``` <b>y</b> **z**",
    });

    expect(bodyOf(fetchMock, 0)).toEqual({
      chat_id: 123,
      text: "api-1 needs input\n<pre>x ``` &lt;b&gt;y&lt;/b&gt; **z**</pre>",
      parse_mode: "HTML",
    });
  });

  it("adds no pre for an empty pane tail", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55));

    await sendTelegramReply(config, { chatId: 123 }, "api-1 needs input", { preformatted: "" });

    expect(bodyOf(fetchMock, 0)["text"]).toBe("api-1 needs input");
  });

  it("puts an oversized pane tail in its own pre chunk", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(okId(55)).mockResolvedValueOnce(okId(56));

    await sendTelegramReply(config, { chatId: 123 }, "n".repeat(4000), {
      preformatted: "t".repeat(200),
    });

    expect(bodyOf(fetchMock, 1)["text"]).toBe(`<pre>${"t".repeat(200)}</pre>`);
  });

  it("splits on the last newline and never inside a surrogate pair", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => okId(55));
    const lines = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    await sendTelegramReply(config, { chatId: 123 }, lines);
    expect(bodyOf(fetchMock, 0)["text"]).toBe("a".repeat(3000));
    expect(bodyOf(fetchMock, 1)["text"]).toBe("b".repeat(3000));

    fetchMock.mockClear();
    const emoji = "\u{1F600}";
    await sendTelegramReply(config, { chatId: 123 }, `${"x".repeat(4095)}${emoji}tail`);
    expect(bodyOf(fetchMock, 0)["text"]).toBe("x".repeat(4095));
    expect(bodyOf(fetchMock, 1)["text"]).toBe(`${emoji}tail`);
  });

  it("closes and reopens a fence across chunks", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => okId(55));
    const code = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");

    await sendTelegramReply(config, { chatId: 123 }, `\`\`\`ts\n${code}\n\`\`\`\ndone`);

    const first = String(bodyOf(fetchMock, 0)["text"]);
    const second = String(bodyOf(fetchMock, 1)["text"]);
    expect(first.startsWith('<pre><code class="language-ts">')).toBe(true);
    expect(first.endsWith("</code></pre>")).toBe(true);
    expect(second.startsWith('<pre><code class="language-ts">')).toBe(true);
    expect(second.endsWith("done")).toBe(true);
  });
});

describe("editTelegramTopic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts editForumTopic with name and reports success", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await expect(
      editTelegramTopic({ token: "token-123" }, -1001, 22, "🟡 api-1 codex"),
    ).resolves.toBe(true);

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

  it("reports false for a non-ok editForumTopic response without throwing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "topic not found" }), {
        status: 400,
      }),
    );

    await expect(
      editTelegramTopic({ token: "token-123" }, -1001, 22, "🟡 api-1 codex"),
    ).resolves.toBe(false);
  });

  it("counts an already-applied name as success", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: "Bad Request: TOPIC_NOT_MODIFIED" }), {
        status: 400,
      }),
    );

    await expect(
      editTelegramTopic({ token: "token-123" }, -1001, 22, "🟡 api-1 codex"),
    ).resolves.toBe(true);
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

describe("sendTelegramChatAction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one typing action without retry", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: true })));

    await expect(sendTelegramChatAction({ token: "token-123" }, -1001, 22)).resolves.toEqual({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken-123/sendChatAction",
      expect.objectContaining({
        body: JSON.stringify({ chat_id: -1001, action: "typing", message_thread_id: 22 }),
      }),
    );
  });

  it("reports retry_after on 429 and never retries or throws", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 12 },
        }),
        { status: 429 },
      ),
    );

    await expect(sendTelegramChatAction({ token: "token-123" }, 123)).resolves.toEqual({
      retryAfterMs: 12_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a network error without retrying", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(sendTelegramChatAction({ token: "token-123" }, 123)).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
