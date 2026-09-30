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

class TelegramApiError extends Error {
  constructor(
    readonly description: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Telegram reply failed: ${description}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let payload: TelegramApiResponse<T> | null = null;
      try {
        payload = (await response.json()) as TelegramApiResponse<T>;
      } catch {
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
      const delayMs = retryDelay(error, attempt);
      if (delayMs === null) throw error;
      await sleep(delayMs);
    }
  }
}

async function createTelegramTopic(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  name: string,
): Promise<number | null> {
  try {
    const topic = await callTelegram<TelegramForumTopic>(config, "createForumTopic", {
      chat_id: chatId,
      name,
    });
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

export async function closeTelegramTopic(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  messageThreadId: number,
): Promise<void> {
  try {
    await callTelegram(config, "closeForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
    });
  } catch {
    // Best-effort; closing the topic must never block session cleanup.
  }
}

function splitTelegramText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(remaining.slice(0, TELEGRAM_MESSAGE_LIMIT));
    remaining = remaining.slice(TELEGRAM_MESSAGE_LIMIT);
  }
  chunks.push(remaining);
  return chunks;
}

function isNotModifiedError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    error.description.toLowerCase().includes("message is not modified")
  );
}

async function sendTelegramMessage(
  config: Pick<TelegramSourceConfig, "token">,
  chatId: number,
  text: string,
  messageThreadId?: number,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<number | undefined> {
  const sent = await callTelegram<{ message_id?: unknown } | undefined>(config, "sendMessage", {
    chat_id: chatId,
    text,
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return Number.isInteger(sent?.message_id) ? (sent?.message_id as number) : undefined;
}

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId" | "statusMessageId">,
  text: string,
  options: { topicName?: string; buttons?: TelegramInlineButton[] } = {},
): Promise<TelegramReplySendResult> {
  const chunks = splitTelegramText(text);
  const firstChunk = chunks[0] ?? "";
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
      await callTelegram(config, "editMessageText", {
        chat_id: target.chatId,
        message_id: target.statusMessageId,
        text: firstChunk,
        ...(firstChunkMarkup ? { reply_markup: firstChunkMarkup } : {}),
      });
      messageIds.push(target.statusMessageId);
    } catch (error) {
      if (isNotModifiedError(error)) {
        messageIds.push(target.statusMessageId);
      } else {
        collect(
          await sendTelegramMessage(
            config,
            target.chatId,
            firstChunk,
            target.messageThreadId,
            firstChunkMarkup,
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
        ),
      );
    }
    return { statusMessageIdConsumed: true, messageIds };
  }

  const createdThreadId =
    target.messageThreadId === undefined && target.chatId < 0 && options.topicName
      ? await createTelegramTopic(config, target.chatId, options.topicName)
      : null;
  const messageThreadId = target.messageThreadId ?? createdThreadId ?? undefined;
  for (const [index, chunk] of chunks.entries()) {
    collect(
      await sendTelegramMessage(config, target.chatId, chunk, messageThreadId, chunkMarkup(index)),
    );
  }
  return messageThreadId !== undefined ? { messageThreadId, messageIds } : { messageIds };
}
