import {
  buildTelegramInboundRouting,
  createAudioTranscriber,
  createInboundContextStore,
  coerceOrchestratorSessionRoutingCandidates,
  downloadTelegramVoiceFileBytes,
  formatInboundMessageForSession,
  selectFallbackOrchestratorSessionId,
  transcribeAudioBytes,
  type AudioTranscriber,
  type InboundContextStore,
  type OrchestratorConfig,
  type SessionManager,
} from "@composio/ao-core";
import type { IntegrationHealthReporter, IntegrationIdentity } from "./integration-health.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const TELEGRAM_FILE_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSCRIBER_MAX_AUDIO_BYTES = 25_000_000;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_ERROR_REASON_LENGTH = 300;
const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;
const PROJECT_PICKER_CALLBACK_PREFIX = "AO_PROJECT:";

interface TelegramNotifierConfig {
  plugin?: unknown;
  botToken?: unknown;
  chatId?: unknown;
  pollingIntervalMs?: unknown;
  rateLimitBackoffMs?: unknown;
  defaultSessionId?: unknown;
}

interface TelegramWebhookInfoResponse {
  ok?: boolean;
  result?: {
    url?: unknown;
  };
}

interface TelegramUpdate {
  update_id?: unknown;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id?: unknown;
  text?: unknown;
  voice?: {
    file_id?: unknown;
    file_size?: unknown;
    duration?: unknown;
  };
  chat?: {
    id?: unknown;
  };
  from?: {
    id?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
  };
  message_thread_id?: unknown;
  reply_to_message?: {
    text?: unknown;
  };
}

interface TelegramCallbackQuery {
  id?: unknown;
  data?: unknown;
  message?: TelegramMessage;
}

interface TelegramUpdatesResponse {
  ok?: boolean;
  result?: TelegramUpdate[];
}

interface TelegramApiErrorResponse {
  description?: unknown;
  parameters?: {
    retry_after?: unknown;
  };
}

interface TelegramApiMethodResponse {
  ok?: boolean;
  description?: unknown;
}

export interface TelegramPollingController {
  stop(): void;
}

interface TelegramLongPollingConfig {
  botToken: string;
  chatId: string;
  intervalMs: number;
  rateLimitBackoffMs: number;
  defaultSessionId?: string;
  preferredOrchestratorSessionId?: string;
}

interface LoggerLike {
  warn: (message: string) => void;
}

interface StartTelegramLongPollingDeps {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  inboundContextStore?: InboundContextStore;
  audioTranscriber?: AudioTranscriber | null;
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
  healthReporter?: IntegrationHealthReporter;
}

type OrchestratorRoutingCandidates = ReturnType<typeof coerceOrchestratorSessionRoutingCandidates>;

const TELEGRAM_POLLING_HEALTH: IntegrationIdentity = {
  id: "telegram-polling",
  label: "Telegram Inbound Polling",
  service: "telegram",
  kind: "polling",
};

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

