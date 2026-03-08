import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig } from "../types.js";
import {
  buildTelegramInboundRouting,
  buildJiraInboundRouting,
  createInboundContextStore,
  formatInboundMessageForSession,
  getInboundContextStatePath,
  isJiraInboundEnvelope,
} from "../inbound-context.js";
import { getProjectBaseDir, getSessionsDir } from "../paths.js";

function makeProject(sessionPrefix: string, path: string) {
  return {
    name: `${sessionPrefix} project`,
    repo: `acme/${sessionPrefix}`,
    path,
    defaultBranch: "main",
    sessionPrefix,
  };
}

describe("createInboundContextStore", () => {
  let tempRoot: string;
  let config: OrchestratorConfig;
  let appProjectBaseDir: string;
  let libProjectBaseDir: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-inbound-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });

    const appPath = join(tempRoot, "app-repo");
    const libPath = join(tempRoot, "lib-repo");
    mkdirSync(appPath, { recursive: true });
    mkdirSync(libPath, { recursive: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n", "utf-8");

    config = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: makeProject("app", appPath),
        lib: makeProject("lib", libPath),
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    appProjectBaseDir = getProjectBaseDir(config.configPath, config.projects.app.path);
    libProjectBaseDir = getProjectBaseDir(config.configPath, config.projects.lib.path);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(appProjectBaseDir, { recursive: true, force: true });
    rmSync(libProjectBaseDir, { recursive: true, force: true });
  });

  function createSessionMetadata(projectId: "app" | "lib", sessionId: string): void {
    const project = config.projects[projectId];
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, sessionId), "status=working\n", "utf-8");
  }

  it("stores pending envelopes in FIFO order and acknowledges them", async () => {
    createSessionMetadata("app", "app-1");
    const store = createInboundContextStore(config);

    const first = await store.enqueue({
      sessionId: "app-1",
      source: "telegram",
      text: "first",
      routing: { chatId: "1", messageId: 101 },
    });

    const second = await store.enqueue({
      sessionId: "app-1",
      source: "telegram",
      text: "second",
      routing: { chatId: "1", messageId: 102 },
    });

    expect((await store.peekNext("app-1"))?.id).toBe(first.id);
    expect((await store.listPending("app-1")).map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
    ]);

    expect(await store.ack("app-1", first.id)).toBe(true);
    expect((await store.peekNext("app-1"))?.id).toBe(second.id);
    expect(await store.ack("app-1", "missing")).toBe(false);
    expect(await store.ack("app-1", second.id)).toBe(true);
    expect(await store.peekNext("app-1")).toBeNull();
  });

  it("deduplicates telegram envelopes by chatId+messageId", async () => {
    createSessionMetadata("app", "app-2");
    const store = createInboundContextStore(config);

    const first = await store.enqueue({
      sessionId: "app-2",
      source: "telegram",
      text: "duplicate",
      routing: { chatId: "123456", messageId: 200 },
    });

    const duplicate = await store.enqueue({
      sessionId: "app-2",
      source: "telegram",
      text: "duplicate retry",
      routing: { chatId: "123456", messageId: 200 },
    });

    expect(duplicate.id).toBe(first.id);
    expect(await store.listPending("app-2")).toHaveLength(1);
  });

  it("resolves project by session prefix for orchestrator sessions", async () => {
    const store = createInboundContextStore(config);

    await store.enqueue({
      sessionId: "app-orchestrator",
      source: "telegram",
      text: "hello orchestrator",
      routing: { chatId: "321", messageId: 300 },
    });

    const statePath = getInboundContextStatePath(config, "app-orchestrator");
    expect(existsSync(statePath)).toBe(true);
    expect((await store.peekNext("app-orchestrator"))?.text).toBe("hello orchestrator");
  });

  it("throws when session cannot be mapped to a configured project", async () => {
    const store = createInboundContextStore(config);

    await expect(
      store.enqueue({
        sessionId: "unknown-session",
        source: "telegram",
        text: "hello",
        routing: { chatId: "1", messageId: 500 },
      }),
    ).rejects.toThrow(/could not resolve project/i);
  });

  it("formats inbound source messages for orchestrator sessions", () => {
    const formatted = formatInboundMessageForSession({
      sessionId: "app-orchestrator",
      source: "telegram",
      text: "please start the task",
      routing: { chatId: "123", threadId: 77, messageId: 99 },
    });

    expect(formatted).toContain("[SOURCE:telegram]");
    expect(formatted).toContain('ao source-reply app-orchestrator "<message>"');
    expect(formatted).toContain("Routing: chat=123, thread=77, message=99");
    expect(formatted).toContain("\n\nplease start the task");
  });

  it("includes selected Telegram project metadata in formatted routing summary", () => {
    const formatted = formatInboundMessageForSession({
      sessionId: "app-orchestrator",
      source: "telegram",
      text: "route this inbound request",
      routing: buildTelegramInboundRouting({
        chatId: "123",
        messageId: 99,
        messageThreadId: 7,
        projectId: "app",
        fromFirstName: "Alex",
        fromLastName: "Worker",
      }),
    });

    expect(formatted).toContain("Routing: chat=123, thread=7, message=99, project=app, from=Alex Worker");
  });

  it("does not wrap inbound source messages for worker sessions", () => {
    const formatted = formatInboundMessageForSession({
      sessionId: "app-1",
      source: "telegram",
      text: "continue",
      routing: { chatId: "123", messageId: 200 },
    });

    expect(formatted).toBe("continue");
  });

  it("builds Jira routing and recognizes Jira envelopes", () => {
    const routing = buildJiraInboundRouting({
      issueKey: "INT-42",
      commentId: "10001",
      authorEmail: "dev@example.com",
      authorDisplayName: "Dev User",
    });

    expect(routing).toMatchObject({
      issueKey: "INT-42",
      commentId: "10001",
      authorEmail: "dev@example.com",
      authorDisplayName: "Dev User",
    });

    expect(
      isJiraInboundEnvelope({
        id: "env-1",
        sessionId: "app-orchestrator",
        source: "jira",
        text: "hello",
        receivedAt: new Date().toISOString(),
        routing,
      }),
    ).toBe(true);
  });
});
