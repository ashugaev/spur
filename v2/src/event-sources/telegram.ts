import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import {
  deleteTelegramReplyTarget,
  readTelegramBindings,
  readTelegramReplyTarget,
  writeTelegramBindings,
  writeTelegramReplyTarget,
} from "../metadata.js";
import {
  TELEGRAM_MESSAGE_EVENT,
  type TelegramBinding,
  type TelegramMessageEventData,
  type TelegramSourceConfig,
} from "../types.js";
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

interface TelegramRuntime {
  deps: SourceStartDeps<TelegramSourceConfig>;
  bindings: Map<string, TelegramBinding>;
  persistBindings(): Promise<void>;
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
      kind: "invalid_watch";
    }
  | {
      kind: "unwatch";
    };

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  const watch = trimmed.match(/^\/watch(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/);
  if (watch) {
    const args = watch[1]?.trim();
    if (!args) return { kind: "watch_menu" };
    const parts = args.split(/\s+/);
    const sessionId = parts[0];
    return parts.length === 1 && sessionId
      ? { kind: "watch", sessionId }
      : { kind: "invalid_watch" };
  }
  if (/^\/unwatch(?:@[a-zA-Z0-9_]+)?\s*$/.test(trimmed)) {
    return { kind: "unwatch" };
  }
  return null;
}

function telegramBindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

function isAllowed(
  config: TelegramSourceConfig,
  chatId: number,
  from?: { id: number; username?: string },
): boolean {
  if (!from) return false;
  const allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;
  const allowedChats = config.allowedChats ? new Set(config.allowedChats) : null;
  if (!allowedUsers?.has(from.id)) return false;
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

async function projectSessions(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceSessionListItem[]> {
  const sessions = deps.listSessions ? await deps.listSessions() : [];
  return sessions.filter((session) => session.project === deps.projectId);
}

async function findProjectSession(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
): Promise<SourceSessionListItem | null> {
  return (await projectSessions(deps)).find((entry) => entry.id === sessionId) ?? null;
}

function sessionLabel(session: SourceSessionListItem): string {
  const label = `${session.id} ${session.agent} ${session.state}`;
  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

async function sendWatchMenu(ctx: TelegramTextContext, runtime: TelegramRuntime): Promise<void> {
  const sessions = await projectSessions(runtime.deps);
  if (sessions.length === 0) {
    await ctx.reply("No active Spur sessions for this project.");
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

async function bindTelegramThread(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  sessionId: string,
): Promise<void> {
  const deps = runtime.deps;
  runtime.bindings.set(telegramBindingKey(chatId, messageThreadId), {
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    sessionId,
  });
  await runtime.persistBindings();
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
  runtime: TelegramRuntime,
): Promise<void> {
  const query = ctx.callbackQuery;
  const data = query?.data;
  const message = query?.message;
  const deps = runtime.deps;
  if (!data?.startsWith(WATCH_CALLBACK_PREFIX) || !message) return;
  if (!isAllowed(deps.config, message.chat.id, query.from)) return;

  const sessionId = data.slice(WATCH_CALLBACK_PREFIX.length);
  const session = await findProjectSession(deps, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery("Session is no longer active.");
    return;
  }

  await bindTelegramThread(runtime, message.chat.id, message.message_thread_id, sessionId);
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
  runtime: TelegramRuntime,
): Promise<void> {
  const message = ctx.message;
  const deps = runtime.deps;
  if (!message?.text || !message.text.trim()) return;
  if (!isAllowed(deps.config, message.chat.id, message.from)) return;

  const key = telegramBindingKey(message.chat.id, message.message_thread_id);
  const command = parseTelegramCommand(message.text);
  if (command?.kind === "watch") {
    const session = await findProjectSession(deps, command.sessionId);
    if (!session) {
      await ctx.reply(`No active Spur session ${command.sessionId} for this project.`);
      return;
    }
    await bindTelegramThread(
      runtime,
      message.chat.id,
      message.message_thread_id,
      command.sessionId,
    );
    await ctx.reply(`Bound this Telegram thread to Spur session ${command.sessionId}.`);
    return;
  }
  if (command?.kind === "watch_menu") {
    await sendWatchMenu(ctx, runtime);
    return;
  }
  if (command?.kind === "invalid_watch") {
    await ctx.reply("Usage: /watch <sessionId>");
    return;
  }
  if (command?.kind === "unwatch") {
    const binding = runtime.bindings.get(key);
    const deleted = runtime.bindings.delete(key);
    await runtime.persistBindings();
    const target = binding ? readTelegramReplyTarget(deps.dataDir, binding.sessionId) : null;
    if (
      binding &&
      target &&
      target.chatId === message.chat.id &&
      target.messageThreadId === message.message_thread_id
    ) {
      deleteTelegramReplyTarget(deps.dataDir, binding.sessionId);
    }
    await ctx.reply(deleted ? "Unbound this Telegram thread." : "No Spur session bound here.");
    return;
  }
  if (message.text.trim().startsWith("/")) return;

  const binding = runtime.bindings.get(key);
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

function logRunnerError(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram runner failed: ${message}`,
  );
}

async function startTelegramSource(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceHandle> {
  const bindings = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId);
  let writeQueue = Promise.resolve();
  const runtime: TelegramRuntime = {
    deps,
    bindings,
    persistBindings(): Promise<void> {
      const snapshot = [...bindings.values()];
      const next = writeQueue.then(() =>
        writeTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId, snapshot),
      );
      writeQueue = next.catch(() => undefined);
      return next;
    },
  };

  const bot = new Bot(deps.config.token);
  bot.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram update failed: ${message}`,
    );
  });
  bot.on("message:text", async (ctx: Context) => {
    await handleTelegramText(ctx as TelegramTextContext, runtime);
  });
  bot.on("callback_query:data", async (ctx: Context) => {
    await handleTelegramCallback(ctx as TelegramCallbackContext, runtime);
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
  handle.task()?.catch((error: unknown) => {
    logRunnerError(deps, error);
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void handle.stop().catch((error: unknown) => {
      logRunnerError(deps, error);
    });
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
