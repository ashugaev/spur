import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars } from "@/lib/validation";
import {
  buildTelegramInboundRouting,
  createInboundContextStore,
  coerceOrchestratorSessionRoutingCandidates,
  downloadTelegramVoiceFileBytes,
  formatInboundMessageForSession,
  selectFallbackOrchestratorSessionId,
  transcribeAudioBytes,
  type AudioTranscriber,
  type OrchestratorConfig,
} from "@composio/ao-core";

const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;
const PROJECT_PICKER_CALLBACK_PREFIX = "AO_PROJECT:";
const MAX_REPLY_LENGTH = 10_000;
const TELEGRAM_FILE_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIBER_MAX_AUDIO_BYTES = 25_000_000;
const MAX_ERROR_REASON_LENGTH = 300;
const selectedProjectByScope = new Map<string, string>();

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  voice?: {
    file_id?: string;
    file_size?: number;
    duration?: number;
  };
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

interface TelegramCallbackQuery {
  id?: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramInboundConfig {
  botToken?: string;
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

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
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
  const botTokenFromConfig =
    typeof notifierConfig?.botToken === "string" ? notifierConfig.botToken.trim() : undefined;

  return {
    botToken:
      botTokenFromConfig ||
      env("AO_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN", "TG_TOKEN"),
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

function resolveTranscriberMaxAudioBytes(config: OrchestratorConfig): number {
  const configuredMaxAudioBytes = toPositiveNumber(config.services?.transcriber?.maxAudioBytes);
  return configuredMaxAudioBytes ?? DEFAULT_TRANSCRIBER_MAX_AUDIO_BYTES;
}

function extractSessionIdFromReply(message: TelegramMessage | undefined): string | null {
  const sourceText = message?.reply_to_message?.text;
  if (typeof sourceText !== "string" || sourceText.length === 0) return null;

  const match = sourceText.match(SESSION_MARKER_REGEX);
  return match?.[1] ?? null;
}

function isProjectPickerCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const firstToken = value.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  if (!firstToken) return false;
  return (
    firstToken === "/project" ||
    firstToken === "/projects" ||
    firstToken.startsWith("/project@") ||
    firstToken.startsWith("/projects@")
  );
}

function buildProjectSelectionScopeKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? 0}`;
}

function getSelectedProjectId(chatId: string, threadId?: number): string | undefined {
  return selectedProjectByScope.get(buildProjectSelectionScopeKey(chatId, threadId));
}

function setSelectedProjectId(chatId: string, threadId: number | undefined, projectId: string): void {
  selectedProjectByScope.set(buildProjectSelectionScopeKey(chatId, threadId), projectId);
}

function parseProjectSelectionCallbackData(value: unknown): string | null {
  const callbackData = toStringOrUndefined(value);
  if (!callbackData || !callbackData.startsWith(PROJECT_PICKER_CALLBACK_PREFIX)) return null;
  const projectId = callbackData.slice(PROJECT_PICKER_CALLBACK_PREFIX.length).trim();
  if (!projectId) return null;
  return projectId;
}

function buildProjectPickerHint(selectedProjectId: string | undefined): string {
  if (selectedProjectId) {
    return `Select active project for this chat/thread scope. Current active project: ${selectedProjectId}.`;
  }

  return "Select active project for this chat/thread scope. Current active project: none (fallback routing).";
}

type OrchestratorRoutingCandidates = ReturnType<typeof coerceOrchestratorSessionRoutingCandidates>;

function resolvePreferredProjectSessionId(
  config: OrchestratorConfig,
  projectId: string,
  routingCandidates: OrchestratorRoutingCandidates,
): string | null {
  const project = config.projects[projectId];
  if (!project) return null;
  const preferredOrchestratorSessionId = `${project.sessionPrefix}-orchestrator`;
  return selectFallbackOrchestratorSessionId(routingCandidates, { preferredOrchestratorSessionId });
}

function resolveFallbackSessionId(
  inboundConfig: TelegramInboundConfig,
  config: OrchestratorConfig,
  routingCandidates: OrchestratorRoutingCandidates,
): string | null {
  const preferredProjectId = process.env["AO_PROJECT_ID"]?.trim();
  const preferredProject = preferredProjectId ? config.projects[preferredProjectId] : undefined;
  const preferredOrchestratorId = preferredProject
    ? `${preferredProject.sessionPrefix}-orchestrator`
    : null;

  return selectFallbackOrchestratorSessionId(
    routingCandidates,
    {
      defaultSessionId: inboundConfig.defaultSessionId,
      preferredOrchestratorSessionId: preferredOrchestratorId,
    },
  );
}

async function callTelegramApiMethod(args: {
  botToken: string | undefined;
  method: "sendMessage" | "answerCallbackQuery";
  body: Record<string, unknown>;
}): Promise<void> {
  if (!args.botToken) {
    throw new Error("Telegram bot token is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${args.botToken}/${args.method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.body),
  });

  if (!response.ok) {
    throw new Error(`${args.method} failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    description?: unknown;
  };
  if (payload.ok === false) {
    const description = toStringOrUndefined(payload.description);
    throw new Error(description ?? `${args.method} failed (ok=false)`);
  }
}

