import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import {
  TELEGRAM_MESSAGE_EVENT,
  type TelegramMessageEventData,
  type TelegramSourceConfig,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

interface TelegramBinding {
  chatId: number;
  messageThreadId?: number;
  sessionId: string;
}

interface TelegramBindingsFile {
  bindings: TelegramBinding[];
}

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
  reply(text: string): Promise<unknown>;
}

type TelegramCommand =
  | {
      kind: "watch";
      sessionId: string;
    }
  | {
      kind: "unwatch";
    }
  | {
      kind: "invalid_watch";
    };

function bindingFilePath(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "telegram", projectId, `${sourceId}.json`);
}

function bindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

function readBindings(path: string): Map<string, TelegramBinding> {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TelegramBindingsFile;
    if (!Array.isArray(parsed.bindings)) return new Map();
    const bindings = parsed.bindings.filter(
      (entry): entry is TelegramBinding =>
        typeof entry.chatId === "number" &&
        Number.isInteger(entry.chatId) &&
        (entry.messageThreadId === undefined ||
          (typeof entry.messageThreadId === "number" && Number.isInteger(entry.messageThreadId))) &&
        typeof entry.sessionId === "string" &&
        entry.sessionId.trim().length > 0,
    );
    return new Map(
      bindings.map((entry) => [bindingKey(entry.chatId, entry.messageThreadId), entry]),
    );
  } catch {
    return new Map();
  }
}

function writeBindings(path: string, bindings: Map<string, TelegramBinding>): void {
  mkdirSync(dirname(path), { recursive: true });
  const value: TelegramBindingsFile = {
    bindings: [...bindings.values()].sort((left, right) => {
      const chatOrder = left.chatId - right.chatId;
      if (chatOrder !== 0) return chatOrder;
      return (left.messageThreadId ?? 0) - (right.messageThreadId ?? 0);
    }),
  };
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  const watch = trimmed.match(/^\/watch(?:@[a-zA-Z0-9_]+)?(?:\s+(\S+))?\s*$/);
  if (watch) {
    const sessionId = watch[1]?.trim();
    return sessionId ? { kind: "watch", sessionId } : { kind: "invalid_watch" };
  }
  if (/^\/unwatch(?:@[a-zA-Z0-9_]+)?\s*$/.test(trimmed)) {
    return { kind: "unwatch" };
  }
  return null;
}

function isAllowed(config: TelegramSourceConfig, message: TelegramTextMessage): boolean {
  const allowedUsers = config.allowedUsers ? new Set(config.allowedUsers) : null;
  const allowedChats = config.allowedChats ? new Set(config.allowedChats) : null;
  if (allowedUsers && (!message.from || !allowedUsers.has(message.from.id))) return false;
  if (allowedChats && !allowedChats.has(message.chat.id)) return false;
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

async function handleTelegramText(
  ctx: TelegramTextContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<void> {
  const message = ctx.message;
  if (!message?.text || !message.text.trim()) return;
  if (!isAllowed(deps.config, message)) return;

  const path = bindingFilePath(deps.dataDir, deps.projectId, deps.sourceId);
  const key = bindingKey(message.chat.id, message.message_thread_id);
  const command = parseTelegramCommand(message.text);
  if (command?.kind === "watch") {
    const bindings = readBindings(path);
    bindings.set(key, {
      chatId: message.chat.id,
      ...(message.message_thread_id !== undefined
        ? { messageThreadId: message.message_thread_id }
        : {}),
      sessionId: command.sessionId,
    });
    writeBindings(path, bindings);
    await ctx.reply(`Bound this Telegram thread to Spur session ${command.sessionId}.`);
    return;
  }
  if (command?.kind === "invalid_watch") {
    await ctx.reply("Usage: /watch <sessionId>");
    return;
  }
  if (command?.kind === "unwatch") {
    const bindings = readBindings(path);
    const deleted = bindings.delete(key);
    writeBindings(path, bindings);
    await ctx.reply(deleted ? "Unbound this Telegram thread." : "No Spur session bound here.");
    return;
  }
  if (message.text.trim().startsWith("/")) return;

  const binding = readBindings(path).get(key);
  if (!binding) return;
  deps.emit(TELEGRAM_MESSAGE_EVENT, eventData(message, binding.sessionId));
}

async function startTelegramSource(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceHandle> {
  const bot = new Bot(deps.config.token);
  bot.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram update failed: ${message}`,
    );
  });
  bot.on("message:text", async (ctx: Context) => {
    await handleTelegramText(ctx as TelegramTextContext, deps);
  });

  let stopped = false;
  const handle: RunnerHandle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message"],
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