function sanitizeMessage(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeErrorReason(input: string): string {
  const normalized = sanitizeMessage(input).replace(/\s+/g, " ").trim();
  if (!normalized) return "Unknown error";
  return truncateText(normalized, MAX_ERROR_REASON_LENGTH);
}

function resolveTelegramNotifierConfig(config: OrchestratorConfig): TelegramNotifierConfig | null {
  for (const notifier of Object.values(config.notifiers)) {
    if (notifier && notifier.plugin === "telegram") {
      return notifier as TelegramNotifierConfig;
    }
  }
  return null;
}

function resolveLongPollingConfig(config: OrchestratorConfig): TelegramLongPollingConfig | null {
  const notifier = resolveTelegramNotifierConfig(config);
  if (!notifier) return null;

  const botToken =
    toStringOrUndefined(notifier.botToken) ||
    env("AO_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN", "TG_TOKEN");

  const chatId =
    toStringOrUndefined(notifier.chatId) ||
    env("AO_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID", "TG_CHAT_ID");

  if (!botToken || !chatId) return null;

  const intervalMs =
    toPositiveNumber(notifier.pollingIntervalMs) ??
    toPositiveNumber(env("AO_TELEGRAM_POLL_INTERVAL_MS", "TELEGRAM_POLL_INTERVAL_MS")) ??
    DEFAULT_POLL_INTERVAL_MS;

  const rateLimitBackoffMs =
    toPositiveNumber(notifier.rateLimitBackoffMs) ??
    toPositiveNumber(
      env("AO_TELEGRAM_RATELIMIT_BACKOFF_MS", "TELEGRAM_RATELIMIT_BACKOFF_MS"),
    ) ??
    DEFAULT_RATE_LIMIT_BACKOFF_MS;

  const defaultSessionId =
    toStringOrUndefined(notifier.defaultSessionId) ||
    env(
      "AO_TELEGRAM_DEFAULT_SESSION_ID",
      "TELEGRAM_DEFAULT_SESSION_ID",
      "TG_DEFAULT_SESSION_ID",
    );
  const preferredProjectId = env("AO_PROJECT_ID");
  const preferredProject = preferredProjectId ? config.projects[preferredProjectId] : undefined;
  const preferredOrchestratorSessionId = preferredProject
    ? `${preferredProject.sessionPrefix}-orchestrator`
    : undefined;

  return {
    botToken,
    chatId,
    intervalMs,
    rateLimitBackoffMs,
    defaultSessionId,
    preferredOrchestratorSessionId,
  };
}

function resolveTranscriberMaxAudioBytes(config: OrchestratorConfig): number {
  const configuredMaxAudioBytes = toPositiveNumber(config.services?.transcriber?.maxAudioBytes);
  return configuredMaxAudioBytes ?? DEFAULT_TRANSCRIBER_MAX_AUDIO_BYTES;
}

class TelegramRateLimitError extends Error {
  readonly backoffMs: number;

  constructor(message: string, backoffMs: number) {
    super(message);
    this.name = "TelegramRateLimitError";
    this.backoffMs = backoffMs;
  }
}

async function isWebhookConfigured(botToken: string, fetchImpl: typeof fetch): Promise<boolean> {
  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`getWebhookInfo failed (${response.status})`);
  }

  const payload = (await response.json()) as TelegramWebhookInfoResponse;
  const url = payload.result?.url;
  return typeof url === "string" && url.trim().length > 0;
}

