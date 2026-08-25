import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import { logSpurEvent } from "../event-log.js";
import {
  deleteTelegramReplyTarget,
  readTelegramBindings,
  readTelegramLastUpdateId,
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
import { telegramStatusEmoji } from "../telegram-status-emoji.js";

const WATCH_CALLBACK_PREFIX = "spur_watch:";
const SPAWN_CALLBACK_PREFIX = "spur_spawn:";
const PROJECT_CALLBACK_PREFIX = "spur_project:";
const PROJECTS_MENU_CALLBACK = "spur_projects";
const PENDING_SPAWN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SPAWNS = 100;

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
  voice?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
}

interface TelegramTextContext {
  update?: {
    update_id?: number;
  };
  message?: TelegramTextMessage;
  reply(text: string, options?: unknown): Promise<TelegramSentMessage | undefined>;
  api?: {
    editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
  };
  getFile?(signal?: AbortSignal): Promise<{ file_path?: string }>;
}

interface TelegramSentMessage {
  message_id?: number;
}

interface TelegramCallbackContext {
  update?: {
    update_id?: number;
  };
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
  lastUpdateId?: number;
  botUsername?: string;
  pendingSpawns: Map<string, TelegramPendingSpawn>;
  persistBindings(options?: { removeKeys?: string[] }): Promise<void>;
  drainWrites(): Promise<void>;
}

type TelegramAgentName = "claude" | "codex" | "cursor" | "opencode";

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

export function parseTelegramCommand(text: string, botUsername?: string): TelegramCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const [, command, mention, rest] = match;
  if (!command) return null;
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }
  const args = rest?.trim();
  switch (command) {
    case "start":
    case "help":
      return { kind: "help" };
    case "agents":
      return { kind: "agents" };
    case "watch": {
      if (!args) return { kind: "watch_menu" };
      const parts = args.split(/\s+/);
      const sessionId = parts[0];
      return parts.length === 1 && sessionId
        ? { kind: "watch", sessionId }
        : { kind: "invalid_watch" };
    }
    case "unwatch":
      return { kind: "unwatch" };
    case "spawn": {
      if (!args) return { kind: "spawn_menu" };
      const [agent, ...promptParts] = args.split(/\s+/);
      if (agent && isTelegramAgentName(agent)) {
        const prompt = promptParts.join(" ").trim();
        return prompt ? { kind: "spawn", agent, prompt } : { kind: "spawn", agent };
      }
      return null;
    }
    default:
      return null;
  }
}

function telegramBindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

function mergePersistedBindings(
  runtime: TelegramRuntime,
  removeKeys: Set<string> = new Set(),
): void {
  const persisted = readTelegramBindings(
    runtime.deps.dataDir,
    runtime.deps.projectId,
    runtime.deps.sourceId,
  );
  for (const [key, binding] of persisted) {
    if (!removeKeys.has(key) && !runtime.bindings.has(key)) {
      runtime.bindings.set(key, binding);
    }
  }
}

async function rememberUpdate(
  runtime: TelegramRuntime,
  update?: { update_id?: number },
): Promise<boolean> {
  const updateId = update?.update_id;
  if (typeof updateId !== "number" || !Number.isInteger(updateId)) return true;
  if (runtime.lastUpdateId !== undefined && updateId <= runtime.lastUpdateId) return false;
  runtime.lastUpdateId = updateId;
  try {
    await runtime.persistBindings();
  } catch (error) {
    logPersistError(runtime.deps, error);
  }
  return true;
}

