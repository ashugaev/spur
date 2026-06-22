import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import {
  TELEGRAM_MESSAGE_EVENT,
  type TelegramMessageEventData,
  type TelegramSourceConfig,
} from "../types.js";
import {
  readTelegramBindings,
  readTelegramReplyTarget,
  removeTelegramReplyTarget,
  telegramBindingFilePath,
  telegramBindingKey,
  writeTelegramBindings,
  writeTelegramReplyTarget,
} from "../telegram-source-state.js";
import type {
  SourceHandle,
  SourceModule,
  SourceSessionListItem,
  SourceStartDeps,
} from "./types.js";

const WATCH_CALLBACK_PREFIX = "spur_watch:";

interface TelegramTextMessage {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  chat: {
    id: number;
  };
  from?: {
    id: number;
    username?: string;
  };
}

interface TelegramTextContext {
  message?: TelegramTextMessage;
  reply(text: string, options?: unknown): Promise<unknown>;
}

interface TelegramCallbackContext {
  callbackQuery?: {
    data?: string;
    message?: {
      message_thread_id?: number;
      chat: {
        id: number;
      };
    };
    from?: {
      id: number;
      username?: string;
    };
  };
  answerCallbackQuery(text?: string): Promise<unknown>;
  editMessageText?(text: string, options?: unknown): Promise<unknown>;
  reply?(text: string, options?: unknown): Promise<unknown>;
}

type TelegramCommand =
  | {
      kind: "watch";
      sessionId: string;
    }
  | {
      kind: "watch_menu";
    }
  | {
      kind: "unwatch";
    };

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  const watch = trimmed.match(/^\/watch(?:@[a-zA-Z0-9_]+)?(?:\s+(\S+))?\s*$/);
  if (watch) {
    const sessionId = watch[1]?.trim();
    return sessionId ? { kind: "watch", sessionId } : { kind: "watch_menu" };
  }
  if (/^\/unwatch(?:@[a-zA-Z0-9_]+)?\s*$/.test(trimmed)) {
    return { kind: "unwatch" };
  }
  return null;
}

function isAllowed(
  config: TelegramSourceConfig,
  chatId: number,
  from?: { id: number; username?: string },
): boolean {
  const allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;
  const allowedChats = config.allowedChats ? new Set(config.allowedChats) : null;
  if (allowedUsers && (!from || !allowedUsers.has(from.id))) return false;
  if (allowedChats && !allowedChats.has(chatId)) return false;
  return true;
}

function eventData(message: TelegramTextMessage, sessionId: string): TelegramMessageEventData {
  return {
    sessionId,
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined
      ? { messageThreadId: message.message_thread_id }
      : {}),
    userId: message.from?.id ?? 0,
    ...(message.from?.username ? { username: message.from.username } : {}),
    messageId: message.message_id,
    text: message.text?.trim() ?? "",
  };
}

