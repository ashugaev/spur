import {
  buildTelegramInboundRouting,
  createInboundContextStore,
  coerceOrchestratorSessionRoutingCandidates,
  formatInboundMessageForSession,
  selectFallbackOrchestratorSessionId,
  type InboundContextStore,
  type OrchestratorConfig,
  type SessionManager,
} from "@composio/ao-core";
import type { IntegrationHealthReporter, IntegrationIdentity } from "./integration-health.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_MESSAGE_LENGTH = 10_000;
const SESSION_MARKER_REGEX = /\bAO_SESSION:([a-zA-Z0-9_-]+)\b/;

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
}

interface TelegramMessage {
  message_id?: unknown;
  text?: unknown;
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
  fetchImpl?: typeof fetch;
  logger?: LoggerLike;
  healthReporter?: IntegrationHealthReporter;
}

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

async function resolveFallbackSessionId(
  cfg: TelegramLongPollingConfig,
  sessionManager: SessionManager,
): Promise<string | null> {
  const listed = await sessionManager.list();
  return selectFallbackOrchestratorSessionId(
    coerceOrchestratorSessionRoutingCandidates(listed),
    {
      defaultSessionId: cfg.defaultSessionId,
      preferredOrchestratorSessionId: cfg.preferredOrchestratorSessionId,
    },
  );
}

export async function maybeStartTelegramLongPolling(
  deps: StartTelegramLongPollingDeps,
): Promise<TelegramPollingController | null> {
  const cfg = resolveLongPollingConfig(deps.config);
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

  const pollOnce = async () => {
    if (stopped || inFlight) return;
    if (Date.now() < rateLimitedUntil) return;
    inFlight = true;

    try {
      const requestBody: Record<string, unknown> = {
        allowed_updates: ["message", "edited_message"],
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

      let fallbackSessionId: string | null | undefined;
      for (const update of updates) {
        if (typeof update.update_id === "number" && Number.isFinite(update.update_id)) {
          offset = (offset === undefined ? update.update_id : Math.max(offset, update.update_id)) + 1;
        }

        const message = update.message ?? update.edited_message;
        if (!message) continue;

        const incomingChatId = toStringOrUndefined(message.chat?.id);
        if (!incomingChatId || incomingChatId !== cfg.chatId) continue;

        const replySessionId = extractSessionId(message);
        let sessionId: string | null = replySessionId;
        if (!sessionId) {
          if (fallbackSessionId === undefined) {
            fallbackSessionId = await resolveFallbackSessionId(cfg, deps.sessionManager);
          }
          sessionId = fallbackSessionId ?? null;
        }
        if (!sessionId) continue;

        const rawText = typeof message.text === "string" ? message.text : "";
        const sanitized = sanitizeMessage(rawText);
        if (!sanitized || sanitized.length > MAX_MESSAGE_LENGTH) continue;

        const routingForDisplay: Record<string, unknown> = {
          chatId: incomingChatId,
        };
        const threadId = toPositiveNumber(message.message_thread_id);
        if (threadId) {
          routingForDisplay["threadId"] = threadId;
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
          health?.markDegraded(
            TELEGRAM_POLLING_HEALTH,
            "Poll cycle warning: incoming Telegram message had no message_id",
            error,
          );
        } else {
          routingForDisplay["messageId"] = messageId;
          try {
            await inboundContextStore.enqueue({
              sessionId,
              source: "telegram",
              text: sanitized,
              routing: buildTelegramInboundRouting({
                chatId: incomingChatId,
                messageId,
                messageThreadId: toPositiveNumber(message.message_thread_id),
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
            health?.markDegraded(
              TELEGRAM_POLLING_HEALTH,
              `Poll cycle warning: context persist failed (${msg})`,
              err,
            );
          }
        }

        try {
          await deps.sessionManager.send(
            sessionId,
            formatInboundMessageForSession({
              sessionId,
              source: "telegram",
              text: sanitized,
              routing: routingForDisplay,
              includeReplyCommand: sourceReplyAvailable,
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[telegram-polling] Failed to send message to session ${sessionId}: ${msg}`);
        }
      }

      health?.markHealthy(
        TELEGRAM_POLLING_HEALTH,
        `Polling active; cycle completed (${updates.length} updates checked)`,
      );
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