function logPersistError(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): void {
  const message = errorText(error);
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram state persist failed: ${message}`,
  );
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

function prunePendingSpawns(runtime: TelegramRuntime): void {
  const now = Date.now();
  for (const [key, pending] of runtime.pendingSpawns) {
    if (pending.expiresAt < now) {
      runtime.pendingSpawns.delete(key);
    }
  }
  while (runtime.pendingSpawns.size >= MAX_PENDING_SPAWNS) {
    const oldestKey = runtime.pendingSpawns.keys().next().value;
    if (typeof oldestKey !== "string") return;
    runtime.pendingSpawns.delete(oldestKey);
  }
}

function takePendingSpawn(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): TelegramPendingSpawn | "expired" | null {
  const key = telegramPendingSpawnKey(chatId, messageThreadId, userId);
  const pending = runtime.pendingSpawns.get(key);
  if (!pending) {
    prunePendingSpawns(runtime);
    return null;
  }
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

function eventData(
  message: TelegramTextMessage,
  sessionId: string,
  text: string,
): TelegramMessageEventData {
  if (!message.from) {
    throw new Error("Telegram message must include a user");
  }
  return {
    sessionId,
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined
      ? { messageThreadId: message.message_thread_id }
      : {}),
    userId: message.from.id,
    ...(message.from.username ? { username: message.from.username } : {}),
    messageId: message.message_id,
    text,
  };
}

async function allSessions(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceSessionListItem[]> {
  return deps.listSessions ? deps.listSessions() : [];
}

async function findSession(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
): Promise<SourceSessionListItem | null> {
  return (await allSessions(deps)).find((entry) => entry.id === sessionId) ?? null;
}

function sessionLabel(session: SourceSessionListItem): string {
  const emoji = telegramStatusEmoji(session.state);
  const title = session.title?.trim();
  const label = title
    ? `${emoji} ${session.id} ${session.state} — ${title}`
    : `${emoji} ${session.id} ${session.agent} ${session.state}`;
  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

function groupSessionsByProject(
  sessions: SourceSessionListItem[],
): Map<string, SourceSessionListItem[]> {
  const grouped = new Map<string, SourceSessionListItem[]>();
  for (const session of sessions) {
    const list = grouped.get(session.project) ?? [];
    list.push(session);
    grouped.set(session.project, list);
  }
  return grouped;
}

function buildProjectMenuKeyboard(
  grouped: Map<string, SourceSessionListItem[]>,
): { text: string; callback_data: string }[][] {
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectId, projectSessions]) => [
      {
        text: `${projectId} (${projectSessions.length})`,
        callback_data: `${PROJECT_CALLBACK_PREFIX}${projectId}`,
      },
    ]);
}

function buildSessionMenuKeyboard(
  sessions: SourceSessionListItem[],
): { text: string; callback_data: string }[][] {
  const rows = sessions
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((session) => [
      {
        text: sessionLabel(session),
        callback_data: `${WATCH_CALLBACK_PREFIX}${session.id}`,
      },
    ]);
  rows.push([
    {
      text: "« Back to projects",
      callback_data: PROJECTS_MENU_CALLBACK,
    },
  ]);
  return rows;
}

function isTelegramAgentName(value: string): value is TelegramAgentName {
  return value === "claude" || value === "codex" || value === "cursor" || value === "opencode";
}

async function sendWatchMenu(ctx: TelegramTextContext, runtime: TelegramRuntime): Promise<void> {
  const sessions = await allSessions(runtime.deps);
  if (sessions.length === 0) {
    await ctx.reply("No active Spur sessions.");
    return;
  }
  const grouped = groupSessionsByProject(sessions);
  await ctx.reply("Select a project:", {
    reply_markup: {
      inline_keyboard: buildProjectMenuKeyboard(grouped),
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
          { text: "opencode", callback_data: `${SPAWN_CALLBACK_PREFIX}opencode` },
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
  prunePendingSpawns(runtime);
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

export function wrapTelegramSpawnPrompt(taskText: string): string {
  return [
    taskText,
    "",
    "Source: telegram. The requester only sees messages you send with:",
    'spur source reply "<message>"',
    "Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.",
  ].join("\n");
}

async function editOrReply(
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  chatId: number,
  statusMessageId: number | undefined,
  text: string,
): Promise<void> {
  if (statusMessageId !== undefined && ctx.api) {
    try {
      await ctx.api.editMessageText(chatId, statusMessageId, text);
      return;
    } catch {
      // fall through to reply
    }
  }
  await ctx.reply(text);
}

async function bindSpawnedSession(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  chatId: number,
  messageThreadId: number | undefined,
  request: Omit<SourceSpawnSessionRequest, "project">,
): Promise<void> {
  const deps = runtime.deps;
  const status = await ctx.reply(`Spawning ${request.agent} agent...`);
  const statusMessageId = extractMessageId(status);
  try {
    const session = await spawnTelegramSession(runtime, {
      ...request,
      prompt: wrapTelegramSpawnPrompt(request.prompt ?? ""),
    });
    if (!session) {
      await editOrReply(
        ctx,
        chatId,
        statusMessageId,
        "Spur spawn is not available for this Telegram source.",
      );
      return;
    }
    await bindTelegramThread(runtime, chatId, messageThreadId, session.id);
    await editOrReply(ctx, chatId, statusMessageId, `Spawned and bound: ${session.id}.`);
  } catch (error) {
    await editOrReply(
      ctx,
      chatId,
      statusMessageId,
      `Spawn failed: ${redactedErrorText(deps, error)}`,
    );
  }
}

async function bindTelegramThread(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  sessionId: string,
): Promise<void> {
  const deps = runtime.deps;
  const key = telegramBindingKey(chatId, messageThreadId);
  const previous = runtime.bindings.get(key);
  runtime.bindings.set(telegramBindingKey(chatId, messageThreadId), {
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    sessionId,
  });
  try {
    await runtime.persistBindings();
  } catch (error) {
    if (previous) {
      runtime.bindings.set(key, previous);
    } else {
      runtime.bindings.delete(key);
    }
    logPersistError(deps, error);
    throw error;
  }
  writeTelegramReplyTarget(deps.dataDir, {
    sessionId,
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    lastInboundAt: new Date().toISOString(),
  });
}

async function unbindTelegramThread(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
): Promise<{ deleted: boolean; binding: TelegramBinding | undefined }> {
  const deps = runtime.deps;
  const key = telegramBindingKey(chatId, messageThreadId);
  const binding = runtime.bindings.get(key);
  const deleted = runtime.bindings.delete(key);
  try {
    await runtime.persistBindings({ removeKeys: [key] });
  } catch (error) {
    if (binding) {
      runtime.bindings.set(key, binding);
    }
    logPersistError(deps, error);
    throw error;
  }
  const target = binding ? readTelegramReplyTarget(deps.dataDir, binding.sessionId) : null;
  if (binding && target && target.chatId === chatId && target.messageThreadId === messageThreadId) {
    deleteTelegramReplyTarget(deps.dataDir, binding.sessionId);
  }
  return { deleted, binding };
}

async function handleTelegramCallback(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
): Promise<void> {
  const query = ctx.callbackQuery;
  const data = query?.data;
  const message = query?.message;
  const deps = runtime.deps;
  if (!(await rememberUpdate(runtime, ctx.update))) return;
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

  if (data === PROJECTS_MENU_CALLBACK) {
    await ctx.answerCallbackQuery();
    const sessions = await allSessions(deps);
    if (sessions.length === 0) {
      if (ctx.editMessageText) {
        await ctx.editMessageText("No active Spur sessions.");
      } else {
        await ctx.reply?.("No active Spur sessions.");
      }
      return;
    }
    const grouped = groupSessionsByProject(sessions);
    const text = "Select a project:";
    const replyMarkup = { inline_keyboard: buildProjectMenuKeyboard(grouped) };
    if (ctx.editMessageText) {
      await ctx.editMessageText(text, { reply_markup: replyMarkup });
    } else {
      await ctx.reply?.(text, { reply_markup: replyMarkup });
    }
    return;
  }

  if (data.startsWith(PROJECT_CALLBACK_PREFIX)) {
    const projectId = data.slice(PROJECT_CALLBACK_PREFIX.length);
    const all = await allSessions(deps);
    const sessions = all.filter((session) => session.project === projectId);
    if (sessions.length === 0) {
      await ctx.answerCallbackQuery("No active sessions in this project.");
      const text = `No active Spur sessions in project ${projectId}.`;
      const replyMarkup = {
        inline_keyboard: [[{ text: "« Back to projects", callback_data: PROJECTS_MENU_CALLBACK }]],
      };
      if (ctx.editMessageText) {
        await ctx.editMessageText(text, { reply_markup: replyMarkup });
      } else {
        await ctx.reply?.(text, { reply_markup: replyMarkup });
      }
      return;
    }
    await ctx.answerCallbackQuery();
    const text = `Select a Spur session in ${projectId}:`;
    const replyMarkup = { inline_keyboard: buildSessionMenuKeyboard(sessions) };
    if (ctx.editMessageText) {
      await ctx.editMessageText(text, { reply_markup: replyMarkup });
    } else {
      await ctx.reply?.(text, { reply_markup: replyMarkup });
    }
    return;
  }

  if (!data.startsWith(WATCH_CALLBACK_PREFIX)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const sessionId = data.slice(WATCH_CALLBACK_PREFIX.length);
  const session = await findSession(deps, sessionId);
  if (!session) {
    await ctx.answerCallbackQuery("Session is no longer active.");
    return;
  }
  if (sessionBindingConflict(runtime, message.chat.id, message.message_thread_id, sessionId)) {
    await ctx.answerCallbackQuery("Session is already bound elsewhere.");
    return;
  }

  clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
  try {
    await bindTelegramThread(runtime, message.chat.id, message.message_thread_id, sessionId);
  } catch (error) {
    await ctx.answerCallbackQuery("Bind failed.");
    const failureMessage = `Failed to bind Spur session ${sessionId}: ${redactedErrorText(deps, error)}`;
    if (ctx.editMessageText) {
      await ctx.editMessageText(failureMessage);
    } else {
      await ctx.reply?.(failureMessage);
    }
    return;
  }
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
  if (!(await rememberUpdate(runtime, ctx.update))) return;
  if (!message?.text || !message.text.trim()) return;
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  const command = parseTelegramCommand(message.text, runtime.botUsername);
  if (command?.kind === "help") {
    await sendHelp(ctx);
    return;
  }
  if (command?.kind === "watch") {
    const session = await findSession(deps, command.sessionId);
    if (!session) {
      await ctx.reply(`No active Spur session ${command.sessionId}.`);
      return;
    }
    if (
      sessionBindingConflict(runtime, message.chat.id, message.message_thread_id, command.sessionId)
    ) {
      await ctx.reply(`Spur session ${command.sessionId} is already bound elsewhere.`);
      return;
    }
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    try {
      await bindTelegramThread(
        runtime,
        message.chat.id,
        message.message_thread_id,
        command.sessionId,
      );
    } catch (error) {
      await ctx.reply(
        `Failed to bind Spur session ${command.sessionId}: ${redactedErrorText(deps, error)}`,
      );
      return;
    }
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
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    const { deleted } = await unbindTelegramThread(
      runtime,
      message.chat.id,
      message.message_thread_id,
    );
    await ctx.reply(deleted ? "Unbound this Telegram thread." : "No Spur session bound here.");
    return;
  }
  if (message.text.trim().startsWith("/")) {
    if (message.chat.id > 0) {
      await ctx.reply("Unknown command. Use /help.");
    }
    return;
  }

  await routeTelegramPrompt(runtime, ctx, message, from, message.text.trim());
}

/**
 * Binds a plain-text prompt (typed text, or a transcribed voice note) to the
 * agent: a pending `/spawn` claims it as the spawn prompt, otherwise it goes
 * to the chat's bound session. `from` is non-optional and `key` is
 * recomputed from `message` so this is safe to call from any handler that
 * has already run `isAllowed`/`rememberUpdate` itself — command parsing and
 * the `/` reject stay in `handleTelegramText` only, so a transcript starting
 * with `/` is never treated as a command.
 */
async function routeTelegramPrompt(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  message: TelegramTextMessage,
  from: { id: number; username?: string },
  text: string,
): Promise<void> {
  const deps = runtime.deps;
  const key = telegramBindingKey(message.chat.id, message.message_thread_id);

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
      prompt: text,
    });
    return;
  }

  let binding = runtime.bindings.get(key);
  if (!binding) {
    mergePersistedBindings(runtime);
    binding = runtime.bindings.get(key);
  }
  if (!binding) {
    await ctx.reply("No Spur session bound here. Use /watch or /spawn.");
    return;
  }
  const session = await findSession(deps, binding.sessionId);
  if (!session) {
    await unbindTelegramThread(runtime, message.chat.id, message.message_thread_id);
    await ctx.reply(`Spur session ${binding.sessionId} is gone. Unbound. Use /watch or /spawn.`);
    return;
  }
  let statusMessageId: number | undefined;
  try {
    statusMessageId = extractMessageId(await ctx.reply("Sent to Spur agent."));
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram ack failed: ${errorText(error)}`,
    );
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
    lastInboundAt: new Date().toISOString(),
  });
  deps.emit(TELEGRAM_MESSAGE_EVENT, eventData(message, binding.sessionId, text));
}

