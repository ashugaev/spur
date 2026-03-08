import {
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
} from "@composio/ao-core";

export const manifest = {
  name: "telegram",
  slot: "notifier" as const,
  description: "Notifier plugin: Telegram bot notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: "[URGENT]",
  action: "[ACTION]",
  warning: "[WARN]",
  info: "[INFO]",
};

const SESSION_MARKER_PREFIX = "AO_SESSION:";

function resolveEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveBotToken(config?: Record<string, unknown>): string | undefined {
  return (
    (typeof config?.botToken === "string" && config.botToken.trim()) ||
    resolveEnv("AO_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN", "TG_TOKEN")
  );
}

function resolveChatId(config?: Record<string, unknown>): string | undefined {
  const raw = config?.chatId;
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return resolveEnv("AO_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID", "TG_CHAT_ID");
}

function resolveThreadId(config?: Record<string, unknown>): number | undefined {
  const raw = config?.threadId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);

  const envValue = resolveEnv("AO_TELEGRAM_THREAD_ID", "TELEGRAM_THREAD_ID", "TG_THREAD_ID");
  if (typeof envValue === "string" && /^\d+$/.test(envValue)) return parseInt(envValue, 10);

  return undefined;
}

function getSessionMarker(sessionId: string): string {
  return `${SESSION_MARKER_PREFIX}${sessionId}`;
}

function formatEventText(event: OrchestratorEvent): string {
  const lines = [`${PRIORITY_EMOJI[event.priority]} ${event.type}`, event.message];
  const sessionId = event.sessionId.trim();
  const projectId = event.projectId.trim();

  if (sessionId) {
    lines.push(`Session: ${sessionId}`);
    lines.push(getSessionMarker(sessionId));
  }
  if (projectId) {
    lines.push(`Project: ${projectId}`);
  }

  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) lines.push(`PR: ${prUrl}`);

  return lines.join("\n");
}

function formatEventWithActions(event: OrchestratorEvent, actions: NotifyAction[]): string {
  const base = formatEventText(event);
  if (actions.length === 0) return base;

  const actionLines = actions.map((action) => {
    if (action.url) return `- ${action.label}: ${action.url}`;
    if (action.callbackEndpoint) return `- ${action.label}: ${action.callbackEndpoint}`;
    return `- ${action.label}`;
  });

  return `${base}\n\nActions:\n${actionLines.join("\n")}`;
}

interface InlineKeyboardButton {
  text: string;
  url: string;
}

async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  threadId?: number,
  inlineButtons?: InlineKeyboardButton[],
): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (threadId !== undefined) {
    payload.message_thread_id = threadId;
  }

  if (inlineButtons && inlineButtons.length > 0) {
    payload.reply_markup = {
      inline_keyboard: inlineButtons.map((btn) => [{ text: btn.text, url: btn.url }]),
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API failed (${response.status}): ${body}`);
  }
}

export function create(config?: Record<string, unknown>): Notifier {
  const botToken = resolveBotToken(config);
  const chatId = resolveChatId(config);
  const threadId = resolveThreadId(config);

  if (!botToken || !chatId) {
    console.warn(
      "[notifier-telegram] Missing bot token or chat id — notifications will be no-ops",
    );
  }

  return {
    name: "telegram",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!botToken || !chatId) return;
      await sendMessage(botToken, chatId, formatEventText(event), threadId);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!botToken || !chatId) return;
      const urlActions = actions.filter((a): a is NotifyAction & { url: string } => !!a.url);
      const textActions = actions.filter((a) => !a.url);
      const inlineButtons = urlActions.map((a) => ({ text: a.label, url: a.url }));
      await sendMessage(
        botToken,
        chatId,
        formatEventWithActions(event, textActions),
        threadId,
        inlineButtons,
      );
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!botToken || !chatId) return null;

      const contextChannel = context?.channel;
      const targetChat =
        typeof contextChannel === "string" && contextChannel.trim().length > 0
          ? contextChannel
          : chatId;

      await sendMessage(botToken, targetChat, message, threadId);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;

export { SESSION_MARKER_PREFIX, getSessionMarker };