function extractSessionId(message: TelegramMessage): string | null {
  const sourceText = message.reply_to_message?.text;
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

function getSelectedProjectId(
  selectedProjectsByScope: Map<string, string>,
  chatId: string,
  threadId?: number,
): string | undefined {
  return selectedProjectsByScope.get(buildProjectSelectionScopeKey(chatId, threadId));
}

function setSelectedProjectId(
  selectedProjectsByScope: Map<string, string>,
  chatId: string,
  threadId: number | undefined,
  projectId: string,
): void {
  selectedProjectsByScope.set(buildProjectSelectionScopeKey(chatId, threadId), projectId);
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
  cfg: TelegramLongPollingConfig,
  routingCandidates: OrchestratorRoutingCandidates,
): string | null {
  return selectFallbackOrchestratorSessionId(
    routingCandidates,
    {
      defaultSessionId: cfg.defaultSessionId,
      preferredOrchestratorSessionId: cfg.preferredOrchestratorSessionId,
    },
  );
}

async function callTelegramApiMethod(args: {
  botToken: string;
  method: "sendMessage" | "answerCallbackQuery";
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const response = await args.fetchImpl(`https://api.telegram.org/bot${args.botToken}/${args.method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.body),
  });

  if (!response.ok) {
    throw new Error(`${args.method} failed (${response.status})`);
  }

  const payload = (await response.json()) as TelegramApiMethodResponse;
  if (payload.ok === false) {
    const description = toStringOrUndefined(payload.description);
    throw new Error(description ?? `${args.method} failed (ok=false)`);
  }
}

async function sendProjectPickerMessage(args: {
  botToken: string;
  chatId: string;
  messageThreadId?: number;
  selectedProjectId?: string;
  config: OrchestratorConfig;
  fetchImpl: typeof fetch;
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
    fetchImpl: args.fetchImpl,
  });
}

async function answerProjectPickerCallbackQuery(args: {
  botToken: string;
  callbackQueryId: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  await callTelegramApiMethod({
    botToken: args.botToken,
    method: "answerCallbackQuery",
    body: { callback_query_id: args.callbackQueryId },
    fetchImpl: args.fetchImpl,
  });
}

async function sendProjectSelectionConfirmation(args: {
  botToken: string;
  chatId: string;
  messageThreadId?: number;
  projectId: string;
  fetchImpl: typeof fetch;
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
    fetchImpl: args.fetchImpl,
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return normalizeErrorReason(error.message);
  if (typeof error === "string") return normalizeErrorReason(error);
  return "Unknown error";
}

function buildVoiceTranscriptionFailureMessage(reason: string): string {
  return sanitizeMessage(
    `[Telegram voice transcription failed] ${normalizeErrorReason(reason)}. Please resend as text or a shorter voice message.`,
  );
}

async function transcribeTelegramVoiceMessage(args: {
  botToken: string;
  fetchImpl: typeof fetch;
  audioTranscriber: AudioTranscriber | null;
  voiceFileId: string;
  durationSec?: number;
  maxAudioBytes: number;
}): Promise<string> {
  if (!args.audioTranscriber) {
    throw new Error("Voice transcription service is not configured");
  }

  const downloaded = await downloadTelegramVoiceFileBytes({
    botToken: args.botToken,
    fileId: args.voiceFileId,
    fetchImpl: args.fetchImpl,
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

export async function maybeStartTelegramLongPolling(
  deps: StartTelegramLongPollingDeps,
): Promise<TelegramPollingController | null> {
  const cfg = resolveLongPollingConfig(deps.config);
  const transcriberMaxAudioBytes = resolveTranscriberMaxAudioBytes(deps.config);
  const inboundContextStore = deps.inboundContextStore ?? createInboundContextStore(deps.config);
  const health = deps.healthReporter;
  if (!cfg) {
    health?.markInactive(
      TELEGRAM_POLLING_HEALTH,
      "Telegram polling inactive: notifier config, bot token, or chat id is missing",
    );
    return null;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? console;
  let audioTranscriber: AudioTranscriber | null;
  if (deps.audioTranscriber !== undefined) {
    audioTranscriber = deps.audioTranscriber;
  } else {
    try {
      audioTranscriber = createAudioTranscriber(deps.config);
    } catch (err) {
      const msg = toErrorMessage(err);
      logger.warn(`[telegram-polling] Audio transcriber disabled due to configuration error: ${msg}`);
      health?.markDegraded(
        TELEGRAM_POLLING_HEALTH,
        `Audio transcriber disabled due to configuration error: ${msg}`,
        err,
      );
      audioTranscriber = null;
    }
  }
  health?.markStarting(TELEGRAM_POLLING_HEALTH, "Starting Telegram polling runtime");

  try {
    if (await isWebhookConfigured(cfg.botToken, fetchImpl)) {
      health?.markInactive(
        TELEGRAM_POLLING_HEALTH,
        "Telegram polling inactive: webhook is configured",
      );
      return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[telegram-polling] Could not verify webhook state (${msg}); using polling fallback`);
    health?.markDegraded(
      TELEGRAM_POLLING_HEALTH,
      "Webhook state check failed; falling back to long polling",
      err,
    );
  }

  let offset: number | undefined;
  let stopped = false;
  let inFlight = false;
  let rateLimitedUntil = 0;
  const selectedProjectByScope = new Map<string, string>();

  const pollOnce = async () => {
    if (stopped || inFlight) return;
    if (Date.now() < rateLimitedUntil) return;
    inFlight = true;

    try {
      const requestBody: Record<string, unknown> = {
        allowed_updates: ["message", "edited_message", "callback_query"],
      };
      if (offset !== undefined) requestBody.offset = offset;

      const response = await fetchImpl(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        if (response.status === 429) {
          let retryAfterMs = 0;
          let description = "Telegram API rate limited";
          try {
            const payload = (await response.json()) as TelegramApiErrorResponse;
            const retryAfterSec = toPositiveNumber(payload.parameters?.retry_after);
            if (retryAfterSec) retryAfterMs = retryAfterSec * 1000;
            if (typeof payload.description === "string" && payload.description.trim().length > 0) {
              description = payload.description.trim();
            }
          } catch {
            // Ignore JSON parsing errors and fallback to configured backoff.
          }
          const backoffMs = Math.max(cfg.rateLimitBackoffMs, retryAfterMs);
          throw new TelegramRateLimitError(description, backoffMs);
        }

        throw new Error(`getUpdates failed (${response.status})`);
      }

      const payload = (await response.json()) as TelegramUpdatesResponse;
      const updates = Array.isArray(payload.result) ? payload.result : [];
      let cycleHasWarnings = false;
      const markCycleDegraded = (message: string, error?: unknown): void => {
        cycleHasWarnings = true;
        health?.markDegraded(TELEGRAM_POLLING_HEALTH, message, error);
      };

      let fallbackSessionId: string | null | undefined;
      let routingCandidates: OrchestratorRoutingCandidates | undefined;
      const getRoutingCandidates = async (): Promise<OrchestratorRoutingCandidates> => {
        if (routingCandidates) return routingCandidates;
        const listed = await deps.sessionManager.list();
        routingCandidates = coerceOrchestratorSessionRoutingCandidates(listed);
        return routingCandidates;
      };
      for (const update of updates) {
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id)) {
          offset = (offset === undefined ? update.update_id : Math.max(offset, update.update_id)) + 1;
        }

        const callbackQuery = update.callback_query;
        if (callbackQuery) {
          const callbackMessage = callbackQuery.message;
          const callbackChatId = toStringOrUndefined(callbackMessage?.chat?.id);
          if (!callbackChatId || callbackChatId !== cfg.chatId) continue;
          const callbackQueryId = toStringOrUndefined(callbackQuery.id);
          if (callbackQueryId) {
            try {
              await answerProjectPickerCallbackQuery({
                botToken: cfg.botToken,
                callbackQueryId,
                fetchImpl,
              });
            } catch (err) {
              const msg = toErrorMessage(err);
              logger.warn(`[telegram-polling] Failed to answer callback query: ${msg}`);
              markCycleDegraded(`Poll cycle warning: callback query ack failed (${msg})`, err);
            }
          }

          const selectedProjectId = parseProjectSelectionCallbackData(callbackQuery.data);
          if (!selectedProjectId || !deps.config.projects[selectedProjectId]) continue;

          const callbackThreadId = toPositiveNumber(callbackMessage?.message_thread_id);
          setSelectedProjectId(
            selectedProjectByScope,
            callbackChatId,
            callbackThreadId,
            selectedProjectId,
          );

          try {
            await sendProjectSelectionConfirmation({
              botToken: cfg.botToken,
              chatId: callbackChatId,
              messageThreadId: callbackThreadId,
              projectId: selectedProjectId,
              fetchImpl,
            });
          } catch (err) {
            const msg = toErrorMessage(err);
            logger.warn(`[telegram-polling] Failed to send project selection confirmation: ${msg}`);
            markCycleDegraded(
              `Poll cycle warning: project selection confirmation failed (${msg})`,
              err,
            );
          }
          continue;
        }

        const message = update.message ?? update.edited_message;
        if (!message) continue;

        const incomingChatId = toStringOrUndefined(message.chat?.id);
        if (!incomingChatId || incomingChatId !== cfg.chatId) continue;

        const threadId = toPositiveNumber(message.message_thread_id);
        const rawText = typeof message.text === "string" ? message.text : "";
        const replySessionId = extractSessionId(message);
        if (!replySessionId && isProjectPickerCommand(rawText)) {
          const selectedProjectId = getSelectedProjectId(
            selectedProjectByScope,
            incomingChatId,
            threadId,
          );
          try {
            await sendProjectPickerMessage({
              botToken: cfg.botToken,
              chatId: incomingChatId,
              messageThreadId: threadId,
              selectedProjectId,
              config: deps.config,
              fetchImpl,
            });
          } catch (err) {
            const msg = toErrorMessage(err);
            logger.warn(`[telegram-polling] Failed to send /project picker: ${msg}`);
            markCycleDegraded(`Poll cycle warning: project picker send failed (${msg})`, err);
          }
          continue;
        }

        let sessionId: string | null = replySessionId;
        let selectedProjectIdForRouting: string | undefined;
        if (!sessionId) {
          selectedProjectIdForRouting = getSelectedProjectId(
            selectedProjectByScope,
            incomingChatId,
            threadId,
          );
          if (selectedProjectIdForRouting) {
            const candidates = await getRoutingCandidates();
            sessionId = resolvePreferredProjectSessionId(
              deps.config,
              selectedProjectIdForRouting,
              candidates,
            );
          }

          if (fallbackSessionId === undefined) {
            const candidates = await getRoutingCandidates();
            fallbackSessionId = resolveFallbackSessionId(cfg, candidates);
          }
          sessionId = sessionId ?? fallbackSessionId ?? null;
        }
        if (!sessionId) continue;

        let inboundText = sanitizeMessage(rawText);
        let usedVoiceInput = false;
        if (!inboundText) {
          const voiceFileId = toStringOrUndefined(message.voice?.file_id);
          const voiceDuration = toPositiveNumber(message.voice?.duration);
          if (voiceFileId) {
            usedVoiceInput = true;
            try {
              const transcript = await transcribeTelegramVoiceMessage({
                botToken: cfg.botToken,
                fetchImpl,
                audioTranscriber,
                voiceFileId,
                durationSec: voiceDuration,
                maxAudioBytes: transcriberMaxAudioBytes,
              });
              inboundText = sanitizeMessage(`[Transcribed voice message] ${transcript}`);
            } catch (err) {
              const reason = toErrorMessage(err);
              logger.warn(`[telegram-polling] Voice transcription failed: ${reason}`);
              markCycleDegraded(`Poll cycle warning: voice transcription failed (${reason})`, err);
              inboundText = buildVoiceTranscriptionFailureMessage(reason);
            }
          }
        }
        if (!inboundText) continue;
        if (inboundText.length > MAX_MESSAGE_LENGTH) {
          if (!usedVoiceInput) continue;
          inboundText = buildVoiceTranscriptionFailureMessage(
            `transcript exceeds ${MAX_MESSAGE_LENGTH} characters`,
          );
        }

        const routingForDisplay: Record<string, unknown> = {
          chatId: incomingChatId,
        };
        if (threadId) {
          routingForDisplay["threadId"] = threadId;
        }
        if (selectedProjectIdForRouting) {
          routingForDisplay["projectId"] = selectedProjectIdForRouting;
        }
        const fromUsername =
          typeof message.from?.username === "string" ? message.from.username : undefined;
        if (fromUsername) {
          routingForDisplay["fromUsername"] = fromUsername;
        }
        const fromDisplayName = [
          typeof message.from?.first_name === "string" ? message.from.first_name : undefined,
          typeof message.from?.last_name === "string" ? message.from.last_name : undefined,
        ]
          .filter((part): part is string => Boolean(part && part.trim().length > 0))
          .join(" ")
          .trim();
        if (fromDisplayName) {
          routingForDisplay["fromDisplayName"] = fromDisplayName;
        }

        const messageId = toPositiveNumber(message.message_id);
        let sourceReplyAvailable = false;
        if (!messageId) {
          const error = new Error("Incoming Telegram message has no message_id");
          logger.warn("[telegram-polling] Skipping context persist: incoming message has no message_id");
          markCycleDegraded(
            "Poll cycle warning: incoming Telegram message had no message_id",
            error,
          );
        } else {
          routingForDisplay["messageId"] = messageId;
          try {
            await inboundContextStore.enqueue({
              sessionId,
              source: "telegram",
              text: inboundText,
              routing: buildTelegramInboundRouting({
                chatId: incomingChatId,
                messageId,
                messageThreadId: toPositiveNumber(message.message_thread_id),
                projectId: selectedProjectIdForRouting,
                fromId: toPositiveNumber(message.from?.id),
                fromUsername:
                  typeof message.from?.username === "string" ? message.from.username : undefined,
                fromFirstName:
                  typeof message.from?.first_name === "string"
                    ? message.from.first_name
                    : undefined,
                fromLastName:
                  typeof message.from?.last_name === "string"
                    ? message.from.last_name
                    : undefined,
              }),
            });
            sourceReplyAvailable = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`[telegram-polling] Failed to persist inbound source context: ${msg}`);
            markCycleDegraded(`Poll cycle warning: context persist failed (${msg})`, err);
          }
        }

        try {
          await deps.sessionManager.send(
            sessionId,
            formatInboundMessageForSession({
              sessionId,
              source: "telegram",
              text: inboundText,
              routing: routingForDisplay,
              includeReplyCommand: sourceReplyAvailable,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[telegram-polling] Failed to send message to session ${sessionId}: ${msg}`);
        }
      }

      if (!cycleHasWarnings) {
        health?.markHealthy(
          TELEGRAM_POLLING_HEALTH,
          `Polling active; cycle completed (${updates.length} updates checked)`,
        );
      }
    } catch (err) {
      if (err instanceof TelegramRateLimitError) {
        rateLimitedUntil = Date.now() + err.backoffMs;
        const backoffSeconds = Math.ceil(err.backoffMs / 1000);
        const message = `Poll cycle rate limited; backing off for ${backoffSeconds}s (${err.message})`;
        logger.warn(`[telegram-polling] ${message}`);
        health?.markDegraded(TELEGRAM_POLLING_HEALTH, message, err);
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[telegram-polling] Poll cycle failed: ${msg}`);
      health?.markDegraded(TELEGRAM_POLLING_HEALTH, `Poll cycle failed: ${msg}`, err);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void pollOnce();
  }, cfg.intervalMs);

  void pollOnce();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      health?.markInactive(TELEGRAM_POLLING_HEALTH, "Telegram polling stopped");
    },
  };
}