function logRunnerError(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): void {
  const message = redactedErrorText(deps, error);
  if (message.toLowerCase().includes("terminated by other getupdates request")) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram polling conflict (409): another process or host is polling this bot token; stop the other poller`,
    );
    return;
  }
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram runner failed: ${message}`,
  );
}

function logSetupError(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): void {
  const message = redactedErrorText(deps, error);
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram commands setup failed: ${message}`,
  );
}

function redactTelegramToken(deps: SourceStartDeps<TelegramSourceConfig>, message: string): string {
  return message.split(deps.config.token).join("<telegram-token>");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactedErrorText(deps: SourceStartDeps<TelegramSourceConfig>, error: unknown): string {
  return redactTelegramToken(deps, errorText(error));
}

function extractMessageId(message: TelegramSentMessage | undefined): number | undefined {
  return message && typeof message.message_id === "number" ? message.message_id : undefined;
}

// `deps.signal.aborted` can flip to `true` while a preceding `await` in this
// module is in flight; routed through a function call so TypeScript's
// control-flow analysis never narrows it to a stale literal across an
// `await` (it otherwise trips `no-unnecessary-condition` on a later check).
function isAborted(deps: SourceStartDeps<TelegramSourceConfig>): boolean {
  return deps.signal.aborted;
}

// ffmpeg + whisper_cpp can run to ~4 minutes on a slow host
// (packages/web/src/lib/voice.ts:951-963); this bounds the detached task so
// a stuck transcription cannot hold a voice note open indefinitely.
const VOICE_TRANSCRIBE_TIMEOUT_MS = 300_000;

/**
 * Downloads the voice note referenced by `ctx.getFile()` and posts it to the
 * web UI's transcribe route. Throws on any failure; the caller decides how
 * to surface it. Voice notes are always OGG/Opus, so the fixed `voice.ogg`
 * filename picks the right decoder (packages/web/src/lib/voice.ts:937/1015
 * take the extension from the filename).
 */
async function transcribeTelegramVoice(
  ctx: Pick<TelegramTextContext, "getFile">,
  deps: SourceStartDeps<TelegramSourceConfig>,
  webBaseUrl: string,
): Promise<string> {
  if (!ctx.getFile) {
    throw new Error("Telegram file API unavailable");
  }
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(VOICE_TRANSCRIBE_TIMEOUT_MS)]);
  const file = await ctx.getFile(signal);
  if (!file.file_path) {
    throw new Error("Telegram returned no file path for this voice note");
  }
  const fileUrl = `https://api.telegram.org/file/bot${deps.config.token}/${file.file_path}`;
  const fileResponse = await fetch(fileUrl, { signal });
  if (!fileResponse.ok) {
    throw new Error(`Telegram file download failed with status ${fileResponse.status}`);
  }
  const audioBuffer = await fileResponse.arrayBuffer();

  const form = new FormData();
  form.set("audio", new File([audioBuffer], "voice.ogg", { type: "audio/ogg" }));
  const transcribeResponse = await fetch(`${webBaseUrl}/api/runtime/voice/transcribe`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!transcribeResponse.ok) {
    throw new Error(`Voice transcription request failed with status ${transcribeResponse.status}`);
  }
  const payload: unknown = await transcribeResponse.json();
  const text =
    payload && typeof payload === "object" ? (payload as { text?: unknown }).text : undefined;
  if (typeof text !== "string") {
    throw new Error("Voice transcription response did not include text");
  }
  return text;
}

