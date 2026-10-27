import { escapeTelegramHtml, renderTelegramHtml } from "./telegram-markdown.js";
import type { TelegramReplyTarget, TelegramSourceConfig } from "./types.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
}

interface TelegramForumTopic {
  message_thread_id: number;
}

export interface TelegramReplySendResult {
  messageThreadId?: number;
  statusMessageIdConsumed?: boolean;
  /** Ids of every message the reply produced or edited, in send order. */
  messageIds: number[];
}

/** First line of every agent-authored Telegram message: `<id> — <title>`, or `<id>` alone. */
export function formatTelegramSessionLabel(id: string, title?: string): string {
  return title ? `${id} — ${title}` : id;
}

/** One inline button: `text` is what the user sees, `callbackData` what the click carries back. */
export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

interface TelegramInlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** One button per row: labels are agent-authored and can be long. */
function inlineKeyboard(buttons: TelegramInlineButton[]): TelegramInlineKeyboard | undefined {
  if (buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((button) => [
      { text: button.text, callback_data: button.callbackData },
    ]),
  };
}

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_RETRY_DELAYS_MS = [250, 1_000] as const;
const topicDeletions = new Set<string>();

export function telegramTopicIsDeleting(
  dataDir: string,
  chatId: number,
  topicId?: number,
): boolean {
  return topicDeletions.has(JSON.stringify([dataDir, chatId, topicId]));
}

export function claimTelegramTopicDeletion(
  dataDir: string,
  chatId: number,
  topicId: number,
): (() => void) | null {
  const key = JSON.stringify([dataDir, chatId, topicId]);
  if (topicDeletions.has(key)) return null;
  topicDeletions.add(key);
  return () => {
    topicDeletions.delete(key);
  };
}

interface TelegramTransport {
  signal: AbortSignal;
}

async function lifecycleTransport<T>(
  task: (transport: TelegramTransport) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    return await task({ signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => reject(new Error("Telegram request timed out"));
    signal.addEventListener("abort", aborted, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

class TelegramApiError extends Error {
  constructor(
    readonly description: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Telegram reply failed: ${description}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer);
      reject(new Error("Telegram request timed out"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function retryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof TelegramApiError) {
    if (error.status === 429 && error.retryAfterMs !== undefined) {
      return error.retryAfterMs;
    }
    if (error.status !== undefined && error.status >= 500) {
      return TELEGRAM_RETRY_DELAYS_MS[attempt] ?? null;
    }
    return null;
  }
  return TELEGRAM_RETRY_DELAYS_MS[attempt] ?? null;
}

async function callTelegram<T>(
  config: Pick<TelegramSourceConfig, "token">,
  method: string,
  body: Record<string, unknown>,
  options: { retry?: false; transport?: TelegramTransport | undefined } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const controller = options.transport ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), 10_000) : undefined;
    const signal =
      controller && options.transport
        ? AbortSignal.any([controller.signal, options.transport.signal])
        : undefined;
    try {
      const request = fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      const response = await (signal ? abortable(request, signal) : request);
      let payload: TelegramApiResponse<T> | null = null;
      try {
        const parsed = response.json();
        payload = (await (signal ? abortable(parsed, signal) : parsed)) as TelegramApiResponse<T>;
      } catch {
        signal?.throwIfAborted();
        // Use status text below.
      }
      if (response.ok && payload?.ok !== false && payload && "result" in payload) {
        return payload.result;
      }
      throw new TelegramApiError(
        payload?.description ?? response.statusText,
        response.status,
        typeof payload?.parameters?.retry_after === "number"
          ? payload.parameters.retry_after * 1_000
          : undefined,
      );
    } catch (error) {
      options.transport?.signal.throwIfAborted();
      const delayMs =
        options.retry === false || (options.transport && attempt >= 2)
          ? null
          : retryDelay(error, attempt);
      if (options.transport && delayMs !== null && delayMs > 5_000) throw error;
      if (delayMs === null) throw error;
      await sleep(delayMs, options.transport?.signal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * One "typing" indicator, lasting about five seconds in the chat. Fire and
 * forget: never retries, never throws. A 429 reports how long to stay quiet.
 */
export async function sendTelegramChatAction(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  messageThreadId?: number,
): Promise<{ retryAfterMs?: number }> {
  try {
    await callTelegram(
      config,
      "sendChatAction",
      {
        chat_id: chatId,
        action: "typing",
        ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      },
      { retry: false },
    );
    return {};
  } catch (error) {
    return error instanceof TelegramApiError &&
      error.status === 429 &&
      error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {};
  }
}

async function createTelegramTopic(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  name: string,
  transport?: TelegramTransport,
): Promise<number | null> {
  try {
    const topic = await callTelegram<TelegramForumTopic>(
      config,
      "createForumTopic",
      {
        chat_id: chatId,
        name,
      },
      { transport },
    );
    return Number.isInteger(topic.message_thread_id) ? topic.message_thread_id : null;
  } catch {
    return null;
  }
}

export async function editTelegramTopic(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  messageThreadId: number,
  name: string,
): Promise<boolean> {
  try {
    await callTelegram(config, "editForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name,
    });
    return true;
  } catch (error) {
    // The topic already carries this name: as good as applied.
    return error instanceof TelegramApiError && error.description.includes("TOPIC_NOT_MODIFIED");
  }
}

export async function deleteTelegramTopic(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  messageThreadId: number,
): Promise<"deleted" | "already_absent"> {
  return lifecycleTransport(async (transport) => {
    try {
      await callTelegram(
        config,
        "deleteForumTopic",
        {
          chat_id: chatId,
          message_thread_id: messageThreadId,
        },
        { transport },
      );
      return "deleted";
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        error.status === 400 &&
        /(?:TOPIC_DELETED|MESSAGE_THREAD_NOT_FOUND|message thread not found)/i.test(
          error.description,
        )
      )
        return "already_absent";
      throw error instanceof TelegramApiError
        ? new Error(
            error.status === 403 || /(?:RIGHT|ADMIN)/i.test(error.description)
              ? "Bot needs administrator can_delete_messages permission"
              : error.description.replaceAll(config.token, "<telegram-token>"),
          )
        : new Error("Telegram topic deletion failed or timed out");
    }
  });
}

/**
 * Splits at the last newline inside the limit, else at the limit, moved back
 * one unit when it would cut a surrogate pair.
 */
function splitTelegramText(text: string, firstBodyOffset = 0): { text: string; offset: number }[] {
  const chunks: { text: string; offset: number }[] = [];
  let remaining = text;
  let offset = 0;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    const newline = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT - 1);
    if (newline > (chunks.length === 0 ? firstBodyOffset : 0)) {
      chunks.push({ text: remaining.slice(0, newline), offset });
      remaining = remaining.slice(newline + 1);
      offset += newline + 1;
      continue;
    }
    const highSurrogate = /[\uD800-\uDBFF]/.test(remaining.charAt(TELEGRAM_MESSAGE_LIMIT - 1));
    const cut = highSurrogate ? TELEGRAM_MESSAGE_LIMIT - 1 : TELEGRAM_MESSAGE_LIMIT;
    chunks.push({ text: remaining.slice(0, cut), offset });
    remaining = remaining.slice(cut);
    offset += cut;
  }
  chunks.push({ text: remaining, offset });
  return chunks;
}

/** One outgoing message: the HTML to send, and the raw text to fall back to. */
interface OutgoingChunk {
  html: string;
  plain: string;
}

function isParseError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.status === 400 &&
    error.description.toLowerCase().includes("can't parse entities")
  );
}