async function sendProjectPickerMessage(args: {
  botToken: string | undefined;
  chatId: string;
  messageThreadId?: number;
  selectedProjectId?: string;
  config: OrchestratorConfig;
}): Promise<void> {
  const inlineKeyboard = Object.entries(args.config.projects).map(([projectId, projectConfig]) => {
    const projectName = projectConfig.name.trim();
    const text = projectName ? `${projectId}: ${projectName}` : projectId;
    return [
      {
        text,
        callback_data: `${PROJECT_PICKER_CALLBACK_PREFIX}${projectId}`,
      },
    ];
  });

  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    text: buildProjectPickerHint(args.selectedProjectId),
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  };
  if (args.messageThreadId !== undefined) {
    body.message_thread_id = args.messageThreadId;
  }

  await callTelegramApiMethod({
    botToken: args.botToken,
    method: "sendMessage",
    body,
  });
}

async function answerProjectPickerCallbackQuery(args: {
  botToken: string | undefined;
  callbackQueryId: string;
}): Promise<void> {
  await callTelegramApiMethod({
    botToken: args.botToken,
    method: "answerCallbackQuery",
    body: { callback_query_id: args.callbackQueryId },
  });
}

async function sendProjectSelectionConfirmation(args: {
  botToken: string | undefined;
  chatId: string;
  messageThreadId?: number;
  projectId: string;
}): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: args.chatId,
    text: `Active project for this chat/thread scope is now: ${args.projectId}.`,
  };
  if (args.messageThreadId !== undefined) {
    body.message_thread_id = args.messageThreadId;
  }

  await callTelegramApiMethod({
    botToken: args.botToken,
    method: "sendMessage",
    body,
  });
}

