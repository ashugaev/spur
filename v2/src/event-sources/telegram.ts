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
  SourceSpawnSessionRequest,
  SourceSessionListItem,
  SourceStartDeps,
} from "./types.js";

const WATCH_CALLBACK_PREFIX = "spur_watch:";
const SPAWN_CALLBACK_PREFIX = "spur_spawn:";
const PENDING_SPAWN_TTL_MS = 10 * 60_000;

const TELEGRAM_COMMANDS = [
  { command: "start", description: "Show Spur bot help" },
  { command: "help", description: "Show Spur bot help" },
  { command: "agents", description: "List active Spur agents" },
  { command: "watch", description: "Bind this chat to a Spur agent" },
  { command: "spawn", description: "Spawn a new Spur agent" },
  { command: "unwatch", description: "Unbind this chat" },
] as const;

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
  reply(text: string, options?: unknown): Promise<TelegramSentMessage | undefined>;
}

interface TelegramSentMessage {
  message_id?: number;
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
  pendingSpawns: Map<string, TelegramPendingSpawn>;
  persistBindings(): Promise<void>;
}

type TelegramAgentName = "claude" | "codex" | "cursor";

interface TelegramPendingSpawn {
  agent: TelegramAgentName;
  expiresAt: number;
}

type TelegramCommand =
  | {
      kind: "help";
    }
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
    }
  | {
      kind: "agents";
    }
  | {
      kind: "spawn_menu";
    }
  | {
      kind: "spawn";
      agent: TelegramAgentName;
      prompt?: string;
    };

export function parseTelegramCommand(text: string): TelegramCommand | null {
  const trimmed = text.trim();
  if (/^\/(?:start|help)(?:@[a-zA-Z0-9_]+)?\s*$/.test(trimmed)) {
    return { kind: "help" };
  }
  if (/^\/agents(?:@[a-zA-Z0-9_]+)?\s*$/.test(trimmed)) {
    return { kind: "agents" };
  }
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
  const spawn = trimmed.match(/^\/spawn(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/);
  if (spawn) {
    const args = spawn[1]?.trim();
    if (!args) return { kind: "spawn_menu" };
    const [agent, ...promptParts] = args.split(/\s+/);
    if (agent && isTelegramAgentName(agent)) {
      const prompt = promptParts.join(" ").trim();
      return prompt ? { kind: "spawn", agent, prompt } : { kind: "spawn", agent };
    }
    return null;
  }
  return null;
}

function telegramBindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

function isSameTelegramTarget(
  binding: Pick<TelegramBinding, "chatId" | "messageThreadId">,
  chatId: number,
  messageThreadId?: number,
): boolean {
  return binding.chatId === chatId && binding.messageThreadId === messageThreadId;
}

function sessionBindingConflict(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  sessionId: string,
): boolean {
  for (const binding of runtime.bindings.values()) {
    if (
      binding.sessionId === sessionId &&
      !isSameTelegramTarget(binding, chatId, messageThreadId)
    ) {
      return true;
    }
  }
  return false;
}

function telegramPendingSpawnKey(
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): string {
  return `${telegramBindingKey(chatId, messageThreadId)}:${userId}`;
}

function clearPendingSpawn(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): void {
  runtime.pendingSpawns.delete(telegramPendingSpawnKey(chatId, messageThreadId, userId));
}

function takePendingSpawn(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): TelegramPendingSpawn | "expired" | null {
  const key = telegramPendingSpawnKey(chatId, messageThreadId, userId);
  const pending = runtime.pendingSpawns.get(key);
  if (!pending) return null;
  runtime.pendingSpawns.delete(key);
  return pending.expiresAt >= Date.now() ? pending : "expired";
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

function isTelegramAgentName(value: string): value is TelegramAgentName {
  return value === "claude" || value === "codex" || value === "cursor";
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

async function sendHelp(ctx: TelegramTextContext): Promise<void> {
  await ctx.reply(
    [
      "Spur Telegram bot",
      "",
      "/agents - list active agents",
      "/watch - choose an agent for this chat",
      "/watch <sessionId> - bind directly",
      "/spawn - choose an agent, then send task",
      "/spawn <agent> <task> - create an agent with a task",
      "/unwatch - unbind this chat",
      "",
      "Plain text goes to the bound agent. Commands stay in Telegram.",
    ].join("\n"),
  );
}

async function sendSpawnMenu(ctx: TelegramTextContext): Promise<void> {
  await ctx.reply("Select an agent to spawn:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "codex", callback_data: `${SPAWN_CALLBACK_PREFIX}codex` },
          { text: "claude", callback_data: `${SPAWN_CALLBACK_PREFIX}claude` },
          { text: "cursor", callback_data: `${SPAWN_CALLBACK_PREFIX}cursor` },
        ],
      ],
    },
  });
}

async function requestSpawnPrompt(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply">,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
  agent: TelegramAgentName,
): Promise<void> {
  runtime.pendingSpawns.set(telegramPendingSpawnKey(chatId, messageThreadId, userId), {
    agent,
    expiresAt: Date.now() + PENDING_SPAWN_TTL_MS,
  });
  await ctx.reply(`Send task prompt for new ${agent} Spur agent.`);
}

