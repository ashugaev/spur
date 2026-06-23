import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../helpers/common.js";

const botInstances: FakeBot[] = [];
const runMock = vi.fn();

class FakeBot {
  readonly handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  readonly catch = vi.fn();
  readonly api = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    setChatMenuButton: vi.fn().mockResolvedValue(true),
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
}

vi.mock("grammy", () => ({
  Bot: FakeBot,
}));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

const { parseTelegramCommand, telegramSourceModule } =
  await import("../../src/event-sources/telegram.js");

const tempDirs: string[] = [];

function telegramContext(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: 10,
      message_thread_id: 22,
      text: "hello agent",
      chat: { id: -1001 },
      from: { id: 123, username: "alek" },
      ...overrides,
    },
    reply: vi.fn().mockResolvedValue({}),
  };
}

async function startSource(dataDir: string, emit = vi.fn(), spawnSession = vi.fn()) {
  const listSessions = vi.fn().mockResolvedValue([
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
  const stop = vi.fn().mockResolvedValue(undefined);
  const task = vi.fn().mockReturnValue(Promise.resolve());
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
    },
    emit,
    signal: new AbortController().signal,
    logger,
    listSessions,
    spawnSession,
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
    expect(parseTelegramCommand("/spawn bogus")).toBeNull();
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

  it("shows active sessions when /watch has no session id", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, listSessions } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const watchCtx = telegramContext({ text: "/watch" });
    await bot.emitText(watchCtx);

    expect(listSessions).toHaveBeenCalled();
    expect(watchCtx.reply).toHaveBeenCalledWith("Select a Spur session:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "api-1 codex waiting", callback_data: "spur_watch:api-1" }],
          [{ text: "api-2 claude working", callback_data: "spur_watch:api-2" }],
        ],
      },
    });
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
          ],
        ],
      },
    });
    await bot.emitText(telegramContext({ text: "/unknown" }));

    expect(emit).not.toHaveBeenCalled();
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

  it("spawns and binds a new session from /spawn", async () => {
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

    expect(spawnSession).toHaveBeenCalledWith({ project: "api", agent: "codex" });
    expect(spawnCtx.reply).toHaveBeenCalledWith(
      "Spawned and bound this Telegram thread to Spur session api-3.",
    );
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-3"');
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

  it("rejects invalid or cross-project watch targets", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const invalidCtx = telegramContext({ text: "/watch api-1 extra" });
    await bot.emitText(invalidCtx);
    expect(invalidCtx.reply).toHaveBeenCalledWith("Usage: /watch <sessionId>");

    const crossProjectCtx = telegramContext({ text: "/watch web-1" });
    await bot.emitText(crossProjectCtx);
    expect(crossProjectCtx.reply).toHaveBeenCalledWith(
      "No active Spur session web-1 for this project.",
    );
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

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();
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
  });

  it("stops the runner when the source stops", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { handle, stop } = await startSource(dataDir);

    handle.stop();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("logs runner task and stop errors", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const runnerError = new Error("bad token");
    const stopError = new Error("stop failed");
    const stop = vi.fn().mockRejectedValue(stopError);
    const task = vi.fn().mockReturnValue(Promise.reject(runnerError));
    runMock.mockReturnValue({
      stop,
      start: vi.fn(),
      size: vi.fn(),
      task,
      isRunning: vi.fn(),
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handle = await telegramSourceModule.start({
      sourceId: "telegram",
      projectId: "api",
      dataDir,
      config: {
        type: "telegram",
        runOnStart: false,
        token: "token-123",
        allowedUsers: [123],
      },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      listSessions: vi.fn().mockResolvedValue([]),
    });

    await Promise.resolve();
    handle.stop();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram runner failed: bad token",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram runner failed: stop failed",
    );
  });
});