function isNotModifiedError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.description.toLowerCase().includes("message is not modified")
  );
}

async function sendPlainTelegramMessage(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  text: string,
  messageThreadId?: number,
  replyMarkup?: TelegramInlineKeyboard,
  parseMode?: "HTML",
  transport?: TelegramTransport,
): Promise<number | undefined> {
  const sent = await callTelegram<{ message_id?: unknown } | undefined>(
    config,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    { transport },
  );
  return Number.isInteger(sent?.message_id) ? (sent?.message_id as number) : undefined;
}

/** Sends the HTML form; a parse rejection resends the raw text once. */
async function sendTelegramMessage(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  chunk: OutgoingChunk,
  messageThreadId?: number,
  replyMarkup?: TelegramInlineKeyboard,
  transport?: TelegramTransport,
): Promise<number | undefined> {
  try {
    return await sendPlainTelegramMessage(
      config,
      chatId,
      chunk.html,
      messageThreadId,
      replyMarkup,
      "HTML",
      transport,
    );
  } catch (error) {
    if (!isParseError(error)) throw error;
    return sendPlainTelegramMessage(
      config,
      chatId,
      chunk.plain,
      messageThreadId,
      replyMarkup,
      undefined,
      transport,
    );
  }
}

/** Edits with the HTML form; a parse rejection retries the edit once as raw text. */
async function editTelegramMessage(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  messageId: number,
  chunk: OutgoingChunk,
  replyMarkup?: TelegramInlineKeyboard,
  transport?: TelegramTransport,
): Promise<void> {
  const edit = (text: string, parseMode?: "HTML"): Promise<unknown> =>
    callTelegram(
      config,
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
      { transport },
    );
  try {
    await edit(chunk.html, "HTML");
  } catch (error) {
    if (!isParseError(error)) throw error;
    await edit(chunk.plain);
  }
}

