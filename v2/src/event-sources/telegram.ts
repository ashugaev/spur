import { run, type RunnerHandle } from "@grammyjs/runner";
import { Bot, type Context } from "grammy";
import { logSpurEvent } from "../event-log.js";
import {
  readInterfaceConsent,
  writeInterfaceConsent,
  readSession,
  readTelegramBindings,
  readTelegramLastUpdateId,
  findTelegramChoice,
  findTelegramMessageSession,
  readTelegramReplyTarget,
  recordTelegramMessages,
  takeTelegramChoice,
  telegramBindingKey,
  writeTelegramBindings,
  writeTelegramReplyTarget,
} from "../metadata.js";
import {
  TELEGRAM_CHOICE_CALLBACK_PREFIX,
  TELEGRAM_MESSAGE_EVENT,
  MAX_ATTACHMENT_BYTES,
  type SendMessageAttachment,
  type TelegramAutoSpawnConfig,
  type TelegramBinding,
  type TelegramBotIdentity,
  type TelegramChoice,
  type TelegramMessageEventData,
  type TelegramSourceConfig,
  type TelegramConversation,
} from "../types.js";
import type {
  SourceHandle,
  SourceModule,
  SourceProjectListItem,
  SourceSpawnSessionRequest,
  SourceSessionListItem,
  SourceStartDeps,
} from "./types.js";
import { formatTelegramSessionLabel, telegramTopicIsDeleting } from "../telegram-source-state.js";
import { telegramStatusEmoji } from "../telegram-status-emoji.js";
import {
  ConsentRejectedError,
  consentPolicy,
  decideConsent,
  reconcileInterfaceConsent,
  repositoryOf,
  type ConsentRejectReason,
  type InterfaceConsent,
} from "../review-interface-consent.js";
import { workspaceIdOf } from "../session-desk.js";
import { readCurrentBranch } from "../workspace.js";
import {
  TelegramWorkbench,
  WORKBENCH_CALLBACK_PREFIX,
  renderLauncher,
  renderSettings,
  renderInbox,
  renderDetail,
  workbenchPage,
  type WorkbenchCard,
  type WorkbenchOwner,
  type WorkbenchView,
  type LaunchCard,
} from "./telegram-workbench.js";

const WATCH_CALLBACK_PREFIX = "spur_watch:";
const SPAWN_CALLBACK_PREFIX = "spur_spawn:";
const SPAWN_PROJECT_CALLBACK_PREFIX = "spur_sproj:";
const PROJECT_CALLBACK_PREFIX = "spur_project:";
const PROJECTS_MENU_CALLBACK = "spur_projects";
const PENDING_SPAWN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SPAWNS = 100;
const SPAWN_EXPIRED_TEXT = "Spawn expired. Run /spawn again.";
const UNDELIVERED_TEXT = "Message not delivered. Send it again.";

const TELEGRAM_COMMANDS = [
  { command: "start", description: "Show Spur bot help" },
  { command: "help", description: "Show Spur bot help" },
  { command: "agents", description: "List active Spur agents" },
  { command: "watch", description: "Bind this chat to a Spur agent" },
  { command: "spawn", description: "Spawn a new Spur agent" },
  { command: "new", description: "Launch a task with project defaults" },
  { command: "work", description: "Inspect tasks needing attention" },
  { command: "unwatch", description: "Unbind this chat" },
  { command: "complete", description: "Complete this topic's Spur session" },
  { command: "kill", description: "Kill this topic's Spur session" },
] as const;

