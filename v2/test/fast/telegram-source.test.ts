import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type * as Grammy from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  SourceProjectListItem,
  SourceSessionListItem,
  SourceWorkbench,
  SourceWorkSessionItem,
  SourceStartDeps,
} from "../../src/event-sources/types.js";
import { flushEventLogCollapse, readEventLog, resetEventLogCollapse } from "../../src/event-log.js";
import * as metadataModule from "../../src/metadata.js";
import * as consentModule from "../../src/review-interface-consent.js";
import * as workspaceModule from "../../src/workspace.js";
import { MAX_ATTACHMENT_BYTES, type SessionRecord } from "../../src/types.js";
import {
  findTelegramChoice,
  findTelegramMessageSession,
  readTelegramBindings,
  readTelegramChoices,
  readTelegramReplyTarget,
  recordTelegramMessages,
  writeTelegramBindings,
  writeTelegramOffer,
  writeTelegramReplyTarget,
} from "../../src/metadata.js";
import { createTempDir } from "../helpers/common.js";

const botInstances: FakeBot[] = [];
const runMock = vi.fn();
const getMeMock = vi.fn().mockResolvedValue({ id: 44, username: "SpurProjectsBot" });

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

  on(event: string | string[], handler: (ctx: unknown) => Promise<void>): void {
    for (const filter of typeof event === "string" ? [event] : event)
      this.handlers.set(filter, handler);
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

  async emitPhoto(ctx: unknown): Promise<void> {
    const handler = this.handlers.get("message:photo");
    if (!handler) throw new Error("missing message:photo handler");
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
const { Api, Context } = await vi.importActual<typeof Grammy>("grammy");

const tempDirs: string[] = [];
const topicLink = "Continue in [agent topic](https://t.me/c/1/22).";

function assignTopic(dataDir: string, sessionId = "api-1", messageThreadId = 22): void {
  const bindings = readTelegramBindings(dataDir, "api", "telegram");
  bindings.set(`-1001:${messageThreadId}`, { chatId: -1001, messageThreadId, sessionId });
  writeTelegramBindings(dataDir, "api", "telegram", bindings.values());
  writeTelegramReplyTarget(dataDir, {
    sessionId,
    projectId: "api",
    sourceId: "telegram",
    chatId: -1001,
    messageThreadId,
  });
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture");
  return value;
}

function telegramContext(overrides: Record<string, unknown> = {}) {
  const { updateId, ...messageOverrides } = overrides;
  return {
    me: { username: "SpurProjectsBot" },
    ...(typeof updateId === "number" ? { update: { update_id: updateId } } : {}),
    message: {
      message_id: 10,
      message_thread_id: 22,
      text: "hello agent",
      is_topic_message: true,
      chat: { id: -1001 },
      from: { id: 123, username: "alek" },
      ...messageOverrides,
    },
    reply: vi.fn().mockResolvedValue({}),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  };
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface ReplyMarkupOptions {
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

/**
 * Reads the `spur_sproj:<nonce>:<index>` callback data straight off the
 * inline keyboard a mocked `reply` was called with, at the given row —
 * tests never guess the daemon's random nonce.
 */
function spawnProjectCallbackData(
  replyMock: { mock: { calls: unknown[][] } },
  row: number,
): string {
  for (const call of replyMock.mock.calls) {
    const options = call[1] as ReplyMarkupOptions | undefined;
    const button = options?.reply_markup?.inline_keyboard[row]?.[0];
    if (button) return button.callback_data;
  }
  throw new Error(`no spawn-project keyboard button found at row ${row}`);
}

function telegramVoiceContext(overrides: Record<string, unknown> = {}) {
  const { updateId, getFile, ...messageOverrides } = overrides;
  return {
    ...(typeof updateId === "number" ? { update: { update_id: updateId } } : {}),
    message: {
      message_id: 10,
      message_thread_id: 22,
      chat: { id: -1001 },
      is_topic_message: true,
      from: { id: 123, username: "alek" },
      voice: { file_id: "file-1", file_unique_id: "unique-1", duration: 3 },
      ...messageOverrides,
    },
    reply: vi.fn().mockResolvedValue({ message_id: 55 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
    getFile: getFile ?? vi.fn().mockResolvedValue({ file_path: "voice/file_1.oga" }),
  };
}

function telegramPhotoContext(overrides: Record<string, unknown> = {}) {
  return {
    ...telegramContext({
      text: undefined,
      photo: [{ file_id: "photo-1", file_unique_id: "unique-photo", width: 100, height: 100 }],
      ...overrides,
    }),
    getFile: vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" }),
  };
}

const mediaKinds = [
  "photo",
  "document",
  "audio",
  "video",
  "animation",
  "voice",
  "video_note",
  "sticker",
] as const;

function telegramAttachmentContext(
  kind: (typeof mediaKinds)[number],
  overrides: Record<string, unknown> = {},
) {
  return {
    ...telegramContext({
      text: undefined,
      [kind]:
        kind === "photo"
          ? [{ file_id: "file", file_unique_id: "unique", width: 50, height: 50 }]
          : { file_id: "file", file_unique_id: "unique" },
      ...overrides,
    }),
    getFile: vi.fn().mockResolvedValue({ file_path: `files/${kind}` }),
  };
}

async function startSource(
  dataDir: string,
  emit = vi.fn(),
  spawnSession = vi.fn(),
  overrides: {
    listSessions?: Mock<() => Promise<SourceSessionListItem[]>>;
    getSession?: Mock<(sessionId: string) => Promise<SourceSessionListItem | null>>;
    // `null` (as opposed to the default `undefined`) omits `listProjects`
    // from the deps passed to `telegramSourceModule.start` entirely, to
    // exercise the "dep not supplied" path.
    listProjects?: Mock<() => Promise<SourceProjectListItem[]>> | null;
    stop?: Mock<(...args: unknown[]) => unknown>;
    task?: Mock<(...args: unknown[]) => unknown>;
    config?: Record<string, unknown>;
    webBaseUrl?: string | null;
    resolveWebBaseUrl?: () => Promise<string | null>;
    workbench?: SourceWorkbench;
    signal?: AbortSignal;
    spawnSession?: null;
    telegramConversations?: SourceStartDeps["telegramConversations"] | null;
    prepareSessionMessage?: SourceStartDeps["prepareSessionMessage"] | null;
  } = {},
) {
  const listSessions =
    overrides.listSessions ??
    vi.fn().mockResolvedValue([
      { id: "api-1", project: "api", agent: "codex", state: "waiting" },
      { id: "api-2", project: "api", agent: "claude", state: "working" },
      { id: "web-1", project: "web", agent: "cursor", state: "waiting" },
    ] as SourceSessionListItem[]);
  const getSession =
    overrides.getSession ??
    vi.fn(
      async (sessionId: string): Promise<SourceSessionListItem | null> =>
        ((await listSessions()) as SourceSessionListItem[]).find(
          (entry) => entry.id === sessionId,
        ) ?? null,
    );
  const listProjects =
    overrides.listProjects === null
      ? undefined
      : (overrides.listProjects ??
        vi.fn().mockResolvedValue([
          { id: "api", name: "api" },
          { id: "web", name: "web" },
        ]));
  const stop = overrides.stop ?? vi.fn().mockResolvedValue(undefined);
  const task = overrides.task ?? vi.fn().mockReturnValue(Promise.resolve());
  const logger = { info: vi.fn(), warn: vi.fn() };
  let nextTopic = 22;
  type EnsureTopic = NonNullable<SourceStartDeps["telegramConversations"]>["ensureTopic"];
  const telegramConversations: NonNullable<SourceStartDeps["telegramConversations"]> = {
    ensureTopic: vi.fn<EnsureTopic>(async (sessionId, origin) => {
      const canonicalChatId =
        overrides.config && "chatId" in overrides.config ? overrides.config["chatId"] : -1001;
      if (typeof canonicalChatId !== "number" || canonicalChatId >= 0) {
        metadataModule.retireTelegramLegacyState(dataDir, "api", "telegram", sessionId);
        return { kind: "disabled" };
      }
      const bindings = readTelegramBindings(dataDir, "api", "telegram");
      const existing = [...bindings.values()].find(
        (binding) =>
          binding.sessionId === sessionId &&
          binding.chatId === canonicalChatId &&
          (binding.messageThreadId ?? 1) > 1,
      );
      let topicId = existing?.messageThreadId;
      if (topicId === undefined) {
        while (bindings.has(`${canonicalChatId}:${nextTopic}`)) nextTopic += 1;
        topicId = nextTopic++;
      }
      const { telegramTopicIsDeleting } = await import("../../src/telegram-source-state.js");
      if (telegramTopicIsDeleting(dataDir, canonicalChatId, topicId))
        throw new Error("Topic is being deleted with its agent");
      bindings.set(`${canonicalChatId}:${topicId}`, {
        chatId: canonicalChatId,
        messageThreadId: topicId,
        sessionId,
      });
      metadataModule.writeTelegramBindings(dataDir, "api", "telegram", bindings.values());
      const old = readTelegramReplyTarget(dataDir, sessionId);
      const same = old?.chatId === canonicalChatId && old.messageThreadId === topicId;
      writeTelegramReplyTarget(dataDir, {
        ...(same ? old : {}),
        sessionId,
        projectId: origin.projectId,
        sourceId: origin.sourceId,
        chatId: canonicalChatId,
        messageThreadId: topicId,
      });
      metadataModule.retireTelegramLegacyState(dataDir, "api", "telegram", sessionId, {
        chatId: canonicalChatId,
        messageThreadId: topicId,
      });
      return {
        kind: "topic",
        projectId: "api",
        sourceId: "telegram",
        chatId: canonicalChatId,
        messageThreadId: topicId,
      };
    }),
    unwatch: vi.fn(async (sessionId, origin) => {
      const bindings = readTelegramBindings(dataDir, "api", "telegram");
      const key = `${origin.chatId}:${origin.messageThreadId ?? 0}`;
      if (bindings.get(key)?.sessionId !== sessionId) return false;
      bindings.delete(key);
      metadataModule.writeTelegramBindings(dataDir, "api", "telegram", bindings.values());
      const target = readTelegramReplyTarget(dataDir, sessionId);
      if (
        target &&
        target.chatId === origin.chatId &&
        target.messageThreadId === origin.messageThreadId
      ) {
        writeTelegramReplyTarget(dataDir, {
          sessionId,
          projectId: origin.projectId,
          sourceId: origin.sourceId,
          chatId: origin.chatId,
        });
      }
      return true;
    }),
  };
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
      chatId: -1001,
      allowedUsers: [123],
      ...overrides.config,
    },
    emit,
    signal: overrides.signal ?? new AbortController().signal,
    logger,
    listSessions,
    getSession,
    ...(overrides.telegramConversations === null
      ? {}
      : { telegramConversations: overrides.telegramConversations ?? telegramConversations }),
    ...(listProjects ? { listProjects } : {}),
    ...(overrides.spawnSession === null ? {} : { spawnSession }),
    ...(overrides.prepareSessionMessage === null
      ? {}
      : {
          prepareSessionMessage:
            overrides.prepareSessionMessage ??
            vi.fn<NonNullable<SourceStartDeps["prepareSessionMessage"]>>(
              async (_sessionId, request) =>
                `[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/voice.ogg]\n${request.message}`,
            ),
        }),
    ...(overrides.workbench ? { workbench: overrides.workbench } : {}),
    resolveWebBaseUrl:
      overrides.resolveWebBaseUrl ??
      (() =>
        Promise.resolve(
          overrides.webBaseUrl !== undefined ? overrides.webBaseUrl : "http://127.0.0.1:5555",
        )),
  });
  return {
    bot: botInstances[0],
    emit,
    handle,
    listSessions,
    listProjects,
    logger,
    spawnSession,
    stop,
    task,
  };
}

describe("parseTelegramCommand", () => {
  it.each(["complete", "kill"])("parses %s without accepting arguments", (command) => {
    expect(parseTelegramCommand(`/${command}`)).toEqual({ kind: command, invalidArgs: false });
    expect(parseTelegramCommand(`/${command}@SPURBOT`, "spurbot")).toEqual({
      kind: command,
      invalidArgs: false,
    });
    expect(parseTelegramCommand(`/${command} force`)).toEqual({ kind: command, invalidArgs: true });
    expect(parseTelegramCommand(`/${command}@otherbot`, "spurbot")).toBeNull();
    for (const username of [undefined, ""]) {
      expect(parseTelegramCommand(`/${command}@spurbot`, username)).toBeNull();
      expect(parseTelegramCommand(`/${command}@otherbot force`, username)).toBeNull();
      expect(parseTelegramCommand(`/${command}`, username)).toEqual({
        kind: command,
        invalidArgs: false,
      });
    }
    expect(parseTelegramCommand(`/${command}@SPURBOT force`, "spurbot")).toEqual({
      kind: command,
      invalidArgs: true,
    });
  });
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
      '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
      'Offer choices with `--button <label>` or `--button <label>=<value>`, repeatable: "$SPUR_SESSION_TOOL_DIR/spur" source reply "Deploy now?" --button "Yes" --button "Later=wait for me". A click arrives as an ordinary user message carrying the value. Prefer buttons when the answer is one pick from a few options. Format with Markdown (**bold**, `code`, ``` blocks, [text](url)), never HTML tags: they show literally.',
      "Your terminal output is invisible to them. Reply when you need input and when the task completes, with a short result summary.",
    ].join("\n");
    expect(wrapTelegramSpawnPrompt("fix the sidecar")).toBe(`fix the sidecar${suffix}`);
  });
});