function buildVoiceTranscriptionFailureMessage(reason: string): string {
  return stripControlChars(
    `[Telegram voice transcription failed] ${normalizeErrorReason(reason)}. Please resend as text or a shorter voice message.`,
  ).trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeErrorReason(input: string): string {
  const normalized = stripControlChars(input).replace(/\s+/g, " ").trim();
  if (!normalized) return "Unknown error";
  return truncateText(normalized, MAX_ERROR_REASON_LENGTH);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return normalizeErrorReason(error.message);
  if (typeof error === "string") return normalizeErrorReason(error);
  return "Unknown error";
}

async function transcribeVoiceMessage(args: {
  botToken: string | undefined;
  voiceFileId: string;
  durationSec?: number;
  audioTranscriber: AudioTranscriber | null;
  maxAudioBytes: number;
}): Promise<string> {
  if (!args.botToken) {
    throw new Error("Telegram bot token is not configured");
  }

  if (!args.audioTranscriber) {
    throw new Error("Voice transcription service is not configured");
  }

  const downloaded = await downloadTelegramVoiceFileBytes({
    botToken: args.botToken,
    fileId: args.voiceFileId,
    timeoutMs: TELEGRAM_FILE_FETCH_TIMEOUT_MS,
    maxAudioBytes: args.maxAudioBytes,
  });
  const result = await transcribeAudioBytes({
    transcriber: args.audioTranscriber,
    bytes: downloaded.bytes,
    fileExtension: downloaded.fileExtension,
    durationSec: args.durationSec,
    fileSizeBytes: downloaded.fileSizeBytes,
  });
  return result.text;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { config, sessionManager, audioTranscriber } = await getServices();
  const transcriberMaxAudioBytes = resolveTranscriberMaxAudioBytes(config);
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

  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    const callbackChatId = toStringOrUndefined(callbackQuery.message?.chat?.id);
    if (!callbackChatId) {
      return NextResponse.json({ ok: false, error: "Callback query chat id is missing" }, { status: 400 });
    }
    if (inboundConfig.allowedChatId !== callbackChatId) {
      return NextResponse.json({ ok: false, error: "Chat is not allowed" }, { status: 403 });
    }

    const callbackThreadId = toPositiveNumber(callbackQuery.message?.message_thread_id);
    let warning: string | undefined;

    const callbackQueryId = toStringOrUndefined(callbackQuery.id);
    if (callbackQueryId) {
      try {
        await answerProjectPickerCallbackQuery({
          botToken: inboundConfig.botToken,
          callbackQueryId,
        });
      } catch (err) {
        warning = `Callback query ack failed: ${toErrorMessage(err)}`;
        console.warn(`[telegram-webhook] ${warning}`);
      }
    }

    const selectedProjectId = parseProjectSelectionCallbackData(callbackQuery.data);
    if (!selectedProjectId || !config.projects[selectedProjectId]) {
      return NextResponse.json({
        ok: true,
        ignored: "Unsupported callback data",
        warning,
      });
    }

    setSelectedProjectId(callbackChatId, callbackThreadId, selectedProjectId);

    try {
      await sendProjectSelectionConfirmation({
        botToken: inboundConfig.botToken,
        chatId: callbackChatId,
        messageThreadId: callbackThreadId,
        projectId: selectedProjectId,
      });
      return NextResponse.json({
        ok: true,
        projectId: selectedProjectId,
        warning,
      });
    } catch (err) {
      const msg = toErrorMessage(err);
      return NextResponse.json(
        { ok: false, error: `Failed to send Telegram project selection confirmation: ${msg}`, warning },
        { status: 503 },
      );
    }
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

  const messageThreadId = toPositiveNumber(message.message_thread_id);
  const replySessionId = extractSessionIdFromReply(message);
  const rawText = typeof message.text === "string" ? message.text : "";

  if (!replySessionId && isProjectPickerCommand(rawText)) {
    const selectedProjectId = getSelectedProjectId(incomingChatId, messageThreadId);
    try {
      await sendProjectPickerMessage({
        botToken: inboundConfig.botToken,
        chatId: incomingChatId,
        messageThreadId,
        selectedProjectId,
        config,
      });
      return NextResponse.json({
        ok: true,
        handled: "project-picker",
        projectId: selectedProjectId ?? null,
      });
    } catch (err) {
      const msg = toErrorMessage(err);
      return NextResponse.json(
        { ok: false, error: `Failed to send Telegram project picker: ${msg}` },
        { status: 503 },
      );
    }
  }

  let selectedProjectIdForRouting: string | undefined;
  let targetSessionId = replySessionId;
  if (!targetSessionId) {
    try {
      const listed = await sessionManager.list();
      const routingCandidates = coerceOrchestratorSessionRoutingCandidates(listed);
      selectedProjectIdForRouting = getSelectedProjectId(incomingChatId, messageThreadId);

      const selectedProjectSessionId = selectedProjectIdForRouting
        ? resolvePreferredProjectSessionId(config, selectedProjectIdForRouting, routingCandidates)
        : null;

      targetSessionId =
        selectedProjectSessionId ?? resolveFallbackSessionId(inboundConfig, config, routingCandidates);
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

  let inboundText = stripControlChars(rawText).trim();
  let usedVoiceInput = false;

  if (!inboundText) {
    const voiceFileId =
      typeof message.voice?.file_id === "string" && message.voice.file_id.trim().length > 0
        ? message.voice.file_id.trim()
        : undefined;
    const voiceDuration =
      typeof message.voice?.duration === "number" && Number.isFinite(message.voice.duration)
        ? message.voice.duration
        : undefined;

    if (voiceFileId) {
      usedVoiceInput = true;
      try {
        const transcript = await transcribeVoiceMessage({
          botToken: inboundConfig.botToken,
          voiceFileId,
          durationSec: voiceDuration,
          audioTranscriber,
          maxAudioBytes: transcriberMaxAudioBytes,
        });
        inboundText = stripControlChars(`[Transcribed voice message] ${transcript}`).trim();
      } catch (err) {
        const reason = toErrorMessage(err);
        console.warn(`[telegram-webhook] Voice transcription failed: ${reason}`);
        inboundText = buildVoiceTranscriptionFailureMessage(reason);
      }
    }
  }

  if (inboundText.length === 0) {
    return NextResponse.json({ ok: false, error: "Reply text is empty" }, { status: 400 });
  }

  if (inboundText.length > MAX_REPLY_LENGTH) {
    if (!usedVoiceInput) {
      return NextResponse.json(
        { ok: false, error: `Reply text exceeds ${MAX_REPLY_LENGTH} characters` },
        { status: 400 },
      );
    }
    inboundText = buildVoiceTranscriptionFailureMessage(
      `transcript exceeds ${MAX_REPLY_LENGTH} characters`,
    );
  }

  const inboundStore = createInboundContextStore(config);
  let inboundContextWarning: string | null = null;
  let sourceReplyAvailable = false;
  const telegramRouting = buildTelegramInboundRouting({
    chatId: incomingChatId,
    messageId,
    messageThreadId,
    projectId: selectedProjectIdForRouting,
    fromId: message.from?.id,
    fromUsername: message.from?.username,
    fromFirstName: message.from?.first_name,
    fromLastName: message.from?.last_name,
  });

  try {
    await inboundStore.enqueue({
      sessionId: targetSessionId,
      source: "telegram",
      text: inboundText,
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
        text: inboundText,
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
