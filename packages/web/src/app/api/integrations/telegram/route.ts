import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars } from "@/lib/validation";

const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;
const MAX_REPLY_LENGTH = 10_000;

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  text?: string;
  chat?: TelegramChat;
  reply_to_message?: {
    text?: string;
  };
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramInboundConfig {
  allowedChatId?: string;
  webhookSecret?: string;
  defaultSessionId?: string;
}

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function resolveTelegramInboundConfig(rawNotifiers: Record<string, { [key: string]: unknown }>): TelegramInboundConfig {
  const notifierConfig = Object.values(rawNotifiers).find((entry) => entry?.plugin === "telegram");

  const chatFromConfig =
    typeof notifierConfig?.chatId === "number"
      ? String(notifierConfig.chatId)
      : typeof notifierConfig?.chatId === "string"
        ? notifierConfig.chatId.trim()
        : undefined;

  const secretFromConfig =
    typeof notifierConfig?.webhookSecret === "string" ? notifierConfig.webhookSecret.trim() : undefined;
  const defaultSessionIdFromConfig =
    typeof notifierConfig?.defaultSessionId === "string"
      ? notifierConfig.defaultSessionId.trim()
      : undefined;

  return {
    allowedChatId:
      chatFromConfig || env("AO_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID", "TG_CHAT_ID"),
    webhookSecret:
      secretFromConfig ||
      env("AO_TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET", "TG_WEBHOOK_SECRET"),
    defaultSessionId:
      defaultSessionIdFromConfig ||
      env(
        "AO_TELEGRAM_DEFAULT_SESSION_ID",
        "TELEGRAM_DEFAULT_SESSION_ID",
        "TG_DEFAULT_SESSION_ID",
      ),
  };
}

function extractSessionIdFromReply(message: TelegramMessage | undefined): string | null {
  const sourceText = message?.reply_to_message?.text;
  if (typeof sourceText !== "string" || sourceText.length === 0) return null;

  const match = sourceText.match(SESSION_MARKER_REGEX);
  return match?.[1] ?? null;
}

async function resolveFallbackSessionId(
  inboundConfig: TelegramInboundConfig,
  sessionManager: { list: () => Promise<Array<{ id: string; status: string }>> },
): Promise<string | null> {
  if (inboundConfig.defaultSessionId) return inboundConfig.defaultSessionId;

  const sessions = await sessionManager.list();
  const orchestrators = sessions.filter(
    (s) => s.id.endsWith("-orchestrator") && s.status !== "killed",
  );

  if (orchestrators.length === 1) return orchestrators[0]?.id ?? null;
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { config, sessionManager } = await getServices();
  const inboundConfig = resolveTelegramInboundConfig(
    config.notifiers as Record<string, { [key: string]: unknown }>,
  );

  if (!inboundConfig.allowedChatId) {
    return NextResponse.json(
      { ok: false, error: "Telegram inbound chat is not configured" },
      { status: 503 },
    );
  }

  if (inboundConfig.webhookSecret) {
    const headerToken = request.headers.get("x-telegram-bot-api-secret-token");
    if (headerToken !== inboundConfig.webhookSecret) {
      return NextResponse.json({ ok: false, error: "Invalid Telegram secret token" }, { status: 401 });
    }
  }

  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  if (!update) {
    return NextResponse.json({ ok: false, error: "Invalid Telegram update payload" }, { status: 400 });
  }

  const message = update.message ?? update.edited_message;
  if (!message) {
    return NextResponse.json({ ok: true, ignored: "No message payload" });
  }

  const incomingChatId =
    typeof message.chat?.id === "number" ? String(message.chat.id) : undefined;

  if (
    incomingChatId &&
    inboundConfig.allowedChatId !== incomingChatId
  ) {
    return NextResponse.json({ ok: false, error: "Chat is not allowed" }, { status: 403 });
  }

  const rawText = typeof message.text === "string" ? message.text : "";
  const sanitized = stripControlChars(rawText).trim();

  if (sanitized.length === 0) {
    return NextResponse.json({ ok: false, error: "Reply text is empty" }, { status: 400 });
  }

  if (sanitized.length > MAX_REPLY_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `Reply text exceeds ${MAX_REPLY_LENGTH} characters` },
      { status: 400 },
    );
  }

  const replySessionId = extractSessionIdFromReply(message);
  const targetSessionId = replySessionId ?? (await resolveFallbackSessionId(inboundConfig, sessionManager));
  if (!targetSessionId) {
    return NextResponse.json({
      ok: true,
      ignored: "No target session found (reply marker or default/orchestrator session required)",
    });
  }

  try {
    await sessionManager.send(targetSessionId, sanitized);
    return NextResponse.json({ ok: true, sessionId: targetSessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to route Telegram reply";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
