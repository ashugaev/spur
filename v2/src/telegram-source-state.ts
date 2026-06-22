import type { TelegramReplyTarget, TelegramSourceConfig } from "./types.js";

export async function sendTelegramReply(
  config: Pick<TelegramSourceConfig, "token">,
  target: Pick<TelegramReplyTarget, "chatId" | "messageThreadId">,
  text: string,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      ...(target.messageThreadId !== undefined
        ? { message_thread_id: target.messageThreadId }
        : {}),
    }),
  });
  if (response.ok) return;

  let description = response.statusText;
  try {
    const payload = (await response.json()) as { description?: unknown };
    if (typeof payload.description === "string") {
      description = payload.description;
    }
  } catch {
    // Use status text.
  }
  throw new Error(`Telegram reply failed: ${description}`);
}
