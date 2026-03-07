import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConfigRef,
  mockSessionManager,
  mockInboundContextStore,
  mockGetSourceReplyAdapter,
  mockAdapter,
} = vi.hoisted(() => ({
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    send: vi.fn(),
  },
  mockInboundContextStore: {
    enqueue: vi.fn(),
    peekNext: vi.fn(),
    ack: vi.fn(),
    listPending: vi.fn(),
  },
  mockGetSourceReplyAdapter: vi.fn(),
  mockAdapter: {
    source: "telegram",
    sendReply: vi.fn(),
  },
}));

vi.mock("@composio/ao-core", async () => {
  const actual = await vi.importActual("@composio/ao-core");
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
    createInboundContextStore: () => mockInboundContextStore,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
}));

vi.mock("../../src/lib/source-replies/index.js", () => ({
  getSourceReplyAdapter: (...args: unknown[]) => mockGetSourceReplyAdapter(...args),
}));

import { Command } from "commander";
import { registerSourceReply } from "../../src/commands/source-reply.js";

let program: Command;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerSourceReply(program);

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockConfigRef.current = {
    configPath: "/tmp/ao-test/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      app: {
        name: "App",
        repo: "acme/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {
      telegram: {
        plugin: "telegram",
      },
    },
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };

  mockSessionManager.get.mockReset();
  mockInboundContextStore.peekNext.mockReset();
  mockInboundContextStore.ack.mockReset();
  mockGetSourceReplyAdapter.mockReset();
  mockAdapter.sendReply.mockReset();

  mockSessionManager.get.mockResolvedValue({
    id: "app-orchestrator",
    projectId: "app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: { role: "orchestrator" },
  });

  mockInboundContextStore.peekNext.mockResolvedValue({
    id: "env-1",
    sessionId: "app-orchestrator",
    source: "telegram",
    text: "hello",
    receivedAt: new Date().toISOString(),
    routing: { chatId: "123456", messageId: 10 },
  });
  mockInboundContextStore.ack.mockResolvedValue(true);
  mockGetSourceReplyAdapter.mockReturnValue(mockAdapter);
  mockAdapter.sendReply.mockResolvedValue(undefined);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("source-reply command", () => {
  it("replies via source adapter and acknowledges envelope", async () => {
    await program.parseAsync([
      "node",
      "test",
      "source-reply",
      "app-orchestrator",
      "Working",
      "on",
      "it",
    ]);

    expect(mockGetSourceReplyAdapter).toHaveBeenCalledWith("telegram");
    expect(mockAdapter.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({ id: "env-1" }),
        message: "Working on it",
      }),
    );
    expect(mockInboundContextStore.ack).toHaveBeenCalledWith("app-orchestrator", "env-1");
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Replied via telegram"));
  });

  it("fails when no pending source context exists", async () => {
    mockInboundContextStore.peekNext.mockResolvedValueOnce(null);

    await expect(
      program.parseAsync(["node", "test", "source-reply", "app-orchestrator", "hello"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No pending source context"));
    expect(mockAdapter.sendReply).not.toHaveBeenCalled();
  });

  it("fails for non-orchestrator sessions", async () => {
    mockSessionManager.get.mockResolvedValueOnce({
      id: "app-1",
      projectId: "app",
      status: "working",
      activity: "active",
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: null,
      runtimeHandle: null,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    });

    await expect(
      program.parseAsync(["node", "test", "source-reply", "app-1", "hello"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("not an orchestrator"));
    expect(mockAdapter.sendReply).not.toHaveBeenCalled();
  });

  it("fails when no adapter is registered for envelope source", async () => {
    mockInboundContextStore.peekNext.mockResolvedValueOnce({
      id: "env-2",
      sessionId: "app-orchestrator",
      source: "jira",
      text: "hello",
      receivedAt: new Date().toISOString(),
      routing: {},
    });
    mockGetSourceReplyAdapter.mockReturnValueOnce(undefined);

    await expect(
      program.parseAsync(["node", "test", "source-reply", "app-orchestrator", "hello"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("No source-reply adapter"));
  });

  it("fails when envelope acknowledgement fails", async () => {
    mockInboundContextStore.ack.mockResolvedValueOnce(false);

    await expect(
      program.parseAsync(["node", "test", "source-reply", "app-orchestrator", "hello"]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockAdapter.sendReply).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to acknowledge"));
  });
});
