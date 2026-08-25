import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEventLog } from "../../src/event-log.js";
import * as metadataModule from "../../src/metadata.js";
import { writeTelegramBindings } from "../../src/metadata.js";
import { createTempDir } from "../helpers/common.js";

const botInstances: FakeBot[] = [];
const runMock = vi.fn();
const getMeMock = vi.fn().mockResolvedValue({ username: "SpurProjectsBot" });

class FakeBot {
  readonly handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  readonly catch = vi.fn();
  readonly api = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    setChatMenuButton: vi.fn().mockResolvedValue(true),
    getMe: getMeMock,
  };

  constructor(readonly token: string) {
    botInstances.push(this);
  }

  on(event: string, handler: (ctx: unknown) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  async emitText(ctx: unknown): Promise<void> {
    const handler = this.handlers.get("message:text");
    if (!handler) throw new Error("missing message:text handler");
    await handler(ctx);
  }

  async emitCallback(ctx: unknown): Promise<void> {
    const handler = this.handlers.get("callback_query:data");
    if (!handler) throw new Error("missing callback_query:data handler");
    await handler(ctx);
  }

  async emitVoice(ctx: unknown): Promise<void> {
    const handler = this.handlers.get("message:voice");
    if (!handler) throw new Error("missing message:voice handler");
    await handler(ctx);
  }
}

vi.mock("grammy", () => ({
  Bot: FakeBot,
}));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

const { parseTelegramCommand, telegramSourceModule, wrapTelegramSpawnPrompt } =
  await import("../../src/event-sources/telegram.js");

const tempDirs: string[] = [];

function telegramContext(overrides: Record<string, unknown> = {}) {
  const { updateId, ...messageOverrides } = overrides;
  return {
    ...(typeof updateId === "number" ? { update: { update_id: updateId } } : {}),
    message: {
      message_id: 10,
      message_thread_id: 22,
      text: "hello agent",
      chat: { id: -1001 },
      from: { id: 123, username: "alek" },
      ...messageOverrides,
    },
    reply: vi.fn().mockResolvedValue({}),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  };
}

