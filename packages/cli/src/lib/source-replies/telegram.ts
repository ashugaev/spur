import { isTelegramInboundEnvelope, type OrchestratorConfig } from "@composio/ao-core";
import type { SourceReplyAdapter } from "./types.js";

interface TelegramNotifierConfig {
  plugin?: unknown;
  botToken?: unknown;
  threadId?: unknown;
}

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function resolveTelegramConfig(config: OrchestratorConfig): TelegramNotifierConfig | null {
  for (const notifier of Object.values(config.notifiers)) {
    if (notifier?.plugin === "telegram") {
      return notifier as TelegramNotifierConfig;
    }
  }
  return null;
}

function resolveBotToken(config: TelegramNotifierConfig | null): string | undefined {
  const fromConfig = toNonEmptyString(config?.botToken);
  if (fromConfig) return fromConfig;

  return env("AO_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN", "TG_TOKEN");
}

function resolveDefaultThreadId(config: TelegramNotifierConfig | null): number | undefined {
  const fromConfig = toPositiveInteger(config?.threadId);
  if (fromConfig !== undefined) return fromConfig;

  return toPositiveInteger(env("AO_TELEGRAM_THREAD_ID", "TELEGRAM_THREAD_ID", "TG_THREAD_ID"));
}

async function sendTelegramReply(payload: {
  botToken: string;
  chatId: string;
  text: string;
  replyToMessageId: number;
  messageThreadId?: number;
}): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${payload.botToken}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: payload.chatId,
    text: payload.text,
    reply_to_message_id: payload.replyToMessageId,
    disable_web_page_preview: true,
  };

  if (payload.messageThreadId !== undefined) {
    body.message_thread_id = payload.messageThreadId;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram API failed (${response.status}): ${responseBody}`);
  }
}

export const telegramSourceReplyAdapter: SourceReplyAdapter = {
  source: "telegram",

  async sendReply({ config, envelope, message }): Promise<void> {
    const text = message.trim();
    if (!text) {
      throw new Error("Reply message is empty");
    }

    if (!isTelegramInboundEnvelope(envelope)) {
      throw new Error("Envelope does not contain valid Telegram routing data");
    }

    const telegramConfig = resolveTelegramConfig(config);
    const botToken = resolveBotToken(telegramConfig);
    if (!botToken) {
      throw new Error("Telegram bot token is not configured");
    }

    const routingThreadId = toPositiveInteger(envelope.routing.threadId);
    const threadId = routingThreadId ?? resolveDefaultThreadId(telegramConfig);

    await sendTelegramReply({
      botToken,
      chatId: envelope.routing.chatId,
      text,
      replyToMessageId: envelope.routing.messageId,
      messageThreadId: threadId,
    });
  },
};