describe("telegramSourceModule", () => {
  function workbenchFixture() {
    const sessions: SourceWorkSessionItem[] = [
      {
        id: "api-1",
        project: "api",
        agent: "codex",
        state: "needs_input",
        status: "running",
        runtimeAlive: true,
        canContinue: true,
        restorable: false,
        lastActivityAt: "2026-10-04T12:00:00Z",
        model: null,
      },
      {
        id: "api-2",
        project: "api",
        agent: "claude",
        state: "stopped",
        status: "stopped",
        runtimeAlive: false,
        canContinue: false,
        restorable: true,
        lastActivityAt: "2026-10-04T11:00:00Z",
        model: "auto",
      },
    ];
    const capability = {
      completeSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
      killSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
      launchOptions: vi.fn(
        async ({
          project,
          agent = "codex",
          mode,
        }: Parameters<SourceWorkbench["launchOptions"]>[0]) => ({
          project,
          agent,
          model: agent === "codex" ? null : "auto",
          mode: mode ?? "manager",
          modes: ["manager", "developer"],
        }),
      ),
      listSessions: vi.fn(async () => sessions),
      getSession: vi.fn(async (id: string) => {
        const session = sessions.find((entry) => entry.id === id);
        if (!session) throw new Error("Session unavailable");
        return session;
      }),
      restoreSession: vi.fn(
        async ({ sessionId }: Parameters<SourceWorkbench["restoreSession"]>[0]) => {
          const session = required(sessions.find((entry) => entry.id === sessionId));
          session.canContinue = true;
          session.restorable = false;
          session.runtimeAlive = true;
          session.status = "running";
          session.state = "working";
          return session;
        },
      ),
    } satisfies SourceWorkbench;
    return { sessions, capability };
  }

  describe("topic lifecycle commands", () => {
    it.each(["completed", "killed"] as const)(
      "does not resurrect externally %s Telegram bindings on unrelated updates",
      async (status) => {
        const dataDir = await createTempDir("spur-telegram-terminal-");
        tempDirs.push(dataDir);
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        const { bot } = await startSource(dataDir);
        metadataModule.writeSession(dataDir, {
          id: "api-1",
          project: "api",
          agent: "codex",
          prompt: "task",
          branch: "feature/test",
          worktree: false,
          worktreePath: dataDir,
          tmuxSession: "test",
          launchCommand: "codex",
          status,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        metadataModule.deleteTelegramSourceStateForSession(dataDir, "api", "api-1");
        await required(bot).emitText(telegramContext({ text: "/help", updateId: 22 }));
        expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
      },
    );

    it("keeps a persisted replacement over the source's cached binding", async () => {
      const dataDir = await createTempDir("spur-telegram-replacement-");
      tempDirs.push(dataDir);
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      ]);
      const { bot } = await startSource(dataDir);
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "api-2" },
      ]);
      await required(bot).emitText(telegramContext({ text: "/help", updateId: 22 }));
      expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
        "api-2",
      );
    });

    it("refuses a watch binding while its topic deletion is pending", async () => {
      const { claimTelegramTopicDeletion } = await import("../../src/telegram-source-state.js");
      const dataDir = await createTempDir("spur-telegram-deleting-");
      tempDirs.push(dataDir);
      const { bot } = await startSource(dataDir);
      const release = claimTelegramTopicDeletion(dataDir, -1001, 22);
      try {
        const ctx = telegramContext({ text: "/watch api-2", updateId: 22 });
        await required(bot).emitText(ctx);
        expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
        expect(ctx.reply).toHaveBeenCalledWith(
          expect.stringContaining("Failed to bind Spur session api-2"),
        );
        expect(readTelegramReplyTarget(dataDir, "api-2")).toBeNull();
      } finally {
        release?.();
      }
    });

    it.each(["complete", "kill"] as const)(
      "lifecycle identity recovery: %s uses recovered Context identity after startup getMe fails",
      async (action) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        getMeMock.mockRejectedValueOnce(new Error("temporary getMe failure"));
        const { bot, emit, spawnSession } = await startSource(dataDir, undefined, undefined, {
          workbench: capability,
        });
        expect(
          readEventLog(dataDir).some((entry) => entry.event === "source.telegram.auth_failed"),
        ).toBe(true);
        // Model the initialized Context supplied by runner recovery, not recovery timing.
        const recoveredContext = (text: string, updateId: number) => {
          const ctx = new Context(
            {
              update_id: updateId,
              message: {
                message_id: updateId,
                date: 0,
                message_thread_id: 22,
                is_topic_message: true,
                chat: { id: -1001, type: "supergroup", title: "Test" },
                from: { id: 123, is_bot: false, first_name: "User" },
                text,
              },
            },
            new Api("test-token"),
            {
              id: 999,
              is_bot: true,
              first_name: "Spur",
              username: "SpurProjectsBot",
              can_join_groups: true,
              can_read_all_group_messages: true,
              supports_inline_queries: false,
              can_connect_to_business: false,
              has_main_web_app: false,
              has_topics_enabled: false,
              allows_users_to_create_topics: false,
              can_manage_bots: false,
              supports_join_request_queries: false,
            },
          );
          vi.spyOn(ctx, "reply").mockImplementation(telegramContext().reply);
          return ctx;
        };
        const foreign = recoveredContext(`/${action}@otherbot`, 10);
        await required(bot).emitText(foreign);
        expect(capability.completeSession).not.toHaveBeenCalled();
        expect(capability.killSession).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
        expect(foreign.reply).not.toHaveBeenCalled();
        const own = recoveredContext(`/${action}@sPuRpRoJeCtSbOt`, 11);
        await required(bot).emitText(own);
        const operation =
          action === "complete" ? capability.completeSession : capability.killSession;
        expect(operation).toHaveBeenCalledExactlyOnceWith("api-1");
        expect(own.reply).not.toHaveBeenCalled();
      },
    );

    it.each(["complete", "kill"] as const)(
      "lifecycle identity recovery: %s rejects mentions without identity and accepts bare commands",
      async (action) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        const { bot, emit, spawnSession } = await startSource(dataDir, undefined, undefined, {
          workbench: capability,
        });
        const addressed = {
          ...telegramContext({ text: `/${action}@SpurProjectsBot` }),
          me: undefined,
        };
        await required(bot).emitText(addressed);
        expect(capability.completeSession).not.toHaveBeenCalled();
        expect(capability.killSession).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
        expect(addressed.reply).not.toHaveBeenCalled();
        await required(bot).emitText({ ...telegramContext({ text: `/${action}` }), me: undefined });
        const operation =
          action === "complete" ? capability.completeSession : capability.killSession;
        expect(operation).toHaveBeenCalledExactlyOnceWith("api-1");
      },
    );

    it.each(["complete", "kill"] as const)(
      "%s uses durable topic target, clears cache, and sends no extra notice",
      async (action) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
          { chatId: -1001, messageThreadId: 44, sessionId: "api-2" },
        ]);
        const { bot, emit, spawnSession } = await startSource(dataDir, undefined, undefined, {
          workbench: capability,
        });
        const operation =
          action === "complete" ? capability.completeSession : capability.killSession;
        operation.mockImplementation(async (id) => {
          metadataModule.deleteTelegramSourceStateForSession(dataDir, "api", id);
        });
        recordTelegramMessages(
          dataDir,
          "api",
          "telegram",
          { sessionId: "api-2", chatId: -1001 },
          [99],
        );
        const ctx = telegramContext({
          text: `/${action}@SpurProjectsBot`,
          updateId: 10,
          reply_to_message: { message_id: 99 },
        });
        await required(bot).emitText(ctx);
        expect(operation).toHaveBeenCalledExactlyOnceWith("api-1");
        expect(ctx.reply).not.toHaveBeenCalled();
        await required(bot).emitText(telegramContext({ text: "/help", updateId: 11 }));
        expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
          { chatId: -1001, messageThreadId: 44, sessionId: "api-2" },
        ]);
        expect(emit).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
      },
    );

    it.each(["api-2", undefined])(
      "reconciles cached A against durable %s before numbered update persistence",
      async (owner) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        const { bot } = await startSource(dataDir, undefined, undefined, { workbench: capability });
        writeTelegramBindings(
          dataDir,
          "api",
          "telegram",
          owner ? [{ chatId: -1001, messageThreadId: 22, sessionId: owner }] : [],
        );
        const ctx = telegramContext({ text: "/kill", updateId: 10 });
        await required(bot).emitText(ctx);
        if (owner) expect(capability.killSession).toHaveBeenCalledExactlyOnceWith(owner);
        else {
          expect(capability.killSession).not.toHaveBeenCalled();
          expect(ctx.reply).toHaveBeenCalledWith("No Spur session bound here.");
        }
        await required(bot).emitText(telegramContext({ text: "/help", updateId: 11 }));
        expect(
          [...readTelegramBindings(dataDir, "api", "telegram").values()].map(
            (entry) => entry.sessionId,
          ),
        ).toEqual(owner ? [owner] : []);
      },
    );

    it("loads late binding without update id and deduplicates numbered commands", async () => {
      const dataDir = await createTempDir("spur-telegram-lifecycle-");
      tempDirs.push(dataDir);
      const { capability } = workbenchFixture();
      const { bot } = await startSource(dataDir, undefined, undefined, { workbench: capability });
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "web-1" },
      ]);
      await required(bot).emitText(telegramContext({ text: "/complete" }));
      await required(bot).emitText(telegramContext({ text: "/complete", updateId: 10 }));
      await required(bot).emitText(telegramContext({ text: "/complete", updateId: 10 }));
      expect(capability.completeSession).toHaveBeenCalledTimes(2);
      expect(capability.completeSession).toHaveBeenLastCalledWith("web-1");
    });

    it.each([
      { text: "/kill force", expected: "Usage: /kill" },
      {
        text: "/complete",
        chat: { id: 123 },
        expected: "Use /complete inside a bound forum topic.",
      },
      {
        text: "/kill",
        is_topic_message: undefined,
        expected: "Use /kill inside a bound forum topic.",
      },
      { text: "/complete", from: { id: 999 }, expected: undefined },
      { text: "/complete@otherbot", expected: undefined },
    ])("rejects unsupported or unauthorized input %o", async ({ expected, ...message }) => {
      const dataDir = await createTempDir("spur-telegram-lifecycle-");
      tempDirs.push(dataDir);
      const { capability } = workbenchFixture();
      const { bot, emit, spawnSession } = await startSource(dataDir, undefined, undefined, {
        workbench: capability,
      });
      const ctx = telegramContext({ ...message, updateId: 10 });
      await required(bot).emitText(ctx);
      if (expected) expect(ctx.reply).toHaveBeenCalledWith(expected);
      expect(capability.completeSession).not.toHaveBeenCalled();
      expect(capability.killSession).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    });

    it("reports unavailable adapter without routing command", async () => {
      const dataDir = await createTempDir("spur-telegram-lifecycle-");
      tempDirs.push(dataDir);
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      ]);
      const { bot, emit } = await startSource(dataDir);
      const ctx = telegramContext({ text: "/kill" });
      await required(bot).emitText(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Session operation unavailable.");
      expect(emit).not.toHaveBeenCalled();
    });

    it.each(["user", "chat"])(
      "rejects unauthorized %s before persisting stale cached binding",
      async (gate) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        const { bot, emit, spawnSession } = await startSource(dataDir, undefined, undefined, {
          workbench: capability,
          config: gate === "chat" ? { allowedChats: [-2002] } : {},
        });
        writeTelegramBindings(dataDir, "api", "telegram", []);
        const ctx = telegramContext({
          text: "/kill",
          updateId: 10,
          ...(gate === "user" ? { from: { id: 999 } } : {}),
        });
        await required(bot).emitText(ctx);
        expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
        expect(capability.killSession).not.toHaveBeenCalled();
        expect(ctx.reply).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
      },
    );

    it("preserves binding on dirty rejection and redacts bot token", async () => {
      const dataDir = await createTempDir("spur-telegram-lifecycle-");
      tempDirs.push(dataDir);
      const { capability } = workbenchFixture();
      capability.killSession.mockRejectedValue(new Error("Dirty workspace token-123"));
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      ]);
      const { bot } = await startSource(dataDir, undefined, undefined, { workbench: capability });
      const ctx = telegramContext({ text: "/kill", updateId: 10 });
      await required(bot).emitText(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Failed to kill session: Dirty workspace"),
      );
      expect(JSON.stringify(ctx.reply.mock.calls)).not.toContain("token-123");
      expect([...readTelegramBindings(dataDir, "api", "telegram").values()][0]?.sessionId).toBe(
        "api-1",
      );
    });

    it.each(["api-2", undefined])(
      "refuses a binding changed to %s during persistence",
      async (owner) => {
        const dataDir = await createTempDir("spur-telegram-lifecycle-");
        tempDirs.push(dataDir);
        const { capability } = workbenchFixture();
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        ]);
        const { bot } = await startSource(dataDir, undefined, undefined, { workbench: capability });
        const write = metadataModule.writeTelegramBindings;
        const spy = vi
          .spyOn(metadataModule, "writeTelegramBindings")
          .mockImplementationOnce((...args) => {
            write(...args);
            write(
              dataDir,
              "api",
              "telegram",
              owner ? [{ chatId: -1001, messageThreadId: 22, sessionId: owner }] : [],
            );
          });
        const ctx = telegramContext({ text: "/complete", updateId: 10 });
        try {
          await required(bot).emitText(ctx);
          expect(capability.completeSession).not.toHaveBeenCalled();
          expect(ctx.reply).toHaveBeenCalledWith(
            owner
              ? "Topic binding changed. Send the command again."
              : "No Spur session bound here.",
          );
        } finally {
          spy.mockRestore();
        }
      },
    );

    it("keeps a replacement binding created during successful lifecycle cleanup", async () => {
      const dataDir = await createTempDir("spur-telegram-lifecycle-");
      tempDirs.push(dataDir);
      const { capability } = workbenchFixture();
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      ]);
      const { bot } = await startSource(dataDir, undefined, undefined, { workbench: capability });
      capability.completeSession.mockImplementation(async () => {
        writeTelegramBindings(dataDir, "api", "telegram", [
          { chatId: -1001, messageThreadId: 22, sessionId: "api-2" },
        ]);
      });
      await required(bot).emitText(telegramContext({ text: "/complete", updateId: 10 }));
      await required(bot).emitText(telegramContext({ text: "/help", updateId: 11 }));
      expect([...readTelegramBindings(dataDir, "api", "telegram").values()][0]?.sessionId).toBe(
        "api-2",
      );
    });
  });

  function cardButton(mock: { mock: { calls: unknown[][] } }, text: string): string {
    for (const call of [...mock.mock.calls].reverse()) {
      const options = call[1] as ReplyMarkupOptions | undefined;
      const button = options?.reply_markup?.inline_keyboard
        .flat()
        .find((entry) => entry.text === text);
      if (button) return button.callback_data;
    }
    throw new Error(`No card button ${text}`);
  }

  function cardCallback(data: string, overrides: Record<string, unknown> = {}) {
    return {
      callbackQuery: {
        data,
        from: { id: 123 },
        message: {
          message_id: 700,
          chat: { id: -1001 },
          message_thread_id: 22,
          is_topic_message: true,
        },
        ...overrides,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue({ message_id: 701 }),
    };
  }

  async function openWorkbench(bot: FakeBot, text: string) {
    const ctx = telegramContext({ text });
    ctx.reply.mockResolvedValue({ message_id: 700 });
    await bot.emitText(ctx);
    return ctx;
  }
  beforeEach(() => {
    resetEventLogCollapse();
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  it.each([
    "renewal",
    "buttonless",
    "revocation",
    "compatible-relocation",
    "wrong-branch",
    "wrong-repo",
    "second-relocation",
    "workspace-changed",
    "project-changed",
    "stored-branch-changed",
  ])(
    "mixed workbench/choice callbacks cannot overwrite consent after %s while branch lookup awaits",
    async (replacement) => {
      const dataDir = await createTempDir("spur-consent-race-");
      tempDirs.push(dataDir);
      const record = {
        ...consentModule.proposeConsent(
          {
            session: "api-1",
            repository: "owner/repo",
            branch: "feature/example",
            baseBranch: "main",
            projectId: "api",
            sourceId: "telegram",
            chatId: -1001,
            approverUserId: 123,
            manifest: {
              version: 1,
              repository: "owner/repo",
              baseBranch: "main",
              surfaces: [
                { kind: "CLI", id: "run", before: ["old"], after: ["new"], constraints: [] },
              ],
            },
          },
          null,
        ),
        delivery: "sent" as const,
      };
      metadataModule.writeInterfaceConsent(dataDir, record);
      metadataModule.writeSession(dataDir, {
        id: "api-1",
        project: "api",
        branch: "feature/example",
        worktreePath: "/fixture",
        agent: "codex",
        prompt: "fixture",
        worktree: true,
        tmuxSession: "fixture",
        launchCommand: "fixture",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies SessionRecord);
      const choice = {
        token: "old",
        offerId: "old",
        sessionId: "api-1",
        chatId: -1001,
        messageThreadId: 22,
        text: "Approve",
        value: "approved",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        interfaceConsent: { challenge: record.challenge, decision: "approved" as const },
      };
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices: [choice],
        keepInterfaceConsent: false,
      });
      assignTopic(dataDir);
      vi.spyOn(consentModule, "consentPolicy").mockResolvedValue({
        repositories: ["owner/repo"],
        approverUserId: 123,
      });
      const reconcile = vi
        .spyOn(consentModule, "reconcileInterfaceConsent")
        .mockResolvedValue(undefined);
      let entered!: () => void, release!: (branch: string) => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(consentModule, "repositoryOf").mockResolvedValue(
        replacement === "wrong-repo" ? "other/repo" : "owner/repo",
      );
      vi.spyOn(workspaceModule, "readCurrentBranch").mockImplementation(async (path) => {
        if (path !== "/fixture") {
          if (replacement === "second-relocation") {
            const latest = metadataModule.readSession(dataDir, "api-1");
            if (!latest) throw new Error("missing fixture session");
            metadataModule.writeSession(dataDir, { ...latest, worktreePath: "/third" });
          }
          return replacement === "wrong-branch" ? "feature/wrong" : "feature/example";
        }
        entered();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      });
      try {
        const { capability } = workbenchFixture();
        const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), {
          workbench: capability,
        });
        if (!bot) throw new Error("missing bot");
        const ordinary = { ...choice, token: "ordinary", offerId: "ordinary" };
        delete (ordinary as { interfaceConsent?: unknown }).interfaceConsent;
        writeTelegramOffer(dataDir, "api", "telegram", {
          sessionId: "api-1",
          chatId: -1001,
          choices: [ordinary],
          keepInterfaceConsent: true,
        });
        await bot.emitCallback(cardCallback("spur_choice:ordinary"));
        expect(metadataModule.readInterfaceConsent(dataDir, "api-1")).toEqual(record);
        expect(reconcile).not.toHaveBeenCalled();
        emit.mockClear();
        writeTelegramOffer(dataDir, "api", "telegram", {
          sessionId: "api-1",
          chatId: -1001,
          choices: [choice],
          keepInterfaceConsent: false,
        });
        const inbox = await openWorkbench(bot, "/work");
        const detail = cardCallback(cardButton(inbox.reply, "api · api-1 · needs_input"));
        await bot.emitCallback(detail);
        await bot.emitCallback(cardCallback(cardButton(detail.editMessageText, "Continue here")));
        await bot.emitCallback(cardCallback("spur_wb:old"));
        expect(findTelegramChoice(dataDir, "api", "telegram", "old", -1001)).not.toBeNull();
        expect(metadataModule.readInterfaceConsent(dataDir, "api-1")).toEqual(record);
        expect(reconcile).not.toHaveBeenCalled();
        const consentMarkup = {
          inline_keyboard: [
            [{ text: "Approve", callback_data: "spur_choice:old" }],
            [{ text: "Reject", callback_data: "spur_choice:old-reject" }],
            [{ text: "Revoke", callback_data: "spur_choice:old-revoke" }],
          ],
        };
        const consentClick = {
          callbackQuery: {
            data: "spur_choice:old",
            from: { id: 123 },
            message: {
              message_id: 7,
              message_thread_id: 22,
              is_topic_message: true,
              chat: { id: -1001 },
              reply_markup: consentMarkup,
            },
          },
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
          editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        };
        const callback = bot.emitCallback(consentClick);
        await waiting;
        if (
          [
            "compatible-relocation",
            "wrong-branch",
            "wrong-repo",
            "second-relocation",
            "workspace-changed",
            "project-changed",
            "stored-branch-changed",
          ].includes(replacement)
        ) {
          const latest = metadataModule.readSession(dataDir, "api-1");
          if (!latest) throw new Error("missing fixture session");
          metadataModule.writeSession(dataDir, {
            ...latest,
            worktreePath: "/replacement",
            ...(replacement === "workspace-changed" ? { workspaceId: "other" } : {}),
            ...(replacement === "project-changed" ? { project: "other" } : {}),
            ...(replacement === "stored-branch-changed" ? { branch: "feature/other" } : {}),
          });
        }
        const renewed =
          replacement === "renewal"
            ? { ...consentModule.proposeConsent(record, record), delivery: "sent" as const }
            : replacement === "revocation"
              ? consentModule.decideConsent(record, {
                  session: "api-1",
                  sourceId: "telegram",
                  projectId: "api",
                  chatId: -1001,
                  actor: 123,
                  challenge: record.challenge,
                  decision: "revoked",
                })
              : record;
        if (["renewal", "revocation"].includes(replacement))
          metadataModule.writeInterfaceConsent(dataDir, renewed);
        writeTelegramOffer(dataDir, "api", "telegram", {
          sessionId: "api-1",
          chatId: -1001,
          choices:
            replacement === "renewal"
              ? [
                  {
                    ...choice,
                    token: "new",
                    offerId: "new",
                    interfaceConsent: { challenge: renewed.challenge, decision: "approved" },
                  },
                ]
              : replacement === "buttonless"
                ? []
                : [choice],
          // A buttonless reply models replyToSource, which spares the approval.
          keepInterfaceConsent: replacement === "buttonless",
        });
        release("feature/example");
        await callback;
        expect(consentClick.editMessageReplyMarkup.mock.calls[0]?.[0]).toEqual({
          reply_markup: {
            inline_keyboard: [[{ text: "Sending: Approve…", callback_data: "spur_choice:old" }]],
          },
        });
        expect(consentClick.answerCallbackQuery).toHaveBeenCalledOnce();
        if (["compatible-relocation", "buttonless"].includes(replacement)) {
          expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("approved");
          expect(reconcile).toHaveBeenCalledOnce();
          expect(emit).toHaveBeenCalledOnce();
          expect(findTelegramChoice(dataDir, "api", "telegram", "old", -1001)).toBeNull();
          expect(consentClick.answerCallbackQuery).toHaveBeenCalledWith("Sent: Approve");
          return;
        }
        if (replacement === "workspace-changed")
          expect(metadataModule.readInterfaceConsent(dataDir, "api-1")).toBeNull();
        else expect(metadataModule.readInterfaceConsent(dataDir, "api-1")).toEqual(renewed);
        expect(reconcile).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        // A superseded offer is gone, so its keyboard goes; a live one comes back.
        expect(consentClick.editMessageReplyMarkup).toHaveBeenLastCalledWith({
          reply_markup: replacement === "renewal" ? { inline_keyboard: [] } : consentMarkup,
        });
        expect(consentClick.answerCallbackQuery).toHaveBeenCalledWith({
          text: ["renewal", "second-relocation"].includes(replacement)
            ? "A newer interface approval replaced this one."
            : replacement === "revocation"
              ? "This interface approval is already decided."
              : "The session branch or workspace changed since approval was requested.",
          show_alert: true,
        });
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  describe("interface approval clicks", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const sendingRow = (text: string, token: string) => ({
      reply_markup: { inline_keyboard: [[{ text, callback_data: `spur_choice:${token}` }]] },
    });

    async function approvalFixture(allowedUsers = [123]) {
      const dataDir = await createTempDir("spur-consent-click-");
      tempDirs.push(dataDir);
      const record = {
        ...consentModule.proposeConsent(
          {
            session: "api-1",
            repository: "owner/repo",
            branch: "feature/example",
            baseBranch: "main",
            projectId: "api",
            sourceId: "telegram",
            chatId: -1001,
            approverUserId: 123,
            manifest: {
              version: 1,
              repository: "owner/repo",
              baseBranch: "main",
              surfaces: [
                { kind: "CLI", id: "run", before: ["old"], after: ["new"], constraints: [] },
              ],
            },
          },
          null,
        ),
        delivery: "sent" as const,
      };
      metadataModule.writeInterfaceConsent(dataDir, record);
      metadataModule.writeSession(dataDir, {
        id: "api-1",
        project: "api",
        branch: "feature/example",
        worktreePath: "/fixture",
        agent: "codex",
        prompt: "fixture",
        worktree: true,
        tmuxSession: "fixture",
        launchCommand: "fixture",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies SessionRecord);
      const labels = {
        approved: "Approve interface",
        rejected: "Reject interface",
        revoked: "Revoke interface approval",
      };
      const choices = (["approved", "rejected", "revoked"] as const).map((decision) => ({
        token: `tok-${decision}`,
        offerId: "consent",
        sessionId: "api-1",
        chatId: -1001,
        messageThreadId: 370,
        text: labels[decision],
        value: decision,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        interfaceConsent: { challenge: record.challenge, decision },
      }));
      writeTelegramBindings(dataDir, "api", "telegram", [
        { chatId: -1001, messageThreadId: 370, sessionId: "api-1" },
      ]);
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices,
        keepInterfaceConsent: false,
      });
      const policy = vi
        .spyOn(consentModule, "consentPolicy")
        .mockResolvedValue({ repositories: ["owner/repo"], approverUserId: 123 });
      const branch = vi
        .spyOn(workspaceModule, "readCurrentBranch")
        .mockResolvedValue("feature/example");
      const reconcile = vi
        .spyOn(consentModule, "reconcileInterfaceConsent")
        .mockResolvedValue(undefined);
      const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), {
        config: { allowedUsers },
      });
      const markup = {
        inline_keyboard: choices.map((choice) => [
          { text: choice.text, callback_data: `spur_choice:${choice.token}` },
        ]),
      };
      const click = (userId: number) => ({
        callbackQuery: {
          data: "spur_choice:tok-approved",
          from: { id: userId },
          message: {
            message_id: 90,
            message_thread_id: 370,
            is_topic_message: true as const,
            text: "Approve?\n\nInterface approval · owner/repo",
            chat: { id: -1001 },
            reply_markup: markup,
          },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageText: vi.fn().mockResolvedValue(undefined),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      });
      const rejections = () =>
        readEventLog(dataDir).filter((entry) => entry.event === "source.telegram.choice_rejected");
      return {
        dataDir,
        record,
        bot: required(bot),
        emit,
        policy,
        branch,
        reconcile,
        markup,
        click,
        rejections,
      };
    }

    it("approves a forum-topic click with Sending before any lookup, then Selected", async () => {
      const { dataDir, bot, emit, policy, branch, reconcile, click } = await approvalFixture();
      const ctx = click(123);

      await bot.emitCallback(ctx);

      expect(ctx.editMessageReplyMarkup.mock.calls).toEqual([
        [sendingRow("Sending: Approve interface…", "tok-approved")],
        [sendingRow("Selected: Approve interface", "tok-approved")],
      ]);
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Sent: Approve interface");
      const sendingAt = ctx.editMessageReplyMarkup.mock.invocationCallOrder[0] ?? Infinity;
      expect(sendingAt).toBeLessThan(policy.mock.invocationCallOrder[0] ?? 0);
      expect(sendingAt).toBeLessThan(branch.mock.invocationCallOrder[0] ?? 0);
      expect(ctx.answerCallbackQuery.mock.invocationCallOrder[0]).toBeLessThan(
        reconcile.mock.invocationCallOrder[0] ?? 0,
      );
      expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("approved");
      expect(emit).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({ sessionId: "api-1", messageThreadId: 370, text: "approved" }),
      );
      expect(findTelegramChoice(dataDir, "api", "telegram", "tok-approved", -1001)).toBeNull();

      // Replaying the spent button changes nothing.
      const replay = click(123);
      await bot.emitCallback(replay);
      expect(replay.answerCallbackQuery).toHaveBeenCalledWith({
        text: "This choice is no longer active.",
        show_alert: true,
      });
      expect(replay.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("approved");
    });

    it("restores the keyboard and names the approver for a non-approver click", async () => {
      const { dataDir, record, bot, emit, markup, click, rejections } = await approvalFixture([
        123, 456,
      ]);
      const ctx = click(456);

      await bot.emitCallback(ctx);

      expect(ctx.editMessageReplyMarkup.mock.calls).toEqual([
        [sendingRow("Sending: Approve interface…", "tok-approved")],
        [{ reply_markup: markup }],
      ]);
      expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "Only the designated approver can decide this interface approval.",
        show_alert: true,
      });
      expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("pending");
      expect(findTelegramChoice(dataDir, "api", "telegram", "tok-approved", -1001)).not.toBeNull();
      expect(emit).not.toHaveBeenCalled();
      const logged = rejections();
      expect(logged.map((entry) => entry.details)).toEqual([
        { reason: "not-approver", chatId: -1001, userId: 456, consent: true },
      ]);
      const serialized = JSON.stringify(logged);
      for (const secret of ["Approve", "tok-approved", record.challenge])
        expect(serialized).not.toContain(secret);
    });

    it("approves after a buttonless follow-up reply of the same session", async () => {
      const { dataDir, bot, emit, click } = await approvalFixture();
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices: [],
        keepInterfaceConsent: true,
      });

      await bot.emitCallback(click(123));

      expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("approved");
      expect(emit).toHaveBeenCalledOnce();
    });

    it("empties the spent keyboard when recording the decision fails after the take", async () => {
      const { dataDir, bot, emit, markup, click, rejections } = await approvalFixture();
      vi.spyOn(metadataModule, "writeInterfaceConsent").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      const ctx = click(123);

      await bot.emitCallback(ctx);

      expect(ctx.editMessageReplyMarkup).toHaveBeenLastCalledWith({
        reply_markup: { inline_keyboard: [] },
      });
      expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalledWith({ reply_markup: markup });
      expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "Choice failed. Try again.",
        show_alert: true,
      });
      expect(emit).not.toHaveBeenCalled();
      expect(findTelegramChoice(dataDir, "api", "telegram", "tok-approved", -1001)).toBeNull();
      expect(rejections().map((entry) => entry.details?.reason)).toEqual(["internal"]);
    });

    it("leaves the keyboard alone on rejection when the Sending edit failed", async () => {
      const { bot, click, rejections } = await approvalFixture([123, 456]);
      const ctx = click(456);
      ctx.editMessageReplyMarkup.mockRejectedValueOnce(new Error("message is not modified"));

      await bot.emitCallback(ctx);

      expect(ctx.editMessageReplyMarkup).toHaveBeenCalledOnce();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: "Only the designated approver can decide this interface approval.",
        show_alert: true,
      });
      expect(rejections().map((entry) => entry.details?.reason)).toEqual(["not-approver"]);
    });

    it("aborts consent approval if the session becomes terminal while reading current branch", async () => {
      const { dataDir, bot, emit, reconcile, click } = await approvalFixture();
      vi.spyOn(workspaceModule, "readCurrentBranch").mockImplementation(async () => {
        writeTelegramBindings(dataDir, "api", "telegram", []);
        return "feature/example";
      });
      const ctx = click(123);

      await bot.emitCallback(ctx);

      expect(metadataModule.readInterfaceConsent(dataDir, "api-1")?.decision).toBe("pending");
      expect(reconcile).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(findTelegramChoice(dataDir, "api", "telegram", "tok-approved", -1001)).not.toBeNull();
    });
  });

  describe("dropped callbacks", () => {
    const drops = (dataDir: string) =>
      readEventLog(dataDir).filter((entry) => entry.event === "source.telegram.callback_dropped");

    it.each([
      ["duplicate", { data: "spur_choice:none", from: { id: 123 } }],
      ["no-data", { from: { id: 123 } }],
      ["not-allowed", { data: "spur_choice:none", from: { id: 999 } }],
      ["no-sender", { data: "spur_choice:none" }],
    ] as const)("logs a %s drop without answering", async (reason, query) => {
      const dataDir = await createTempDir("spur-telegram-drop-");
      tempDirs.push(dataDir);
      const { bot } = await startSource(dataDir);
      const ctx = {
        update: { update_id: 5 },
        callbackQuery: { ...query, message: { message_id: 90, chat: { id: -1001 } } },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      };
      if (reason === "duplicate") {
        await required(bot).emitCallback(ctx);
        ctx.answerCallbackQuery.mockClear();
      }

      await required(bot).emitCallback(ctx);

      expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
      expect(drops(dataDir).map((entry) => entry.details)).toEqual([
        {
          reason,
          updateId: 5,
          chatId: -1001,
          ...("from" in query ? { userId: query.from.id } : {}),
        },
      ]);
    });

    it("counts repeated drops in one collapse window", async () => {
      const dataDir = await createTempDir("spur-telegram-drop-");
      tempDirs.push(dataDir);
      const { bot } = await startSource(dataDir);
      const stranger = () => ({
        callbackQuery: {
          data: "spur_choice:none",
          from: { id: 999 },
          message: { message_id: 90, chat: { id: -1001 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      });

      await required(bot).emitCallback(stranger());
      await required(bot).emitCallback(stranger());
      flushEventLogCollapse(dataDir);

      expect(drops(dataDir).map((entry) => entry.details?.suppressedCount)).toEqual([undefined, 1]);
    });
  });

  it("workbench /new task plus project tap submits displayed defaults once with multiline task and origin", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "api-new", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    const ctx = await openWorkbench(
      required(bot),
      "/new@SpurProjectsBot Fix checkout\nKeep compatibility",
    );
    expect(spawn).not.toHaveBeenCalled();
    const callback = cardCallback(cardButton(ctx.reply, "Launch api"));
    await required(bot).emitCallback(callback);
    await required(bot).emitCallback(cardCallback(callback.callbackQuery.data));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({
      project: "api",
      agent: "codex",
      mode: "manager",
      prompt: wrapTelegramSpawnPrompt("Fix checkout\nKeep compatibility"),
      telegramOrigin: {
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
      },
    });
    expect(callback.editMessageText).toHaveBeenCalledWith(
      `Created api-new. ${topicLink}`,
      expect.anything(),
    );
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-new",
    );
  });

  it.each(["manual", "auto"])(
    "legacy %s spawn without capability reports unavailable without leaving Spawning",
    async (kind) => {
      const dataDir = await createTempDir("spur-telegram-status-");
      tempDirs.push(dataDir);
      const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), {
        spawnSession: null,
        listProjects: vi.fn().mockResolvedValue([{ id: "api", name: "api" }]),
        config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } },
      });
      const ctx = telegramContext({ text: kind === "manual" ? "/spawn codex task" : "task" });
      await required(bot).emitText(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(
        "Spur spawn is not available for this Telegram source.",
      );
      expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining("Spawning"));
    },
  );

  it.each(["success", "submitted_unknown", "binding_failure"])(
    "legacy status ends in terminal text after %s",
    async (outcome) => {
      const dataDir = await createTempDir("spur-telegram-status-");
      tempDirs.push(dataDir);
      const spawn =
        outcome === "submitted_unknown"
          ? vi.fn().mockRejectedValue(new Error("boom token-123"))
          : vi.fn().mockResolvedValue({
              id: "created",
              project: "api",
              agent: "codex",
              state: "working",
            });
      const { bot } = await startSource(dataDir, vi.fn(), spawn, {
        listProjects: vi.fn().mockResolvedValue([{ id: "api", name: "api" }]),
      });
      const write =
        outcome === "binding_failure"
          ? vi.spyOn(metadataModule, "writeTelegramBindings").mockImplementationOnce(() => {
              throw new Error("Write failed");
            })
          : undefined;
      const ctx = telegramContext({ text: "/spawn codex task" });
      ctx.reply.mockResolvedValue({ message_id: 900 });
      await required(bot).emitText(ctx);
      expect(ctx.reply).toHaveBeenCalledWith("Spawning codex agent...");
      const expected =
        outcome === "success"
          ? `Spawned created. ${topicLink}`
          : outcome === "binding_failure"
            ? "Created created. Binding failed. Use /work to inspect."
            : "Spawn failed: boom <telegram-token>";
      expect(ctx.api.editMessageText).toHaveBeenLastCalledWith(-1001, 900, expected);
      write?.mockRestore();
    },
  );

  it("workbench rejects wrong owner/chat/topic/message without consuming valid revision", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "api-new", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, {
      workbench: capability,
      config: { allowedUsers: [123, 456] },
    });
    const ctx = await openWorkbench(required(bot), "/new task");
    const data = cardButton(ctx.reply, "Launch api");
    for (const overrides of [
      { from: { id: 456 } },
      {
        message: {
          message_id: 700,
          chat: { id: -9 },
          message_thread_id: 22,
          is_topic_message: true,
        },
      },
      {
        message: {
          message_id: 700,
          chat: { id: -1001 },
          message_thread_id: 23,
          is_topic_message: true,
        },
      },
      {
        message: {
          message_id: 999,
          chat: { id: -1001 },
          message_thread_id: 22,
          is_topic_message: true,
        },
      },
    ])
      await required(bot).emitCallback(cardCallback(data, overrides));
    expect(spawn).not.toHaveBeenCalled();
    await required(bot).emitCallback(cardCallback(data));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("workbench refreshes changed defaults without spawning and rejects removed project", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const { bot, spawnSession, listProjects } = await startSource(dataDir, vi.fn(), vi.fn(), {
      workbench: capability,
    });
    const ctx = await openWorkbench(required(bot), "/new task");
    capability.launchOptions.mockImplementation(async ({ project }) => ({
      project,
      agent: "claude",
      model: "auto",
      mode: "manager",
      modes: ["manager"],
    }));
    const callback = cardCallback(cardButton(ctx.reply, "Launch api"));
    await required(bot).emitCallback(callback);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(callback.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Defaults changed"),
      expect.anything(),
    );
    required(listProjects).mockResolvedValue([{ id: "web", name: "web" }]);
    const next = cardCallback(cardButton(callback.editMessageText, "Launch api"));
    await required(bot).emitCallback(next);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(next.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Project unavailable"),
      expect.anything(),
    );
  });

  it("workbench Settings edits the same message, selects configured mode/engine and clears overrides on project switch", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), { workbench: capability });
    const initial = await openWorkbench(required(bot), "/new task");
    const settings = cardCallback(cardButton(initial.reply, "Settings"));
    await required(bot).emitCallback(settings);
    const project = cardCallback(cardButton(settings.editMessageText, "api"));
    await required(bot).emitCallback(project);
    const engine = cardCallback(cardButton(project.editMessageText, "claude"));
    await required(bot).emitCallback(engine);
    const mode = cardCallback(cardButton(engine.editMessageText, "developer"));
    await required(bot).emitCallback(mode);
    expect(capability.launchOptions).toHaveBeenLastCalledWith({
      project: "api",
      agent: "claude",
      mode: "developer",
    });
    expect(mode.reply).not.toHaveBeenCalled();
    const back = cardCallback(cardButton(mode.editMessageText, "Projects"));
    await required(bot).emitCallback(back);
    const nextSettings = cardCallback(cardButton(back.editMessageText, "Settings"));
    await required(bot).emitCallback(nextSettings);
    const web = cardCallback(cardButton(nextSettings.editMessageText, "web"));
    await required(bot).emitCallback(web);
    expect(capability.launchOptions).toHaveBeenLastCalledWith({ project: "web" });
  });

  it("workbench /work inspection leaves binding, pending wizard and mutations unchanged", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "new", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    const wizard = telegramContext({ text: "/spawn codex" });
    await required(bot).emitText(wizard);
    const projectData = spawnProjectCallbackData(wizard.reply, 0);
    await required(bot).emitCallback(cardCallback(projectData));
    const ctx = await openWorkbench(required(bot), "/work");
    const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
    await required(bot).emitCallback(detail);
    expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
    expect(capability.restoreSession).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await required(bot).emitText(telegramContext({ text: "wizard task" }));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["continue", "restore"])(
    "workbench %s clears only same requester pending spawn then ordinary text reaches selected session",
    async (kind) => {
      const dataDir = await createTempDir("spur-telegram-workbench-");
      tempDirs.push(dataDir);
      const { capability, sessions } = workbenchFixture();
      if (kind === "restore") {
        required(sessions[0]).canContinue = false;
        required(sessions[0]).restorable = true;
      }
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        workbench: capability,
      });
      const wizard = telegramContext({ text: "/spawn codex" });
      await required(bot).emitText(wizard);
      await required(bot).emitCallback(cardCallback(spawnProjectCallbackData(wizard.reply, 0)));
      const ctx = await openWorkbench(required(bot), "/work");
      const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
      await required(bot).emitCallback(detail);
      const action = cardCallback(
        cardButton(
          detail.editMessageText,
          kind === "restore" ? "Restore and continue here" : "Continue here",
        ),
      );
      await required(bot).emitCallback(action);
      expect(action.editMessageText).toHaveBeenCalledWith(topicLink, expect.anything());
      expect(emit).not.toHaveBeenCalled();
      await required(bot).emitText(telegramContext({ text: "next instruction" }));
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({ sessionId: "api-1", text: "next instruction" }),
      );
      expect(spawnSession).not.toHaveBeenCalled();
      expect(capability.restoreSession).toHaveBeenCalledTimes(kind === "restore" ? 1 : 0);
      await required(bot).emitCallback(cardCallback(spawnProjectCallbackData(wizard.reply, 0)));
      expect(spawnSession).not.toHaveBeenCalled();
    },
  );

  it("workbench failed restore preserves pending wizard and routing", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability, sessions } = workbenchFixture();
    required(sessions[0]).canContinue = false;
    required(sessions[0]).restorable = true;
    capability.restoreSession.mockRejectedValue(new Error("Admission refused"));
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "new", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    const wizard = telegramContext({ text: "/spawn codex" });
    await required(bot).emitText(wizard);
    await required(bot).emitCallback(cardCallback(spawnProjectCallbackData(wizard.reply, 0)));
    const ctx = await openWorkbench(required(bot), "/work");
    const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
    await required(bot).emitCallback(detail);
    await required(bot).emitCallback(
      cardCallback(cardButton(detail.editMessageText, "Restore and continue here")),
    );
    expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
    await required(bot).emitText(telegramContext({ text: "wizard task" }));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["rejection", "missing result"])(
    "workbench ambiguous submitted spawn (%s) never offers another launch",
    async (failure) => {
      const dataDir = await createTempDir("spur-telegram-workbench-");
      tempDirs.push(dataDir);
      const { capability } = workbenchFixture();
      const spawn =
        failure === "rejection"
          ? vi.fn().mockRejectedValue(new Error("Lost acknowledgement"))
          : vi.fn().mockResolvedValue(undefined);
      const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
      const ctx = await openWorkbench(required(bot), "/new task");
      const action = cardCallback(cardButton(ctx.reply, "Launch api"));
      await required(bot).emitCallback(action);
      expect(action.editMessageText).toHaveBeenCalledWith(
        expect.stringContaining("outcome unknown"),
        { reply_markup: { inline_keyboard: [] } },
      );
      await required(bot).emitCallback(cardCallback(action.callbackQuery.data));
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("workbench duplicate callbacks and source abort during core spawn never duplicate or bind stale result", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const controller = new AbortController();
    let complete!: (session: SourceSessionListItem) => void;
    const spawn = vi.fn(
      () =>
        new Promise<SourceSessionListItem>((resolve) => {
          complete = resolve;
        }),
    );
    const { bot } = await startSource(dataDir, vi.fn(), spawn, {
      workbench: capability,
      signal: controller.signal,
    });
    const ctx = await openWorkbench(required(bot), "/new task");
    const data = cardButton(ctx.reply, "Launch api");
    const first = required(bot).emitCallback(cardCallback(data));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await required(bot).emitCallback(cardCallback(data));
    controller.abort();
    complete({ id: "created", project: "api", agent: "codex", state: "working" });
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
  });

  it("workbench binding failure retains created id and recovery never spawns a replacement", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability, sessions } = workbenchFixture();
    const created = { ...required(sessions[0]), id: "api-new" };
    sessions.push(created);
    const spawn = vi.fn().mockResolvedValue(created);
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    await required(bot).emitText(telegramContext({ text: "/watch api-1" }));
    const oldTarget = readTelegramReplyTarget(dataDir, "api-1");
    const write = vi.spyOn(metadataModule, "writeTelegramBindings").mockImplementationOnce(() => {
      throw new Error("Write failed");
    });
    const ctx = await openWorkbench(required(bot), "/new task");
    const action = cardCallback(cardButton(ctx.reply, "Launch api"));
    await required(bot).emitCallback(action);
    expect(action.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining("Created api-new. No Telegram conversation"),
      expect.anything(),
    );
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-1",
    );
    expect(readTelegramReplyTarget(dataDir, "api-1")).toEqual(oldTarget);
    write.mockRestore();
    await required(bot).emitCallback(
      cardCallback(cardButton(action.editMessageText, "Continue here")),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual(
      expect.arrayContaining([
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        { chatId: -1001, messageThreadId: expect.any(Number), sessionId: "api-new" },
      ]),
    );
  });

  it("workbench duplicate deferred restore callbacks mutate once even when acknowledgement rejects", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability, sessions } = workbenchFixture();
    const session = required(sessions[0]);
    session.canContinue = false;
    session.restorable = true;
    let finish: ((session: SourceWorkSessionItem) => void) | undefined;
    capability.restoreSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), { workbench: capability });
    const ctx = await openWorkbench(required(bot), "/work");
    const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
    await required(bot).emitCallback(detail);
    const data = cardButton(detail.editMessageText, "Restore and continue here");
    const action = cardCallback(data);
    action.answerCallbackQuery.mockRejectedValue(new Error("Expired query"));
    const first = required(bot).emitCallback(action);
    await vi.waitFor(() => expect(capability.restoreSession).toHaveBeenCalledTimes(1));
    await required(bot).emitCallback(cardCallback(data));
    session.canContinue = true;
    session.runtimeAlive = true;
    session.restorable = false;
    required(finish)(session);
    await first;
    expect(capability.restoreSession).toHaveBeenCalledTimes(1);
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-1",
    );
  });

  it("workbench replacing launcher during spawn leaves created session unbound", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    let finish: ((session: SourceSessionListItem) => void) | undefined;
    const spawn = vi.fn(
      () =>
        new Promise<SourceSessionListItem>((resolve) => {
          finish = resolve;
        }),
    );
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    const ctx = await openWorkbench(required(bot), "/new first task");
    const action = cardCallback(cardButton(ctx.reply, "Launch api"));
    const first = required(bot).emitCallback(action);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await openWorkbench(required(bot), "/new replacement task");
    required(finish)({ id: "created", project: "api", agent: "codex", state: "working" });
    await first;
    expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
    expect(action.editMessageText).not.toHaveBeenCalled();
    expect(action.reply).toHaveBeenCalledWith(
      "Task created is available but not bound here. Use /work to inspect and continue it.",
    );
  });

  it.each(["replaced", "revoked", "aborted"])(
    "workbench completed Restore reports unbound id only while still authorized (%s)",
    async (reason) => {
      const dataDir = await createTempDir("spur-telegram-restore-notice-");
      tempDirs.push(dataDir);
      const { capability, sessions } = workbenchFixture();
      const session = required(sessions[0]);
      session.canContinue = false;
      session.restorable = true;
      const controller = new AbortController();
      const allowedUsers = [123];
      let finish: ((session: SourceWorkSessionItem) => void) | undefined;
      capability.restoreSession.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), {
        workbench: capability,
        signal: controller.signal,
        config: { allowedUsers },
      });
      const ctx = await openWorkbench(required(bot), "/work");
      const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
      await required(bot).emitCallback(detail);
      const action = cardCallback(cardButton(detail.editMessageText, "Restore and continue here"));
      const pending = required(bot).emitCallback(action);
      await vi.waitFor(() => expect(capability.restoreSession).toHaveBeenCalledTimes(1));
      if (reason === "replaced") await openWorkbench(required(bot), "/work");
      else if (reason === "revoked") allowedUsers.splice(0);
      else controller.abort();
      session.canContinue = true;
      session.restorable = false;
      session.runtimeAlive = true;
      required(finish)(session);
      await pending;
      expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
      expect(action.editMessageText).not.toHaveBeenCalled();
      if (reason === "replaced")
        expect(action.reply).toHaveBeenCalledWith(
          "Task api-1 is available but not bound here. Use /work to inspect and continue it.",
        );
      else expect(action.reply).not.toHaveBeenCalled();
    },
  );

  it("workbench Continue leaves other users and topics pending wizards intact", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "created", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, {
      workbench: capability,
      config: { allowedUsers: [123, 456] },
    });
    for (const other of [
      { from: { id: 456 }, message_thread_id: 22 },
      { from: { id: 123 }, message_thread_id: 23 },
    ]) {
      const wizard = telegramContext({ text: "/spawn codex", ...other });
      await required(bot).emitText(wizard);
      const callback = cardCallback(spawnProjectCallbackData(wizard.reply, 0), {
        from: other.from,
        message: {
          message_id: 700,
          chat: { id: -1001 },
          message_thread_id: other.message_thread_id,
          is_topic_message: true,
        },
      });
      await required(bot).emitCallback(callback);
    }
    const ctx = await openWorkbench(required(bot), "/work");
    const detail = cardCallback(cardButton(ctx.reply, "api · api-1 · needs_input"));
    await required(bot).emitCallback(detail);
    await required(bot).emitCallback(
      cardCallback(cardButton(detail.editMessageText, "Continue here")),
    );
    await required(bot).emitText(telegramContext({ text: "other user task", from: { id: 456 } }));
    await required(bot).emitText(
      telegramContext({ text: "other topic task", message_thread_id: 23 }),
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("workbench Recent completed rows do not revive legacy watch membership or old recorded replies", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability, sessions } = workbenchFixture();
    sessions.push({
      ...required(sessions[0]),
      id: "completed",
      status: "completed",
      runtimeAlive: false,
      canContinue: false,
      restorable: false,
    });
    recordTelegramMessages(
      dataDir,
      "api",
      "telegram",
      { sessionId: "completed", chatId: -1001 },
      [99],
    );
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { workbench: capability });
    const watch = telegramContext({ text: "/watch completed" });
    await required(bot).emitText(watch);
    expect(watch.reply).toHaveBeenCalledWith("No active Spur session completed.");
    const ctx = await openWorkbench(required(bot), "/work");
    const recent = cardCallback(cardButton(ctx.reply, "recent"));
    await required(bot).emitCallback(recent);
    expect(cardButton(recent.editMessageText, "api · completed · needs_input")).toMatch(
      /^spur_wb:/,
    );
    const reply = telegramContext({
      text: "reply",
      chat: { id: 123 },
      message_thread_id: undefined,
      reply_to_message: { message_id: 99 },
    });
    recordTelegramMessages(
      dataDir,
      "api",
      "telegram",
      { sessionId: "completed", chatId: 123 },
      [99],
    );
    await required(bot).emitText(reply);
    expect(reply.reply).toHaveBeenCalledWith(
      "Spur session completed is gone. Message not delivered.",
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("workbench post-bind edit and reply failures do not roll back successful creation", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const spawn = vi
      .fn()
      .mockResolvedValue({ id: "api-new", project: "api", agent: "codex", state: "working" });
    const { bot } = await startSource(dataDir, vi.fn(), spawn, { workbench: capability });
    const ctx = await openWorkbench(required(bot), "/new task");
    const action = cardCallback(cardButton(ctx.reply, "Launch api"));
    action.editMessageText.mockRejectedValue(new Error("Edit rejected"));
    action.reply.mockRejectedValue(new Error("Reply rejected"));
    await required(bot).emitCallback(action);
    await required(bot).emitCallback(cardCallback(action.callbackQuery.data));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-new",
    );
  });

  it("workbench cards never consume ordinary text and missing capability leaves legacy available", async () => {
    const dataDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(dataDir);
    const { capability } = workbenchFixture();
    const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
      workbench: capability,
    });
    await required(bot).emitText(telegramContext({ text: "/watch api-1" }));
    await openWorkbench(required(bot), "/new task");
    await required(bot).emitText(telegramContext({ text: "ordinary instruction" }));
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", text: "ordinary instruction" }),
    );
    expect(spawnSession).not.toHaveBeenCalled();
    await openWorkbench(required(bot), "/new");
    const otherDir = await createTempDir("spur-telegram-workbench-");
    tempDirs.push(otherDir);
    botInstances.splice(0);
    const legacy = await startSource(otherDir);
    const unavailable = telegramContext({ text: "/work" });
    await required(legacy.bot).emitText(unavailable);
    expect(unavailable.reply).toHaveBeenCalledWith("Workbench unavailable. Use /watch.");
  });

  it("binds a Telegram thread with /watch and emits bound messages", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    const watchCtx = telegramContext({ text: "/watch api-1" });
    await bot.emitText(watchCtx);
    expect(watchCtx.reply).toHaveBeenCalledWith(topicLink);

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

  it("redirects main-chat continuation to the assigned forum topic", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(
      telegramContext({ text: "/watch api-1", chat: { id: 123 }, message_thread_id: undefined }),
    );
    recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-1", chatId: 123 }, [500]);
    const continuation = telegramContext({
      chat: { id: 123 },
      message_thread_id: undefined,
      text: "hello main",
      reply_to_message: { message_id: 500 },
    });
    await bot.emitText(continuation);
    expect(emit).not.toHaveBeenCalled();
    expect(continuation.reply).toHaveBeenCalledWith(topicLink);
    expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({
      chatId: -1001,
      messageThreadId: 22,
    });
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

  it("delivers an agent button click to the offering session and kills the offer", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes, deploy",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          token: "tok1",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Later",
          value: "wait",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
    const offerMarkup = {
      inline_keyboard: [
        [{ text: "Yes", callback_data: "spur_choice:tok0" }],
        [{ text: "Later", callback_data: "spur_choice:tok1" }],
      ],
    };

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          text: "Deploy now?",
          is_topic_message: true,
          chat: { id: -1001 },
          reply_markup: offerMarkup,
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
      editMessageReplyMarkup,
    });

    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(answerCallbackQuery).toHaveBeenCalledWith("Sent: Yes");
    // The keyboard reports progress; the message text and formatting stay.
    expect(editMessageReplyMarkup.mock.calls).toEqual([
      [
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Sending: Yes…", callback_data: "spur_choice:tok0" }]],
          },
        },
      ],
      [
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Selected: Yes", callback_data: "spur_choice:tok0" }]],
          },
        },
      ],
    ]);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("telegram:message", {
      sessionId: "api-1",
      chatId: -1001,
      messageThreadId: 22,
      userId: 123,
      username: "alek",
      messageId: 90,
      text: "yes, deploy",
    });
    expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({
      sessionId: "api-1",
      projectId: "api",
      sourceId: "telegram",
      chatId: -1001,
      messageThreadId: 22,
    });

    // The sibling button is dead: the click consumed the whole offer.
    emit.mockClear();
    answerCallbackQuery.mockClear();
    editMessageReplyMarkup.mockClear();
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok1",
        message: { message_id: 90, chat: { id: -1001 }, reply_markup: offerMarkup },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
      editMessageReplyMarkup,
    });
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "This choice is no longer active.",
      show_alert: true,
    });
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "rejects a callback outside its assigned topic; topic: %s",
    async (isTopic) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const { bot, emit } = await startSource(dataDir);
      if (!bot) throw new Error("missing bot");
      // A stale thread on the stored choice must lose to the clicked message's own.
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices: [
          {
            token: "tok0",
            offerId: "offer-1",
            sessionId: "api-1",
            chatId: -1001,
            messageThreadId: 11,
            text: "Yes",
            value: "yes",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
        keepInterfaceConsent: false,
      });
      const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);

      await bot.emitCallback({
        callbackQuery: {
          data: "spur_choice:tok0",
          message: {
            message_id: 90,
            message_thread_id: 5678,
            is_topic_message: isTopic,
            chat: { id: -1001 },
          },
          from: { id: 123, username: "alek" },
        },
        answerCallbackQuery,
      });

      expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({ messageThreadId: 22 });
      expect(emit).not.toHaveBeenCalled();
      expect(answerCallbackQuery).not.toHaveBeenCalledWith("Sent: Yes");
    },
  );

  it.each([22, undefined])("keeps inaccessible click thread: %s", async (threadId) => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          ...(threadId !== undefined ? { messageThreadId: threadId } : {}),
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: { message_id: 90, date: 0, chat: { id: -1001 } },
        from: { id: 123 },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    });
    expect(emit).toHaveBeenCalledTimes(threadId === undefined ? 0 : 1);
    const target = readTelegramReplyTarget(dataDir, "api-1");
    if (threadId !== undefined) {
      expect(target).toHaveProperty("messageThreadId", threadId);
      expect(emit.mock.calls[0]?.[1]).toHaveProperty("messageThreadId", threadId);
    } else {
      expect(target).toHaveProperty("messageThreadId", 22);
    }
    expect(readTelegramChoices(dataDir, "api", "telegram")).toEqual([]);
  });

  it("carries an unconsumed status message across a click", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    assignTopic(dataDir);
    writeTelegramReplyTarget(dataDir, {
      sessionId: "api-1",
      projectId: "api",
      sourceId: "telegram",
      chatId: -1001,
      messageThreadId: 22,
      statusMessageId: 77,
      lastReplyAt: "2026-03-18T10:02:00.000Z",
    });
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    });

    // A click posts no status message; dropping the pending one would orphan it.
    expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({
      statusMessageId: 77,
      lastReplyAt: "2026-03-18T10:02:00.000Z",
    });
  });

  it("tells a click that lost the race the choice is gone", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    // A buttonless reply retiring the offer between the peek and the take is the
    // only way the take loses; listSessions is the await that opens the window.
    const listSessions = vi.fn().mockImplementation(() => {
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices: [],
        keepInterfaceConsent: true,
      });
      return Promise.resolve([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    });
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
          reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:tok0" }]] },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageReplyMarkup,
    });

    // Never "Sent" for a click that delivered nothing; the spent keyboard goes.
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "This choice is no longer active.",
      show_alert: true,
    });
    expect(editMessageReplyMarkup).toHaveBeenLastCalledWith({
      reply_markup: { inline_keyboard: [] },
    });
    expect(answerCallbackQuery).not.toHaveBeenCalledWith("Sent: Yes");
    expect(emit).not.toHaveBeenCalled();
  });

  it("delivers the click even when acknowledging it fails", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      // Telegram expires callback queries; a rejected ack must not eat the click.
      answerCallbackQuery: vi.fn().mockRejectedValue(new Error("query is too old")),
    });

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", text: "yes" }),
    );
    expect(readTelegramChoices(dataDir, "api", "telegram")).toHaveLength(0);
  });

  it.each(["ordinary", "consent"])(
    "redirects legacy DM %s buttons before taking or deciding",
    async (kind) => {
      const dataDir = await createTempDir("spur-telegram-legacy-choice-");
      tempDirs.push(dataDir);
      const { bot, emit } = await startSource(dataDir);
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: 123,
        choices: [
          {
            token: "legacy",
            offerId: "legacy",
            sessionId: "api-1",
            chatId: 123,
            text: "Approve",
            value: "approved",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ...(kind === "consent"
              ? { interfaceConsent: { challenge: "legacy", decision: "approved" as const } }
              : {}),
          },
        ],
        keepInterfaceConsent: false,
      });
      const take = vi.spyOn(metadataModule, "takeTelegramChoice");
      const decide = vi.spyOn(consentModule, "decideConsent");
      const policy = vi.spyOn(consentModule, "consentPolicy");
      const publish = vi.spyOn(consentModule, "reconcileInterfaceConsent");
      try {
        const callback = cardCallback("spur_choice:legacy", {
          message: { message_id: 90, chat: { id: 123 } },
        });
        await required(bot).emitCallback(callback);
        expect(callback.answerCallbackQuery).toHaveBeenCalledWith(
          "Continue in the assigned topic.",
        );
        expect(callback.reply).toHaveBeenCalledWith(topicLink);
        expect(callback.editMessageText).not.toHaveBeenCalled();
        expect(take).not.toHaveBeenCalled();
        expect(decide).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({
          chatId: -1001,
          messageThreadId: 22,
        });
      } finally {
        take.mockRestore();
        decide.mockRestore();
        policy.mockRestore();
        publish.mockRestore();
      }
    },
  );

  it.each(["unwatch", "replace"])(
    "does not restore routing after %s while the placeholder awaits",
    async (change) => {
      const dataDir = await createTempDir("spur-telegram-placeholder-race-");
      tempDirs.push(dataDir);
      const { bot, emit } = await startSource(dataDir);
      await required(bot).emitText(telegramContext({ text: "/watch api-1" }));
      let acknowledge!: (message: { message_id: number }) => void;
      const ctx = telegramContext();
      ctx.reply.mockReturnValueOnce(
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
      );
      const delivering = required(bot).emitText(ctx);
      await vi.waitFor(() =>
        expect(ctx.reply).toHaveBeenCalledWith("Received. api-1 is thinking..."),
      );
      if (change === "unwatch") await required(bot).emitText(telegramContext({ text: "/unwatch" }));
      else assignTopic(dataDir, "api-2");
      acknowledge({ message_id: 77 });
      await delivering;
      expect(ctx.reply).toHaveBeenCalledWith("Agent conversation changed. Message not delivered.");
      expect(emit).not.toHaveBeenCalled();
      expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
        change === "unwatch" ? undefined : "api-2",
      );
      expect(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId).toBeUndefined();
    },
  );

  it("drops an agent button click for an unknown token, a foreign chat, or a dead session", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi.fn().mockResolvedValue([]);
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const inactive = { text: "This choice is no longer active.", show_alert: true };

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:missing",
        message: { message_id: 90, chat: { id: -1001 } },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
    });
    expect(answerCallbackQuery).toHaveBeenLastCalledWith(inactive);

    // A token from another chat must not fire, and stays unconsumed.
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: { message_id: 91, chat: { id: 123 } },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
    });
    expect(answerCallbackQuery).toHaveBeenLastCalledWith(inactive);

    // Right chat, but the offering session is gone.
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: { message_id: 92, chat: { id: -1001 } },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
    });
    expect(answerCallbackQuery).toHaveBeenLastCalledWith({
      text: "Session is no longer active.",
      show_alert: true,
    });
    expect(emit).not.toHaveBeenCalled();
    expect(readTelegramReplyTarget(dataDir, "api-1")).toBeNull();
    // The offer survives a dead lookup: consuming it would strand the question.
    expect(readTelegramChoices(dataDir, "api", "telegram").map((entry) => entry.token)).toEqual([
      "tok0",
    ]);
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
          is_topic_message: true,
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
          is_topic_message: true,
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
        message: { message_thread_id: 22, is_topic_message: true, chat: { id: -1001 } },
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
          is_topic_message: true,
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
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Conversation selected.");
    expect(editMessageText).toHaveBeenCalledWith(topicLink);
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-2"');
  });

  it("watch commands and callbacks ignore non-topic reply-chain ids", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(
      telegramContext({
        text: "/watch api-1",
        message_thread_id: 400,
        is_topic_message: undefined,
      }),
    );
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
    ]);
    await bot.emitText(
      telegramContext({
        text: "/unwatch",
        message_thread_id: 500,
        is_topic_message: false,
      }),
    );
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-1",
    );
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_watch:api-2",
        message: { message_thread_id: 600, chat: { id: -1001 } },
        from: { id: 123 },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    });
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      { chatId: -1001, messageThreadId: 23, sessionId: "api-2" },
    ]);
    expect(readTelegramReplyTarget(dataDir, "api-2")).toHaveProperty("messageThreadId", 23);
  });

  it.each([123, -1001])(
    "watch commands and callbacks retain identity outside forum topics: %s",
    async (chatId) => {
      const dataDir = await createTempDir("spur-telegram-watch-");
      tempDirs.push(dataDir);
      const { bot } = await startSource(dataDir);
      const ctx = telegramContext({
        text: "/watch api-1",
        chat: { id: chatId },
        is_topic_message: false,
      });
      await required(bot).emitText(ctx);
      expect(ctx.reply).toHaveBeenCalledWith(topicLink);
      const callback = cardCallback("spur_watch:api-2", {
        message: { message_id: 700, chat: { id: chatId }, message_thread_id: 400 },
      });
      await required(bot).emitCallback(callback);
      expect(callback.answerCallbackQuery).toHaveBeenCalledWith("Conversation selected.");
      expect(callback.editMessageText).toHaveBeenCalledWith(
        "Continue in [agent topic](https://t.me/c/1/23).",
      );
    },
  );

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
        { chatId: -1001, messageThreadId: 22, sessionId: "api-2" },
      ]),
    );
  });

  it("reuses the canonical topic when watched from another Telegram target", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1", chat: { id: 123 } }));
    const secondWatchCtx = telegramContext({ text: "/watch api-1", chat: { id: 456 } });
    await bot.emitText(secondWatchCtx);

    expect(secondWatchCtx.reply).toHaveBeenCalledWith(topicLink);
  });

  it("watch callback selects the existing canonical topic", async () => {
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
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageText,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Conversation selected.");
    expect(editMessageText).toHaveBeenCalledWith(topicLink);
  });

  it.each([true, false])("keeps pending spawn across reply chains; topic: %s", async (isTopic) => {
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

    const spawnCtx = telegramContext({ text: "/spawn codex", is_topic_message: isTopic });
    await bot.emitText(spawnCtx);
    expect(spawnCtx.reply).toHaveBeenCalledWith("Select a project for the new codex agent:", {
      reply_markup: expect.anything(),
    });
    expect(spawnSession).not.toHaveBeenCalled();

    const pickCtx = telegramContext({});
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 0),
        message: {
          message_thread_id: isTopic ? 22 : 500,
          is_topic_message: isTopic,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: pickCtx.reply,
    });
    expect(pickCtx.reply).toHaveBeenCalledWith("Send task prompt for new codex Spur agent in api.");
    expect(spawnSession).not.toHaveBeenCalled();

    const promptCtx = telegramContext({
      text: "fix the sidecar",
      message_thread_id: isTopic ? 22 : 600,
      is_topic_message: isTopic,
    });
    await bot.emitText(promptCtx);

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "codex",
        prompt: expect.stringContaining("fix the sidecar"),
      }),
    );
    const origin = spawnSession.mock.calls[0]?.[0]?.telegramOrigin;
    if (isTopic) expect(origin).toHaveProperty("messageThreadId", 22);
    else expect(origin).not.toHaveProperty("messageThreadId");
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
      { chatId: -1001, sessionId: "api-3", messageThreadId: 22 },
    ]);
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain(
      '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
    );
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawning codex agent...");
    expect(promptCtx.reply).toHaveBeenCalledWith(`Spawned api-3. ${topicLink}`);
    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "api-3"');
  });

  it.each(["success", "submitted_unknown", "terminal_failure", "binding_failure"])(
    "consumes a ready text task once after rejected spawn progress: %s",
    async (outcome) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const spawn =
        outcome === "submitted_unknown"
          ? vi.fn().mockRejectedValue(new Error("spawn failed token-123"))
          : vi.fn().mockResolvedValue({
              id: "api-new",
              project: "api",
              agent: "codex",
              state: "working",
            });
      const { bot, emit, logger, listSessions } = await startSource(dataDir, vi.fn(), spawn);
      const spawnCtx = telegramContext({ text: "/spawn codex" });
      await required(bot).emitText(spawnCtx);
      await required(bot).emitCallback({
        callbackQuery: {
          data: spawnProjectCallbackData(spawnCtx.reply, 0),
          message: spawnCtx.message,
          from: spawnCtx.message.from,
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue({}),
      });
      const write =
        outcome === "binding_failure"
          ? vi.spyOn(metadataModule, "writeTelegramBindings").mockImplementationOnce(() => {
              throw new Error("Write failed");
            })
          : undefined;
      const taskCtx = telegramContext({ text: "deliver task" });
      taskCtx.reply.mockRejectedValueOnce(new Error("progress failed token-123"));
      if (outcome === "terminal_failure") {
        taskCtx.reply.mockRejectedValueOnce(new Error("terminal failed"));
      }
      try {
        await required(bot).emitText(taskCtx);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledWith({
          project: "api",
          agent: "codex",
          prompt: wrapTelegramSpawnPrompt("deliver task"),
          telegramOrigin: {
            projectId: "api",
            sourceId: "telegram",
            chatId: -1001,
            messageThreadId: 22,
          },
        });
        expect(logger.warn).toHaveBeenCalledWith(
          "[source:api/telegram] telegram spawn progress failed: progress failed <telegram-token>",
        );
        const bound = outcome === "success" || outcome === "terminal_failure";
        if (bound) {
          listSessions.mockResolvedValue([
            { id: "api-new", project: "api", agent: "codex", state: "working" },
          ]);
        }
        expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
          bound ? "api-new" : undefined,
        );
        const terminal =
          outcome === "submitted_unknown"
            ? "Spawn failed: spawn failed <telegram-token>"
            : outcome === "binding_failure"
              ? "Created api-new. Binding failed. Use /work to inspect."
              : `Spawned api-new. ${topicLink}`;
        expect(taskCtx.reply).toHaveBeenCalledWith(terminal);
        if (outcome === "terminal_failure") {
          expect(taskCtx.reply).toHaveBeenLastCalledWith(
            "Created api-new. Bound; notification failed. Use /work to inspect.",
          );
        }
        expect(taskCtx.api.editMessageText).not.toHaveBeenCalled();
        const followup = telegramContext({ text: "next task" });
        await required(bot).emitText(followup);
        expect(spawn).toHaveBeenCalledTimes(1);
        if (bound) {
          expect(emit).toHaveBeenCalledWith(
            "telegram:message",
            expect.objectContaining({ sessionId: "api-new", text: "next task" }),
          );
        } else {
          expect(emit).not.toHaveBeenCalled();
          expect(followup.reply).toHaveBeenCalledWith(
            "No Spur session bound here. Use /watch or /spawn.",
          );
        }
      } finally {
        write?.mockRestore();
      }
    },
  );

  it.each(["resolve", "reject"])("aborted progress %s prevents submission", async (result) => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const controller = new AbortController();
    const { bot, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
      signal: controller.signal,
      listProjects: vi.fn().mockResolvedValue([{ id: "api", name: "api" }]),
    });
    let resolveProgress: ((value: { message_id: number }) => void) | undefined;
    let rejectProgress: ((error: Error) => void) | undefined;
    const progress = new Promise<{ message_id: number }>((resolve, reject) => {
      resolveProgress = resolve;
      rejectProgress = reject;
    });
    const ctx = telegramContext({ text: "/spawn codex task" });
    ctx.reply.mockReturnValueOnce(progress);
    const task = required(bot).emitText(ctx);
    await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith("Spawning codex agent..."));
    controller.abort();
    if (result === "resolve") resolveProgress?.({ message_id: 55 });
    else rejectProgress?.(new Error("progress failed"));
    await task;
    expect(spawnSession).not.toHaveBeenCalled();
    expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.api.editMessageText).not.toHaveBeenCalled();
  });

  it("retains a replacement ready selection while the previous progress reply rejects", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-old", project: "api", agent: "codex", state: "working" })
      .mockResolvedValueOnce({ id: "api-new", project: "api", agent: "claude", state: "working" });
    const { bot, listSessions } = await startSource(dataDir, vi.fn(), spawn);
    let rejectProgress: ((error: Error) => void) | undefined;
    const progress = new Promise<never>((_resolve, reject) => {
      rejectProgress = reject;
    });
    const oldCtx = telegramContext({ text: "/spawn codex" });
    await required(bot).emitText(oldCtx);
    await required(bot).emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(oldCtx.reply, 0),
        message: oldCtx.message,
        from: oldCtx.message.from,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue({}),
    });
    const oldPrompt = telegramContext({ text: "old task" });
    oldPrompt.reply.mockReturnValueOnce(progress);
    const oldTask = required(bot).emitText(oldPrompt);
    await vi.waitFor(() => expect(oldPrompt.reply).toHaveBeenCalledWith("Spawning codex agent..."));
    const replacement = telegramContext({ text: "/spawn claude" });
    await required(bot).emitText(replacement);
    await required(bot).emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(replacement.reply, 0),
        message: replacement.message,
        from: replacement.message.from,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue({}),
    });
    rejectProgress?.(new Error("progress failed"));
    await oldTask;
    await required(bot).emitText(telegramContext({ text: "replacement task" }));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agent: "codex", prompt: wrapTelegramSpawnPrompt("old task") }),
    );
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        agent: "claude",
        prompt: wrapTelegramSpawnPrompt("replacement task"),
      }),
    );
    listSessions.mockResolvedValue([
      { id: "api-new", project: "api", agent: "claude", state: "working" },
    ]);
    await required(bot).emitText(telegramContext({ text: "followup" }));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:23")?.sessionId).toBe(
      "api-new",
    );
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

  it("asks for a project when /spawn includes an agent and prompt", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "web",
      agent: "codex",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex fix the sidecar" });
    await bot.emitText(spawnCtx);
    expect(spawnCtx.reply).toHaveBeenCalledWith("Select a project for the new codex agent:", {
      reply_markup: expect.anything(),
    });
    expect(spawnSession).not.toHaveBeenCalled();

    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({ message_id: 77 });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 1),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply,
      api: { editMessageText },
    });

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "web",
        agent: "codex",
        prompt: expect.stringContaining("fix the sidecar"),
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain(
      '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
    );
    expect(reply).toHaveBeenCalledWith("Spawning codex agent...");
    // The status message spawned via `reply` gets edited in place through the
    // callback ctx's `api`, not re-sent as a second `reply` — proves the
    // project-pick path's `replyShim` now forwards `api` like the direct
    // `/spawn <agent> <task>` path does.
    expect(editMessageText).toHaveBeenCalledWith(-1001, 77, `Spawned api-3. ${topicLink}`);
    expect(reply).not.toHaveBeenCalledWith(`Spawned api-3. ${topicLink}`);
  });

  it("asks for a prompt after a spawn callback", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "web",
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
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply,
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Selected claude.");
    expect(reply).toHaveBeenCalledWith("Select a project for the new claude agent:", {
      reply_markup: expect.anything(),
    });
    expect(spawnSession).not.toHaveBeenCalled();

    const pickAnswerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const pickReply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(reply, 1),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: pickAnswerCallbackQuery,
      reply: pickReply,
    });
    expect(pickReply).toHaveBeenCalledWith("Send task prompt for new claude Spur agent in web.");
    expect(spawnSession).not.toHaveBeenCalled();

    const promptCtx = telegramContext({ text: "review the branch" });
    await bot.emitText(promptCtx);

    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "web",
        agent: "claude",
        prompt: expect.stringContaining("review the branch"),
      }),
    );
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain(
      '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
    );
    expect(promptCtx.reply).toHaveBeenCalledWith("Spawning claude agent...");
    expect(promptCtx.reply).toHaveBeenCalledWith(`Spawned api-3. ${topicLink}`);
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
    await bot.emitText(spawnCtx);

    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 0),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply,
    });

    expect(reply).toHaveBeenNthCalledWith(1, "Spawning codex agent...");
    expect(reply).toHaveBeenNthCalledWith(2, `Spawned api-3. ${topicLink}`);
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it("reports spawn failure with redacted token", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockRejectedValue(new Error("boom token-123"));
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex fix bug" });
    await bot.emitText(spawnCtx);

    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 0),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply,
    });

    expect(reply).toHaveBeenNthCalledWith(2, "Spawn failed: boom <telegram-token>");
  });

  it("auto-picks the only configured project", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, { listProjects });
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);
    expect(spawnCtx.reply).toHaveBeenCalledWith(
      "Send task prompt for new codex Spur agent in api.",
    );
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
  });

  it("hands the DM it was spawned from to the daemon as the agent's reply origin", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi
      .fn()
      .mockResolvedValue({ id: "api-3", project: "api", agent: "claude", state: "working" });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, { listProjects });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(
      telegramContext({
        text: "/spawn claude do X",
        chat: { id: 123 },
        message_thread_id: undefined,
      }),
    );

    expect(spawnSession.mock.calls[0]?.[0]?.telegramOrigin).toEqual({
      projectId: "api",
      sourceId: "telegram",
      chatId: 123,
    });
  });

  it("a second /spawn with an inline task overwrites the pending record instead of stacking a spawn", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "api",
      agent: "claude",
      state: "working",
    });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-3", project: "api", agent: "claude", state: "waiting" }]);
    const emit = vi.fn();
    const { bot } = await startSource(dataDir, emit, spawnSession, { listProjects, listSessions });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/spawn codex" }));
    await bot.emitText(telegramContext({ text: "/spawn claude do X" }));

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "claude",
        prompt: expect.stringContaining("do X"),
      }),
    );

    // A leftover "codex" pending record from the first /spawn must not
    // stack a second, unrequested spawn on the next free text — it should
    // reach the session the second /spawn just bound instead.
    const textCtx = telegramContext({ text: "hello there" });
    await bot.emitText(textCtx);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-3", text: "hello there" }),
    );
  });

  it("reports when no project can be listed (empty list)", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();

    const noProjectsListProjects = vi.fn().mockResolvedValue([]);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      listProjects: noProjectsListProjects,
    });
    if (!bot) throw new Error("missing bot");
    const emptyCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(emptyCtx);
    expect(emptyCtx.reply).toHaveBeenCalledWith("No projects configured.");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("reports when no project can be listed (dep absent)", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();

    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      listProjects: null,
    });
    if (!bot) throw new Error("missing bot");
    const absentCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(absentCtx);
    expect(absentCtx.reply).toHaveBeenCalledWith("Cannot list projects.");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("reports when listProjects throws", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();

    const throwingListProjects = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      listProjects: throwingListProjects,
    });
    if (!bot) throw new Error("missing bot");
    const throwCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(throwCtx);
    expect(throwCtx.reply).toHaveBeenCalledWith("Cannot list projects: db unavailable");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("routes text to the bound session while a project pick is pending", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "web",
      agent: "codex",
      state: "working",
    });
    const emit = vi.fn();
    const { bot } = await startSource(dataDir, emit, spawnSession);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);

    const textCtx = telegramContext({ text: "send this to api-1" });
    await bot.emitText(textCtx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({
        sessionId: "api-1",
        text: "send this to api-1",
      }),
    );

    // The pending project pick must have survived the bound-session delivery
    // above — a subsequent `spur_sproj:` tap still completes the spawn.
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const pickReply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 1),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: pickReply,
    });
    expect(pickReply).toHaveBeenCalledWith("Send task prompt for new codex Spur agent in web.");

    const promptCtx = telegramContext({ text: "fix the sidecar" });
    await bot.emitText(promptCtx);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ project: "web", agent: "codex" }),
    );
  });

  it("prompts for the project pick instead of auto-spawning", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "api-3",
      project: "web",
      agent: "codex",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: { autoSpawn: { enabled: true, project: "spur-shepherd", agent: "opencode" } },
    });
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);
    const textCtx = telegramContext({ text: "not a project pick" });
    await bot.emitText(textCtx);

    expect(spawnSession).not.toHaveBeenCalled();
    expect(textCtx.reply).toHaveBeenCalledWith(
      "Pick a project for the pending /spawn, or run /spawn again.",
    );

    // The pending record must have survived the skipped autoSpawn above — a
    // subsequent `spur_sproj:` tap still completes the spawn.
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const pickReply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 1),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: pickReply,
    });
    expect(pickReply).toHaveBeenCalledWith("Send task prompt for new codex Spur agent in web.");

    const promptCtx = telegramContext({ text: "fix the sidecar" });
    await bot.emitText(promptCtx);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ project: "web", agent: "codex" }),
    );
  });

  it("rejects an expired project pick", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex" });
    const callbackData = await (async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        await bot.emitText(spawnCtx);
        const data = spawnProjectCallbackData(spawnCtx.reply, 0);
        vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
        return data;
      } finally {
        vi.useRealTimers();
      }
    })();

    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: callbackData,
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: vi.fn().mockResolvedValue({}),
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Spawn expired. Run /spawn again.");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("rejects a project callback with no pending spawn", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_sproj:abc123:0",
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: vi.fn().mockResolvedValue({}),
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Spawn expired. Run /spawn again.");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("rejects a project callback with an empty index instead of resolving it to project 0", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn();
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession);
    if (!bot) throw new Error("missing bot");

    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);
    const validData = spawnProjectCallbackData(spawnCtx.reply, 0);
    const nonce = validData.split(":")[1];
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: `spur_sproj:${nonce}:`,
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: vi.fn().mockResolvedValue({}),
    });

    expect(answerCallbackQuery).toHaveBeenCalledWith("Spawn expired. Run /spawn again.");
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it("rejects a stale project keyboard after a second /spawn", async () => {
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

    const firstCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(firstCtx);
    const staleData = spawnProjectCallbackData(firstCtx.reply, 0);

    const secondCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(secondCtx);
    const freshData = spawnProjectCallbackData(secondCtx.reply, 0);

    const staleAnswer = vi.fn().mockResolvedValue(undefined);
    await bot.emitCallback({
      callbackQuery: {
        data: staleData,
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: staleAnswer,
      reply: vi.fn().mockResolvedValue({}),
    });
    expect(staleAnswer).toHaveBeenCalledWith("Spawn expired. Run /spawn again.");
    expect(spawnSession).not.toHaveBeenCalled();

    const freshAnswer = vi.fn().mockResolvedValue(undefined);
    const freshReply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: freshData,
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: freshAnswer,
      reply: freshReply,
    });
    expect(freshReply).toHaveBeenCalledWith("Send task prompt for new codex Spur agent in api.");
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
          is_topic_message: true,
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
          is_topic_message: true,
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

  it("posts a thinking placeholder naming the agent and records it for reply routing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();
    textCtx.reply.mockResolvedValueOnce({ message_id: 77 });

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith("Received. api-1 is thinking...");
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
    expect(findTelegramMessageSession(dataDir, "api", "telegram", -1001, 77)).toBe("api-1");
  });

  it("marks a superseded placeholder as received", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const first = telegramContext();
    first.reply.mockResolvedValueOnce({ message_id: 77 });
    await bot.emitText(first);
    const second = telegramContext();
    second.reply.mockResolvedValueOnce({ message_id: 78 });

    await bot.emitText(second);

    expect(second.api.editMessageText).toHaveBeenCalledWith(-1001, 77, "Received.");
    expect(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId).toBe(78);
  });

  it("records the new placeholder before editing the superseded one", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const first = telegramContext();
    first.reply.mockResolvedValueOnce({ message_id: 77 });
    await bot.emitText(first);
    const second = telegramContext();
    second.reply.mockResolvedValueOnce({ message_id: 78 });
    const recordedDuringEdit: (number | undefined)[] = [];
    second.api.editMessageText.mockImplementation(async () => {
      recordedDuringEdit.push(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId);
    });

    await bot.emitText(second);

    expect(second.api.editMessageText).toHaveBeenCalledWith(-1001, 77, "Received.");
    expect(recordedDuringEdit).toEqual([78]);
  });

  it("does not edit a placeholder an agent reply already claimed", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const first = telegramContext();
    first.reply.mockResolvedValueOnce({ message_id: 77 });
    await bot.emitText(first);
    // The agent claims the placeholder (clears it) before it starts editing it.
    const claimed = readTelegramReplyTarget(dataDir, "api-1");
    if (!claimed) throw new Error("missing reply target");
    const { statusMessageId: _claimed, updatedAt: _updatedAt, ...withoutStatus } = claimed;
    writeTelegramReplyTarget(dataDir, withoutStatus);
    const second = telegramContext();
    second.reply.mockResolvedValueOnce({ message_id: 78 });

    await bot.emitText(second);

    expect(second.api.editMessageText).not.toHaveBeenCalled();
  });

  it("tells the user a replied-to session is not active and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi.fn().mockResolvedValue([
      { id: "api-1", project: "api", agent: "codex", state: "waiting" },
      { id: "api-2", project: "api", agent: "claude", state: "stopped", inactive: true },
    ]);
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(
      telegramContext({ text: "/watch api-1", chat: { id: 123 }, message_thread_id: undefined }),
    );
    recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-2", chatId: 123 }, [500]);
    const textCtx = telegramContext({
      chat: { id: 123 },
      message_thread_id: undefined,
      reply_to_message: { message_id: 500 },
    });

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith("Continue in [agent topic](https://t.me/c/1/23).");
    expect(emit).not.toHaveBeenCalled();
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
      { chatId: -1001, messageThreadId: 23, sessionId: "api-2" },
    ]);
  });

  it.each([
    ["working", "Received. api-1 is busy; your message is queued."],
    ["rate_limited", "Received. api-1 is busy; your message is queued."],
    ["error", "Received. api-1 is busy; your message is queued."],
    ["needs_input", "Received. api-1 needs input in its terminal; your message is queued."],
    ["waiting", "Received. api-1 is thinking..."],
    ["stale", "Received. api-1 is thinking..."],
  ])("words the placeholder for a %s session", async (state, expected) => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state }]);
    const { bot } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith(expected);
  });

  it("keeps the canonical placeholder when a foreign-chat reply is redirected", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const dm = telegramContext();
    dm.reply.mockResolvedValueOnce({ message_id: 77 });
    await bot.emitText(dm);
    recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-1", chatId: 456 }, [500]);
    const group = telegramContext({
      chat: { id: 456 },
      message_thread_id: undefined,
      reply_to_message: { message_id: 500 },
    });
    group.reply.mockResolvedValueOnce({ message_id: 601 });

    await bot.emitText(group);

    expect(group.api.editMessageText).not.toHaveBeenCalled();
    expect(group.reply).toHaveBeenCalledWith(topicLink);
    expect(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId).toBe(77);
  });

  it("marks the pick on the keyboard and never rewrites the offer text", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);

    // No keyboard on the callback: nothing to roll back, so no "Sending" step.
    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          text: "a < b & c",
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText,
      editMessageReplyMarkup,
    });

    expect(editMessageText).not.toHaveBeenCalled();
    expect(editMessageReplyMarkup.mock.calls).toEqual([
      [
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Selected: Yes", callback_data: "spur_choice:tok0" }]],
          },
        },
      ],
    ]);
  });

  it("drops a legacy DM placeholder when a canonical-topic choice migrates the session", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    writeTelegramBindings(dataDir, "api", "telegram", [{ chatId: 123, sessionId: "api-1" }]);
    writeTelegramReplyTarget(dataDir, {
      sessionId: "api-1",
      projectId: "api",
      sourceId: "telegram",
      chatId: 123,
      statusMessageId: 77,
    });
    const dm = telegramContext({ chat: { id: 123 } });
    expect(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId).toBe(77);
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    });

    const target = readTelegramReplyTarget(dataDir, "api-1");
    expect(target?.chatId).toBe(-1001);
    expect(target?.statusMessageId).toBeUndefined();
    expect(dm.api.editMessageText).not.toHaveBeenCalled();
  });

  it.each([123, -1001])(
    "redirects a recorded legacy reply without delivering or auto-spawning: %s",
    async (chatId) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        config: { autoSpawn: { enabled: true, project: "api", agent: "claude" } },
      });
      if (!bot) throw new Error("missing bot");
      await bot.emitText(
        telegramContext({
          text: "/watch api-1",
          chat: { id: chatId },
          message_thread_id: undefined,
        }),
      );
      recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-2", chatId }, [500]);
      const textCtx = telegramContext({
        chat: { id: chatId },
        message_thread_id: chatId < 0 ? 500 : undefined,
        is_topic_message: undefined,
        reply_to_message: { message_id: 500 },
      });
      textCtx.reply.mockResolvedValueOnce({ message_id: 601 });

      await bot.emitText(textCtx);

      expect(textCtx.reply).toHaveBeenCalledWith("Continue in [agent topic](https://t.me/c/1/23).");
      expect(emit).not.toHaveBeenCalled();
      expect(readTelegramReplyTarget(dataDir, "api-2")).toMatchObject({
        chatId: -1001,
        messageThreadId: 23,
      });
      expect(readTelegramReplyTarget(dataDir, "api-2")?.statusMessageId).toBeUndefined();
      expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        { chatId: -1001, messageThreadId: 23, sessionId: "api-2" },
      ]);
      await bot.emitText(telegramContext({ text: "to first" }));
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({ sessionId: "api-1" }),
      );
      emit.mockClear();
      await bot.emitText(telegramContext({ text: "to second", message_thread_id: 23 }));
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({ sessionId: "api-2", messageThreadId: 23 }),
      );
      expect(spawnSession).not.toHaveBeenCalled();
    },
  );

  it("routes a group reply to an old agent's message by the thread binding, not the message owner", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    recordTelegramMessages(
      dataDir,
      "api",
      "telegram",
      { sessionId: "api-2", chatId: -1001 },
      [500],
    );

    await bot.emitText(telegramContext({ reply_to_message: { message_id: 500 } }));

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1" }),
    );
    expect(readTelegramReplyTarget(dataDir, "api-2")).toBeNull();
  });

  it.each([true, false])(
    "spawn preserves an existing topic owner; origin topic: %s",
    async (isTopic) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const spawnSession = vi
        .fn()
        .mockResolvedValue({ id: "api-3", project: "api", agent: "claude", state: "working" });
      const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
      const listSessions = vi.fn().mockResolvedValue([
        { id: "api-1", project: "api", agent: "codex", state: "waiting" },
        { id: "api-3", project: "api", agent: "claude", state: "working" },
      ]);
      const { bot, emit } = await startSource(dataDir, vi.fn(), spawnSession, {
        listProjects,
        listSessions,
      });
      if (!bot) throw new Error("missing bot");
      await bot.emitText(telegramContext({ text: "/watch api-1", is_topic_message: isTopic }));
      writeTelegramReplyTarget(dataDir, {
        sessionId: "api-1",
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        ...(isTopic ? { messageThreadId: 22 } : {}),
      });
      writeTelegramOffer(dataDir, "api", "telegram", {
        sessionId: "api-1",
        chatId: -1001,
        choices: [
          {
            token: "tok0",
            offerId: "offer-1",
            sessionId: "api-1",
            chatId: -1001,
            text: "Yes",
            value: "yes",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            interfaceConsent: { challenge: "c1", decision: "approved" },
          },
        ],
        keepInterfaceConsent: false,
      });
      recordTelegramMessages(
        dataDir,
        "api",
        "telegram",
        { sessionId: "api-1", chatId: -1001 },
        [500],
      );
      const spawnCtx = telegramContext({ text: "/spawn claude do X", is_topic_message: isTopic });

      await bot.emitText(spawnCtx);

      expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
        { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
        { chatId: -1001, messageThreadId: 23, sessionId: "api-3" },
      ]);
      expect(readTelegramReplyTarget(dataDir, "api-1")).not.toBeNull();
      expect(readTelegramReplyTarget(dataDir, "api-3")?.chatId).toBe(-1001);
      expect(readTelegramChoices(dataDir, "api", "telegram").map((choice) => choice.token)).toEqual(
        ["tok0"],
      );
      expect(spawnCtx.reply).toHaveBeenCalledWith(
        "Spawned api-3. Continue in [agent topic](https://t.me/c/1/23).",
      );
      await bot.emitText(
        telegramContext({
          reply_to_message: { message_id: 500 },
          message_thread_id: isTopic ? 22 : 500,
          is_topic_message: isTopic,
        }),
      );
      if (isTopic)
        expect(emit).toHaveBeenCalledWith(
          "telegram:message",
          expect.objectContaining({ sessionId: "api-1" }),
        );
      else expect(emit).not.toHaveBeenCalled();
      emit.mockClear();
      await bot.emitText(telegramContext({ message_thread_id: 23 }));
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({ sessionId: "api-3" }),
      );
    },
  );

  it("does not detach an existing agent or its offers when another agent spawns", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi
      .fn()
      .mockResolvedValue({ id: "api-3", project: "api", agent: "claude", state: "working" });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, { listProjects });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    // The displaced agent's latest reply target is a different thread of the same group.
    writeTelegramReplyTarget(dataDir, {
      sessionId: "api-1",
      projectId: "api",
      sourceId: "telegram",
      chatId: -1001,
      messageThreadId: 99,
    });
    const offer = (chatId: number, token: string) => ({
      token,
      offerId: `offer-${token}`,
      sessionId: "api-1",
      chatId,
      text: "Yes",
      value: "yes",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [offer(-1001, "here")],
      keepInterfaceConsent: false,
    });
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -2002,
      choices: [offer(-2002, "elsewhere")],
      keepInterfaceConsent: false,
    });

    await bot.emitText(telegramContext({ text: "/spawn claude do X" }));

    expect(readTelegramReplyTarget(dataDir, "api-1")?.messageThreadId).toBe(99);
    expect(readTelegramChoices(dataDir, "api", "telegram").map((choice) => choice.token)).toEqual([
      "here",
      "elsewhere",
    ]);
  });

  it("falls back to the chat binding when the replied-to message is unknown", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    await bot.emitText(telegramContext({ reply_to_message: { message_id: 501 } }));

    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1" }),
    );
  });

  it.each(["gone", "inactive"])(
    "rejects a group-main reply to %s owner without spawning",
    async (state) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const listSessions = vi
        .fn()
        .mockResolvedValue([
          { id: "api-1", project: "api", agent: "codex", state: "waiting" },
          ...(state === "inactive"
            ? [{ id: "api-9", project: "api", agent: "claude", state: "stopped", inactive: true }]
            : []),
        ]);
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        listSessions,
        config: { autoSpawn: { enabled: true, project: "api", agent: "claude" } },
      });
      if (!bot) throw new Error("missing bot");
      await bot.emitText(telegramContext({ text: "/watch api-1", message_thread_id: undefined }));
      recordTelegramMessages(
        dataDir,
        "api",
        "telegram",
        { sessionId: "api-9", chatId: -1001 },
        [500],
      );
      const textCtx = telegramContext({
        message_thread_id: undefined,
        reply_to_message: { message_id: 500 },
      });
      await bot.emitText(textCtx);
      expect(textCtx.reply).toHaveBeenCalledWith(
        state === "gone"
          ? "Spur session api-9 is gone. Message not delivered."
          : "Continue in [agent topic](https://t.me/c/1/23).",
      );
      expect(emit).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      if (state === "gone") expect(readTelegramReplyTarget(dataDir, "api-9")).toBeNull();
      else
        expect(readTelegramReplyTarget(dataDir, "api-9")).toMatchObject({
          chatId: -1001,
          messageThreadId: 23,
        });
      expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
        "api-1",
      );
    },
  );

  it("tells the user a replied-to session is gone and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(
      telegramContext({ text: "/watch api-1", chat: { id: 123 }, message_thread_id: undefined }),
    );
    recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-9", chatId: 123 }, [500]);
    const textCtx = telegramContext({
      chat: { id: 123 },
      message_thread_id: undefined,
      reply_to_message: { message_id: 500 },
    });

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith(
      "Spur session api-9 is gone. Message not delivered.",
    );
    expect(emit).not.toHaveBeenCalled();
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toEqual([
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
    ]);
  });

  it("tells the user a bound session is not active and emits nothing", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi
      .fn()
      .mockResolvedValue([
        { id: "api-1", project: "api", agent: "codex", state: "stopped", inactive: true },
      ]);
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const textCtx = telegramContext();

    await bot.emitText(textCtx);

    expect(textCtx.reply).toHaveBeenCalledWith("api-1 is not active. Message not delivered.");
    expect(emit).not.toHaveBeenCalled();
    expect([...readTelegramBindings(dataDir, "api", "telegram").values()]).toHaveLength(1);
  });

  it("DM spawns receive separate topics and DM replies cannot deliver to either agent", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ id: "api-3", project: "api", agent: "claude", state: "working" })
      .mockResolvedValueOnce({ id: "api-4", project: "api", agent: "claude", state: "working" });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const listSessions = vi.fn().mockResolvedValue([
      { id: "api-3", project: "api", agent: "claude", state: "waiting" },
      { id: "api-4", project: "api", agent: "claude", state: "waiting" },
    ]);
    const emit = vi.fn();
    const { bot } = await startSource(dataDir, emit, spawnSession, { listProjects, listSessions });
    if (!bot) throw new Error("missing bot");
    const spawnA = telegramContext({ text: "/spawn claude task A", chat: { id: 123 } });
    spawnA.reply.mockResolvedValueOnce({ message_id: 40 });
    await bot.emitText(spawnA);
    const spawnB = telegramContext({ text: "/spawn claude task B", chat: { id: 123 } });
    spawnB.reply.mockResolvedValueOnce({ message_id: 41 });
    await bot.emitText(spawnB);

    await bot.emitText(telegramContext({ text: "plain", chat: { id: 123 } }));
    await bot.emitText(
      telegramContext({ text: "to A", chat: { id: 123 }, reply_to_message: { message_id: 40 } }),
    );

    expect(emit).not.toHaveBeenCalled();
    expect(readTelegramReplyTarget(dataDir, "api-3")).toMatchObject({
      chatId: -1001,
      messageThreadId: 22,
    });
    expect(readTelegramReplyTarget(dataDir, "api-4")).toMatchObject({
      chatId: -1001,
      messageThreadId: 23,
    });
    await bot.emitText(telegramContext({ text: "to A", message_thread_id: 22 }));
    await bot.emitText(telegramContext({ text: "to B", message_thread_id: 23 }));
    expect(emit).toHaveBeenNthCalledWith(
      1,
      "telegram:message",
      expect.objectContaining({ sessionId: "api-3", text: "to A" }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      "telegram:message",
      expect.objectContaining({ sessionId: "api-4", text: "to B" }),
    );
    expect(spawnB.reply).not.toHaveBeenCalledWith(expect.stringContaining("took over"));
  });

  it("rejects a button click for an inactive session and keeps the offer", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const listSessions = vi
      .fn()
      .mockResolvedValue([
        { id: "api-1", project: "api", agent: "codex", state: "stopped", inactive: true },
      ]);
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { listSessions });
    if (!bot) throw new Error("missing bot");
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);
    const offerMarkup = {
      inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:tok0" }]],
    };

    await bot.emitCallback({
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
          reply_markup: offerMarkup,
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      editMessageReplyMarkup,
    });

    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: "api-1 is not active.",
      show_alert: true,
    });
    // "Sending" first, then the untouched keyboard back.
    expect(editMessageReplyMarkup).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkup).toHaveBeenLastCalledWith({ reply_markup: offerMarkup });
    expect(emit).not.toHaveBeenCalled();
    expect(findTelegramChoice(dataDir, "api", "telegram", "tok0", -1001)).not.toBeNull();
    expect(
      readEventLog(dataDir)
        .filter((entry) => entry.event === "source.telegram.choice_rejected")
        .map((entry) => [entry.sessionId, entry.details?.reason]),
    ).toEqual([["api-1", "session-inactive"]]);
  });

  it("keeps lastInboundAt behind an agent reply when the spawn bind runs, and a real inbound re-arms it", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockImplementation(async () => {
      // What the daemon does mid-spawn: pre-write the target, then the agent replies.
      assignTopic(dataDir, "api-3");
      writeTelegramReplyTarget(dataDir, {
        sessionId: "api-3",
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
        lastInboundAt: "2000-01-01T00:00:00.000Z",
        lastReplyAt: "2000-01-02T00:00:00.000Z",
      });
      return { id: "api-3", project: "api", agent: "claude", state: "working" };
    });
    const listProjects = vi.fn().mockResolvedValue([{ id: "api", name: "api" }]);
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-3", project: "api", agent: "claude", state: "waiting" }]);
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      listProjects,
      listSessions,
    });
    if (!bot) throw new Error("missing bot");

    await bot.emitText(
      telegramContext({
        text: "/spawn claude do X",
        chat: { id: 123 },
        message_thread_id: undefined,
      }),
    );

    expect(readTelegramReplyTarget(dataDir, "api-3")).toMatchObject({
      lastInboundAt: "2000-01-01T00:00:00.000Z",
      lastReplyAt: "2000-01-02T00:00:00.000Z",
    });

    await bot.emitText(telegramContext({ text: "next" }));

    const afterInbound = readTelegramReplyTarget(dataDir, "api-3");
    expect((afterInbound?.lastInboundAt ?? "") > (afterInbound?.lastReplyAt ?? "")).toBe(true);
    expect(afterInbound?.lastReplyAt).toBe("2000-01-02T00:00:00.000Z");
  });

  it("stamps lastInboundAt when forwarding a bound inbound message", async () => {
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
    const persisted = JSON.parse(await readFile(replyTargetPath, "utf8")) as {
      lastInboundAt?: string;
    };
    expect(typeof persisted.lastInboundAt).toBe("string");
    expect(new Date(persisted.lastInboundAt ?? "").toString()).not.toBe("Invalid Date");
  });

  it("stores placeholders only for the assigned forum topic", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");

    await bot.emitText(telegramContext({ text: "/watch api-1" }));
    const topic = telegramContext();
    topic.reply.mockResolvedValueOnce({ message_id: 77 });
    await bot.emitText(topic);
    expect(readTelegramReplyTarget(dataDir, "api-1")?.statusMessageId).toBe(77);

    await bot.emitText(
      telegramContext({ text: "/watch api-2", chat: { id: 123 }, message_thread_id: undefined }),
    );
    const dm = telegramContext({ chat: { id: 123 }, message_thread_id: undefined });
    dm.reply.mockResolvedValueOnce({ message_id: 78 });
    await bot.emitText(dm);
    expect(readTelegramReplyTarget(dataDir, "api-2")?.statusMessageId).toBeUndefined();

    await bot.emitText(telegramContext({ text: "/watch web-1", message_thread_id: undefined }));
    const groupMain = telegramContext({ message_thread_id: undefined });
    groupMain.reply.mockResolvedValueOnce({ message_id: 79 });
    await bot.emitText(groupMain);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1" }),
    );
    expect(readTelegramReplyTarget(dataDir, "web-1")?.statusMessageId).toBeUndefined();
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
    expect(readTelegramReplyTarget(dataDir, "api-1")).toMatchObject({
      projectId: "api",
      sourceId: "telegram",
      chatId: -1001,
    });
    expect(readTelegramReplyTarget(dataDir, "api-1")).not.toHaveProperty("messageThreadId");
  });

  const autoSpawnConfig = {
    autoSpawn: {
      enabled: true,
      project: "spur-shepherd",
      agent: "opencode",
      model: "google/gemini-3.8-flash",
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
      model: "google/gemini-3.8-flash",
      selfDestruct: { enabled: true },
      prompt: expect.stringContaining("help me out"),
      // The agent may reply before this handler binds; the daemon writes the target from this.
      telegramOrigin: {
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
      },
    });
    expect(spawnSession.mock.calls[0]?.[0]?.prompt).toContain(
      '"$SPUR_SESSION_TOOL_DIR/spur" source reply "<message>"',
    );
    expect(ctx.reply).toHaveBeenCalledWith(`Spawned shp-1. ${topicLink}`);
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
    expect(textCtx.reply).toHaveBeenCalledWith(
      "Spawned shp-3. Continue in [agent topic](https://t.me/c/1/23).",
    );
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
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:23")?.sessionId).toBe(
      "shp-5",
    );
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
    expect(ctx2.reply).toHaveBeenCalledWith(`Spawned shp-4. ${topicLink}`);
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
      expect(expiredCtx.reply).toHaveBeenCalledWith("Spawn expired. Run /spawn again.");
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
      { command: "new", description: "Launch a task with project defaults" },
      { command: "work", description: "Inspect tasks needing attention" },
      { command: "unwatch", description: "Unbind this chat" },
      { command: "complete", description: "Complete this topic's Spur session" },
      { command: "kill", description: "Kill this topic's Spur session" },
    ]);
    expect(bot.api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: "commands" },
    });
    expect(runMock).toHaveBeenCalledWith(
      bot,
      expect.objectContaining({ sink: { concurrency: 1 } }),
    );
  });

  it("registers the command menu on a new bot after source stop and restart", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const first = await startSource(dataDir);
    const firstBot = required(first.bot);
    await vi.waitFor(() => expect(firstBot.api.setChatMenuButton).toHaveBeenCalledTimes(1));
    await first.handle.stop();

    const second = await startSource(dataDir);
    const secondBot = required(botInstances.at(-1));
    expect(botInstances).toHaveLength(2);
    expect(secondBot).not.toBe(firstBot);
    await vi.waitFor(() => expect(secondBot.api.setChatMenuButton).toHaveBeenCalledTimes(1));
    expect(firstBot.api.setMyCommands).toHaveBeenCalledTimes(1);
    expect(secondBot.api.setMyCommands).toHaveBeenCalledTimes(1);
    expect(secondBot.api.setMyCommands.mock.calls).toEqual(firstBot.api.setMyCommands.mock.calls);
    expect(secondBot.api.setChatMenuButton).toHaveBeenCalledWith({
      menu_button: { type: "commands" },
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock.mock.calls[1]?.[0]).toBe(secondBot);
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).not.toHaveBeenCalled();
    await second.handle.stop();
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["setMyCommands", "setChatMenuButton"] as const)(
    "redacts %s menu setup failure while the runner continues",
    async (method) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      getMeMock.mockImplementationOnce(async () => {
        required(botInstances.at(-1)).api[method].mockRejectedValueOnce(
          new Error(`${method} rejected token-123`),
        );
        return { username: "SpurProjectsBot" };
      });
      const { bot, handle, logger, stop } = await startSource(dataDir);
      const startedBot = required(bot);
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          `[source:api/telegram] telegram commands setup failed: ${method} rejected <telegram-token>`,
        ),
      );
      expect(logger.warn.mock.calls.flat().join("\n")).not.toContain("token-123");
      expect(startedBot.api.setMyCommands).toHaveBeenCalledTimes(1);
      if (method === "setMyCommands") {
        expect(startedBot.api.setChatMenuButton).not.toHaveBeenCalled();
      } else {
        expect(startedBot.api.setChatMenuButton).toHaveBeenCalledTimes(1);
      }
      expect(runMock).toHaveBeenCalledWith(startedBot, expect.anything());
      expect(stop).not.toHaveBeenCalled();
      const help = telegramContext({ text: "/help" });
      await startedBot.emitText(help);
      expect(help.reply).toHaveBeenCalledWith(expect.stringContaining("/new"));
      expect(help.reply).toHaveBeenCalledWith(expect.stringContaining("/complete"));
      expect(help.reply).toHaveBeenCalledWith(expect.stringContaining("/kill"));
      await handle.stop();
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

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

  it("exposes cached bot identity without another getMe", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const calls = getMeMock.mock.calls.length;
    const { handle } = await startSource(dataDir, vi.fn(), vi.fn());
    expect(handle.telegramBotIdentity).toEqual({ id: 44, username: "SpurProjectsBot" });
    expect(handle.telegramBotIdentity).toEqual({ id: 44, username: "SpurProjectsBot" });
    expect(getMeMock.mock.calls.length).toBe(calls + 1);
    expect(JSON.stringify(handle.telegramBotIdentity)).not.toContain("token");
  });

  it("logs auth_failed and still starts when getMe fails", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    getMeMock.mockRejectedValueOnce(new Error("unauthorized"));
    const { handle, logger } = await startSource(dataDir, vi.fn(), vi.fn(), {
      listSessions: vi.fn().mockResolvedValue([]),
    });

    expect(handle).toBeDefined();
    expect(handle.telegramBotIdentity).toBeUndefined();
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
      return Promise.resolve(new Response(new Uint8Array(4)));
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text }) });
  });
}

