import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars } from "@/lib/validation";
import {
  buildTelegramInboundRouting,
  createInboundContextStore,
  coerceOrchestratorSessionRoutingCandidates,
  formatInboundMessageForSession,
  selectFallbackOrchestratorSessionId,
  type OrchestratorConfig,
} from "@composio/ao-core";

const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;
const MAX_REPLY_LENGTH = 10_000;

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  chat?: TelegramChat;
  from?: {
    id?: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  message_thread_id?: number;
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
  config: OrchestratorConfig,
  sessionManager: { list: () => Promise<unknown> },
): Promise<string | null> {
  const preferredProjectId = process.env["AO_PROJECT_ID"]?.trim();
  const preferredProject = preferredProjectId ? config.projects[preferredProjectId] : undefined;
  const preferredOrchestratorId = preferredProject
    ? `${preferredProject.sessionPrefix}-orchestrator`
    : null;

  const listed = await sessionManager.list();
  return selectFallbackOrchestratorSessionId(
    coerceOrchestratorSessionRoutingCandidates(listed),
    {
      defaultSessionId: inboundConfig.defaultSessionId,
      preferredOrchestratorSessionId: preferredOrchestratorId,
    },
  );
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

  const messageId = typeof message.message_id === "number" ? message.message_id : null;
  if (messageId === null) {
    return NextResponse.json({ ok: false, error: "Message id is missing" }, { status: 400 });
  }

  const incomingChatId =
    typeof message.chat?.id === "number" ? String(message.chat.id) : undefined;

  if (!incomingChatId) {
    return NextResponse.json({ ok: false, error: "Message chat id is missing" }, { status: 400 });
  }

  if (inboundConfig.allowedChatId !== incomingChatId) {
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
  let targetSessionId = replySessionId;
  if (!targetSessionId) {
    try {
      targetSessionId = await resolveFallbackSessionId(inboundConfig, config, sessionManager);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, error: `Failed to resolve Telegram fallback session: ${msg}` },
        { status: 503 },
      );
    }
  }

  if (!targetSessionId) {
    return NextResponse.json({
      ok: true,
      ignored: "No target session found (reply marker or default/orchestrator session required)",
    });
  }

  const inboundStore = createInboundContextStore(config);
  let inboundContextWarning: string | null = null;
  let sourceReplyAvailable = false;
  const telegramRouting = buildTelegramInboundRouting({
    chatId: incomingChatId,
    messageId,
    messageThreadId: message.message_thread_id,
    fromId: message.from?.id,
    fromUsername: message.from?.username,
    fromFirstName: message.from?.first_name,
    fromLastName: message.from?.last_name,
  });

  try {
    await inboundStore.enqueue({
      sessionId: targetSessionId,
      source: "telegram",
      text: sanitized,
      routing: telegramRouting,
    });
    sourceReplyAvailable = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to persist inbound source context";
    inboundContextWarning = msg;
    console.warn(`[telegram-webhook] Failed to persist inbound source context: ${msg}`);
  }

  try {
    await sessionManager.send(
      targetSessionId,
      formatInboundMessageForSession({
        sessionId: targetSessionId,
        source: "telegram",
        text: sanitized,
        routing: telegramRouting,
        includeReplyCommand: sourceReplyAvailable,
      }),
    );
    return NextResponse.json({
      ok: true,
      sessionId: targetSessionId,
      warning: inboundContextWarning ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to route Telegram reply";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