interface TelegramTextMessage {
  message_id: number;
  message_thread_id?: number | undefined;
  is_topic_message?: true;
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_unique_id: string; width: number; height: number }[];
  chat: {
    id: number;
  };
  from?: {
    id: number;
    username?: string;
  };
  reply_to_message?: {
    message_id: number;
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
  me?: { username?: string };
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

interface TelegramInlineMarkup {
  inline_keyboard: { text: string; callback_data?: string; url?: string }[][];
}

interface TelegramCallbackContext {
  update?: {
    update_id?: number;
  };
  callbackQuery?: {
    data?: string;
    message?: {
      message_id?: number;
      date?: number;
      message_thread_id?: number | undefined;
      is_topic_message?: true;
      text?: string;
      reply_markup?: TelegramInlineMarkup;
      chat: {
        id: number;
      };
    };
    from?: {
      id: number;
      username?: string;
    };
  };
  answerCallbackQuery(text?: string | { text: string; show_alert?: boolean }): Promise<unknown>;
  editMessageText?(text: string, options?: unknown): Promise<unknown>;
  editMessageReplyMarkup?(other: { reply_markup: TelegramInlineMarkup }): Promise<unknown>;
  reply?(text: string, options?: unknown): Promise<unknown>;
  api?: {
    editMessageText(chatId: number, messageId: number, text: string): Promise<unknown>;
  };
}

interface TelegramRuntime {
  deps: SourceStartDeps<TelegramSourceConfig>;
  bindings: Map<string, TelegramBinding>;
  lastUpdateId?: number;
  botIdentity?: TelegramBotIdentity;
  pendingSpawns: Map<string, TelegramPendingSpawn>;
  autoSpawnInFlight: Set<string>;
  workbench: TelegramWorkbench;
  persistBindings(): Promise<void>;
  drainWrites(): Promise<void>;
}

type TelegramAgentName = "claude" | "codex" | "cursor" | "opencode";

/**
 * Discriminated by `project`: `undefined` means "awaiting a project pick" —
 * `projects`/`nonce` back the currently displayed `spur_sproj:` keyboard and
 * a callback with a mismatched nonce or index is rejected. Once `project` is
 * set, the record is "awaiting a prompt" and free text spawns with it.
 */
interface TelegramPendingSpawn {
  agent: TelegramAgentName;
  expiresAt: number;
  projects: string[];
  nonce: string;
  project?: string;
  prompt?: string;
}

type TelegramCommand =
  | { kind: "complete" | "kill"; invalidArgs: boolean }
  | { kind: "new"; task?: string }
  | { kind: "work" }
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
    case "complete":
    case "kill":
      if (mention && !botUsername) return null;
      return { kind: command, invalidArgs: Boolean(args) };
    case "new":
      return args ? { kind: "new", task: args } : { kind: "new" };
    case "work":
      return { kind: "work" };
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
  reconcileKey?: string,
): Promise<boolean> {
  const updateId = update?.update_id;
  if (typeof updateId === "number" && Number.isInteger(updateId)) {
    if (runtime.lastUpdateId !== undefined && updateId <= runtime.lastUpdateId) return false;
    runtime.lastUpdateId = updateId;
  } else if (reconcileKey === undefined) return true;
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

/**
 * Reads the pending spawn without deleting it, TTL-checked first. Lets
 * `routeTelegramPrompt` distinguish "awaiting a project pick" (record must
 * survive free text) from "awaiting a prompt" (record is consumed by it,
 * via an explicit `clearPendingSpawn`) before deciding what to do with it.
 */
function peekPendingSpawn(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
): TelegramPendingSpawn | "expired" | null {
  const pending = runtime.pendingSpawns.get(
    telegramPendingSpawnKey(chatId, messageThreadId, userId),
  );
  if (!pending) return null;
  return pending.expiresAt >= Date.now() ? pending : "expired";
}

function telegramMessageThreadId(
  message: Pick<TelegramTextMessage, "chat" | "message_thread_id" | "is_topic_message">,
  candidate = message.message_thread_id,
): number | undefined {
  return message.chat.id < 0 && message.is_topic_message !== true ? undefined : candidate;
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

/** Tell an allowed sender their update failed; never rethrows, never retries. */
async function noticeUndelivered(
  deps: SourceStartDeps<TelegramSourceConfig>,
  ctx: TelegramTextContext | TelegramCallbackContext,
): Promise<void> {
  const message = "message" in ctx ? ctx.message : undefined;
  const callback = "callbackQuery" in ctx ? ctx.callbackQuery : undefined;
  const chat = message?.chat ?? callback?.message?.chat;
  const from = message?.from ?? callback?.from;
  if (!chat || !isAllowed(deps.config, chat.id, from)) return;
  try {
    await ctx.reply?.(UNDELIVERED_TEXT);
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram undelivered notice failed: ${redactedErrorText(deps, error)}`,
    );
  }
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
  if (!deps.getSession) throw new Error("Telegram source requires getSession");
  return deps.getSession(sessionId);
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
      "/spawn - choose an agent, then a project, then send task",
      "/spawn <agent> <task> - choose a project, then create an agent with that task",
      "/new <task> - launch with displayed project defaults",
      "/work - inspect Attention, Working, and Recent tasks",
      "/unwatch - unbind this chat",
      "/complete - complete this topic's session; keep PR open",
      "/kill - kill this topic's session; requires saved and pushed work",
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

function buildSpawnProjectKeyboard(
  projects: SourceProjectListItem[],
  nonce: string,
): { text: string; callback_data: string }[][] {
  return projects.map((project, index) => [
    {
      text: project.name,
      callback_data: `${SPAWN_PROJECT_CALLBACK_PREFIX}${nonce}:${index}`,
    },
  ]);
}

function newSpawnNonce(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Entry point for both `/spawn <agent>` and the `spur_spawn:` callback: lists
 * the spawnable projects, auto-picks when there's exactly one (no keyboard —
 * every downstream reply names the project instead), otherwise stores a
 * fresh `nonce`-tagged snapshot on the pending record and sends the picker.
 * `prompt`, when supplied (`/spawn <agent> <task>`), is held on the record
 * and fires the spawn as soon as a project is picked instead of asking for
 * one.
 */
async function requestSpawnProject(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply">,
  chatId: number,
  messageThreadId: number | undefined,
  userId: number,
  agent: TelegramAgentName,
  prompt?: string,
): Promise<void> {
  const deps = runtime.deps;
  // Every `/spawn` (and `spur_spawn:` callback) attempt overwrites whatever
  // pending record a previous attempt left behind, on every outcome —
  // otherwise a live record from an earlier `/spawn` can survive an
  // immediate single-project spawn below and let the NEXT free text spawn a
  // second, unrequested agent.
  clearPendingSpawn(runtime, chatId, messageThreadId, userId);
  let projects: SourceProjectListItem[] | null;
  try {
    projects = deps.listProjects ? await deps.listProjects() : null;
  } catch (error) {
    await ctx.reply(`Cannot list projects: ${redactedErrorText(deps, error)}`);
    return;
  }
  if (projects === null) {
    await ctx.reply("Cannot list projects.");
    return;
  }
  if (projects.length === 0) {
    await ctx.reply("No projects configured.");
    return;
  }
  prunePendingSpawns(runtime);
  const key = telegramPendingSpawnKey(chatId, messageThreadId, userId);
  if (projects.length === 1) {
    const project = projects[0]?.id;
    if (project === undefined) {
      await ctx.reply("Cannot list projects.");
      return;
    }
    if (prompt !== undefined) {
      await bindSpawnedSession(runtime, ctx, chatId, messageThreadId, { agent, project, prompt });
      return;
    }
    runtime.pendingSpawns.set(key, {
      agent,
      expiresAt: Date.now() + PENDING_SPAWN_TTL_MS,
      projects: [project],
      nonce: "",
      project,
    });
    await ctx.reply(`Send task prompt for new ${agent} Spur agent in ${project}.`);
    return;
  }
  const nonce = newSpawnNonce();
  runtime.pendingSpawns.set(key, {
    agent,
    expiresAt: Date.now() + PENDING_SPAWN_TTL_MS,
    projects: projects.map((project) => project.id),
    nonce,
    ...(prompt !== undefined ? { prompt } : {}),
  });
  await ctx.reply(`Select a project for the new ${agent} agent:`, {
    reply_markup: { inline_keyboard: buildSpawnProjectKeyboard(projects, nonce) },
  });
}

export function wrapTelegramSpawnPrompt(taskText: string): string {
  return [
    taskText,
    "",
    "Source: telegram. The requester only sees messages you send with:",
    '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
    'Offer choices with `--button <label>` or `--button <label>=<value>`, repeatable: "$SPUR_SESSION_TOOL_DIR/spur" source reply "Deploy now?" --button "Yes" --button "Later=wait for me". A click arrives as an ordinary user message carrying the value. Prefer buttons when the answer is one pick from a few options. Format with Markdown (**bold**, `code`, ``` blocks, [text](url)), never HTML tags: they show literally.',
    "Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.",
  ].join("\n");
}

async function editOrReply(
  ctx: TelegramTextContext,
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

type TelegramSpawnOutcome =
  | { phase: "not_submitted"; error?: unknown }
  | { phase: "submitted_unknown"; error: unknown }
  | {
      phase: "created";
      session: SourceSessionListItem;
      bound: boolean;
      conversation?: TelegramConversation;
      error?: unknown;
    };

async function bindSpawnedSession(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  chatId: number,
  messageThreadId: number | undefined,
  request: SourceSpawnSessionRequest,
  options?: { current(): boolean; created(): void },
): Promise<TelegramSpawnOutcome> {
  const deps = runtime.deps;
  let submitted = false;
  let created: SourceSessionListItem | undefined;
  let bound = false;
  let statusMessageId: number | undefined;
  const current = (): boolean => !deps.signal.aborted && (!options || options.current());
  try {
    if (!current()) return { phase: "not_submitted" };
    if (!deps.spawnSession) {
      if (!options) await ctx.reply("Spur spawn is not available for this Telegram source.");
      return { phase: "not_submitted" };
    }
    if (!options) {
      try {
        const status = await ctx.reply(`Spawning ${request.agent} agent...`);
        statusMessageId = extractMessageId(status);
      } catch (error) {
        deps.logger.warn?.(
          `[source:${deps.projectId}/${deps.sourceId}] telegram spawn progress failed: ${redactedErrorText(deps, error)}`,
        );
      }
    }
    if (!current()) return { phase: "not_submitted" };
    submitted = true;
    const session = await deps.spawnSession({
      ...request,
      prompt:
        deps.config.chatId !== undefined && deps.config.chatId < 0
          ? wrapTelegramSpawnPrompt(request.prompt ?? "")
          : (request.prompt ?? ""),
      telegramOrigin: {
        projectId: deps.projectId,
        sourceId: deps.sourceId,
        chatId,
        ...(messageThreadId !== undefined ? { messageThreadId } : {}),
      },
    });
    created = session;
    options?.created();
    if (!current()) {
      return { phase: "created", session, bound: false };
    }
    const conversation = await bindTelegramThread(runtime, chatId, messageThreadId, session.id);
    bound = conversation.kind === "topic";
    rememberSent(deps, session.id, chatId, statusMessageId);
    if (!options)
      await editOrReply(
        ctx,
        chatId,
        statusMessageId,
        `Spawned ${session.id}. ${conversationText(conversation)}`,
      );
    return { phase: "created", session, bound, conversation };
  } catch (error) {
    if (
      created &&
      runtime.bindings.get(telegramBindingKey(chatId, messageThreadId))?.sessionId === created.id
    )
      bound = true;
    if (!options) {
      try {
        await editOrReply(
          ctx,
          chatId,
          statusMessageId,
          created
            ? `Created ${created.id}. ${bound ? "Bound; notification failed" : "Binding failed"}. Use /work to inspect.`
            : `Spawn failed: ${redactedErrorText(deps, error)}`,
        );
      } catch (noticeError) {
        logPersistError(deps, noticeError);
      }
    }
    return created
      ? { phase: "created", session: created, bound, error }
      : submitted
        ? { phase: "submitted_unknown", error }
        : { phase: "not_submitted", error };
  }
}

/**
 * Records input in the checked assigned topic, preserving its pending placeholder.
 */
function recordTelegramReplyTarget(
  deps: SourceStartDeps<TelegramSourceConfig>,
  target: {
    sessionId: string;
    chatId: number;
    messageThreadId?: number;
    statusMessageId?: number;
  },
): void {
  const previous = readTelegramReplyTarget(deps.dataDir, target.sessionId);
  const sameTarget =
    previous !== null && isSameTelegramTarget(previous, target.chatId, target.messageThreadId);
  const carriedStatus = sameTarget ? previous.statusMessageId : undefined;
  const lastInboundAt = new Date().toISOString();
  const keepsNewStatus =
    target.statusMessageId !== undefined &&
    (target.chatId > 0 || target.messageThreadId !== undefined);
  const statusMessageId = keepsNewStatus ? target.statusMessageId : carriedStatus;
  writeTelegramReplyTarget(deps.dataDir, {
    sessionId: target.sessionId,
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId: target.chatId,
    ...(target.messageThreadId !== undefined ? { messageThreadId: target.messageThreadId } : {}),
    ...(statusMessageId !== undefined ? { statusMessageId } : {}),
    ...(sameTarget && previous.topicName !== undefined ? { topicName: previous.topicName } : {}),
    ...(previous?.lastReplyAt !== undefined ? { lastReplyAt: previous.lastReplyAt } : {}),
    lastInboundAt,
  });
}

async function bindTelegramThread(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
  sessionId: string,
): Promise<TelegramConversation> {
  const deps = runtime.deps;
  if (!deps.telegramConversations) throw new Error("Telegram conversations unavailable");
  const conversation = await deps.telegramConversations.ensureTopic(sessionId, {
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  });
  runtime.bindings.clear();
  mergePersistedBindings(runtime);
  return conversation;
}

async function unbindTelegramThread(
  runtime: TelegramRuntime,
  chatId: number,
  messageThreadId: number | undefined,
): Promise<{ deleted: boolean; binding: TelegramBinding | undefined }> {
  const deps = runtime.deps;
  const key = telegramBindingKey(chatId, messageThreadId);
  const binding = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId).get(key);
  if (!binding) return { deleted: false, binding: undefined };
  if (!deps.telegramConversations) throw new Error("Telegram conversations unavailable");
  const deleted = await deps.telegramConversations.unwatch(binding.sessionId, {
    projectId: deps.projectId,
    sourceId: deps.sourceId,
    chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  });
  runtime.bindings.clear();
  mergePersistedBindings(runtime);
  return { deleted, binding };
}

function conversationText(conversation: TelegramConversation): string {
  return conversation.kind === "disabled"
    ? "Telegram conversation unavailable; configure a forum chatId."
    : `Continue in [agent topic](https://t.me/c/${String(conversation.chatId).replace(/^-100/, "")}/${conversation.messageThreadId}).`;
}

function conversationIsCurrent(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
  conversation: TelegramConversation,
): conversation is Extract<TelegramConversation, { kind: "topic" }> {
  if (conversation.kind !== "topic" || deps.config.chatId !== conversation.chatId) return false;
  const record = readSession(deps.dataDir, sessionId);
  if (record?.status === "completed" || record?.status === "killed") return false;
  const target = readTelegramReplyTarget(deps.dataDir, sessionId);
  return (
    target?.projectId === conversation.projectId &&
    target.sourceId === conversation.sourceId &&
    target.chatId === conversation.chatId &&
    target.messageThreadId === conversation.messageThreadId &&
    readTelegramBindings(deps.dataDir, conversation.projectId, conversation.sourceId).get(
      telegramBindingKey(conversation.chatId, conversation.messageThreadId),
    )?.sessionId === sessionId &&
    !telegramTopicIsDeleting(deps.dataDir, conversation.chatId, conversation.messageThreadId)
  );
}

async function guardAgentInput(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply">,
  message: TelegramTextMessage,
  sessionId: string,
): Promise<TelegramConversation | null> {
  const conversation = await bindTelegramThread(
    runtime,
    message.chat.id,
    message.message_thread_id,
    sessionId,
  );
  if (
    !conversationIsCurrent(runtime.deps, sessionId, conversation) ||
    !isSameTelegramTarget(conversation, message.chat.id, message.message_thread_id)
  ) {
    await ctx.reply(conversationText(conversation));
    return null;
  }
  return conversation;
}

type AutoSpawnAcquireResult =
  | { status: "off" }
  | { status: "busy" }
  | { status: "acquired"; autoSpawn: TelegramAutoSpawnConfig };

function tryAcquireAutoSpawn(runtime: TelegramRuntime, key: string): AutoSpawnAcquireResult {
  const autoSpawn = runtime.deps.config.autoSpawn;
  if (autoSpawn?.enabled !== true) return { status: "off" };
  if (runtime.autoSpawnInFlight.has(key)) return { status: "busy" };
  runtime.autoSpawnInFlight.add(key);
  return { status: "acquired", autoSpawn };
}

async function runAutoSpawn(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  chatId: number,
  messageThreadId: number | undefined,
  text: string,
  key: string,
  autoSpawn: TelegramAutoSpawnConfig,
  attachments?: SendMessageAttachment[],
): Promise<void> {
  try {
    await bindSpawnedSession(runtime, ctx, chatId, messageThreadId, {
      project: autoSpawn.project,
      agent: autoSpawn.agent,
      ...(autoSpawn.model !== undefined ? { model: autoSpawn.model } : {}),
      ...(autoSpawn.selfDestruct !== undefined ? { selfDestruct: autoSpawn.selfDestruct } : {}),
      prompt: text,
      ...(attachments ? { attachments } : {}),
    });
  } finally {
    runtime.autoSpawnInFlight.delete(key);
  }
}

function workbenchCurrent(runtime: TelegramRuntime, card: WorkbenchCard): boolean {
  return (
    !runtime.deps.signal.aborted &&
    isAllowed(runtime.deps.config, card.owner.chatId, { id: card.owner.userId }) &&
    runtime.workbench.current(card)
  );
}

async function launchProjects(
  runtime: TelegramRuntime,
  card: LaunchCard,
): Promise<SourceProjectListItem[]> {
  if (!runtime.deps.listProjects) throw new Error("Project listing unavailable");
  return runtime.workbench.projects(card.owner, await runtime.deps.listProjects());
}

async function workbenchView(
  runtime: TelegramRuntime,
  card: WorkbenchCard,
): Promise<WorkbenchView> {
  const capability = runtime.deps.workbench;
  if (!capability || !runtime.deps.listProjects) throw new Error("Workbench unavailable");
  if (card.kind === "launch") {
    const projects = await launchProjects(runtime, card);
    const visible = workbenchPage(projects, card.page);
    card.page = visible.index;
    if (card.project !== undefined) {
      if (!projects.some((entry) => entry.id === card.project))
        throw new Error("Project unavailable");
      return renderSettings(
        card,
        await capability.launchOptions({
          project: card.project,
          ...(card.agent ? { agent: card.agent } : {}),
          ...(card.mode ? { mode: card.mode } : {}),
        }),
      );
    }
    const options = await Promise.all(
      visible.items.map(async ({ id }) => {
        try {
          return await capability.launchOptions({ project: id });
        } catch {
          return null;
        }
      }),
    );
    return renderLauncher(
      card,
      projects,
      options.filter((entry) => entry !== null),
    );
  }
  if (card.sessionId) {
    const session = await capability.getSession(card.sessionId);
    const projects = await runtime.deps.listProjects();
    return renderDetail(
      card,
      session,
      projects.some((project) => project.id === session.project),
    );
  }
  return renderInbox(card, await capability.listSessions());
}

async function editWorkbenchCard(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
  card: WorkbenchCard,
  view: WorkbenchView,
): Promise<void> {
  if (!workbenchCurrent(runtime, card)) return;
  const options = { reply_markup: runtime.workbench.keyboard(card, view) };
  if (ctx.editMessageText) {
    try {
      await ctx.editMessageText(view.text, options);
      return;
    } catch (error) {
      logPersistError(runtime.deps, error);
    }
  }
  if (!workbenchCurrent(runtime, card)) return;
  const sent = await ctx.reply?.(view.text, options);
  if (!workbenchCurrent(runtime, card)) return;
  const messageId = extractMessageId(sent as TelegramSentMessage | undefined);
  if (messageId === undefined) {
    card.token = undefined;
    return;
  }
  card.messageId = messageId;
}

async function bindWorkbenchSession(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
  card: WorkbenchCard,
  session: SourceSessionListItem,
): Promise<TelegramConversation> {
  const { chatId, threadId, userId } = card.owner;
  clearPendingSpawn(runtime, chatId, threadId, userId);
  return bindTelegramThread(runtime, chatId, threadId, session.id);
}

async function notifyUnboundWorkbenchResult(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
  card: WorkbenchCard,
  session: SourceSessionListItem,
): Promise<void> {
  if (
    isAborted(runtime.deps) ||
    !isAllowed(runtime.deps.config, card.owner.chatId, { id: card.owner.userId })
  )
    return;
  try {
    await ctx.reply?.(
      `Task ${session.id} is available but not bound here. Use /work to inspect and continue it.`,
    );
  } catch (error) {
    logPersistError(runtime.deps, error);
  }
}

async function handleWorkbenchCallback(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
  data: string,
  owner: WorkbenchOwner,
  messageId: number | undefined,
): Promise<void> {
  if (runtime.deps.signal.aborted || !runtime.deps.workbench) return;
  const claim = runtime.workbench.claim(owner, messageId, data);
  if (!claim) {
    await ctx.answerCallbackQuery("Card expired. Run /new or /work again.");
    return;
  }
  const { card, action } = claim;
  // Claim precedes acknowledgement; Telegram acknowledgement failure cannot undo it.
  try {
    await ctx.answerCallbackQuery();
  } catch (error) {
    logPersistError(runtime.deps, error);
  }
  if (!workbenchCurrent(runtime, card)) return;
  const capability = runtime.deps.workbench;
  try {
    if (action.kind === "close") {
      await editWorkbenchCard(ctx, runtime, card, { text: "Closed.", rows: [] });
      if (runtime.workbench.current(card)) runtime.workbench.invalidate(owner, card.kind);
      return;
    }
    if (action.kind === "launch" && card.kind === "launch") {
      const projects = await launchProjects(runtime, card);
      if (!workbenchCurrent(runtime, card)) return;
      if (!projects.some((entry) => entry.id === action.options.project))
        throw new Error("Project unavailable");
      const fresh = await capability.launchOptions({
        project: action.options.project,
        ...(card.agent ? { agent: card.agent } : {}),
        ...(card.mode ? { mode: card.mode } : {}),
      });
      if (!workbenchCurrent(runtime, card)) return;
      if (
        fresh.agent !== action.options.agent ||
        fresh.model !== action.options.model ||
        fresh.mode !== action.options.mode
      ) {
        const view = await workbenchView(runtime, card);
        await editWorkbenchCard(ctx, runtime, card, {
          ...view,
          text: `Defaults changed. Review and tap Launch again.\n${view.text}`,
        });
        return;
      }
      const outcome = await bindSpawnedSession(
        runtime,
        {
          reply: async (text) => {
            const sent = await ctx.reply?.(text);
            return sent as TelegramSentMessage | undefined;
          },
        },
        owner.chatId,
        owner.threadId,
        {
          project: fresh.project,
          agent: fresh.agent,
          prompt: card.task,
          ...(fresh.model !== null ? { model: fresh.model } : {}),
          ...(fresh.mode !== null ? { mode: fresh.mode } : {}),
        },
        {
          current: () => workbenchCurrent(runtime, card),
          created: () => {
            if (workbenchCurrent(runtime, card)) runtime.workbench.remember(owner, fresh.project);
          },
        },
      );
      if (!workbenchCurrent(runtime, card)) {
        if (outcome.phase === "created" && !outcome.bound)
          await notifyUnboundWorkbenchResult(ctx, runtime, card, outcome.session);
        return;
      }
      if (outcome.phase === "created") {
        await editWorkbenchCard(ctx, runtime, card, {
          text: `Created ${outcome.session.id}. ${outcome.conversation ? conversationText(outcome.conversation) : "No Telegram conversation; use /work to inspect."}${outcome.error ? `\n${redactedErrorText(runtime.deps, outcome.error)}` : ""}`,
          rows: outcome.bound
            ? []
            : [
                [
                  {
                    text: "Continue here",
                    action: {
                      kind: "continue",
                      sessionId: outcome.session.id,
                      project: outcome.session.project,
                    },
                  },
                ],
              ],
        });
      } else if (outcome.phase === "submitted_unknown") {
        await editWorkbenchCard(ctx, runtime, card, {
          text: "Spawn outcome unknown. Use /work to inspect before launching again.",
          rows: [],
        });
      } else {
        const view = await workbenchView(runtime, card);
        await editWorkbenchCard(ctx, runtime, card, {
          ...view,
          text: `Not submitted. ${outcome.error ? redactedErrorText(runtime.deps, outcome.error) : "Launch unavailable."}\n${view.text}`,
        });
      }
      return;
    }
    if (action.kind === "continue" || action.kind === "restore") {
      let session = await capability.getSession(action.sessionId);
      if (!workbenchCurrent(runtime, card)) return;
      if (session.id !== action.sessionId || session.project !== action.project)
        throw new Error("Session changed");
      if (action.kind === "restore") {
        if (!runtime.deps.listProjects) throw new Error("Project listing unavailable");
        const projects = await runtime.deps.listProjects();
        if (!workbenchCurrent(runtime, card)) return;
        if (!session.restorable || !projects.some((project) => project.id === session.project))
          throw new Error("Restore unavailable");
        session = await capability.restoreSession({
          sessionId: session.id,
          expectedProject: action.project,
        });
        if (!workbenchCurrent(runtime, card)) {
          await notifyUnboundWorkbenchResult(ctx, runtime, card, session);
          return;
        }
        session = await capability.getSession(action.sessionId);
        if (!workbenchCurrent(runtime, card)) {
          await notifyUnboundWorkbenchResult(ctx, runtime, card, session);
          return;
        }
      }
      if (
        session.id !== action.sessionId ||
        session.project !== action.project ||
        !session.canContinue
      )
        throw new Error("Continue unavailable");
      const conversation = await bindWorkbenchSession(ctx, runtime, card, session);
      await editWorkbenchCard(ctx, runtime, card, {
        text: conversationText(conversation),
        rows: [],
      });
      return;
    }
    if (card.kind === "launch") {
      if (action.kind === "projects") {
        card.page = Math.max(0, action.page);
        card.project = undefined;
        card.agent = undefined;
        card.mode = undefined;
      } else if (action.kind === "settings") {
        const projects = await launchProjects(runtime, card);
        if (!workbenchCurrent(runtime, card)) return;
        if (!action.project) {
          const current = workbenchPage(projects, card.page).items;
          await editWorkbenchCard(ctx, runtime, card, {
            text: "Choose a project for Settings.",
            rows: [
              ...current.map((project) => [
                { text: project.name, action: { kind: "settings" as const, project: project.id } },
              ]),
              [{ text: "Projects", action: { kind: "projects", page: card.page } }],
            ],
          });
          return;
        }
        card.project = action.project;
        card.agent = undefined;
        card.mode = undefined;
      } else if (action.kind === "agent") card.agent = action.agent;
      else if (action.kind === "mode") card.mode = action.mode;
    } else if (action.kind === "list") {
      card.tab = action.tab;
      card.page = Math.max(0, action.page);
      card.sessionId = undefined;
    } else if (action.kind === "detail") card.sessionId = action.sessionId;
    await editWorkbenchCard(ctx, runtime, card, await workbenchView(runtime, card));
  } catch (error) {
    if (!workbenchCurrent(runtime, card)) return;
    const reason = redactedErrorText(runtime.deps, error);
    let rows: WorkbenchView["rows"] = [[{ text: "Close", action: { kind: "close" } }]];
    if (card.kind === "inbox") {
      try {
        rows = (await workbenchView(runtime, card)).rows;
      } catch {
        rows.unshift([{ text: "Back", action: { kind: "list", tab: card.tab, page: card.page } }]);
      }
    }
    try {
      await editWorkbenchCard(ctx, runtime, card, { text: `Action unavailable: ${reason}`, rows });
    } catch (noticeError) {
      logPersistError(runtime.deps, noticeError);
    }
  }
}

async function handleTelegramCallback(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
): Promise<void> {
  const query = ctx.callbackQuery;
  const data = query?.data;
  const message = query?.message
    ? { ...query.message, message_thread_id: telegramMessageThreadId(query.message) }
    : undefined;
  const deps = runtime.deps;
  const updateId = ctx.update?.update_id;
  const drop = (
    reason: "duplicate" | "no-data" | "no-message" | "not-allowed" | "no-sender",
  ): void =>
    logSpurEvent(deps.dataDir, {
      event: "source.telegram.callback_dropped",
      level: "warn",
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      message: `Telegram callback dropped: ${reason}`,
      details: {
        reason,
        ...(updateId !== undefined ? { updateId } : {}),
        ...(message ? { chatId: message.chat.id } : {}),
        ...(query?.from ? { userId: query.from.id } : {}),
      },
    });
  if (!(await rememberUpdate(runtime, ctx.update))) return drop("duplicate");
  runtime.workbench.prune();
  if (!data) return drop("no-data");
  if (!message) return drop("no-message");
  const from = query.from;
  if (!from) return drop("no-sender");
  if (!isAllowed(deps.config, message.chat.id, from)) return drop("not-allowed");

  if (data.startsWith(WORKBENCH_CALLBACK_PREFIX)) {
    await handleWorkbenchCallback(
      ctx,
      runtime,
      data,
      {
        userId: from.id,
        chatId: message.chat.id,
        ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
      },
      message.message_id,
    );
    return;
  }

  if (data.startsWith(TELEGRAM_CHOICE_CALLBACK_PREFIX)) {
    await handleAgentChoiceCallback(
      ctx,
      runtime,
      data.slice(TELEGRAM_CHOICE_CALLBACK_PREFIX.length),
      message,
      from,
    );
    return;
  }

  if (data.startsWith(SPAWN_CALLBACK_PREFIX)) {
    runtime.workbench.invalidate(
      {
        userId: from.id,
        chatId: message.chat.id,
        ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
      },
      "launch",
    );
    const agent = data.slice(SPAWN_CALLBACK_PREFIX.length);
    if (!isTelegramAgentName(agent)) return;
    await ctx.answerCallbackQuery(`Selected ${agent}.`);
    await requestSpawnProject(
      runtime,
      {
        reply: async (text: string, options?: unknown) => {
          await ctx.reply?.(text, options);
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

  if (data.startsWith(SPAWN_PROJECT_CALLBACK_PREFIX)) {
    const [nonce, indexRaw] = data.slice(SPAWN_PROJECT_CALLBACK_PREFIX.length).split(":");
    const chatId = message.chat.id;
    const messageThreadId = message.message_thread_id;
    const userId = from.id;
    const peeked = peekPendingSpawn(runtime, chatId, messageThreadId, userId);
    if (peeked === "expired") {
      clearPendingSpawn(runtime, chatId, messageThreadId, userId);
      await ctx.answerCallbackQuery(SPAWN_EXPIRED_TEXT);
      return;
    }
    if (!peeked || peeked.project !== undefined || peeked.nonce !== nonce) {
      await ctx.answerCallbackQuery(SPAWN_EXPIRED_TEXT);
      return;
    }
    const index = indexRaw !== undefined && indexRaw !== "" ? Number(indexRaw) : NaN;
    const project = Number.isInteger(index) ? peeked.projects[index] : undefined;
    if (project === undefined) {
      await ctx.answerCallbackQuery(SPAWN_EXPIRED_TEXT);
      return;
    }
    await ctx.answerCallbackQuery();
    const replyShim = {
      reply: async (text: string) => {
        const sent = await ctx.reply?.(text);
        return (sent ?? {}) as TelegramSentMessage;
      },
      ...(ctx.api ? { api: ctx.api } : {}),
    };
    if (peeked.prompt !== undefined) {
      clearPendingSpawn(runtime, chatId, messageThreadId, userId);
      await bindSpawnedSession(runtime, replyShim, chatId, messageThreadId, {
        agent: peeked.agent,
        project,
        prompt: peeked.prompt,
      });
      return;
    }
    prunePendingSpawns(runtime);
    runtime.pendingSpawns.set(telegramPendingSpawnKey(chatId, messageThreadId, userId), {
      agent: peeked.agent,
      expiresAt: Date.now() + PENDING_SPAWN_TTL_MS,
      projects: [],
      nonce: "",
      project,
    });
    await replyShim.reply(`Send task prompt for new ${peeked.agent} Spur agent in ${project}.`);
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
  clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
  let conversation: TelegramConversation;
  try {
    conversation = await bindTelegramThread(
      runtime,
      message.chat.id,
      message.message_thread_id,
      sessionId,
    );
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
  const reply = conversationText(conversation);
  await ctx.answerCallbackQuery("Conversation selected.");
  if (ctx.editMessageText) {
    await ctx.editMessageText(reply);
  } else {
    await ctx.reply?.(reply);
  }
}

type ChoiceRejectReason =
  | ConsentRejectReason
  | "inactive"
  | "session-missing"
  | "session-inactive"
  | "internal";

/** Alert per rejected click; every text stays under Telegram's 200-char answer limit. */
const CHOICE_REJECT_TEXT: Record<Exclude<ChoiceRejectReason, "session-inactive">, string> = {
  inactive: "This choice is no longer active.",
  retired: "This choice is no longer active.",
  "session-missing": "Session is no longer active.",
  "not-approver": "Only the designated approver can decide this interface approval.",
  expired: "This interface approval expired. Ask the agent to request it again.",
  decided: "This interface approval is already decided.",
  superseded: "A newer interface approval replaced this one.",
  "not-delivered": "This interface approval was not delivered.",
  "binding-mismatch": "This interface approval belongs to another chat or source.",
  "policy-unavailable": "Interface approval policy is unavailable or changed.",
  "policy-changed": "Interface approval policy is unavailable or changed.",
  "task-changed": "The session branch or workspace changed since approval was requested.",
  internal: "Choice failed. Try again.",
};

interface ChoiceRejection {
  reason: ChoiceRejectReason;
  alert: string;
  error?: unknown;
}

function choiceRejection(
  reason: Exclude<ChoiceRejectReason, "session-inactive">,
  error?: unknown,
): ChoiceRejection {
  return { reason, alert: CHOICE_REJECT_TEXT[reason], ...(error !== undefined ? { error } : {}) };
}

function singleChoiceButton(text: string, callbackData: string): TelegramInlineMarkup {
  return { inline_keyboard: [[{ text, callback_data: callbackData }]] };
}

/** Best-effort keyboard edit; resolves whether Telegram accepted it. */
async function editChoiceMarkup(
  ctx: TelegramCallbackContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
  markup: TelegramInlineMarkup,
): Promise<boolean> {
  if (!ctx.editMessageReplyMarkup) return false;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: markup });
    return true;
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram choice keyboard edit failed: ${redactedErrorText(deps, error)}`,
    );
    return false;
  }
}

/**
 * Best-effort: Telegram expires callback queries, and a rejected answer must
 * not swallow a click that was already consumed.
 */
async function answerChoice(
  ctx: TelegramCallbackContext,
  deps: SourceStartDeps<TelegramSourceConfig>,
  answer: string | { text: string; show_alert: true },
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(answer);
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram choice ack failed: ${redactedErrorText(deps, error)}`,
    );
  }
}

/**
 * Delivers a click on an agent-offered button as an ordinary user message to
 * the session that offered it. The token is single-use and carries the whole
 * offer with it, so sibling buttons go dead on the first click. The keyboard
 * turns "Sending" before any lookup; a rejection restores it and alerts why.
 */
async function handleAgentChoiceCallback(
  ctx: TelegramCallbackContext,
  runtime: TelegramRuntime,
  token: string,
  message: NonNullable<NonNullable<TelegramCallbackContext["callbackQuery"]>["message"]>,
  from: { id: number; username?: string },
): Promise<void> {
  const deps = runtime.deps;
  const chatId = message.chat.id;
  const callbackData = `${TELEGRAM_CHOICE_CALLBACK_PREFIX}${token}`;
  let sending = false;
  const reject = async (rejection: ChoiceRejection, pending?: TelegramChoice): Promise<void> => {
    // Only a keyboard this click changed is put back: the original while the
    // offer is live, none once it is spent.
    if (sending) {
      const live = findTelegramChoice(deps.dataDir, deps.projectId, deps.sourceId, token, chatId);
      const restore = live ? message.reply_markup : undefined;
      await editChoiceMarkup(ctx, deps, restore ?? { inline_keyboard: [] });
    }
    logSpurEvent(deps.dataDir, {
      event: "source.telegram.choice_rejected",
      level: "warn",
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      ...(pending ? { sessionId: pending.sessionId } : {}),
      message: `Telegram choice rejected: ${rejection.reason}`,
      details: {
        reason: rejection.reason,
        chatId,
        userId: from.id,
        consent: pending?.interfaceConsent !== undefined,
        ...(rejection.error !== undefined
          ? { error: redactedErrorText(deps, rejection.error) }
          : {}),
      },
    });
    await answerChoice(ctx, deps, { text: rejection.alert, show_alert: true });
  };
  const pending = findTelegramChoice(deps.dataDir, deps.projectId, deps.sourceId, token, chatId);
  if (!pending) {
    await reject(choiceRejection("inactive"));
    return;
  }
  if (message.reply_markup)
    sending = await editChoiceMarkup(
      ctx,
      deps,
      singleChoiceButton(`Sending: ${pending.text}…`, callbackData),
    );
  let session: SourceSessionListItem | null;
  try {
    session = await findSession(deps, pending.sessionId);
  } catch (error) {
    await reject(choiceRejection("internal", error), pending);
    return;
  }
  if (!session) {
    await reject(choiceRejection("session-missing"), pending);
    return;
  }
  const inputThreadId =
    message.date === 0
      ? pending.messageThreadId
      : telegramMessageThreadId(message, message.message_thread_id ?? pending.messageThreadId);
  const conversation = await bindTelegramThread(
    runtime,
    message.chat.id,
    inputThreadId,
    session.id,
  );
  if (
    !conversationIsCurrent(deps, session.id, conversation) ||
    !isSameTelegramTarget(conversation, message.chat.id, inputThreadId)
  ) {
    if (sending) {
      await editChoiceMarkup(ctx, deps, message.reply_markup ?? { inline_keyboard: [] });
    }
    await ctx.answerCallbackQuery("Continue in the assigned topic.");
    await ctx.reply?.(conversationText(conversation));
    return;
  }
  if (session.inactive) {
    await reject(
      {
        reason: "session-inactive",
        alert: `${formatTelegramSessionLabel(session.id, session.title?.trim() || undefined)} is not active.`,
      },
      pending,
    );
    return;
  }
  const outcome = await claimAgentChoice(deps, pending, token, chatId, from.id, conversation).catch(
    (error: unknown) =>
      error instanceof ConsentRejectedError
        ? choiceRejection(error.reason)
        : choiceRejection("internal", error),
  );
  if ("reason" in outcome) {
    await reject(outcome, pending);
    return;
  }
  const choice = outcome;
  await answerChoice(ctx, deps, `Sent: ${choice.text}`);
  // Text and formatting stay; the spent keyboard shows the pick.
  await editChoiceMarkup(ctx, deps, singleChoiceButton(`Selected: ${choice.text}`, callbackData));
  // Failed external publication keeps the durable outbox for the next lifecycle call.
  if (choice.interfaceConsent)
    await reconcileInterfaceConsent(deps.dataDir, choice.sessionId).catch(() => {
      deps.logger.warn?.("Interface consent publication blocked; decision retained locally.");
    });
  // The clicked message is the truth about the thread: an offer sent before a
  // forum topic existed carries none, and a stale one would strand the reply.
  const messageThreadId =
    message.date === 0
      ? choice.messageThreadId
      : telegramMessageThreadId(message, message.message_thread_id ?? choice.messageThreadId);
  const clickMessage: TelegramTextMessage = {
    message_id: message.message_id ?? 0,
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
    chat: { id: choice.chatId },
    from,
  };
  if (!conversationIsCurrent(deps, choice.sessionId, conversation)) return;
  // A click posts no status message of its own.
  recordTelegramReplyTarget(deps, {
    sessionId: choice.sessionId,
    chatId: choice.chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  });
  deps.emit(TELEGRAM_MESSAGE_EVENT, eventData(clickMessage, choice.sessionId, choice.value));
}

/** Liveness before consumption: a dead lookup must leave the offer clickable. */
async function claimAgentChoice(
  deps: SourceStartDeps<TelegramSourceConfig>,
  pending: TelegramChoice,
  token: string,
  chatId: number,
  actor: number,
  conversation: TelegramConversation,
): Promise<TelegramChoice | ChoiceRejection> {
  const session = await findSession(deps, pending.sessionId);
  if (!session) return choiceRejection("session-missing");
  if (session.inactive)
    return {
      reason: "session-inactive",
      alert: `${formatTelegramSessionLabel(session.id, session.title?.trim() || undefined)} is not active.`,
    };
  const decision = pending.interfaceConsent
    ? await decideConsentClick(deps, pending.sessionId, token, chatId, actor, conversation)
    : undefined;
  const choice = takeTelegramChoice(deps.dataDir, deps.projectId, deps.sourceId, token, chatId);
  // Lost the race with a sibling click or a superseding reply.
  if (!choice) return choiceRejection("retired");
  if (decision) writeInterfaceConsent(deps.dataDir, decision);
  return choice;
}

/** Re-validates policy and task binding of an approval click; throws a named rejection. */
async function decideConsentClick(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
  token: string,
  chatId: number,
  actor: number,
  conversation: TelegramConversation,
): Promise<InterfaceConsent> {
  const policy = await consentPolicy(deps.config.allowedUsers).catch((error: unknown) => {
    throw new ConsentRejectedError("policy-unavailable", errorText(error));
  });
  const record = readInterfaceConsent(deps.dataDir, sessionId);
  if (
    !record ||
    policy.approverUserId !== record.approverUserId ||
    !policy.repositories.includes(record.repository)
  )
    throw new ConsentRejectedError("policy-changed", "Interface approval policy changed");
  const actualSession = readSession(deps.dataDir, sessionId);
  if (
    !actualSession ||
    actualSession.project !== record.projectId ||
    actualSession.branch !== record.branch ||
    workspaceIdOf(actualSession) !== record.authority ||
    (await readCurrentBranch(actualSession.worktreePath)) !== record.branch
  )
    throw new ConsentRejectedError("task-changed", "Interface approval task changed");
  const relocated = readSession(deps.dataDir, sessionId);
  if (
    !relocated ||
    relocated.project !== record.projectId ||
    relocated.branch !== record.branch ||
    workspaceIdOf(relocated) !== record.authority
  )
    throw new ConsentRejectedError("task-changed", "Interface approval task changed");
  const validatedPath = relocated.worktreePath;
  if (validatedPath !== actualSession.worktreePath) {
    const [branch, repository] = await Promise.all([
      readCurrentBranch(validatedPath),
      repositoryOf(validatedPath),
    ]);
    if (branch !== record.branch || repository !== record.repository)
      throw new ConsentRejectedError("task-changed", "Interface approval task changed");
  }
  const active = findTelegramChoice(deps.dataDir, deps.projectId, deps.sourceId, token, chatId);
  const current = readInterfaceConsent(deps.dataDir, sessionId);
  const currentSession = readSession(deps.dataDir, sessionId);
  if (
    !conversationIsCurrent(deps, sessionId, conversation) ||
    !active?.interfaceConsent ||
    !current ||
    current.generation !== record.generation ||
    current.challenge !== record.challenge ||
    current.authority !== record.authority ||
    !currentSession ||
    currentSession.project !== record.projectId ||
    currentSession.branch !== record.branch ||
    currentSession.worktreePath !== validatedPath ||
    workspaceIdOf(currentSession) !== record.authority
  )
    throw new ConsentRejectedError("superseded", "Interface approval superseded");
  return decideConsent(current, {
    session: sessionId,
    sourceId: deps.sourceId,
    projectId: deps.projectId,
    chatId,
    actor,
    challenge: active.interfaceConsent.challenge,
    decision: active.interfaceConsent.decision,
  });
}

async function handleTelegramText(
  ctx: TelegramTextContext,
  runtime: TelegramRuntime,
): Promise<void> {
  const message = ctx.message
    ? { ...ctx.message, message_thread_id: telegramMessageThreadId(ctx.message) }
    : undefined;
  const deps = runtime.deps;
  const command = message?.text ? parseTelegramCommand(message.text, ctx.me?.username) : null;
  const lifecycle = command?.kind === "complete" || command?.kind === "kill";
  if (lifecycle && (!message || !isAllowed(deps.config, message.chat.id, message.from))) return;
  const lifecycleKey =
    lifecycle && message && message.chat.id < 0 && message.message_thread_id !== undefined
      ? telegramBindingKey(message.chat.id, message.message_thread_id)
      : undefined;
  if (!(await rememberUpdate(runtime, ctx.update, lifecycleKey))) return;
  runtime.workbench.prune();
  if (!message?.text || !message.text.trim()) return;
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  if (command?.kind === "complete" || command?.kind === "kill") {
    if (command.invalidArgs) {
      await ctx.reply(`Usage: /${command.kind}`);
      return;
    }
    if (lifecycleKey === undefined) {
      await ctx.reply(`Use /${command.kind} inside a bound forum topic.`);
      return;
    }
    const selected = runtime.bindings.get(lifecycleKey);
    const current = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId).get(
      lifecycleKey,
    );
    if (current) runtime.bindings.set(lifecycleKey, current);
    else runtime.bindings.delete(lifecycleKey);
    if (!current) {
      await ctx.reply("No Spur session bound here.");
      return;
    }
    if (selected?.sessionId !== current.sessionId) {
      await ctx.reply("Topic binding changed. Send the command again.");
      return;
    }
    if (!deps.workbench) {
      await ctx.reply("Session operation unavailable.");
      return;
    }
    try {
      if (command.kind === "complete") await deps.workbench.completeSession(current.sessionId);
      else await deps.workbench.killSession(current.sessionId);
      for (const [key, binding] of runtime.bindings) {
        if (binding.sessionId === current.sessionId) runtime.bindings.delete(key);
      }
    } catch (error) {
      await ctx.reply(`Failed to ${command.kind} session: ${redactedErrorText(deps, error)}`);
    }
    return;
  }
  const owner: WorkbenchOwner = {
    userId: from.id,
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
  };
  if (command?.kind === "new" || command?.kind === "work") {
    if (!deps.workbench || !deps.listProjects || (command.kind === "new" && !deps.spawnSession)) {
      await ctx.reply(
        `Workbench unavailable. Use ${command.kind === "new" ? "/spawn" : "/watch"}.`,
      );
      return;
    }
    if (command.kind === "new") {
      runtime.workbench.invalidate(owner, "launch");
      clearPendingSpawn(runtime, owner.chatId, owner.threadId, owner.userId);
      if (!command.task) {
        await ctx.reply("Usage: /new <task>");
        return;
      }
    }
    const card = runtime.workbench.create(owner, command.kind === "new" ? command.task : undefined);
    if (!card) {
      await ctx.reply("Too many open cards. Close a card or wait for expiry.");
      return;
    }
    try {
      const view = await workbenchView(runtime, card);
      if (!workbenchCurrent(runtime, card)) return;
      const sent = await ctx.reply(view.text, {
        reply_markup: runtime.workbench.keyboard(card, view),
      });
      card.messageId = extractMessageId(sent);
      if (card.messageId === undefined) runtime.workbench.invalidate(owner, card.kind);
    } catch (error) {
      if (!workbenchCurrent(runtime, card)) return;
      runtime.workbench.invalidate(owner, card.kind);
      await ctx.reply(`Workbench unavailable: ${redactedErrorText(deps, error)}`);
    }
    return;
  }
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
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    try {
      const conversation = await bindTelegramThread(
        runtime,
        message.chat.id,
        message.message_thread_id,
        command.sessionId,
      );
      await ctx.reply(conversationText(conversation));
    } catch (error) {
      await ctx.reply(
        `Failed to bind Spur session ${command.sessionId}: ${redactedErrorText(deps, error)}`,
      );
      return;
    }
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
    runtime.workbench.invalidate(owner, "launch");
    await sendSpawnMenu(ctx);
    return;
  }
  if (command?.kind === "spawn") {
    runtime.workbench.invalidate(owner, "launch");
    await requestSpawnProject(
      runtime,
      ctx,
      message.chat.id,
      message.message_thread_id,
      from.id,
      command.agent,
      command.prompt,
    );
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
    await ctx.reply(
      deleted
        ? "Unbound this Telegram thread. An agent send can bind it again."
        : "No Spur session bound here.",
    );
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
  attachments?: SendMessageAttachment[],
): Promise<void> {
  const deps = runtime.deps;
  const key = telegramBindingKey(message.chat.id, message.message_thread_id);

  const peekedSpawn = peekPendingSpawn(
    runtime,
    message.chat.id,
    message.message_thread_id,
    from.id,
  );
  if (peekedSpawn === "expired") {
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    await ctx.reply(SPAWN_EXPIRED_TEXT);
    return;
  }
  if (peekedSpawn && peekedSpawn.project !== undefined) {
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    await bindSpawnedSession(runtime, ctx, message.chat.id, message.message_thread_id, {
      agent: peekedSpawn.agent,
      project: peekedSpawn.project,
      prompt: text,
      ...(attachments ? { attachments } : {}),
    });
    return;
  }
  // `peekedSpawn` here, if present, is an awaiting-project record: it never
  // preempts a live bound session, but it must survive free text and skip
  // autoSpawn when there's no session to deliver to (see routeTelegramPrompt
  // doc comment above and spec revision 2 G2).
  const hasAwaitingProject = peekedSpawn !== null;

  // Private/group-main bot-message replies reach their sender without
  // changing bindings or auto-spawning.
  const ownerId = telegramReplyOwner(deps, message);
  if (ownerId !== null) {
    const owner = await findSession(deps, ownerId);
    if (!owner) {
      await ctx.reply(`Spur session ${ownerId} is gone. Message not delivered.`);
      return;
    }
    await deliverRoutedPrompt(runtime, ctx, message, owner, text);
    return;
  }

  let binding = runtime.bindings.get(key);
  if (!binding) {
    mergePersistedBindings(runtime);
    binding = runtime.bindings.get(key);
  }
  if (!binding) {
    if (hasAwaitingProject) {
      await ctx.reply("Pick a project for the pending /spawn, or run /spawn again.");
      return;
    }
    const acquireResult = tryAcquireAutoSpawn(runtime, key);
    switch (acquireResult.status) {
      case "busy":
        await ctx.reply("Spawn already in progress here.");
        return;
      case "acquired":
        await runAutoSpawn(
          runtime,
          ctx,
          message.chat.id,
          message.message_thread_id,
          text,
          key,
          acquireResult.autoSpawn,
          attachments,
        );
        return;
      case "off":
        break;
    }
    await ctx.reply("No Spur session bound here. Use /watch or /spawn.");
    return;
  }
  const session = await findSession(deps, binding.sessionId);
  if (!session) {
    if (hasAwaitingProject) {
      await ctx.reply("Pick a project for the pending /spawn, or run /spawn again.");
      return;
    }
    const acquireResult = tryAcquireAutoSpawn(runtime, key);
    switch (acquireResult.status) {
      case "busy":
        await ctx.reply("Spawn already in progress here.");
        return;
      case "acquired":
        await unbindTelegramThread(runtime, message.chat.id, message.message_thread_id);
        await runAutoSpawn(
          runtime,
          ctx,
          message.chat.id,
          message.message_thread_id,
          text,
          key,
          acquireResult.autoSpawn,
          attachments,
        );
        return;
      case "off":
        break;
    }
    await unbindTelegramThread(runtime, message.chat.id, message.message_thread_id);
    await ctx.reply(`Spur session ${binding.sessionId} is gone. Unbound. Use /watch or /spawn.`);
    return;
  }
  await deliverRoutedPrompt(runtime, ctx, message, session, text);
}

function telegramReplyOwner(
  deps: SourceStartDeps<TelegramSourceConfig>,
  message: TelegramTextMessage,
): string | null {
  const repliedTo = message.reply_to_message?.message_id;
  return repliedTo === undefined || (message.chat.id < 0 && message.message_thread_id !== undefined)
    ? null
    : findTelegramMessageSession(
        deps.dataDir,
        deps.projectId,
        deps.sourceId,
        message.chat.id,
        repliedTo,
      );
}

/**
 * A message waits in the queue unless the agent is idle (waiting, or parked
 * and woken by the send); the placeholder says so instead of claiming thought.
 */
function placeholderText(label: string, state: string): string {
  if (state === "needs_input") {
    return `Received. ${label} needs input in its terminal; your message is queued.`;
  }
  if (state === "working" || state === "rate_limited" || state === "error") {
    return `Received. ${label} is busy; your message is queued.`;
  }
  return `Received. ${label} is thinking...`;
}

/**
 * Hands a routed prompt to one live session: posts the thinking placeholder,
 * records it as the reply target, then emits. A session that would drop the
 * message gets a notice instead, so the user never waits on a dead agent.
 */
async function deliverRoutedPrompt(
  runtime: TelegramRuntime,
  ctx: Pick<TelegramTextContext, "reply" | "api">,
  message: TelegramTextMessage,
  session: SourceSessionListItem,
  text: string,
): Promise<void> {
  const deps = runtime.deps;
  const conversation = await guardAgentInput(runtime, ctx, message, session.id);
  if (!conversation) return;
  const label = formatTelegramSessionLabel(session.id, session.title?.trim() || undefined);
  if (session.inactive) {
    await ctx.reply(`${label} is not active. Message not delivered.`);
    return;
  }
  let statusMessageId: number | undefined;
  try {
    statusMessageId = extractMessageId(await ctx.reply(placeholderText(label, session.state)));
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram ack failed: ${errorText(error)}`,
    );
  }
  const currentSession = await findSession(deps, session.id);
  if (
    !currentSession ||
    currentSession.inactive ||
    !conversationIsCurrent(deps, session.id, conversation)
  ) {
    await ctx.reply("Agent conversation changed. Message not delivered.");
    return;
  }
  // Read and replaced in one synchronous step: a reply that claimed the old
  // placeholder before this point is not superseded, and one that starts after
  // it reads the new placeholder.
  const superseded =
    statusMessageId !== undefined ? supersededPlaceholder(deps, session.id, message) : undefined;
  recordTelegramReplyTarget(deps, {
    sessionId: session.id,
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined
      ? { messageThreadId: message.message_thread_id }
      : {}),
    ...(statusMessageId !== undefined ? { statusMessageId } : {}),
  });
  rememberSent(deps, session.id, message.chat.id, statusMessageId);
  deps.emit(TELEGRAM_MESSAGE_EVENT, eventData(message, session.id, text));
  if (superseded !== undefined && ctx.api) {
    // Best-effort: the superseded placeholder stops claiming the agent is thinking.
    try {
      await ctx.api.editMessageText(message.chat.id, superseded, "Received.");
    } catch {
      // Already edited or deleted: nothing left to clear.
    }
  }
}

/** The unconsumed placeholder in this chat and thread, if the session has one. */
function supersededPlaceholder(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
  message: TelegramTextMessage,
): number | undefined {
  const previous = readTelegramReplyTarget(deps.dataDir, sessionId);
  return previous && isSameTelegramTarget(previous, message.chat.id, message.message_thread_id)
    ? previous.statusMessageId
    : undefined;
}

/** Records a bot message so a user reply to it routes back to the session. */
function rememberSent(
  deps: SourceStartDeps<TelegramSourceConfig>,
  sessionId: string,
  chatId: number,
  messageId: number | undefined,
): void {
  if (messageId === undefined) return;
  try {
    recordTelegramMessages(deps.dataDir, deps.projectId, deps.sourceId, { sessionId, chatId }, [
      messageId,
    ]);
  } catch (error) {
    logPersistError(deps, error);
  }
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
  intake: TelegramIntake,
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
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram voice transcription failed: ${redactedErrorText(deps, error)}`,
    );
    if (isAborted(deps)) return;
    try {
      await editOrReply(
        ctx,
        message.chat.id,
        statusMessageId,
        `Voice transcription failed: ${redactedErrorText(deps, error)}`,
      );
    } catch (noticeError) {
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] telegram voice failure notice failed: ${redactedErrorText(deps, noticeError)}`,
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

  if (!telegramIntakeIsCurrent(runtime, message, from.id, intake)) {
    await editOrReply(
      ctx,
      message.chat.id,
      statusMessageId,
      "Voice context changed. Send the message again.",
    );
    return;
  }
  try {
    await editOrReply(
      ctx,
      message.chat.id,
      statusMessageId,
      intake.kind === "agent" ? `Heard: "${trimmed}"` : "Voice task received.",
    );
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram voice echo failed: ${redactedErrorText(deps, error)}`,
    );
  }
  if (isAborted(deps) || !telegramIntakeIsCurrent(runtime, message, from.id, intake)) return;

  if (intake.kind === "agent") {
    if (!conversationIsCurrent(deps, intake.sessionId, intake.conversation)) return;
    const session = await findSession(deps, intake.sessionId);
    if (session && conversationIsCurrent(deps, intake.sessionId, intake.conversation))
      await deliverRoutedPrompt(runtime, ctx, message, session, trimmed);
  } else {
    await routeTelegramPrompt(runtime, ctx, message, from, trimmed);
  }
}

