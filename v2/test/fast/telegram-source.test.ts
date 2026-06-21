import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "../helpers/common.js";

const botInstances: FakeBot[] = [];
const runMock = vi.fn();

class FakeBot {
  readonly handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  readonly catch = vi.fn();

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
}

vi.mock("grammy", () => ({
  Bot: FakeBot,
}));

vi.mock("@grammyjs/runner", () => ({
  run: runMock,
}));

const { parseTelegramCommand, telegramSourceModule } =
  await import("../../src/event-sources/telegram.js");

let tempDirs: string[] = [];

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
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

async function startSource(dataDir: string, emit = vi.fn()) {
  const stop = vi.fn().mockResolvedValue(undefined);
  runMock.mockReturnValue({
    stop,
    start: vi.fn(),
    size: vi.fn(),
    task: vi.fn(),
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
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { bot: botInstances[0], emit, handle, stop };
}

describe("parseTelegramCommand", () => {
  it("parses watch commands with optional bot mention", () => {
    expect(parseTelegramCommand("/watch api-1")).toEqual({ kind: "watch", sessionId: "api-1" });
    expect(parseTelegramCommand("/watch@SpurProjectsBot api-2")).toEqual({
      kind: "watch",
      sessionId: "api-2",
    });
  });

  it("parses unwatch and invalid watch", () => {
    expect(parseTelegramCommand("/unwatch")).toEqual({ kind: "unwatch" });
    expect(parseTelegramCommand("/watch")).toEqual({ kind: "invalid_watch" });
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

  it("stops the runner when the source stops", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { handle, stop } = await startSource(dataDir);

    handle.stop();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