/**
 * The detached task behind a voice update: transcribes, echoes the
 * transcript back to the chat, then routes it exactly like typed text. Never
 * awaited by the sink handler — see `handleTelegramVoice`. Every step after
 * an `await` re-checks `deps.signal.aborted` so a source `stop()` mid-flight
 * degrades to silence rather than a stale reply or a spawn after shutdown.
 */
async function transcribeAndRoute(
  runtime: TelegramRuntime,
  ctx: TelegramTextContext,
  message: TelegramTextMessage,
  from: { id: number; username?: string },
  statusMessageId: number | undefined,
): Promise<void> {
  const deps = runtime.deps;
  const webBaseUrl = await deps.resolveWebBaseUrl();
  if (isAborted(deps)) return;
  if (webBaseUrl === null) {
    await editOrReply(
      ctx,
      message.chat.id,
      statusMessageId,
      "Voice transcription is disabled for this Spur instance.",
    );
    return;
  }

  let transcript: string;
  try {
    transcript = await transcribeTelegramVoice(ctx, deps, webBaseUrl);
  } catch (error) {
    if (isAborted(deps)) {
      // An abort-cancelled fetch must not reply during shutdown, but the
      // failure still gets logged so it isn't silent in the daemon's own log.
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] telegram voice failed: ${redactedErrorText(deps, error)}`,
      );
    } else {
      await editOrReply(
        ctx,
        message.chat.id,
        statusMessageId,
        `Voice transcription failed: ${redactedErrorText(deps, error)}`,
      );
    }
    return;
  }
  if (isAborted(deps)) return;

  const trimmed = transcript.trim();
  if (!trimmed) {
    await editOrReply(
      ctx,
      message.chat.id,
      statusMessageId,
      "Could not transcribe voice message (empty transcript).",
    );
    return;
  }

  await editOrReply(ctx, message.chat.id, statusMessageId, `Heard: "${trimmed}"`);
  if (isAborted(deps)) return;

  await routeTelegramPrompt(runtime, ctx, message, from, trimmed);
}

/**
 * Sink handler for `message:voice`. Does only cheap, ordered work —
 * `rememberUpdate`, allow-check, one ack reply — then detaches the
 * transcribe-and-route task and returns, so `sink.concurrency: 1` never
 * blocks the source on a multi-minute transcription.
 */
async function handleTelegramVoice(
  ctx: TelegramTextContext,
  runtime: TelegramRuntime,
): Promise<void> {
  const deps = runtime.deps;
  if (!(await rememberUpdate(runtime, ctx.update))) return;
  const message = ctx.message;
  if (!message?.voice) return;
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  let statusMessageId: number | undefined;
  try {
    statusMessageId = extractMessageId(await ctx.reply("Transcribing voice message..."));
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram voice ack failed: ${errorText(error)}`,
    );
  }

  void transcribeAndRoute(runtime, ctx, message, from, statusMessageId).catch((error: unknown) => {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram voice failed: ${redactedErrorText(deps, error)}`,
    );
  });
}

async function startTelegramSource(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceHandle> {
  const bindings = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId);
  const lastUpdateId = readTelegramLastUpdateId(deps.dataDir, deps.projectId, deps.sourceId);
  let writeQueue = Promise.resolve();
  const runtime: TelegramRuntime = {
    deps,
    bindings,
    ...(lastUpdateId !== undefined ? { lastUpdateId } : {}),
    pendingSpawns: new Map(),
    persistBindings(options: { removeKeys?: string[] } = {}): Promise<void> {
      const removedKeys = new Set(options.removeKeys ?? []);
      const next = writeQueue.then(() =>
        writeTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId, bindings.values(), {
          ...(runtime.lastUpdateId !== undefined ? { lastUpdateId: runtime.lastUpdateId } : {}),
          preserveExisting: true,
          ...(removedKeys.size > 0 ? { removeKeys: removedKeys } : {}),
        }),
      );
      writeQueue = next.catch((error: unknown) => {
        logPersistError(deps, error);
      });
      return next;
    },
    drainWrites(): Promise<void> {
      return writeQueue;
    },
  };

  const bot = new Bot(deps.config.token);
  try {
    const me = await bot.api.getMe();
    runtime.botUsername = me.username;
  } catch (error) {
    logSetupError(deps, error);
    logSpurEvent(deps.dataDir, {
      event: "source.telegram.auth_failed",
      level: "error",
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      message: `Telegram getMe failed for ${deps.projectId}/${deps.sourceId}: ${redactedErrorText(deps, error)}`,
    });
  }
  bot.api
    .setMyCommands(TELEGRAM_COMMANDS)
    .then(() => bot.api.setChatMenuButton({ menu_button: { type: "commands" } }))
    .catch((error: unknown) => logSetupError(deps, error));
  bot.catch((error: unknown) => {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram update failed: ${redactedErrorText(deps, error)}`,
    );
  });
  bot.on("message:text", async (ctx: Context) => {
    await handleTelegramText(ctx as TelegramTextContext, runtime);
  });
  bot.on("message:voice", async (ctx: Context) => {
    await handleTelegramVoice(ctx as TelegramTextContext, runtime);
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
      concurrency: 1,
    },
  });
  handle.task()?.catch((error: unknown) => {
    logRunnerError(deps, error);
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const stopTask = handle.stop() as Promise<void> | undefined;
    try {
      await stopTask;
    } catch (error) {
      logRunnerError(deps, error);
    }
    try {
      await runtime.drainWrites();
    } catch (error) {
      logPersistError(deps, error);
    }
  };
  deps.signal.addEventListener(
    "abort",
    () => {
      void stop();
    },
    { once: true },
  );
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