function telegramVoiceContext(overrides: Record<string, unknown> = {}) {
  const { updateId, getFile, ...messageOverrides } = overrides;
  return {
    ...(typeof updateId === "number" ? { update: { update_id: updateId } } : {}),
    message: {
      message_id: 10,
      message_thread_id: 22,
      chat: { id: -1001 },
      from: { id: 123, username: "alek" },
      voice: { file_id: "file-1", file_unique_id: "unique-1", duration: 3 },
      ...messageOverrides,
    },
    reply: vi.fn().mockResolvedValue({ message_id: 55 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
    getFile: getFile ?? vi.fn().mockResolvedValue({ file_path: "voice/file_1.oga" }),
  };
}

async function startSource(
  dataDir: string,
  emit = vi.fn(),
  spawnSession = vi.fn(),
  overrides: {
    listSessions?: ReturnType<typeof vi.fn>;
    stop?: ReturnType<typeof vi.fn>;
    task?: ReturnType<typeof vi.fn>;
    config?: Record<string, unknown>;
    webBaseUrl?: string | null;
    resolveWebBaseUrl?: () => Promise<string | null>;
  } = {},
) {
  const listSessions =
    overrides.listSessions ??
    vi.fn().mockResolvedValue([
      {
        id: "api-1",
        project: "api",
        agent: "codex",
        state: "waiting",
      },
      {
        id: "api-2",
        project: "api",
        agent: "claude",
        state: "working",
      },
      {
        id: "web-1",
        project: "web",
        agent: "cursor",
        state: "waiting",
      },
    ]);
  const stop = overrides.stop ?? vi.fn().mockResolvedValue(undefined);
  const task = overrides.task ?? vi.fn().mockReturnValue(Promise.resolve());
  const logger = { info: vi.fn(), warn: vi.fn() };
  runMock.mockReturnValue({
    stop,
    start: vi.fn(),
    size: vi.fn(),
    task,
    isRunning: vi.fn(),
  });
  const handle = await telegramSourceModule.start({
    sourceId: "telegram",
    projectId: "api",
    dataDir,
    config: {
      type: "telegram",
      runOnStart: false,
      token: "token-123",
      allowedUsers: [123],
      ...overrides.config,
    },
    emit,
    signal: new AbortController().signal,
    logger,
    listSessions,
    spawnSession,
    resolveWebBaseUrl:
      overrides.resolveWebBaseUrl ??
      (() =>
        Promise.resolve(
          overrides.webBaseUrl !== undefined ? overrides.webBaseUrl : "http://127.0.0.1:5555",
        )),
  });
  return { bot: botInstances[0], emit, handle, listSessions, logger, spawnSession, stop, task };
}

describe("parseTelegramCommand", () => {
  it("parses watch commands with optional bot mention", () => {
    expect(parseTelegramCommand("/watch api-1")).toEqual({ kind: "watch", sessionId: "api-1" });
    expect(parseTelegramCommand("/watch@SpurProjectsBot api-2")).toEqual({
      kind: "watch",
      sessionId: "api-2",
    });
  });

  it("parses unwatch and watch menu", () => {
    expect(parseTelegramCommand("/unwatch")).toEqual({ kind: "unwatch" });
    expect(parseTelegramCommand("/watch")).toEqual({ kind: "watch_menu" });
    expect(parseTelegramCommand("/watch api-1 extra")).toEqual({ kind: "invalid_watch" });
  });

  it("parses help, agents, and spawn commands", () => {
    expect(parseTelegramCommand("/start")).toEqual({ kind: "help" });
    expect(parseTelegramCommand("/help@SpurProjectsBot")).toEqual({ kind: "help" });
    expect(parseTelegramCommand("/agents")).toEqual({ kind: "agents" });
    expect(parseTelegramCommand("/spawn")).toEqual({ kind: "spawn_menu" });
    expect(parseTelegramCommand("/spawn codex")).toEqual({ kind: "spawn", agent: "codex" });
    expect(parseTelegramCommand("/spawn opencode")).toEqual({ kind: "spawn", agent: "opencode" });
    expect(parseTelegramCommand("/spawn codex fix bug")).toEqual({
      kind: "spawn",
      agent: "codex",
      prompt: "fix bug",
    });
    expect(parseTelegramCommand("/spawn bogus")).toBeNull();
  });

  it("matches only bare or own-addressed commands when a bot username is known", () => {
    expect(parseTelegramCommand("/watch@spurbot api-1", "spurbot")).toEqual({
      kind: "watch",
      sessionId: "api-1",
    });
    expect(parseTelegramCommand("/watch@otherbot api-1", "spurbot")).toBeNull();
    expect(parseTelegramCommand("/help@SPURBOT", "spurbot")).toEqual({ kind: "help" });
    expect(parseTelegramCommand("/watch")).toEqual({ kind: "watch_menu" });
  });
});

describe("wrapTelegramSpawnPrompt", () => {
  it("produces exactly the suffix that packages/web strips via TELEGRAM_REPLY_SUFFIX", () => {
    // Mirror of TELEGRAM_REPLY_SUFFIX in packages/web/src/lib/session-prompt.ts.
    // Both must stay in sync: if one changes, the web UI will display the raw
    // suffix instead of stripping it.
    const suffix = [
      "",
      "",
      "Source: telegram. The requester only sees messages you send with:",
      'spur source reply "<message>"',
      "Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.",
    ].join("\n");
    expect(wrapTelegramSpawnPrompt("fix the sidecar")).toBe(`fix the sidecar${suffix}`);
  });
});

describe("telegramSourceModule", () => {
  beforeEach(() => {
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("binds a Telegram thread with /watch and emits bound messages", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const watchCtx = telegramContext({ text: "/watch api-1" });
    await bot.emitText(watchCtx);
    expect(watchCtx.reply).toHaveBeenCalledWith(
      "Bound this Telegram thread to Spur session api-1.",
    );

    await bot.emitText(telegramContext());

    expect(emit).toHaveBeenCalledWith("telegram:message", {
      sessionId: "api-1",
      chatId: -1001,
      messageThreadId: 22,
      userId: 123,
      username: "alek",
      messageId: 10,
      text: "hello agent",
    });
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-1"');
    const replyTargetPath = join(
      dataDir,
      "source-state",
      "telegram",
      "reply-targets",
      "api-1.json",
    );
    await expect(readFile(replyTargetPath, "utf8")).resolves.toContain('"sourceId": "telegram"');
  });

  it("shows project selection when /watch or /agents has no session id", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, listSessions } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const watchCtx = telegramContext({ text: "/watch" });
    await bot.emitText(watchCtx);

    expect(listSessions).toHaveBeenCalled();
    expect(watchCtx.reply).toHaveBeenCalledWith("Select a project:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "api (2)", callback_data: "spur_project:api" }],
          [{ text: "web (1)", callback_data: "spur_project:web" }],
        ],
      },
    });

    const agentsCtx = telegramContext({ text: "/agents" });
    await bot.emitText(agentsCtx);
    expect(agentsCtx.reply).toHaveBeenCalledWith("Select a project:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "api (2)", callback_data: "spur_project:api" }],
          [{ text: "web (1)", callback_data: "spur_project:web" }],
        ],
      },
    });
  });

  it("navigates project sessions with status emojis and back button", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_project:api",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith("Select a Spur session in api:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟡 api-1 codex waiting", callback_data: "spur_watch:api-1" }],
          [{ text: "🟢 api-2 claude working", callback_data: "spur_watch:api-2" }],
          [{ text: "« Back to projects", callback_data: "spur_projects" }],
        ],
      },
    });

    editMessageText.mockClear();
    answerCallbackQuery.mockClear();

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_projects",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith("Select a project:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "api (2)", callback_data: "spur_project:api" }],
          [{ text: "web (1)", callback_data: "spur_project:web" }],
        ],
      },
    });
  });

  it("shows the session title in the picker label", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi
      .fn()
      .mockResolvedValue([
        { id: "s-1", project: "proj", agent: "claude", state: "working", title: "Fix telegram" },
      ]);
    const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_project:proj",
        message: { message_thread_id: 22, chat: { id: -1001 } },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
    });

    expect(editMessageText).toHaveBeenCalledWith("Select a Spur session in proj:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟢 s-1 working — Fix telegram", callback_data: "spur_watch:s-1" }],
          [{ text: "« Back to projects", callback_data: "spur_projects" }],
        ],
      },
    });
  });

  it("handles empty sessions and formats all state emojis", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi.fn().mockResolvedValue([
      { id: "s-1", project: "proj", agent: "codex", state: "working" },
      { id: "s-2", project: "proj", agent: "claude", state: "waiting" },
      { id: "s-3", project: "proj", agent: "cursor", state: "needs_input" },
      { id: "s-4", project: "proj", agent: "codex", state: "error" },
      { id: "s-5", project: "proj", agent: "claude", state: "stopped" },
      { id: "s-6", project: "proj", agent: "cursor", state: "rate_limited" },
      { id: "s-7", project: "proj", agent: "cursor", state: "other" },
    ]);
    const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_project:proj",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(editMessageText).toHaveBeenCalledWith("Select a Spur session in proj:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🟢 s-1 codex working", callback_data: "spur_watch:s-1" }],
          [{ text: "🟡 s-2 claude waiting", callback_data: "spur_watch:s-2" }],
          [{ text: "🔴 s-3 cursor needs_input", callback_data: "spur_watch:s-3" }],
          [{ text: "🔴 s-4 codex error", callback_data: "spur_watch:s-4" }],
          [{ text: "⚫ s-5 claude stopped", callback_data: "spur_watch:s-5" }],
          [{ text: "⏳ s-6 cursor rate_limited", callback_data: "spur_watch:s-6" }],
          [{ text: "⚪ s-7 cursor other", callback_data: "spur_watch:s-7" }],
          [{ text: "« Back to projects", callback_data: "spur_projects" }],
        ],
      },
    });

    // Test empty sessions on /watch
    listSessions.mockResolvedValueOnce([]);
    const emptyCtx = telegramContext({ text: "/watch" });
    await bot.emitText(emptyCtx);
    expect(emptyCtx.reply).toHaveBeenCalledWith("No active Spur sessions.");
  });

  it("shows help and spawn menus without emitting to agents", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const startCtx = telegramContext({ text: "/start" });
    await bot.emitText(startCtx);
    expect(startCtx.reply).toHaveBeenCalledWith(
      expect.stringContaining("/agents - list active agents"),
    );

    const spawnCtx = telegramContext({ text: "/spawn" });
    await bot.emitText(spawnCtx);
    expect(spawnCtx.reply).toHaveBeenCalledWith("Select an agent to spawn:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "codex", callback_data: "spur_spawn:codex" },
            { text: "claude", callback_data: "spur_spawn:claude" },
            { text: "cursor", callback_data: "spur_spawn:cursor" },
            { text: "opencode", callback_data: "spur_spawn:opencode" },
          ],
        ],
      },
    });
    const unknownCtx = telegramContext({ text: "/unknown", chat: { id: 123 } });
    await bot.emitText(unknownCtx);
    expect(unknownCtx.reply).toHaveBeenCalledWith("Unknown command. Use /help.");

    expect(emit).not.toHaveBeenCalled();
  });

  it("stays silent on unknown/foreign commands in groups", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const unknownGroupCtx = telegramContext({ text: "/unknown" });
    await bot.emitText(unknownGroupCtx);
    expect(unknownGroupCtx.reply).not.toHaveBeenCalled();

    const foreignGroupCtx = telegramContext({ text: "/watch@otherbot" });
    await bot.emitText(foreignGroupCtx);
    expect(foreignGroupCtx.reply).not.toHaveBeenCalled();

    expect(emit).not.toHaveBeenCalled();

    const unknownPrivateCtx = telegramContext({ text: "/unknown", chat: { id: 123 } });
    await bot.emitText(unknownPrivateCtx);
    expect(unknownPrivateCtx.reply).toHaveBeenCalledWith("Unknown command. Use /help.");
  });

  it("binds a Telegram thread from a watch menu callback", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_watch:api-2",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Bound api-2.");
    expect(editMessageText).toHaveBeenCalledWith(
      "Bound this Telegram thread to Spur session api-2.",
    );
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-2"');
  });

  it("routes inbound messages to agent-created topic bindings after startup", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramBindings(dataDir, "api", "telegram", [
      { chatId: -1001, messageThreadId: 44, sessionId: "api-1" },
    ]);

    await bot.emitText(telegramContext({ message_thread_id: 44, text: "reply in topic" }));

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", messageThreadId: 44, text: "reply in topic" }),
    );
  });

  it("preserves agent-created topic bindings when persisting watch changes", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramBindings(dataDir, "api", "telegram", [
      { chatId: -1001, messageThreadId: 44, sessionId: "api-1" },
    ]);

    await bot.emitText(
      telegramContext({ text: "/watch api-2", chat: { id: 123 }, message_thread_id: undefined }),
    );

    const state = JSON.parse(
      await readFile(join(dataDir, "source-state", "telegram", "api", "telegram.json"), "utf8"),
    ) as { bindings: unknown[] };
    expect(state.bindings).toEqual(
      expect.arrayContaining([
        { chatId: -1001, messageThreadId: 44, sessionId: "api-1" },
        { chatId: 123, sessionId: "api-2" },
      ]),
    );
  });

  it("rejects binding the same session to another Telegram target", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", chat: { id: 123 } }));
    const secondWatchCtx = telegramContext({ text: "/watch api-1", chat: { id: 456 } });
    await bot.emitText(secondWatchCtx);

    expect(secondWatchCtx.reply).toHaveBeenCalledWith(
      "Spur session api-1 is already bound elsewhere.",
    );
  });

  it("rejects watch callback binding when the session is bound elsewhere", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitText(telegramContext({ text: "/watch api-1", chat: { id: 123 } }));
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_watch:api-1",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Session is already bound elsewhere.");
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("asks for a prompt before spawning and binding a new session", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);
    expect(spawnCtx.reply).toHaveBeenCalledWith("Send task prompt for new codex Spur agent.");
    expect(spawnSession).not.toHaveBeenCalled();

    const promptCtx = telegramContext({ text: "fix the sidecar" });
    await bot.emitText(promptCtx);

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "codex",
        prompt: expect.stringContaining("fix the sidecar"),
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain('spur source reply "<message>"');
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawning codex agent...");
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawned and bound: api-3.");
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-3"');
  });

  it("clears a pending spawn when the user binds an existing session", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const emit = vi.fn();
    const { bot } = await startSource(dataDir, emit, spawnSession);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/spawn codex" }));
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    await bot.emitText(telegramContext({ text: "send this to api-1" }));

    expect(spawnSession).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({
        sessionId: "api-1",
        text: "send this to api-1",
      }),
    );
  });

  it("limits abandoned pending spawn prompts", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    for (let threadId = 1; threadId <= 101; threadId += 1) {
      await bot.emitText(telegramContext({ message_thread_id: threadId, text: "/spawn codex" }));
    }
    const promptCtx = telegramContext({ message_thread_id: 1, text: "old prompt" });
    await bot.emitText(promptCtx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(promptCtx.reply).toHaveBeenCalledWith(
      "No Spur session bound here. Use /watch or /spawn.",
    );
  });

  it("clears a pending spawn on unwatch and tells plain text how to continue", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    await bot.emitText(telegramContext({ text: "/spawn codex" }));
    await bot.emitText(telegramContext({ text: "/unwatch" }));
    const textCtx = telegramContext({ text: "not a spawn prompt" });
    await bot.emitText(textCtx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(textCtx.reply).toHaveBeenCalledWith("No Spur session bound here. Use /watch or /spawn.");
  });

  it("spawns immediately when /spawn includes an agent and prompt", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex fix the sidecar" });
    await bot.emitText(spawnCtx);

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "codex",
        prompt: expect.stringContaining("fix the sidecar"),
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain('spur source reply "<message>"');
    expect(spawnCtx.reply).toHaveBeenCalledWith("Spawning codex agent...");
    expect(spawnCtx.reply).toHaveBeenCalledWith("Spawned and bound: api-3.");
  });

  it("asks for a prompt after a spawn callback", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "claude",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({});

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_spawn:claude",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Selected claude.");
    expect(reply).toHaveBeenCalledWith("Send task prompt for new claude Spur agent.");

    const promptCtx = telegramContext({ text: "review the branch" });
    await bot.emitText(promptCtx);

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "claude",
        prompt: expect.stringContaining("review the branch"),
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain('spur source reply "<message>"');
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawning claude agent...");
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawned and bound: api-3.");
  });

  it("surfaces spawn progress and result", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex fix bug" });
    spawnCtx.reply.mockResolvedValueOnce({ message_id: 55 });
    await bot.emitText(spawnCtx);

    expect(spawnCtx.reply).toHaveBeenNthCalledWith(1, "Spawning codex agent...");
    expect(spawnCtx.api.editMessageText).toHaveBeenCalledWith(
      -1001,
      55,
      "Spawned and bound: api-3.",
    );
  });

  it("reports spawn failure with redacted token", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockRejectedValue(new Error("boom token-123"));
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex fix bug" });
    spawnCtx.reply.mockResolvedValueOnce({ message_id: 55 });
    await bot.emitText(spawnCtx);

    expect(spawnCtx.api.editMessageText).toHaveBeenCalledWith(
      -1001,
      55,
      "Spawn failed: boom <telegram-token>",
    );
  });

  it("ignores unauthorized callbacks", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_watch:api-2",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 999, username: "mallory" },
      },
      answerCallbackQuery,
      editMessageText,
    });
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_spawn:codex",
        message: {
          message_thread_id: 22,
          chat: { id: -1001 },
        },
        from: { id: 999, username: "mallory" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).not.toHaveBeenCalled();
    expect(editMessageText).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("rejects invalid or unknown watch targets", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const invalidCtx = telegramContext({ text: "/watch api-1 extra" });
    await bot.emitText(invalidCtx);
    expect(invalidCtx.reply).toHaveBeenCalledWith("Usage: /watch <sessionId>");

    const unknownCtx = telegramContext({ text: "/watch unknown-1" });
    await bot.emitText(unknownCtx);
    expect(unknownCtx.reply).toHaveBeenCalledWith("No active Spur session unknown-1.");
  });

  it("reports watch bind persist failure", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const persistSpy = vi
      .spyOn(metadataModule, "writeTelegramBindings")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    try {
      const watchCtx = telegramContext({ text: "/watch api-1" });
      await expect(bot.emitText(watchCtx)).resolves.toBeUndefined();
      expect(watchCtx.reply).toHaveBeenCalledWith("Failed to bind Spur session api-1: disk full");
    } finally {
      persistSpy.mockRestore();
    }
  });

  it("ignores messages from unauthorized users", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", from: { id: 999 } }));
    await bot.emitText(telegramContext({ from: { id: 999 } }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores messages without a Telegram user", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", from: undefined }));
    await bot.emitText(telegramContext({ from: undefined }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("acks bound messages and stores the ack for editing by source replies", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", chat: { id: 123 } }));
    const textCtx = telegramContext({ chat: { id: 123 } });
    textCtx.reply.mockResolvedValueOnce({ message_id: 77 });

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith("Sent to Spur agent.");
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ text: "hello agent" }),
    );
    const replyTargetPath = join(
      dataDir,
      "source-state",
      "telegram",
      "reply-targets",
      "api-1.json",
    );
    await expect(readFile(replyTargetPath, "utf8")).resolves.toContain('"statusMessageId": 77');
  });

  it("stamps lastInboundAt when forwarding a bound inbound message", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", chat: { id: 123 } }));
    const textCtx = telegramContext({ chat: { id: 123 } });
    textCtx.reply.mockResolvedValueOnce({ message_id: 77 });

    await bot.emitText(textCtx);

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ text: "hello agent" }),
    );
    const replyTargetPath = join(
      dataDir,
      "source-state",
      "telegram",
      "reply-targets",
      "api-1.json",
    );
    const persisted = JSON.parse(await readFile(replyTargetPath, "utf8")) as {
      lastInboundAt?: string;
    };
    expect(typeof persisted.lastInboundAt).toBe("string");
    expect(new Date(persisted.lastInboundAt ?? "").toString()).not.toBe("Invalid Date");
  });

  it("does not store group acks as editable reply targets", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();
    textCtx.reply.mockResolvedValueOnce({ message_id: 77 });

    await bot.emitText(textCtx);

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ text: "hello agent" }),
    );
    const replyTargetPath = join(
      dataDir,
      "source-state",
      "telegram",
      "reply-targets",
      "api-1.json",
    );
    await expect(readFile(replyTargetPath, "utf8")).resolves.not.toContain('"statusMessageId"');
  });

  it("still emits bound messages when the Telegram ack fails", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, logger } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();
    textCtx.reply.mockRejectedValueOnce(new Error("rate limited"));

    await bot.emitText(textCtx);

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", text: "hello agent" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram ack failed: rate limited",
    );
  });

  it("ignores replayed Telegram updates", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", updateId: 10 }));
    await bot.emitText(telegramContext({ text: "first", updateId: 11 }));
    await bot.emitText(telegramContext({ text: "duplicate", updateId: 11 }));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", text: "first" }),
    );
  });

  it("tells plain text users when no session is bound", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const textCtx = telegramContext({ text: "hello?" });
    await bot.emitText(textCtx);

    expect(emit).not.toHaveBeenCalled();
    expect(textCtx.reply).toHaveBeenCalledWith("No Spur session bound here. Use /watch or /spawn.");
  });

  it("unbinds a dead session before emitting", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, listSessions } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    listSessions.mockResolvedValue([]);

    const textCtx = telegramContext();
    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith(
      "Spur session api-1 is gone. Unbound. Use /watch or /spawn.",
    );
    expect(emit).not.toHaveBeenCalled();
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.not.toContain('"sessionId": "api-1"');
    const replyTargetPath = join(
      dataDir,
      "source-state",
      "telegram",
      "reply-targets",
      "api-1.json",
    );
    await expect(readFile(replyTargetPath, "utf8")).rejects.toThrow();
  });

  const autoSpawnConfig = {
    autoSpawn: {
      enabled: true,
      project: "spur-shepherd",
      agent: "opencode",
      model: "google/gemini-3.7-flash",
      selfDestruct: { enabled: true },
    },
  };

  it("auto-spawns a shepherd session for an unbound chat", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "shp-1",
      project: "spur-shepherd",
      agent: "opencode",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    const ctx = telegramContext({ text: "help me out" });
    await bot.emitText(ctx);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith({
      project: "spur-shepherd",
      agent: "opencode",
      model: "google/gemini-3.7-flash",
      selfDestruct: { enabled: true },
      prompt: expect.stringContaining("help me out"),
    });
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain('spur source reply "<message>"');
    expect(ctx.reply).toHaveBeenCalledWith("Spawned and bound: shp-1.");
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "shp-1"');
  });

  it("keeps the rejection reply when autoSpawn is disabled", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: { autoSpawn: { ...autoSpawnConfig.autoSpawn, enabled: false } },
    });
    if (!bot) throw new Error("missing bot");

    const ctx = telegramContext({ text: "hello?" });
    await bot.emitText(ctx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("No Spur session bound here. Use /watch or /spawn.");
  });

  it("does not auto-spawn when a live session is bound", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot, emit } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext({ text: "still watching" });
    await bot.emitText(textCtx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", text: "still watching" }),
    );
  });

  it("spawns once for two unbound messages in flight", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    let resolveSpawn: (value: unknown) => void = () => {};
    const spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });
    const spawnSession = vi.fn().mockReturnValue(spawnPromise);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    const ctx1 = telegramContext({ text: "first message" });
    const ctx2 = telegramContext({ text: "second message" });
    const a = bot.emitText(ctx1);
    const b = bot.emitText(ctx2);
    resolveSpawn({ id: "shp-2", project: "spur-shepherd", agent: "opencode", state: "working" });
    await Promise.all([a, b]);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    const busyReplies = [ctx1, ctx2].filter((ctx) =>
      ctx.reply.mock.calls.some((call: unknown[]) => call[0] === "Spawn already in progress here."),
    );
    expect(busyReplies).toHaveLength(1);
  });

  it("auto-spawns after the bound session disappears", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "shp-3",
      project: "spur-shepherd",
      agent: "opencode",
      state: "working",
    });
    const { bot, listSessions } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    listSessions.mockResolvedValue([]);

    const textCtx = telegramContext({ text: "still there?" });
    await bot.emitText(textCtx);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(textCtx.reply).not.toHaveBeenCalledWith(expect.stringContaining("is gone. Unbound."));
    expect(textCtx.reply).toHaveBeenCalledWith("Spawned and bound: shp-3.");
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "shp-3"');
    await expect(readFile(statePath, "utf8")).resolves.not.toContain('"sessionId": "api-1"');
  });

  it("does not unbind while an auto-spawn is in flight", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    let resolveSpawn: (value: unknown) => void = () => {};
    const spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });
    const spawnSession = vi.fn().mockReturnValue(spawnPromise);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      listSessions,
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    listSessions.mockResolvedValue([]);

    const persistSpy = vi.spyOn(metadataModule, "writeTelegramBindings");
    persistSpy.mockClear();

    const ctx1 = telegramContext({ text: "still there?" });
    const ctx2 = telegramContext({ text: "still there? (again)" });
    const a = bot.emitText(ctx1);
    const b = bot.emitText(ctx2);
    resolveSpawn({ id: "shp-5", project: "spur-shepherd", agent: "opencode", state: "working" });
    await Promise.all([a, b]);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    const busyReplies = [ctx1, ctx2].filter((ctx) =>
      ctx.reply.mock.calls.some((call: unknown[]) => call[0] === "Spawn already in progress here."),
    );
    expect(busyReplies).toHaveLength(1);
    const removeKeyCalls = persistSpy.mock.calls.filter((call) => {
      const options = call[4] as { removeKeys?: Iterable<string> } | undefined;
      return options?.removeKeys !== undefined;
    });
    expect(removeKeyCalls).toHaveLength(1);
  });

  it("reports the spawn failure and retries on the next message", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom token-123"))
      .mockResolvedValueOnce({
        id: "shp-4",
        project: "spur-shepherd",
        agent: "opencode",
        state: "working",
      });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    const ctx1 = telegramContext({ text: "first try" });
    await bot.emitText(ctx1);

    expect(ctx1.reply).toHaveBeenCalledWith("Spawn failed: boom <telegram-token>");
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
    const replyTargetsDir = join(dataDir, "source-state", "telegram", "reply-targets");
    await expect(readFile(join(replyTargetsDir, "shp-4.json"), "utf8")).rejects.toThrow();

    const ctx2 = telegramContext({ text: "second try" });
    await bot.emitText(ctx2);

    expect(spawnSession).toHaveBeenCalledTimes(2);
    expect(ctx2.reply).toHaveBeenCalledWith("Spawned and bound: shp-4.");
  });

  it("keeps command and pending-spawn paths ahead of autoSpawn", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "shp-6",
      project: "spur-shepherd",
      agent: "opencode",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: autoSpawnConfig,
    });
    if (!bot) throw new Error("missing bot");

    const unwatchCtx = telegramContext({ text: "/unwatch" });
    await bot.emitText(unwatchCtx);
    expect(unwatchCtx.reply).toHaveBeenCalledWith("No Spur session bound here.");

    const unknownCtx = telegramContext({ text: "/notacommand", chat: { id: 555 } });
    await bot.emitText(unknownCtx);
    expect(unknownCtx.reply).toHaveBeenCalledWith("Unknown command. Use /help.");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await bot.emitText(telegramContext({ text: "/spawn codex" }));
      vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
      const expiredCtx = telegramContext({ text: "late prompt" });
      await bot.emitText(expiredCtx);
      expect(expiredCtx.reply).toHaveBeenCalledWith("Spawn prompt expired. Run /spawn again.");
    } finally {
      vi.useRealTimers();
    }

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("sets Telegram commands and command menu button on start", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await Promise.resolve();

    expect(bot.api.setMyCommands).toHaveBeenCalledWith([
      { command: "start", description: "Show Spur bot help" },
      { command: "help", description: "Show Spur bot help" },
      { command: "agents", description: "List active Spur agents" },
      { command: "watch", description: "Bind this chat to a Spur agent" },
      { command: "spawn", description: "Spawn a new Spur agent" },
      { command: "unwatch", description: "Unbind this chat" },
    ]);
    expect(bot.api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: "commands" },
    });
    expect(runMock).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({ sink: { concurrency: 1 } }),
    );
  });

  it("stops the runner when the source stops", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { handle, stop } = await startSource(dataDir);

    await handle.stop();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not crash shutdown after the runner already stopped", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { handle, stop } = await startSource(dataDir);
    stop.mockReturnValue(undefined);

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("logs runner task and stop errors", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const runnerError = new Error("bad token token-123");
    const stopError = new Error("stop failed");
    const { handle, logger } = await startSource(dataDir, vi.fn(), vi.fn(), {
      listSessions: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockRejectedValue(stopError),
      task: vi.fn().mockReturnValue(Promise.reject(runnerError)),
    });

    await Promise.resolve();
    await handle.stop();

    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram runner failed: bad token <telegram-token>",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram runner failed: stop failed",
    );
  });

  it("logs distinct 409 conflict", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const conflictError = new Error("Conflict: terminated by other getUpdates request");
    const { logger } = await startSource(dataDir, vi.fn(), vi.fn(), {
      listSessions: vi.fn().mockResolvedValue([]),
      task: vi.fn().mockReturnValue(Promise.reject(conflictError)),
    });

    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram polling conflict (409): another process or host is polling this bot token; stop the other poller",
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("telegram runner failed"));
  });

  it("logs auth_failed and still starts when getMe fails", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    getMeMock.mockRejectedValueOnce(new Error("unauthorized"));
    const { handle, logger } = await startSource(dataDir, vi.fn(), vi.fn(), {
      listSessions: vi.fn().mockResolvedValue([]),
    });

    expect(handle).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("telegram commands setup failed"),
    );
    const events = readEventLog(dataDir);
    expect(events.some((entry) => entry.event === "source.telegram.auth_failed")).toBe(true);
  });
});