type TelegramIntake =
  | { kind: "agent"; sessionId: string; conversation: TelegramConversation }
  | { kind: "spawn"; binding: string | undefined; pending: TelegramPendingSpawn; autoSpawn?: never }
  | {
      kind: "spawn";
      binding: string | undefined;
      pending: null;
      autoSpawn: TelegramAutoSpawnConfig;
    };

function telegramIntakeIsCurrent(
  runtime: TelegramRuntime,
  message: TelegramTextMessage,
  userId: number,
  intake: TelegramIntake,
): boolean {
  const deps = runtime.deps;
  if (intake.kind === "agent")
    return conversationIsCurrent(deps, intake.sessionId, intake.conversation);
  const binding = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId).get(
    telegramBindingKey(message.chat.id, message.message_thread_id),
  )?.sessionId;
  if (binding !== intake.binding) return false;
  const pending = peekPendingSpawn(runtime, message.chat.id, message.message_thread_id, userId);
  if (intake.pending !== null) return pending === intake.pending;
  return (
    pending === null &&
    deps.config.autoSpawn?.enabled === true &&
    deps.config.autoSpawn.agent === intake.autoSpawn.agent &&
    deps.config.autoSpawn.project === intake.autoSpawn.project
  );
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
  const message = ctx.message
    ? { ...ctx.message, message_thread_id: telegramMessageThreadId(ctx.message) }
    : undefined;
  if (!message?.voice) return;
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;
  if (!from) return;

  const binding = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId).get(
    telegramBindingKey(message.chat.id, message.message_thread_id),
  )?.sessionId;
  const replyOwner = telegramReplyOwner(deps, message);
  const pending = peekPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
  let intake: TelegramIntake;
  if (
    replyOwner !== null ||
    (binding !== undefined && !(pending && pending !== "expired" && pending.project !== undefined))
  ) {
    const sessionId = replyOwner ?? binding;
    if (sessionId === undefined) return;
    const conversation = await guardAgentInput(runtime, ctx, message, sessionId);
    if (!conversation) return;
    const session = await findSession(deps, sessionId);
    if (!session || session.inactive || !conversationIsCurrent(deps, sessionId, conversation)) {
      await ctx.reply("Agent is not active. Message not delivered.");
      return;
    }
    intake = { kind: "agent", sessionId, conversation };
  } else if (pending && pending !== "expired") {
    intake = { kind: "spawn", binding, pending };
  } else if (deps.config.autoSpawn?.enabled === true) {
    intake = { kind: "spawn", binding, pending: null, autoSpawn: { ...deps.config.autoSpawn } };
  } else {
    await ctx.reply(
      pending === "expired" ? SPAWN_EXPIRED_TEXT : "Use /spawn to send a voice task.",
    );
    return;
  }

  let statusMessageId: number | undefined;
  try {
    statusMessageId = extractMessageId(await ctx.reply("Transcribing voice message..."));
  } catch (error) {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram voice ack failed: ${errorText(error)}`,
    );
  }

  void transcribeAndRoute(runtime, ctx, message, from, statusMessageId, intake).catch(
    (error: unknown) => reportVoiceFailure(deps, ctx, error),
  );
}

async function handleTelegramPhoto(
  ctx: TelegramTextContext,
  runtime: TelegramRuntime,
): Promise<void> {
  const deps = runtime.deps;
  if (!(await rememberUpdate(runtime, ctx.update))) return;
  const message = ctx.message
    ? { ...ctx.message, message_thread_id: telegramMessageThreadId(ctx.message) }
    : undefined;
  if (!message?.photo?.length || !message.from) return;
  const from = message.from;
  if (!isAllowed(deps.config, message.chat.id, from)) return;

  const binding = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId).get(
    telegramBindingKey(message.chat.id, message.message_thread_id),
  )?.sessionId;
  const pending = peekPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
  if (pending === "expired") {
    clearPendingSpawn(runtime, message.chat.id, message.message_thread_id, from.id);
    await ctx.reply(SPAWN_EXPIRED_TEXT);
    return;
  }
  let intake: Extract<TelegramIntake, { kind: "spawn" }>;
  if (pending?.project !== undefined) {
    intake = { kind: "spawn", binding, pending };
  } else {
    const sessionId = telegramReplyOwner(deps, message) ?? binding;
    if (sessionId !== undefined) {
      const conversation = await guardAgentInput(runtime, ctx, message, sessionId);
      if (!conversation) return;
      const session = await findSession(deps, sessionId);
      await ctx.reply(
        !session || session.inactive
          ? "Agent is not active. Message not delivered."
          : "Photos are supported for new tasks only. Use /spawn to send an image task.",
      );
      return;
    }
    if (pending) {
      await ctx.reply("Pick a project for the pending /spawn, or run /spawn again.");
      return;
    }
    if (deps.config.autoSpawn?.enabled !== true) {
      await ctx.reply("Use /spawn to send an image task.");
      return;
    }
    intake = { kind: "spawn", binding, pending: null, autoSpawn: { ...deps.config.autoSpawn } };
  }
  const autoSpawnSnapshot = JSON.stringify(deps.config.autoSpawn);
  void (async () => {
    try {
      if (!ctx.getFile) throw new Error("Telegram file API unavailable");
      const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(60_000)]);
      const file = await ctx.getFile(signal);
      if (!file.file_path) throw new Error("Telegram returned no file path for this photo");
      const response = await fetch(
        `https://api.telegram.org/file/bot${deps.config.token}/${file.file_path}`,
        { signal },
      );
      if (!response.ok)
        throw new Error(`Telegram photo download failed with status ${response.status}`);
      if (!response.body) throw new Error("Telegram returned an empty photo");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          byteLength += chunk.value.byteLength;
          if (byteLength > MAX_ATTACHMENT_BYTES) {
            await reader.cancel();
            throw new Error("Photo exceeds 5MB");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (byteLength === 0) throw new Error("Telegram returned an empty photo");
      const bytes = Buffer.concat(chunks, byteLength);
      if (isAborted(deps)) return;
      if (
        !telegramIntakeIsCurrent(runtime, message, from.id, intake) ||
        (intake.pending === null && JSON.stringify(deps.config.autoSpawn) !== autoSpawnSnapshot)
      ) {
        await ctx.reply("Image context changed. Send the message again.");
        return;
      }
      await routeTelegramPrompt(
        runtime,
        ctx,
        message,
        from,
        message.caption?.trim() || "Inspect the attached image.",
        [{ name: `telegram-${message.message_id}.jpg`, data: bytes.toString("base64") }],
      );
    } catch (error) {
      deps.logger.warn?.(
        `[source:${deps.projectId}/${deps.sourceId}] telegram photo failed: ${redactedErrorText(deps, error)}`,
      );
      if (!isAborted(deps))
        await ctx.reply(`Image task failed: ${redactedErrorText(deps, error)}`);
    }
  })().catch((error: unknown) => {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram photo notice failed: ${redactedErrorText(deps, error)}`,
    );
  });
}

async function reportVoiceFailure(
  deps: SourceStartDeps<TelegramSourceConfig>,
  ctx: TelegramTextContext,
  error: unknown,
): Promise<void> {
  deps.logger.warn?.(
    `[source:${deps.projectId}/${deps.sourceId}] telegram voice failed: ${redactedErrorText(deps, error)}`,
  );
  if (!isAborted(deps)) await noticeUndelivered(deps, ctx);
}

async function startTelegramSource(
  deps: SourceStartDeps<TelegramSourceConfig>,
): Promise<SourceHandle> {
  if (!deps.getSession) throw new Error("Telegram source requires getSession");
  const bindings = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId);
  const lastUpdateId = readTelegramLastUpdateId(deps.dataDir, deps.projectId, deps.sourceId);
  let writeQueue = Promise.resolve();
  const runtime: TelegramRuntime = {
    deps,
    bindings,
    ...(lastUpdateId !== undefined ? { lastUpdateId } : {}),
    pendingSpawns: new Map(),
    autoSpawnInFlight: new Set(),
    workbench: new TelegramWorkbench(),
    persistBindings(): Promise<void> {
      const next = writeQueue.then(() => {
        const persisted = readTelegramBindings(deps.dataDir, deps.projectId, deps.sourceId);
        bindings.clear();
        for (const [key, binding] of persisted) {
          bindings.set(key, binding);
        }
        for (const [key, binding] of bindings) {
          const record = readSession(deps.dataDir, binding.sessionId);
          if (
            record?.status === "completed" ||
            record?.status === "killed" ||
            telegramTopicIsDeleting(deps.dataDir, binding.chatId, binding.messageThreadId)
          ) {
            bindings.delete(key);
          }
        }
        return writeTelegramBindings(
          deps.dataDir,
          deps.projectId,
          deps.sourceId,
          bindings.values(),
          {
            ...(runtime.lastUpdateId !== undefined ? { lastUpdateId: runtime.lastUpdateId } : {}),
          },
        );
      });
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
    runtime.botIdentity = { id: me.id, ...(me.username ? { username: me.username } : {}) };
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
  bot.catch(async (error: unknown) => {
    deps.logger.warn?.(
      `[source:${deps.projectId}/${deps.sourceId}] telegram update failed: ${redactedErrorText(deps, error)}`,
    );
    if (isAborted(deps)) return;
    if (typeof error !== "object" || error === null || !("ctx" in error)) return;
    await noticeUndelivered(deps, error.ctx as TelegramTextContext | TelegramCallbackContext);
  });
  bot.on("message:text", async (ctx: Context) => {
    await handleTelegramText(ctx as TelegramTextContext, runtime);
  });
  bot.on("message:voice", async (ctx: Context) => {
    try {
      await handleTelegramVoice(ctx as TelegramTextContext, runtime);
    } catch (error) {
      await reportVoiceFailure(deps, ctx as TelegramTextContext, error);
    }
  });
  bot.on("message:photo", async (ctx: Context) => {
    await handleTelegramPhoto(ctx as TelegramTextContext, runtime);
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
    runtime.workbench.clear();
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
    ...(runtime.botIdentity ? { telegramBotIdentity: runtime.botIdentity } : {}),
  };
}

export const telegramSourceModule = {
  type: "telegram",
  start: startTelegramSource,
} satisfies SourceModule<TelegramSourceConfig>;
