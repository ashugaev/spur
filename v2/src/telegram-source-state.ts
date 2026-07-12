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
): Promise<void> {
  try {
    await callTelegram(config, "editForumTopic", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      name,
    });
  } catch {
    // Best-effort; topic rename failures should never block a Telegram notice.
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
): Promise<void> {
  await callTelegram(config, "sendMessage", {
    chat_id: chatId,
    text,
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
  });
}

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId" | "statusMessageId">,
  text: string,
  options: { topicName?: string } = {},
): Promise<TelegramReplySendResult> {
  const chunks = splitTelegramText(text);
  const firstChunk = chunks[0] ?? "";
  if (target.statusMessageId !== undefined) {
    try {
      await callTelegram(config, "editMessageText", {
        chat_id: target.chatId,
        message_id: target.statusMessageId,
        text: firstChunk,
      });
    } catch (error) {
      if (!isNotModifiedError(error)) {
        await sendTelegramMessage(config, target.chatId, firstChunk, target.messageThreadId);
      }
    }
    for (const chunk of chunks.slice(1)) {
      await sendTelegramMessage(config, target.chatId, chunk, target.messageThreadId);
    }
    return { statusMessageIdConsumed: true };
  }

  const createdThreadId =
    target.messageThreadId === undefined && target.chatId < 0 && options.topicName
      ? await createTelegramTopic(config, target.chatId, options.topicName)
      : null;
  const messageThreadId = target.messageThreadId ?? createdThreadId ?? undefined;
  for (const chunk of chunks) {
    await sendTelegramMessage(config, target.chatId, chunk, messageThreadId);
  }
  return messageThreadId !== undefined ? { messageThreadId } : {};
}