function mockTranscribeFetch(text: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: unknown) => {
    if (typeof url === "string" && url.includes("api.telegram.org")) {
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text }) });
  });
}

describe("telegramSourceModule voice notes", () => {
  beforeEach(() => {
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("A1: emits telegram:message with the transcript as text in a bound chat", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    await bot.emitVoice(telegramVoiceContext());

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit).toHaveBeenCalledWith("telegram:message", {
      sessionId: "api-1",
      chatId: -1001,
      messageThreadId: 22,
      userId: 123,
      username: "alek",
      messageId: 10,
      text: "fix the sidecar",
    });
  });

  it("A2: spawns via wrapTelegramSpawnPrompt when no binding exists", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, spawnSession } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    spawnSession.mockResolvedValue({
      id: "api-9",
      project: "api",
      agent: "codex",
      state: "waiting",
    });
    await bot.emitText(telegramContext({ text: "/spawn codex" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    await bot.emitVoice(telegramVoiceContext());

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalled());
    expect(spawnSession).toHaveBeenCalledWith({
      project: "api",
      agent: "codex",
      prompt: wrapTelegramSpawnPrompt("fix the sidecar"),
    });
  });

  it("A3: a non-2xx transcribe response replies with failure and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, spawnSession } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) => {
        if (typeof url === "string" && url.includes("api.telegram.org")) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          });
        }
        return Promise.resolve({ ok: false, status: 502 });
      }),
    );
    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() =>
      expect(voiceCtx.api.editMessageText).toHaveBeenCalledWith(
        -1001,
        55,
        expect.stringContaining("Voice transcription failed"),
      ),
    );
    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("A3: a rejected fetch replies with failure and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, spawnSession } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() =>
      expect(voiceCtx.api.editMessageText).toHaveBeenCalledWith(
        -1001,
        55,
        expect.stringContaining("Voice transcription failed: network down"),
      ),
    );
    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("A1-G2: an abort mid-fetch on the failure path replies nothing and logs a warning", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const emit = vi.fn();
    const spawnSession = vi.fn();
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    const stop = vi.fn().mockResolvedValue(undefined);
    const task = vi.fn().mockReturnValue(Promise.resolve());
    runMock.mockReturnValue({ stop, start: vi.fn(), size: vi.fn(), task, isRunning: vi.fn() });
    const controller = new AbortController();
    const logger = { info: vi.fn(), warn: vi.fn() };
    await telegramSourceModule.start({
      sourceId: "telegram",
      projectId: "api",
      dataDir,
      config: { type: "telegram", runOnStart: false, token: "token-123", allowedUsers: [123] },
      emit,
      signal: controller.signal,
      logger,
      listSessions,
      spawnSession,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });
    const bot = botInstances[0];
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    let rejectTranscribe: ((error: Error) => void) | undefined;
    const pending = new Promise((_resolve, reject) => {
      rejectTranscribe = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) => {
        if (typeof url === "string" && url.includes("api.telegram.org")) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          });
        }
        return pending;
      }),
    );

    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);
    await vi.waitFor(() => expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2));

    controller.abort();
    rejectTranscribe?.(new DOMException("This operation was aborted", "AbortError"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalledWith(
      -1001,
      55,
      expect.stringContaining("Voice transcription failed"),
    );
    expect(voiceCtx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("Voice transcription failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("telegram voice failed:"));
    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("A4: a repeated update_id performs no download and no emit", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    const fetchMock = mockTranscribeFetch("first take");
    vi.stubGlobal("fetch", fetchMock);
    await bot.emitVoice(telegramVoiceContext({ updateId: 11 }));
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));

    await bot.emitVoice(telegramVoiceContext({ updateId: 11 }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("A5: the handler resolves while the transcribe fetch is still pending", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    let resolveTranscribe: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveTranscribe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) => {
        if (typeof url === "string" && url.includes("api.telegram.org")) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          });
        }
        return pending.then(() => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ text: "later" }),
        }));
      }),
    );

    await bot.emitVoice(telegramVoiceContext());
    expect(emit).not.toHaveBeenCalled();

    resolveTranscribe?.();
    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
  });

  it("A6: a /help transcript emits telegram:message and never sends the help reply", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("/help"));
    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ text: "/help" }),
    );
    expect(voiceCtx.reply).not.toHaveBeenCalledWith(expect.stringContaining("Spur Telegram bot"));
    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("Spur Telegram bot"),
    );
  });

  it("A7: an empty transcript replies with failure and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("   "));
    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() =>
      expect(voiceCtx.api.editMessageText).toHaveBeenCalledWith(
        -1001,
        55,
        expect.stringContaining("empty transcript"),
      ),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("A8: a null webBaseUrl (no ui.port known for this instance) replies unavailable and never fetches", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { webBaseUrl: null });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() =>
      expect(voiceCtx.api.editMessageText).toHaveBeenCalledWith(
        -1001,
        55,
        "Voice transcription is disabled for this Spur instance.",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("A9: posts multipart form with an audio File named voice.ogg", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    const fetchMock = mockTranscribeFetch("fix the sidecar");
    vi.stubGlobal("fetch", fetchMock);
    await bot.emitVoice(telegramVoiceContext());

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const transcribeCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/runtime/voice/transcribe"),
    );
    expect(transcribeCall?.[0]).toBe("http://127.0.0.1:5555/api/runtime/voice/transcribe");
    const body = (transcribeCall?.[1] as { body: FormData }).body;
    const audio = body.get("audio") as File;
    expect(audio.name).toBe("voice.ogg");
  });

  it("guards the ack reply: a rejected placeholder ack still transcribes and routes the prompt", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, logger } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    const voiceCtx = telegramVoiceContext();
    voiceCtx.reply.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    await bot.emitVoice(voiceCtx);

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ text: "fix the sidecar" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram voice ack failed: 429 Too Many Requests",
    );
    // No statusMessageId to edit: the echo and the routing ack both fall
    // back to a fresh ctx.reply call.
    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalled();
  });

  it("A10: a rejected reply on the failure path logs a redacted warning with no unhandled rejection", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, logger } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const voiceCtx = telegramVoiceContext();
    voiceCtx.api.editMessageText.mockRejectedValue(new Error("edit failed"));
    voiceCtx.reply.mockImplementation((text: string) => {
      if (text === "Transcribing voice message...") return Promise.resolve({ message_id: 55 });
      return Promise.reject(new Error("reply failed"));
    });

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      await bot.emitVoice(voiceCtx);
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("telegram voice failed:")),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBe(false);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("A11: a transcription resolving after abort emits nothing, spawns nothing, replies nothing further", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const emit = vi.fn();
    const spawnSession = vi.fn();
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    const stop = vi.fn().mockResolvedValue(undefined);
    const task = vi.fn().mockReturnValue(Promise.resolve());
    runMock.mockReturnValue({ stop, start: vi.fn(), size: vi.fn(), task, isRunning: vi.fn() });
    const controller = new AbortController();
    await telegramSourceModule.start({
      sourceId: "telegram",
      projectId: "api",
      dataDir,
      config: { type: "telegram", runOnStart: false, token: "token-123", allowedUsers: [123] },
      emit,
      signal: controller.signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      listSessions,
      spawnSession,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });
    const bot = botInstances[0];
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    let resolveTranscribe: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveTranscribe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) => {
        if (typeof url === "string" && url.includes("api.telegram.org")) {
          return Promise.resolve({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
          });
        }
        return pending.then(() => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ text: "too late" }),
        }));
      }),
    );

    const voiceCtx = telegramVoiceContext();
    await bot.emitVoice(voiceCtx);
    controller.abort();
    resolveTranscribe?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(voiceCtx.reply).toHaveBeenCalledTimes(1);
    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalledWith(
      -1001,
      55,
      expect.stringContaining("Heard:"),
    );
  });

  it("A1-G7: an abort landing while the echo reply is in flight emits nothing and spawns nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const emit = vi.fn();
    const spawnSession = vi.fn();
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    const stop = vi.fn().mockResolvedValue(undefined);
    const task = vi.fn().mockReturnValue(Promise.resolve());
    runMock.mockReturnValue({ stop, start: vi.fn(), size: vi.fn(), task, isRunning: vi.fn() });
    const controller = new AbortController();
    await telegramSourceModule.start({
      sourceId: "telegram",
      projectId: "api",
      dataDir,
      config: { type: "telegram", runOnStart: false, token: "token-123", allowedUsers: [123] },
      emit,
      signal: controller.signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      listSessions,
      spawnSession,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });
    const bot = botInstances[0];
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));

    let resolveEcho: (() => void) | undefined;
    const pendingEcho = new Promise<void>((resolve) => {
      resolveEcho = resolve;
    });
    const voiceCtx = telegramVoiceContext();
    voiceCtx.api.editMessageText.mockImplementation(() => pendingEcho);

    await bot.emitVoice(voiceCtx);
    await vi.waitFor(() => expect(voiceCtx.api.editMessageText).toHaveBeenCalled());

    controller.abort();
    resolveEcho?.();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
