import { NextResponse, type NextRequest } from "next/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getServices } from "@/lib/services";
import { stripControlChars } from "@/lib/validation";
import {
  buildTelegramInboundRouting,
  createAudioTranscriber,
  createInboundContextStore,
  coerceOrchestratorSessionRoutingCandidates,
  downloadTelegramVoiceFile,
  formatInboundMessageForSession,
  selectFallbackOrchestratorSessionId,
  type OrchestratorConfig,
} from "@composio/ao-core";

const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;
const MAX_REPLY_LENGTH = 10_000;

interface TelegramChat {
  id: number;
}

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  voice?: TelegramVoice;
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

function resolveBotToken(rawNotifiers: Record<string, { [key: string]: unknown }>): string | undefined {
  const notifierConfig = Object.values(rawNotifiers).find((entry) => entry?.plugin === "telegram");
  const fromConfig =
    typeof notifierConfig?.botToken === "string" && notifierConfig.botToken.trim().length > 0
      ? notifierConfig.botToken.trim()
      : undefined;
  return fromConfig || env("AO_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN", "TG_TOKEN");
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

  // Determine message text: text takes priority, then voice transcription
  let sanitized = "";
  let voiceTranscriptionError: string | null = null;
  const hasText = typeof message.text === "string" && message.text.trim().length > 0;
  const hasVoice = message.voice && typeof message.voice.file_id === "string";

  if (hasText) {
    const rawText = message.text as string;
    sanitized = stripControlChars(rawText).trim();
  } else if (hasVoice) {
    // Attempt voice transcription
    const notifiers = config.notifiers as Record<string, { [key: string]: unknown }>;
    const botToken = resolveBotToken(notifiers);
    const transcriber = createAudioTranscriber(config.services?.transcriber);

    if (!botToken) {
      voiceTranscriptionError = "Voice transcription failed: bot token not configured for file download";
    } else if (!transcriber) {
      voiceTranscriptionError = "Voice transcription failed: transcriber service is not configured (services.transcriber in config)";
    } else {
      try {
        const tempDir = join(tmpdir(), `ao-tg-voice-${randomUUID()}`);
        await mkdir(tempDir, { recursive: true });
        const voiceFileId = (message.voice as TelegramVoice).file_id;
        const localPath = await downloadTelegramVoiceFile(botToken, voiceFileId, tempDir);
        try {
          const result = await transcriber.transcribeLocalFile({ filePath: localPath });
          sanitized = result.text;
        } finally {
          // Best-effort cleanup
          try {
            const { unlink, rmdir } = await import("node:fs/promises");
            await unlink(localPath);
            await rmdir(tempDir);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        voiceTranscriptionError = `Voice transcription failed: ${msg}`;
      }
    }
  }

  // If neither text nor successful voice transcription, check for voice error
  if (sanitized.length === 0 && !voiceTranscriptionError) {
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

  // Use error message as the text to route if voice transcription failed
  const textToRoute = voiceTranscriptionError
    ? `[SYSTEM] ${voiceTranscriptionError}`
    : sanitized;

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
      text: textToRoute,
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
        text: textToRoute,
        routing: telegramRouting,
        includeReplyCommand: sourceReplyAvailable,
      }),
    );
    return NextResponse.json({
      ok: true,
      sessionId: targetSessionId,
      voiceTranscribed: hasVoice && !voiceTranscriptionError ? true : undefined,
      voiceError: voiceTranscriptionError ?? undefined,
      warning: inboundContextWarning ?? undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to route Telegram reply";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
