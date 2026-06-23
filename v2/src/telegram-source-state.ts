import type { TelegramReplyTarget, TelegramSourceConfig } from "./types.js";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramForumTopic {
  message_thread_id: number;
}

export interface TelegramReplySendResult {
  messageThreadId?: number;
}

async function callTelegram<T>(
  config: Pick<TelegramSourceConfig, "token">,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
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
  if (response.ok && payload?.ok !== false) {
    return payload?.result as T;
  }
  throw new Error(`Telegram reply failed: ${payload?.description ?? response.statusText}`);
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

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId" | "statusMessageId">,
  text: string,
  options: { topicName?: string } = {},
): Promise<TelegramReplySendResult> {
  if (target.statusMessageId !== undefined) {
    await callTelegram(config, "editMessageText", {
      chat_id: target.chatId,
      message_id: target.statusMessageId,
      text,
    });
    return {};
  }

  const createdThreadId =
    target.messageThreadId === undefined && target.chatId < 0 && options.topicName
      ? await createTelegramTopic(config, target.chatId, options.topicName)
      : null;
  const messageThreadId = target.messageThreadId ?? createdThreadId ?? undefined;
  await callTelegram(config, "sendMessage", {
    chat_id: target.chatId,
    text,
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
  });
  return messageThreadId !== undefined ? { messageThreadId } : {};
}