async function spawnTelegramSession(
  runtime: TelegramRuntime,
  request: Omit<SourceSpawnSessionRequest, "project">,
): Promise<SourceSessionListItem | null> {
  if (!runtime.deps.spawnSession) return null;
  return runtime.deps.spawnSession({
    project: runtime.deps.projectId,
    ...request,
  });
}

async function bindSpawnedSession(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply">,
  chatId: number,
  messageThreadId: number | undefined,
  request: Omit<SourceSpawnSessionRequest, "project">,
): Promise<void> {
  const session = await spawnTelegramSession(runtime, request);
  if (!session) {
    await ctx.reply("Spur spawn is not available for this Telegram source.");
    return;
  }
  await bindTelegramThread(runtime, chatId, messageThreadId, session.id);
  await ctx.reply(`Spawned and bound this Telegram thread to Spur session ${session.id}.`);
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
  if (!data || !message) return;
  const from = query.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  if (data.startsWith(SPAWN_CALLBACK_PREFIX)) {
    const agent = data.slice(SPAWN_CALLBACK_PREFIX.length);
    if (!isTelegramAgentName(agent)) return;
    await ctx.answerCallbackQuery(`Selected ${agent}.`);
    await requestSpawnPrompt(
      runtime,
      {
        reply: async (text: string) => {
          await ctx.reply?.(text);
          return {};
        },
      },
      message.chat.id,
      message.message_thread_id,
      from.id,
      agent,
    );
    return;
  }

  if (!data.startsWith(WATCH_CALLBACK_PREFIX)) return;
  const sessionId = data.slice(WATCH_CALLBACK_PREFIX.length);
  const session = await findProjectSession(deps, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery("Session is no longer active.");
    return;
  }
  if (sessionBindingConflict(runtime, message.chat.id, message.message_thread_id, sessionId)) {
    await ctx.answerCallbackQuery("Session is already bound elsewhere.");
    return;
  }

  clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
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
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  const key = telegramBindingKey(message.chat.id, message.message_thread_id);
  const command = parseTelegramCommand(message.text);
  if (command?.kind === "help") {
    await sendHelp(ctx);
    return;
  }
  if (command?.kind === "watch") {
    const session = await findProjectSession(deps, command.sessionId);
    if (!session) {
      await ctx.reply(`No active Spur session ${command.sessionId} for this project.`);
      return;
    }
    if (
      sessionBindingConflict(
        runtime,
        message.chat.id,
        message.message_thread_id,
        command.sessionId,
      )
    ) {
      await ctx.reply(`Spur session ${command.sessionId} is already bound elsewhere.`);
      return;
    }
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
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
  if (command?.kind === "agents") {
    await sendWatchMenu(ctx, runtime);
    return;
  }
  if (command?.kind === "spawn_menu") {
    await sendSpawnMenu(ctx);
    return;
  }
  if (command?.kind === "spawn") {
    if (!command.prompt) {
      await requestSpawnPrompt(
        runtime,
        ctx,
        message.chat.id,
        message.message_thread_id,
        from.id,
        command.agent,
      );
      return;
    }
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    await bindSpawnedSession(runtime, ctx, message.chat.id, message.message_thread_id, {
      agent: command.agent,
      prompt: command.prompt,
    });
    return;
  }
  if (command?.kind === "invalid_watch") {
    await ctx.reply("Usage: /watch <sessionId>");
    return;
  }
  if (command?.kind === "unwatch") {
    const binding = runtime.bindings.get(key);
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
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
  if (message.text.trim().startsWith("/")) {
    await ctx.reply("Unknown command. Use /help.");
    return;
  }

  const pendingSpawn = takePendingSpawn(
    runtime,
    message.chat.id,
    message.message_thread_id,
    from.id,
  );
  if (pendingSpawn) {
    if (pendingSpawn === "expired") {
      await ctx.reply("Spawn prompt expired. Run /spawn again.");
      return;
    }
    await bindSpawnedSession(runtime, ctx, message.chat.id, message.message_thread_id, {
      agent: pendingSpawn.agent,
      prompt: message.text.trim(),
    });
    return;
  }

  const binding = runtime.bindings.get(key);
  if (!binding) {
    await ctx.reply("No Spur session bound here. Use /watch or /spawn.");
    return;
  }
  let statusMessageId: number | undefined;
  try {
    const status = await ctx.reply("Sent to Spur agent.");
    statusMessageId =
      status && typeof status.message_id === "number" ? status.message_id : undefined;
  } catch (error) {
    const warn = deps.logger.warn;
    if (warn) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      warn(`[source:${deps.projectId}/${deps.sourceId}] telegram ack failed: ${errorMessage}`);
    }
  }
  writeTelegramReplyTarget(deps.dataDir, {
    sessionId: binding.sessionId,
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId: message.chat.id,
    ...(statusMessageId !== undefined && message.chat.id > 0 ? { statusMessageId } : {}),
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

function logSetupError(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram commands setup failed: ${message}`,
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
    pendingSpawns: new Map(),
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
  bot.api
    .setMyCommands(TELEGRAM_COMMANDS)
    .then(() => bot.api.setChatMenuButton({ menu_button: { type: "commands" } }))
    .catch((error: unknown) => logSetupError(deps, error));
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
    const stopTask = handle.stop() as Promise<void> | undefined;
    void stopTask?.catch((error: unknown) => {
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