interface TelegramReplyOptions {
  topicName?: string;
  buttons?: TelegramInlineButton[];
  preformatted?: string;
  sessionLabel?: string;
  lifecycle?: boolean;
  onTopicCreated?: (topicId: number) => Promise<void>;
}

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId" | "statusMessageId">,
  text: string,
  options: TelegramReplyOptions = {},
): Promise<TelegramReplySendResult> {
  return options.lifecycle
    ? lifecycleTransport((transport) =>
        sendTelegramReplyWithTransport(config, target, text, options, transport),
      )
    : sendTelegramReplyWithTransport(config, target, text, options);
}

async function sendTelegramReplyWithTransport(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId" | "statusMessageId">,
  text: string,
  options: TelegramReplyOptions,
  transport?: TelegramTransport,
): Promise<TelegramReplySendResult> {
  const createdThreadId =
    target.statusMessageId === undefined &&
    target.messageThreadId === undefined &&
    target.chatId < 0 &&
    options.topicName
      ? await createTelegramTopic(config, target.chatId, options.topicName, transport)
      : null;
  if (createdThreadId !== null) await options.onTopicCreated?.(createdThreadId);
  const messageThreadId = target.messageThreadId ?? createdThreadId ?? undefined;
  const label =
    target.chatId < 0 && messageThreadId !== undefined ? "" : (options.sessionLabel ?? "");
  const prefix = label ? `${label}\n\n` : "";
  const body = label ? text.replace(/^(?:\r?\n)+/u, "") : text;
  const rawChunks = splitTelegramText(prefix + body, prefix.length);
  const labelLength = (offset: number, plain: string): number =>
    Math.max(0, Math.min(label.length - offset, plain.length));
  const htmlChunks = renderTelegramHtml(
    rawChunks.map(({ text: plain, offset }) => plain.slice(labelLength(offset, plain))),
  );
  const chunks: OutgoingChunk[] = rawChunks.map(({ text: plain, offset }, index) => {
    const length = labelLength(offset, plain);
    const signature = length ? `<b>${escapeTelegramHtml(plain.slice(0, length))}</b>` : "";
    return { plain, html: signature + (htmlChunks[index] as string) };
  });
  // A pane tail is shown verbatim in <pre>, never parsed as markdown.
  const tail = options.preformatted;
  if (tail) {
    const last = chunks.at(-1);
    if (last && last.plain.length + 1 + tail.length <= TELEGRAM_MESSAGE_LIMIT) {
      last.plain += `\n${tail}`;
      last.html += `\n<pre>${escapeTelegramHtml(tail)}</pre>`;
    } else {
      for (const part of splitTelegramText(tail)) {
        chunks.push({ plain: part.text, html: `<pre>${escapeTelegramHtml(part.text)}</pre>` });
      }
    }
  }
  const firstChunk = chunks[0] ?? { plain: "", html: "" };
  // The keyboard rides the last chunk, so the buttons sit under the full message.
  const keyboard = inlineKeyboard(options.buttons ?? []);
  const chunkMarkup = (index: number): TelegramInlineKeyboard | undefined =>
    index === chunks.length - 1 ? keyboard : undefined;
  const firstChunkMarkup = chunkMarkup(0);
  const messageIds: number[] = [];
  const collect = (id: number | undefined): void => {
    if (id !== undefined) messageIds.push(id);
  };
  if (target.statusMessageId !== undefined) {
    try {
      await editTelegramMessage(
        config,
        target.chatId,
        target.statusMessageId,
        firstChunk,
        firstChunkMarkup,
        transport,
      );
      messageIds.push(target.statusMessageId);
    } catch (error) {
      if (isNotModifiedError(error)) {
        messageIds.push(target.statusMessageId);
      } else {
        // The edit failed for good: send new, as plain text (no second HTML attempt).
        collect(
          await sendPlainTelegramMessage(
            config,
            target.chatId,
            firstChunk.plain,
            target.messageThreadId,
            firstChunkMarkup,
            undefined,
            transport,
          ),
        );
      }
    }
    for (const [index, chunk] of chunks.slice(1).entries()) {
      collect(
        await sendTelegramMessage(
          config,
          target.chatId,
          chunk,
          target.messageThreadId,
          chunkMarkup(index + 1),
          transport,
        ),
      );
    }
    return { statusMessageIdConsumed: true, messageIds };
  }

  for (const [index, chunk] of chunks.entries()) {
    collect(
      await sendTelegramMessage(
        config,
        target.chatId,
        chunk,
        messageThreadId,
        chunkMarkup(index),
        transport,
      ),
    );
  }
  return messageThreadId !== undefined ? { messageThreadId, messageIds } : { messageIds };
}