function sessionLabel(session: SourceSessionListItem): string {
  const label = `${session.id} ${session.agent} ${session.state}`;
  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

async function sendWatchMenu(
  ctx: TelegramTextContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<void> {
  const sessions = deps.listSessions ? await deps.listSessions() : [];
  if (sessions.length === 0) {
    await ctx.reply("No active Spur sessions.");
    return;
  }
  await ctx.reply("Select a Spur session:", {
    reply_markup: {
      inline_keyboard: sessions
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((session) => [
          {
            text: sessionLabel(session),
            callback_data: `${WATCH_CALLBACK_PREFIX}${session.id}`,
          },
        ]),
    },
  });
}

function bindTelegramThread(
  deps: SourceStartDeps<TelegramSourceConfig>,
  chatId: number,
  messageThreadId: number | undefined,
  sessionId: string,
): void {
  const path = telegramBindingFilePath(deps.dataDir, deps.projectId, deps.sourceId);
  const key = telegramBindingKey(chatId, messageThreadId);
  const bindings = readTelegramBindings(path);
  bindings.set(key, {
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    sessionId,
  });
  writeTelegramBindings(path, bindings);
  writeTelegramReplyTarget(deps.dataDir, {
    sessionId,
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  });
}

async function handleTelegramCallback(
  ctx: TelegramCallbackContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<void> {
  const query = ctx.callbackQuery;
  const data = query?.data;
  const message = query?.message;
  if (!data?.startsWith(WATCH_CALLBACK_PREFIX) || !message) return;
  if (!isAllowed(deps.config, message.chat.id, query.from)) return;

  const sessionId = data.slice(WATCH_CALLBACK_PREFIX.length);
  const sessions = deps.listSessions ? await deps.listSessions() : [];
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    await ctx.answerCallbackQuery("Session is no longer active.");
    return;
  }

  bindTelegramThread(deps, message.chat.id, message.message_thread_id, sessionId);
  const reply = `Bound this Telegram thread to Spur session ${sessionId}.`;
  await ctx.answerCallbackQuery(`Bound ${sessionId}.`);
  if (ctx.editMessageText) {
    await ctx.editMessageText(reply);
  } else {
    await ctx.reply?.(reply);
  }
}

async function handleTelegramText(
  ctx: TelegramTextContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<void> {
  const message = ctx.message;
  if (!message?.text || !message.text.trim()) return;
  if (!isAllowed(deps.config, message.chat.id, message.from)) return;

  const path = telegramBindingFilePath(deps.dataDir, deps.projectId, deps.sourceId);
  const key = telegramBindingKey(message.chat.id, message.message_thread_id);
  const command = parseTelegramCommand(message.text);
  if (command?.kind === "watch") {
    bindTelegramThread(deps, message.chat.id, message.message_thread_id, command.sessionId);
    await ctx.reply(`Bound this Telegram thread to Spur session ${command.sessionId}.`);
    return;
  }
  if (command?.kind === "watch_menu") {
    await sendWatchMenu(ctx, deps);
    return;
  }
  if (command?.kind === "unwatch") {
    const bindings = readTelegramBindings(path);
    const binding = bindings.get(key);
    const deleted = bindings.delete(key);
    writeTelegramBindings(path, bindings);
    const target = binding ? readTelegramReplyTarget(deps.dataDir, binding.sessionId) : null;
    if (
      binding &&
      target &&
      target.chatId === message.chat.id &&
      target.messageThreadId === message.message_thread_id
    ) {
      removeTelegramReplyTarget(deps.dataDir, binding.sessionId);
    }
    await ctx.reply(deleted ? "Unbound this Telegram thread." : "No Spur session bound here.");
    return;
  }
  if (message.text.trim().startsWith("/")) return;

  const binding = readTelegramBindings(path).get(key);
  if (!binding) return;
  writeTelegramReplyTarget(deps.dataDir, {
    sessionId: binding.sessionId,
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined
      ? { messageThreadId: message.message_thread_id }
      : {}),
  });
  deps.emit(TELEGRAM_MESSAGE_EVENT, eventData(message, binding.sessionId));
}

async function startTelegramSource(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceHandle> {
  const bot = new Bot(deps.config.token);
  bot.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram update failed: ${message}`,
    );
  });
  bot.on("message:text", async (ctx: Context) => {
    await handleTelegramText(ctx as TelegramTextContext, deps);
  });
  bot.on("callback_query:data", async (ctx: Context) => {
    await handleTelegramCallback(ctx as TelegramCallbackContext, deps);
  });

  let stopped = false;
  const handle: RunnerHandle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "callback_query"],
      },
      silent: true,
    },
    sink: {
      concurrency: 8,
    },
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void handle.stop();
  };
  deps.signal.addEventListener("abort", stop, { once: true });
  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram started: event="${TELEGRAM_MESSAGE_EVENT}"`,
  );

  return {
    stop,
  };
}

export const telegramSourceModule: SourceModule<TelegramSourceConfig> = {
  type: "telegram",
  start: startTelegramSource,
};