describe("telegramSourceModule photo tasks", () => {
  beforeEach(() => {
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function beginWizard(bot: FakeBot, agent = "codex", pickProject = true) {
    const wizard = telegramContext({ text: `/spawn ${agent}` });
    await bot.emitText(wizard);
    if (pickProject)
      await bot.emitCallback({
        callbackQuery: {
          data: spawnProjectCallbackData(wizard.reply, 0),
          message: wizard.message,
          from: wizard.message.from,
        },
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue({}),
      });
  }

  it.each([
    { mode: "wizard", caption: "  /inspect this photo  " },
    { mode: "wizard", caption: undefined },
    { mode: "auto", caption: undefined },
  ])("spawns a $mode photo task with caption $caption once", async ({ mode, caption }) => {
    const dataDir = await createTempDir("spur-telegram-photo-");
    tempDirs.push(dataDir);
    const spawn = vi.fn().mockResolvedValue({
      id: "photo-agent",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot, emit } = await startSource(dataDir, vi.fn(), spawn, {
      config:
        mode === "auto"
          ? { autoSpawn: { enabled: true, project: "api", agent: "codex", model: "auto" } }
          : {},
    });
    if (mode === "wizard") await beginWizard(required(bot));
    const fetchMock = vi.fn().mockResolvedValue(new Response("photo-bytes"));
    vi.stubGlobal("fetch", fetchMock);
    const photo = telegramPhotoContext({ caption, updateId: 500 });
    await required(bot).emitPhoto(photo);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "api",
        agent: "codex",
        prompt: wrapTelegramSpawnPrompt(caption?.trim() || "Inspect the attached files."),
        attachments: [
          { name: "telegram-10.jpg", data: Buffer.from("photo-bytes").toString("base64") },
        ],
        ...(mode === "auto" ? { model: "auto" } : {}),
      }),
    );
    await required(bot).emitPhoto(photo);
    expect(photo.getFile).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "awaiting-project", "expired", "inactive", "legacy", "off"])(
    "rejects %s photo intake before download",
    async (scenario) => {
      const dataDir = await createTempDir("spur-telegram-photo-guard-");
      tempDirs.push(dataDir);
      if (["bound", "inactive", "legacy"].includes(scenario)) {
        if (scenario === "legacy")
          writeTelegramBindings(dataDir, "api", "telegram", [
            { chatId: -1001, sessionId: "api-1" },
          ]);
        else assignTopic(dataDir);
      }
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        ...(scenario === "inactive"
          ? {
              getSession: vi.fn().mockResolvedValue({
                id: "api-1",
                project: "api",
                agent: "codex",
                state: "waiting",
                inactive: true,
              }),
            }
          : {}),
      });
      if (scenario === "awaiting-project") await beginWizard(required(bot), "codex", false);
      if (scenario === "expired") {
        vi.useFakeTimers();
        await beginWizard(required(bot));
        vi.setSystemTime(Date.now() + 11 * 60_000);
      }
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const photo = telegramPhotoContext({
        ...(scenario === "unauthorized" ? { from: { id: 999 } } : {}),
        ...(scenario === "legacy" ? { message_thread_id: undefined, is_topic_message: false } : {}),
      });
      await required(bot).emitPhoto(photo);
      expect(photo.getFile).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      if (scenario !== "unauthorized") expect(photo.reply).toHaveBeenCalled();
    },
  );

  it.each(["missing-path", "http", "empty", "oversize", "network"])(
    "rejects %s photo downloads without submitting the caption",
    async (failure) => {
      const dataDir = await createTempDir("spur-telegram-photo-failure-");
      tempDirs.push(dataDir);
      const { bot, emit, spawnSession, logger } = await startSource(dataDir);
      await beginWizard(required(bot));
      const photo = telegramPhotoContext({ caption: "do not submit alone" });
      if (failure === "missing-path") photo.getFile.mockResolvedValue({ file_path: "" });
      const fetchMock = vi.fn().mockImplementation(async () => {
        if (failure === "network")
          throw new Error("failed https://api.telegram.org/file/bottoken-123/photo.jpg");
        return new Response(
          failure === "oversize"
            ? new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
            : failure === "empty"
              ? ""
              : "photo",
          { status: failure === "http" ? 403 : 200 },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      await required(bot).emitPhoto(photo);
      await vi.waitFor(() =>
        expect(photo.reply).toHaveBeenCalledWith(
          expect.stringContaining("Attachment task failed:"),
        ),
      );
      expect(spawnSession).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(JSON.stringify(photo.reply.mock.calls)).not.toContain("token-123");
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("token-123");
    },
  );

  it.each(
    mediaKinds.flatMap((kind) => ["wizard", "auto", "followup"].map((mode) => ({ kind, mode }))),
  )("delivers $kind attachment bytes through $mode", async ({ kind, mode }) => {
    const dataDir = await createTempDir("spur-telegram-media-");
    tempDirs.push(dataDir);
    if (mode === "followup") assignTopic(dataDir);
    const prepare = vi.fn<NonNullable<SourceStartDeps["prepareSessionMessage"]>>(
      async (_sessionId, request) =>
        `[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/saved]\n${request.message}`,
    );
    const spawn = vi.fn().mockResolvedValue({
      id: "media-agent",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot, emit } = await startSource(dataDir, vi.fn(), spawn, {
      prepareSessionMessage: prepare,
      config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } },
    });
    if (mode === "wizard") await beginWizard(required(bot));
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("api.telegram.org")
        ? new Response("file-bytes")
        : Response.json({ text: "voice transcript" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const attachment = telegramAttachmentContext(kind, { caption: " file task " });
    await required(bot).emitPhoto(attachment);
    if (mode === "followup") {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
      expect(prepare).toHaveBeenCalledWith(
        "api-1",
        expect.objectContaining({
          message: kind === "voice" ? "file task\nvoice transcript" : "file task",
          attachments: [
            { name: expect.any(String), data: Buffer.from("file-bytes").toString("base64") },
          ],
        }),
      );
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({
          text: expect.stringContaining("$SPUR_SESSION_ARTIFACTS_DIR/saved"),
        }),
      );
      expect(spawn).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("file task"),
          attachments: [
            { name: expect.any(String), data: Buffer.from("file-bytes").toString("base64") },
          ],
        }),
      );
      expect(prepare).not.toHaveBeenCalled();
    }
    expect(attachment.getFile).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(kind === "voice" ? 2 : 1);
  });

  it.each([
    { input: "../../bad name.txt", expected: "bad_name.txt" },
    { input: "C:\\folder\\音声.wav", expected: "__.wav" },
    { input: "...", expected: "telegram-10.bin" },
    { input: "", expected: "telegram-10.bin" },
    { input: `${"a".repeat(200)}.csv`, expected: `${"a".repeat(156)}.csv` },
  ])("normalizes attachment filename $input", async ({ input, expected }) => {
    const dataDir = await createTempDir("spur-telegram-media-name-");
    tempDirs.push(dataDir);
    const { bot, spawnSession } = await startSource(
      dataDir,
      vi.fn(),
      vi.fn().mockResolvedValue({
        id: "media",
        project: "api",
        agent: "codex",
        state: "working",
      }),
      { config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } } },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bytes")),
    );
    await required(bot).emitPhoto(
      telegramAttachmentContext("document", {
        document: { file_id: "doc", file_name: input },
      }),
    );
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledTimes(1));
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ name: expected, data: Buffer.from("bytes").toString("base64") }],
      }),
    );
  });

  it("selects animation alias once and retains native animated sticker formats", async () => {
    const dataDir = await createTempDir("spur-telegram-media-alias-");
    tempDirs.push(dataDir);
    assignTopic(dataDir);
    const prepare = vi.fn<NonNullable<SourceStartDeps["prepareSessionMessage"]>>(
      async (_id, request) => request.message,
    );
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), {
      prepareSessionMessage: prepare,
    });
    const fetchMock = vi.fn(async () => new Response("bytes"));
    vi.stubGlobal("fetch", fetchMock);
    const contexts = [
      telegramAttachmentContext("animation", {
        animation: { file_id: "gif", file_name: "motion.gif" },
        document: { file_id: "gif", file_name: "alias.gif" },
      }),
      telegramAttachmentContext("sticker", { sticker: { file_id: "tgs", is_animated: true } }),
      telegramAttachmentContext("sticker", { sticker: { file_id: "webm", is_video: true } }),
    ];
    for (const context of contexts) {
      await required(bot).emitPhoto(context);
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(contexts.indexOf(context) + 1));
    }
    expect(prepare.mock.calls.map((call) => call[1].attachments?.[0]?.name)).toEqual([
      "motion.gif",
      "telegram-10.tgs",
      "telegram-10.webm",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "reject", "retarget", "inactive", "placeholder", "stop"])(
    "blocks followup emission when attachment preparation is $s",
    async (scenario) => {
      const dataDir = await createTempDir("spur-telegram-media-prepare-");
      tempDirs.push(dataDir);
      assignTopic(dataDir);
      let finish!: (text: string) => void;
      const prepare = vi.fn<NonNullable<SourceStartDeps["prepareSessionMessage"]>>(() =>
        scenario === "reject"
          ? Promise.reject(new Error("disk failed"))
          : new Promise((resolve) => {
              finish = resolve;
            }),
      );
      const getSession = vi.fn().mockResolvedValue({
        id: "api-1",
        project: "api",
        agent: "codex",
        state: "waiting",
      });
      const { bot, emit, handle } = await startSource(dataDir, vi.fn(), vi.fn(), {
        prepareSessionMessage: scenario === "missing" ? null : prepare,
        getSession,
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("bytes")),
      );
      const context = telegramAttachmentContext("document");
      if (scenario === "placeholder")
        context.reply.mockImplementation(async () => {
          assignTopic(dataDir, "api-2");
          return {};
        });
      await required(bot).emitPhoto(context);
      if (scenario === "missing" || scenario === "reject") {
        await vi.waitFor(() =>
          expect(context.reply).toHaveBeenCalledWith(
            expect.stringContaining(scenario === "missing" ? "unavailable" : "disk failed"),
          ),
        );
      } else {
        await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
        if (scenario === "retarget") assignTopic(dataDir, "api-2");
        if (scenario === "inactive")
          getSession.mockResolvedValue({
            id: "api-1",
            project: "api",
            agent: "codex",
            state: "waiting",
            inactive: true,
          });
        if (scenario === "stop") await handle.stop();
        finish("[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/saved]");
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each(["spawn", "followup", "failure", "overflow", "deadline", "late", "capacity", "stop"])(
    "assembles albums without partial delivery: %s",
    async (scenario) => {
      vi.useFakeTimers();
      const dataDir = await createTempDir("spur-telegram-media-album-");
      tempDirs.push(dataDir);
      if (scenario === "followup") assignTopic(dataDir);
      const prepare = vi.fn<NonNullable<SourceStartDeps["prepareSessionMessage"]>>(
        async (_id, request) =>
          `[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/album]\n${request.message}`,
      );
      const spawn = vi
        .fn()
        .mockResolvedValue({ id: "album", project: "api", agent: "codex", state: "working" });
      const { bot, emit, handle } = await startSource(dataDir, vi.fn(), spawn, {
        config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } },
        prepareSessionMessage: prepare,
      });
      let downloadCount = 0;
      const fetchMock = vi.fn(async () => {
        downloadCount++;
        if (scenario === "failure" && downloadCount === 2)
          return new Response("bad", { status: 403 });
        return new Response("album-bytes");
      });
      vi.stubGlobal("fetch", fetchMock);
      const first = telegramAttachmentContext("photo", {
        media_group_id: "album",
        message_id: 20,
        caption: "second caption",
      });
      const second = telegramAttachmentContext("photo", {
        media_group_id: "album",
        message_id: 10,
        caption: "first caption",
      });
      await required(bot).emitPhoto(first);
      await required(bot).emitPhoto(first); // Same member without update_id must not reset collection.
      await required(bot).emitPhoto(second);
      expect(fetchMock).not.toHaveBeenCalled();
      if (scenario === "overflow") {
        for (let index = 0; index < 9; index++)
          await required(bot).emitPhoto(
            telegramAttachmentContext("photo", {
              media_group_id: "album",
              message_id: 30 + index,
            }),
          );
      } else if (scenario === "deadline") {
        for (let index = 0; index < 7; index++) {
          await vi.advanceTimersByTimeAsync(700);
          await required(bot).emitPhoto(
            telegramAttachmentContext("photo", {
              media_group_id: "album",
              message_id: 30 + index,
            }),
          );
        }
        await vi.advanceTimersByTimeAsync(100);
      } else if (scenario === "capacity") {
        for (let index = 0; index < 9; index++)
          await required(bot).emitPhoto(
            telegramAttachmentContext("photo", {
              media_group_id: `other-${index}`,
              message_id: 100 + index,
            }),
          );
        const excess = telegramAttachmentContext("photo", {
          media_group_id: "excess",
          message_id: 200,
        });
        await required(bot).emitPhoto(excess);
        expect(excess.reply).toHaveBeenCalledWith(expect.stringContaining("busy"));
        await handle.stop();
      } else if (scenario === "stop") {
        await handle.stop();
      }
      await vi.advanceTimersByTimeAsync(750);
      if (["spawn", "followup", "late"].includes(scenario)) {
        if (scenario === "followup") {
          expect(prepare).toHaveBeenCalledExactlyOnceWith("api-1", {
            message: "first caption\nsecond caption",
            attachments: [
              { name: "telegram-10.jpg", data: Buffer.from("album-bytes").toString("base64") },
              { name: "telegram-20.jpg", data: Buffer.from("album-bytes").toString("base64") },
            ],
          });
          expect(emit).toHaveBeenCalledTimes(1);
        } else {
          expect(spawn).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              prompt: wrapTelegramSpawnPrompt("first caption\nsecond caption"),
              attachments: [
                { name: "telegram-10.jpg", data: Buffer.from("album-bytes").toString("base64") },
                { name: "telegram-20.jpg", data: Buffer.from("album-bytes").toString("base64") },
              ],
            }),
          );
        }
        if (scenario === "late") {
          const repeat = telegramAttachmentContext("photo", {
            media_group_id: "album",
            message_id: 20,
          });
          await required(bot).emitPhoto(repeat);
          expect(repeat.reply).not.toHaveBeenCalled();
          const late = telegramAttachmentContext("photo", {
            media_group_id: "album",
            message_id: 50,
          });
          await required(bot).emitPhoto(late);
          expect(late.reply).toHaveBeenCalledWith(expect.stringContaining("Album already closed"));
          expect(late.getFile).not.toHaveBeenCalled();
          expect(spawn).toHaveBeenCalledTimes(1);
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } else {
        expect(spawn).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        if (scenario !== "failure") expect(fetchMock).not.toHaveBeenCalled();
        if (scenario === "failure")
          expect(second.reply).toHaveBeenCalledWith(expect.stringContaining("403"));
      }
      await handle.stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not install album timers after a delayed intake lookup is stopped", async () => {
    vi.useFakeTimers();
    const dataDir = await createTempDir("spur-telegram-media-stop-intake-");
    tempDirs.push(dataDir);
    assignTopic(dataDir);
    let finish!: (session: SourceSessionListItem) => void;
    const getSession = vi.fn(
      () =>
        new Promise<SourceSessionListItem>((resolve) => {
          finish = resolve;
        }),
    );
    const { bot, handle, emit } = await startSource(dataDir, vi.fn(), vi.fn(), { getSession });
    const context = telegramAttachmentContext("photo", { media_group_id: "album" });
    const receiving = required(bot).emitPhoto(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSession).toHaveBeenCalled();
    await handle.stop();
    finish({ id: "api-1", project: "api", agent: "codex", state: "working" });
    await receiving;
    expect(vi.getTimerCount()).toBe(0);
    expect(context.getFile).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not install album timers after update persistence is stopped", async () => {
    vi.useFakeTimers();
    const dataDir = await createTempDir("spur-telegram-media-stop-update-");
    tempDirs.push(dataDir);
    const { bot, handle, emit } = await startSource(dataDir, vi.fn(), vi.fn(), {
      config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } },
    });
    const context = telegramAttachmentContext("photo", { media_group_id: "album", updateId: 500 });
    const receiving = required(bot).emitPhoto(context);
    await handle.stop();
    await receiving;
    expect(vi.getTimerCount()).toBe(0);
    expect(context.getFile).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("retains 1000 closed album keys without eviction and admits groups after expiry", async () => {
    vi.useFakeTimers();
    const dataDir = await createTempDir("spur-telegram-media-closed-");
    tempDirs.push(dataDir);
    const { bot, handle, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
      config: { autoSpawn: { enabled: true, project: "api", agent: "codex" } },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (let batch = 0; batch < 100; batch++) {
      for (let index = 0; index < 10; index++) {
        await required(bot).emitPhoto(
          telegramAttachmentContext("document", {
            media_group_id: `closed-${batch * 10 + index}`,
            document: { file_id: "large", file_size: MAX_ATTACHMENT_BYTES + 1 },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(750);
    }
    const excess = telegramAttachmentContext("photo", { media_group_id: "excess" });
    await required(bot).emitPhoto(excess);
    expect(excess.reply).toHaveBeenCalledWith(expect.stringContaining("busy"));
    const late = telegramAttachmentContext("photo", { media_group_id: "closed-0", message_id: 11 });
    await required(bot).emitPhoto(late);
    expect(late.reply).toHaveBeenCalledWith(expect.stringContaining("Album already closed"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const retry = telegramAttachmentContext("photo", { media_group_id: "excess" });
    await required(bot).emitPhoto(retry);
    expect(retry.reply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    await handle.stop();
  });

  it.each(["wizard", "binding", "config", "abort"])(
    "rejects a stale photo after %s changes during download",
    async (change) => {
      const dataDir = await createTempDir("spur-telegram-photo-stale-");
      tempDirs.push(dataDir);
      const controller = new AbortController();
      const autoSpawn = { enabled: true, project: "api", agent: "codex", model: "auto" };
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        signal: controller.signal,
        config: { autoSpawn },
      });
      if (change === "wizard") await beginWizard(required(bot));
      let finish!: (response: Response) => void;
      const fetchMock = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const photo = telegramPhotoContext();
      await required(bot).emitPhoto(photo);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      if (change === "wizard") await beginWizard(required(bot), "claude");
      if (change === "binding") assignTopic(dataDir);
      if (change === "config") autoSpawn.model = "other";
      if (change === "abort") controller.abort();
      finish(new Response("photo"));
      if (change !== "abort")
        await vi.waitFor(() =>
          expect(photo.reply).toHaveBeenCalledWith(
            expect.stringContaining("Attachment context changed. Send the message again."),
          ),
        );
      else await new Promise((resolve) => setTimeout(resolve, 10));
      expect(spawnSession).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      if (change === "abort") expect(photo.reply).not.toHaveBeenCalled();
    },
  );
});

describe("telegramSourceModule voice notes", () => {
  beforeEach(() => {
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each([
    { mode: "wizard", forum: true },
    { mode: "wizard", forum: false },
    { mode: "auto", forum: true },
    { mode: "auto", forum: false },
  ])(
    "keeps DM $mode voice spawn intake without transcript echo; forum:$forum",
    async ({ mode, forum }) => {
      const dataDir = await createTempDir("spur-telegram-voice-spawn-");
      tempDirs.push(dataDir);
      const spawn = vi
        .fn()
        .mockResolvedValue({ id: "voice-agent", project: "api", agent: "codex", state: "working" });
      const { bot, emit } = await startSource(dataDir, vi.fn(), spawn, {
        config: {
          chatId: forum ? -1001 : undefined,
          ...(mode === "auto"
            ? { autoSpawn: { enabled: true, project: "api", agent: "codex" } }
            : {}),
        },
      });
      if (mode === "wizard") {
        const wizard = telegramContext({
          text: "/spawn codex",
          chat: { id: 123 },
          message_thread_id: undefined,
          is_topic_message: false,
        });
        await required(bot).emitText(wizard);
        await required(bot).emitCallback({
          callbackQuery: {
            data: spawnProjectCallbackData(wizard.reply, 0),
            message: wizard.message,
            from: wizard.message.from,
          },
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue({}),
        });
      }
      vi.stubGlobal("fetch", mockTranscribeFetch("  voice task  "));
      const voice = telegramVoiceContext({
        chat: { id: 123 },
        message_thread_id: undefined,
        is_topic_message: false,
      });
      await required(bot).emitVoice(voice);
      await vi.waitFor(() =>
        expect(voice.api.editMessageText).toHaveBeenCalledWith(
          123,
          55,
          expect.stringContaining("Spawned voice-agent."),
        ),
      );
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          prompt: forum ? wrapTelegramSpawnPrompt("voice task") : "voice task",
          telegramOrigin: { projectId: "api", sourceId: "telegram", chatId: 123 },
        }),
      );
      expect(voice.reply.mock.calls.some((call) => String(call[0]).includes("Heard:"))).toBe(false);
      expect(
        voice.api.editMessageText.mock.calls.some((call) => String(call[2]).includes("Heard:")),
      ).toBe(false);
      expect(emit).not.toHaveBeenCalled();
      if (forum)
        expect(readTelegramReplyTarget(dataDir, "voice-agent")).toMatchObject({
          chatId: -1001,
          messageThreadId: 22,
        });
      else expect(readTelegramBindings(dataDir, "api", "telegram").size).toBe(0);
    },
  );

  it.each(["wizard", "binding"])(
    "rejects stale voice spawn intake when %s changes during transcription",
    async (change) => {
      const dataDir = await createTempDir("spur-telegram-voice-intent-");
      tempDirs.push(dataDir);
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        config:
          change === "binding"
            ? { autoSpawn: { enabled: true, project: "api", agent: "codex" } }
            : {},
      });
      const beginWizard = async (agent: string) => {
        const wizard = telegramContext({ text: `/spawn ${agent}` });
        await required(bot).emitText(wizard);
        await required(bot).emitCallback({
          callbackQuery: {
            data: spawnProjectCallbackData(wizard.reply, 0),
            message: wizard.message,
            from: wizard.message.from,
          },
          answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
          reply: vi.fn().mockResolvedValue({}),
        });
      };
      if (change === "wizard") await beginWizard("codex");
      let finish!: (response: {
        ok: boolean;
        status: number;
        json(): Promise<{ text: string }>;
      }) => void;
      const fetchMock = vi.fn().mockImplementation((url: unknown) =>
        typeof url === "string" && url.includes("api.telegram.org")
          ? Promise.resolve(new Response(new Uint8Array(4)))
          : new Promise((resolve) => {
              finish = resolve;
            }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const voice = telegramVoiceContext();
      await required(bot).emitVoice(voice);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      if (change === "wizard") await beginWizard("claude");
      else await required(bot).emitText(telegramContext({ text: "/watch api-1" }));
      finish({ ok: true, status: 200, json: async () => ({ text: "old task" }) });
      await vi.waitFor(() =>
        expect(voice.reply).toHaveBeenCalledWith(
          expect.stringContaining("Attachment context changed. Send the message again."),
        ),
      );
      expect(emit).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    },
  );

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
      text: "[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/voice.ogg]\nfix the sidecar",
    });
  });

  it.each([123, -1001])(
    "redirects a recorded legacy voice reply before download/transcription: %s",
    async (chatId) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const { bot, emit, spawnSession } = await startSource(dataDir);
      if (!bot) throw new Error("missing bot");
      await bot.emitText(
        telegramContext({
          text: "/watch api-1",
          chat: { id: chatId },
          message_thread_id: undefined,
        }),
      );
      recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-2", chatId }, [500]);

      const fetchMock = mockTranscribeFetch("fix the sidecar");
      vi.stubGlobal("fetch", fetchMock);
      const voiceCtx = telegramVoiceContext({
        chat: { id: chatId },
        message_thread_id: chatId < 0 ? 500 : undefined,
        is_topic_message: false,
        reply_to_message: { message_id: 500 },
      });
      await bot.emitVoice(voiceCtx);

      expect(voiceCtx.reply).toHaveBeenCalledWith(
        "Continue in [agent topic](https://t.me/c/1/23).",
      );
      expect(voiceCtx.getFile).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(voiceCtx.api.editMessageText).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
      expect(readTelegramReplyTarget(dataDir, "api-2")).toMatchObject({
        chatId: -1001,
        messageThreadId: 23,
      });
    },
  );

  it.each([
    { name: "denied user", userId: 999, chatId: -1001 },
    { name: "disallowed chat", userId: 123, chatId: -1002 },
  ])(
    "rejects a recorded group-main voice reply from $name before transcription",
    async ({ userId, chatId }) => {
      const dataDir = await createTempDir("spur-telegram-source-");
      tempDirs.push(dataDir);
      const { bot, emit, spawnSession } = await startSource(dataDir, vi.fn(), vi.fn(), {
        config: {
          allowedChats: [-1001],
          autoSpawn: { enabled: true, project: "api", agent: "claude" },
        },
      });
      if (!bot) throw new Error("missing bot");
      await bot.emitText(telegramContext({ text: "/watch api-1", message_thread_id: undefined }));
      recordTelegramMessages(dataDir, "api", "telegram", { sessionId: "api-2", chatId }, [500]);
      const bindings = readTelegramBindings(dataDir, "api", "telegram");
      const boundTarget = readTelegramReplyTarget(dataDir, "api-1");
      const ownerTarget = readTelegramReplyTarget(dataDir, "api-2");
      const writes = [
        vi.spyOn(metadataModule, "writeTelegramBindings"),
        vi.spyOn(metadataModule, "writeTelegramReplyTarget"),
        vi.spyOn(metadataModule, "recordTelegramMessages"),
      ];
      for (const write of writes) write.mockClear();
      try {
        const fetchMock = mockTranscribeFetch("fix the sidecar");
        vi.stubGlobal("fetch", fetchMock);
        const voiceCtx = telegramVoiceContext({
          chat: { id: chatId },
          from: { id: userId },
          message_thread_id: undefined,
          reply_to_message: { message_id: 500 },
        });
        await bot.emitVoice(voiceCtx);
        expect(voiceCtx.reply).not.toHaveBeenCalled();
        expect(voiceCtx.api.editMessageText).not.toHaveBeenCalled();
        expect(voiceCtx.getFile).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(spawnSession).not.toHaveBeenCalled();
        for (const write of writes) expect(write).not.toHaveBeenCalled();
        expect(readTelegramBindings(dataDir, "api", "telegram")).toEqual(bindings);
        expect(readTelegramReplyTarget(dataDir, "api-1")).toEqual(boundTarget);
        expect(readTelegramReplyTarget(dataDir, "api-2")).toEqual(ownerTarget);
      } finally {
        for (const write of writes) write.mockRestore();
      }
    },
  );

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
    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await bot.emitText(spawnCtx);

    // A voice note can never satisfy a pending project pick; only a
    // `spur_sproj:` callback can.
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const pickReply = vi.fn().mockResolvedValue({});
    await bot.emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 0),
        message: {
          message_thread_id: 22,
          is_topic_message: true,
          chat: { id: -1001 },
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery,
      reply: pickReply,
    });
    expect(spawnSession).not.toHaveBeenCalled();

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    await bot.emitVoice(telegramVoiceContext());

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalled());
    expect(spawnSession).toHaveBeenCalledWith({
      project: "api",
      agent: "codex",
      prompt: wrapTelegramSpawnPrompt("fix the sidecar"),
      attachments: [{ name: "telegram-10.ogg", data: Buffer.alloc(4).toString("base64") }],
      telegramOrigin: {
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
      },
    });
  });

  it("A2b: auto-spawns a shepherd session from a voice note in an unbound chat", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawnSession = vi.fn().mockResolvedValue({
      id: "shp-1",
      project: "spur-shepherd",
      agent: "opencode",
      state: "working",
    });
    const { bot } = await startSource(dataDir, vi.fn(), spawnSession, {
      config: {
        autoSpawn: {
          enabled: true,
          project: "spur-shepherd",
          agent: "opencode",
          selfDestruct: { enabled: true },
        },
      },
    });
    if (!bot) throw new Error("missing bot");

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    await bot.emitVoice(telegramVoiceContext());

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalled());
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith({
      project: "spur-shepherd",
      agent: "opencode",
      selfDestruct: { enabled: true },
      prompt: expect.stringContaining("fix the sidecar"),
      attachments: [{ name: "telegram-10.ogg", data: Buffer.alloc(4).toString("base64") }],
      telegramOrigin: {
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
      },
    });

    const statePath = join(dataDir, "source-state", "telegram", "api", "telegram.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"sessionId": "shp-1"');
  });

  it("A3: a non-2xx transcribe response retains the original voice attachment", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, spawnSession } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown) => {
        if (typeof url === "string" && url.includes("api.telegram.org")) {
          return Promise.resolve(new Response(new Uint8Array(4)));
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
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({
          text: expect.stringContaining("$SPUR_SESSION_ARTIFACTS_DIR/voice.ogg"),
        }),
      ),
    );
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
      expect(voiceCtx.reply).toHaveBeenCalledWith(
        expect.stringContaining("Attachment task failed: network down"),
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
    const controller = new AbortController();
    const { bot, logger } = await startSource(dataDir, emit, spawnSession, {
      listSessions,
      signal: controller.signal,
    });
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
          return Promise.resolve(new Response(new Uint8Array(4)));
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
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("telegram voice transcription failed:"),
    );
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
          return Promise.resolve(new Response(new Uint8Array(4)));
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
      expect.objectContaining({ text: expect.stringContaining("\n/help") }),
    );
    expect(voiceCtx.reply).not.toHaveBeenCalledWith(expect.stringContaining("Spur Telegram bot"));
    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("Spur Telegram bot"),
    );
  });

  it("A7: an empty transcript delivers the original voice attachment", async () => {
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
        expect.stringContaining("Empty voice transcript"),
      ),
    );
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({
          text: expect.stringContaining("$SPUR_SESSION_ARTIFACTS_DIR/voice.ogg"),
        }),
      ),
    );
  });

  it("A8: a null webBaseUrl delivers the original without transcription", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(4)));
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
        "Voice transcription is disabled for this Spur instance. Sending original file.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "telegram:message",
        expect.objectContaining({
          text: expect.stringContaining("$SPUR_SESSION_ARTIFACTS_DIR/voice.ogg"),
        }),
      ),
    );
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
      expect.objectContaining({ text: expect.stringContaining("\nfix the sidecar") }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram voice ack failed: 429 Too Many Requests",
    );
    // No statusMessageId to edit: the echo and the routing ack both fall
    // back to a fresh ctx.reply call.
    expect(voiceCtx.api.editMessageText).not.toHaveBeenCalled();
  });

  it("launches a ready voice task once after rejected echo and spawn progress", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const spawn = vi.fn().mockResolvedValue({
      id: "api-new",
      project: "api",
      agent: "codex",
      state: "working",
    });
    const { bot, emit, logger, listSessions } = await startSource(dataDir, vi.fn(), spawn);
    const spawnCtx = telegramContext({ text: "/spawn codex" });
    await required(bot).emitText(spawnCtx);
    await required(bot).emitCallback({
      callbackQuery: {
        data: spawnProjectCallbackData(spawnCtx.reply, 0),
        message: spawnCtx.message,
        from: spawnCtx.message.from,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue({}),
    });
    vi.stubGlobal("fetch", mockTranscribeFetch("  delivery  "));
    const voice = telegramVoiceContext({ updateId: 81 });
    voice.api.editMessageText.mockRejectedValue(new Error("echo edit failed"));
    voice.reply.mockResolvedValueOnce({ message_id: 55 });
    voice.reply.mockRejectedValueOnce(new Error("echo failed token-123"));
    voice.reply.mockRejectedValueOnce(new Error("progress failed token-123"));
    await required(bot).emitVoice(voice);
    await vi.waitFor(() =>
      expect(voice.reply).toHaveBeenCalledWith(`Spawned api-new. ${topicLink}`),
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith({
      project: "api",
      agent: "codex",
      prompt: wrapTelegramSpawnPrompt("delivery"),
      attachments: [{ name: "telegram-10.ogg", data: Buffer.alloc(4).toString("base64") }],
      telegramOrigin: {
        projectId: "api",
        sourceId: "telegram",
        chatId: -1001,
        messageThreadId: 22,
      },
    });
    expect(readTelegramBindings(dataDir, "api", "telegram").get("-1001:22")?.sessionId).toBe(
      "api-new",
    );
    expect(logger.warn.mock.calls).toEqual([
      ["[source:api/telegram] telegram voice echo failed: echo failed <telegram-token>"],
      ["[source:api/telegram] telegram spawn progress failed: progress failed <telegram-token>"],
    ]);
    listSessions.mockResolvedValue([
      { id: "api-new", project: "api", agent: "codex", state: "working" },
    ]);
    await required(bot).emitVoice(voice);
    await required(bot).emitText(telegramContext({ text: "followup" }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-new", text: "followup" }),
    );
  });

  it("routes a trimmed transcript once when its echo edit and fallback reply reject", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, emit, spawnSession, logger } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("  fix the sidecar  "));
    const voiceCtx = telegramVoiceContext();
    voiceCtx.api.editMessageText.mockRejectedValue(new Error("edit failed token-123"));
    voiceCtx.reply.mockResolvedValueOnce({ message_id: 55 });
    voiceCtx.reply.mockRejectedValueOnce(new Error("reply failed token-123"));
    voiceCtx.reply.mockRejectedValue(new Error("routing ack failed"));

    await bot.emitVoice(voiceCtx);
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("telegram:message", {
      sessionId: "api-1",
      chatId: -1001,
      messageThreadId: 22,
      userId: 123,
      username: "alek",
      messageId: 10,
      text: "[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/voice.ogg]\nfix the sidecar",
    });
    expect(spawnSession).not.toHaveBeenCalled();
    expect(voiceCtx.api.editMessageText).toHaveBeenCalledWith(
      -1001,
      55,
      'Heard: "fix the sidecar"',
    );
    expect(voiceCtx.reply).toHaveBeenCalledWith('Heard: "fix the sidecar"');
    expect(logger.warn).toHaveBeenCalledWith(
      "[source:api/telegram] telegram voice echo failed: reply failed <telegram-token>",
    );
    expect(logger.warn.mock.calls.flat().join("\n")).not.toContain("token-123");
  });

  it("A10: logs a redacted download error before a rejected failure notice without unhandled rejection", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const { bot, logger, emit, spawnSession } = await startSource(dataDir);
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down token-123")));
    const voiceCtx = telegramVoiceContext();
    voiceCtx.api.editMessageText.mockRejectedValue(new Error("edit failed"));
    voiceCtx.reply.mockImplementation((text: string) => {
      if (text === "Transcribing voice message...") return Promise.resolve({ message_id: 55 });
      return Promise.reject(new Error("reply failed token-123"));
    });

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      await bot.emitVoice(voiceCtx);
      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          "[source:api/telegram] telegram attachment notice failed: reply failed <telegram-token>",
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(logger.warn.mock.calls).toEqual([
        ["[source:api/telegram] telegram attachment failed: network down <telegram-token>"],
        ["[source:api/telegram] telegram attachment notice failed: reply failed <telegram-token>"],
      ]);
      expect(logger.warn.mock.calls.flat().join("\n")).not.toContain("token-123");
      expect(emit).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
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
      getSession: async () => (await listSessions())[0],
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
          return Promise.resolve(new Response(new Uint8Array(4)));
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

  it.each(["resolve", "reject"])("suppresses routing on echo %s after abort", async (result) => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    const emit = vi.fn();
    const spawnSession = vi.fn();
    const listSessions = vi
      .fn()
      .mockResolvedValue([{ id: "api-1", project: "api", agent: "codex", state: "waiting" }]);
    const controller = new AbortController();
    const { bot } = await startSource(dataDir, emit, spawnSession, {
      listSessions,
      signal: controller.signal,
    });
    if (!bot) throw new Error("missing bot");
    await bot.emitText(telegramContext({ text: "/watch api-1" }));

    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));

    let resolveEcho: (() => void) | undefined;
    let rejectEcho: ((error: Error) => void) | undefined;
    const pendingEcho = new Promise<void>((resolve, reject) => {
      resolveEcho = resolve;
      rejectEcho = reject;
    });
    const voiceCtx = telegramVoiceContext();
    voiceCtx.api.editMessageText.mockImplementation(() => pendingEcho);
    voiceCtx.reply.mockResolvedValueOnce({ message_id: 55 });
    voiceCtx.reply.mockRejectedValue(new Error("echo fallback failed"));

    await bot.emitVoice(voiceCtx);
    await vi.waitFor(() => expect(voiceCtx.api.editMessageText).toHaveBeenCalled());

    controller.abort();
    if (result === "resolve") resolveEcho?.();
    else rejectEcho?.(new Error("echo edit failed"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(emit).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe("telegramSourceModule inbound delivery under lookup failure", () => {
  const UNDELIVERED = "Message not delivered. Send it again.";
  const bound = { id: "api-1", project: "api", agent: "codex", state: "waiting" } as const;

  beforeEach(() => {
    botInstances.splice(0);
    runMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function startBound(
    getSession: Mock<(id: string) => Promise<SourceSessionListItem | null>>,
    signal?: AbortSignal,
  ) {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    writeTelegramBindings(dataDir, "api", "telegram", [
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
    ]);
    const started = await startSource(dataDir, vi.fn(), vi.fn(), {
      getSession,
      ...(signal ? { signal } : {}),
    });
    if (!started.bot) throw new Error("missing bot");
    const catchHandler = started.bot.catch.mock.calls[0]?.[0] as (error: unknown) => Promise<void>;
    return { ...started, bot: started.bot, catchHandler, dataDir };
  }

  it("delivers a topic message while the fleet list throws", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    writeTelegramBindings(dataDir, "api", "telegram", [
      { chatId: -1001, messageThreadId: 22, sessionId: "api-1" },
    ]);
    const listSessions = vi.fn().mockRejectedValue(new Error("session_lifecycle_snapshot_changed"));
    const getSession = vi.fn().mockResolvedValue(bound);
    const { bot, emit } = await startSource(dataDir, vi.fn(), vi.fn(), {
      listSessions,
      getSession,
    });
    if (!bot) throw new Error("missing bot");
    const ctx = telegramContext();

    await bot.emitText(ctx);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "telegram:message",
      expect.objectContaining({ sessionId: "api-1", messageThreadId: 22 }),
    );
    expect(listSessions).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalledWith(UNDELIVERED);
  });

  it("replies once with the notice when a text update fails", async () => {
    const error = new Error("lookup failed");
    const { bot, emit, catchHandler } = await startBound(vi.fn().mockRejectedValue(error));
    const ctx = telegramContext();

    await expect(bot.emitText(ctx)).rejects.toBe(error);
    await catchHandler({ error, ctx });

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith(UNDELIVERED);
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses to start without a by-id session lookup", async () => {
    const dataDir = await createTempDir("spur-telegram-source-");
    tempDirs.push(dataDir);
    await expect(
      telegramSourceModule.start({
        sourceId: "telegram",
        projectId: "api",
        dataDir,
        config: { type: "telegram", runOnStart: false, token: "token-123", allowedUsers: [123] },
        emit: vi.fn(),
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveWebBaseUrl: () => Promise.resolve(null),
      }),
    ).rejects.toThrow("requires getSession");
  });

  it("sends no notice when a text update fails after the source stopped", async () => {
    const error = new Error("lookup failed");
    const controller = new AbortController();
    const { catchHandler } = await startBound(vi.fn().mockRejectedValue(error), controller.signal);
    const ctx = telegramContext();
    controller.abort();

    await catchHandler({ error, ctx });

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("does not notify a sender that is not allowed", async () => {
    const error = new Error("lookup failed");
    const { bot, catchHandler } = await startBound(vi.fn().mockRejectedValue(error));
    const ctx = telegramContext({ from: { id: 999 } });

    await bot.emitText(ctx);
    await catchHandler({ error, ctx });

    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("alerts once and keeps the offer clickable when a choice callback fails", async () => {
    const error = new Error("lookup failed");
    const { bot, dataDir } = await startBound(vi.fn().mockRejectedValue(error));
    writeTelegramOffer(dataDir, "api", "telegram", {
      sessionId: "api-1",
      chatId: -1001,
      choices: [
        {
          token: "tok0",
          offerId: "offer-1",
          sessionId: "api-1",
          chatId: -1001,
          messageThreadId: 22,
          text: "Yes",
          value: "yes",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      keepInterfaceConsent: false,
    });
    const offerMarkup = {
      inline_keyboard: [[{ text: "Yes", callback_data: "spur_choice:tok0" }]],
    };
    const ctx = {
      callbackQuery: {
        data: "spur_choice:tok0",
        message: {
          message_id: 90,
          message_thread_id: 22,
          text: "Deploy?",
          is_topic_message: true,
          chat: { id: -1001 },
          reply_markup: offerMarkup,
        },
        from: { id: 123, username: "alek" },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue({}),
    };

    await bot.emitCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Choice failed. Try again.",
      show_alert: true,
    });
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).toHaveBeenLastCalledWith({ reply_markup: offerMarkup });
    expect(findTelegramChoice(dataDir, "api", "telegram", "tok0", -1001)).not.toBeNull();
    expect(
      readEventLog(dataDir)
        .filter((entry) => entry.event === "source.telegram.choice_rejected")
        .map((entry) => entry.details),
    ).toEqual([
      {
        reason: "internal",
        chatId: -1001,
        userId: 123,
        consent: false,
        error: "lookup failed",
      },
    ]);
  });

  it("replies once when a detached voice route fails", async () => {
    const getSession = vi.fn().mockResolvedValue(bound);
    const { bot, emit } = await startBound(getSession);
    getSession.mockRejectedValue(new Error("lookup failed"));
    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    const ctx = telegramVoiceContext();

    await bot.emitVoice(ctx);

    await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith(UNDELIVERED));
    expect(ctx.reply.mock.calls.filter(([text]) => text === UNDELIVERED)).toHaveLength(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("sends no notice when a voice route fails after the source stopped", async () => {
    const controller = new AbortController();
    const getSession = vi.fn().mockResolvedValue(bound);
    const { bot, logger } = await startBound(getSession, controller.signal);
    getSession.mockImplementation(async () => {
      controller.abort();
      throw new Error("lookup failed");
    });
    vi.stubGlobal("fetch", mockTranscribeFetch("fix the sidecar"));
    const ctx = telegramVoiceContext();

    await bot.emitVoice(ctx);

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("telegram attachment failed"),
      ),
    );
    expect(ctx.reply).not.toHaveBeenCalledWith(UNDELIVERED);
  });

  it("logs and does not retry when the notice itself fails", async () => {
    const error = new Error("lookup failed");
    const { catchHandler, logger } = await startBound(vi.fn());
    const ctx = telegramContext();
    ctx.reply.mockRejectedValue(new Error("send failed"));

    await expect(catchHandler({ error, ctx })).resolves.toBeUndefined();

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("undelivered notice failed"));
  });

  it.each([["boom"], [null], [{ error: new Error("x") }]])(
    "logs without replying when the failure carries no context: %j",
    async (error) => {
      const { catchHandler, logger } = await startBound(vi.fn());

      await expect(catchHandler(error)).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("telegram update failed"));
    },
  );
});
