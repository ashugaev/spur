import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ListenerConfig, OrchestratorConfig, Session, SessionManager } from "@composio/ao-core";
import type { IntegrationHealthReporter } from "../../src/lib/integration-health.js";

const { jiraMock, mockedPaths, archivedStateBySession } = vi.hoisted(() => ({
  jiraMock: vi.fn(),
  mockedPaths: { baseDir: "", sessionsDir: "" },
  archivedStateBySession: {} as Record<
    string,
    { status?: string; terminationReason?: string } | undefined
  >,
}));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: jiraMock,
  });
  return { execFile };
});

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    getProjectBaseDir: () => mockedPaths.baseDir,
    getSessionsDir: () => mockedPaths.sessionsDir,
    readArchivedMetadataRaw: (_dataDir: string, sessionId: string) => {
      const state = archivedStateBySession[sessionId];
      if (!state?.status) return null;

      const result: Record<string, string> = { status: state.status };
      if (state.terminationReason) {
        result["terminationReason"] = state.terminationReason;
      }
      return result;
    },
  };
});

import { jiraBacklogSource } from "../../src/lib/listeners/jira-backlog-source.js";

function makeConfig(rootDir: string): OrchestratorConfig {
  const repoPath = join(rootDir, "repo");
  mkdirSync(repoPath, { recursive: true });

  const configPath = join(rootDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n", "utf-8");

  return {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      int: {
        name: "Intelas",
        repo: "intelas/intelas-web",
        path: repoPath,
        defaultBranch: "main",
        sessionPrefix: "intelas",
        tracker: { plugin: "jira" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    listeners: {
      "jira-broai": {
        enabled: true,
        source: "jira-backlog",
        projectId: "int",
        intervalMs: 60_000,
        jql: 'assignee = "aleksey@intelas.com" AND labels = "BroAI"',
        trigger: { type: "spawn-session" },
      },
    },
  };
}

function makeSession(sessionId: string, issueId: string): Session {
  return {
    id: sessionId,
    projectId: "int",
    status: "spawning",
    activity: "active",
    branch: issueId,
    issueId,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSessionManager(
  listImpl: SessionManager["list"],
  spawnImpl: SessionManager["spawn"],
): SessionManager {
  return {
    list: vi.fn(listImpl),
    spawn: vi.fn(spawnImpl),
    get: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    send: vi.fn(),
  };
}

function makeHealthReporterStub(): IntegrationHealthReporter {
  return {
    snapshotPath: "/tmp/ao-test/integration-health.json",
    upsert: vi.fn(),
    markStarting: vi.fn(),
    markHealthy: vi.fn(),
    markDegraded: vi.fn(),
    markInactive: vi.fn(),
    getSnapshot: vi.fn(),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("jiraBacklogSource", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-jira-listener-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mockedPaths.baseDir = join(rootDir, "ao-base");
    mockedPaths.sessionsDir = join(mockedPaths.baseDir, "sessions");
    mkdirSync(mockedPaths.sessionsDir, { recursive: true });
    for (const key of Object.keys(archivedStateBySession)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete archivedStateBySession[key];
    }
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("enforces backlog status in effective JQL and spawns once", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const warn = vi.fn();

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });
    const healthReporter = makeHealthReporterStub();

    const sm = makeSessionManager(async () => [], async () => makeSession("intelas-1", "INT-101"));

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn },
      healthReporter,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.spawn).toHaveBeenCalledTimes(1);
    expect(sm.spawn).toHaveBeenCalledWith({ projectId: "int", issueId: "INT-101" });

    const jiraArgs = jiraMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(jiraArgs).toBeDefined();
    expect(jiraArgs?.join(" ")).toContain('status = "Backlog"');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sm.spawn).toHaveBeenCalledTimes(1);
    controller.stop();
    expect(healthReporter.markStarting).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:jira-broai" }),
      expect.stringContaining("Starting"),
    );
    expect(healthReporter.markHealthy).toHaveBeenCalled();
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:jira-broai" }),
      expect.stringContaining("stopped"),
    );
  });

  it("treats jira no-results response as an empty backlog, not a failed poll", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const healthReporter = makeHealthReporterStub();

    const noResultsError = Object.assign(new Error("Command failed"), {
      stderr:
        '\u001b[0;31m✗\u001b[0m No result found for given query in project "WEBDEV"',
    });
    jiraMock.mockRejectedValueOnce(noResultsError);

    const sm = makeSessionManager(async () => [], async () => makeSession("intelas-1", "INT-101"));

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn: vi.fn() },
      healthReporter,
    });

    await flushPromises();
    await flushPromises();

    expect(sm.spawn).not.toHaveBeenCalled();
    expect(healthReporter.markDegraded).not.toHaveBeenCalled();
    expect(healthReporter.markHealthy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:jira-broai" }),
      expect.stringContaining("0 issues checked"),
    );

    controller.stop();
  });

  it("retries the same issue only after previous listener session was killed", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });

    const sm = makeSessionManager(
      async () => [],
      vi
        .fn()
        .mockResolvedValueOnce(makeSession("intelas-1", "INT-101"))
        .mockResolvedValueOnce(makeSession("intelas-2", "INT-101")),
    );

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn: vi.fn() },
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    archivedStateBySession["intelas-1"] = {
      status: "killed",
      terminationReason: "manual",
    };

    await vi.advanceTimersByTimeAsync(60_001);
    expect(sm.spawn).toHaveBeenCalledTimes(2);
    expect(sm.spawn).toHaveBeenLastCalledWith({ projectId: "int", issueId: "INT-101" });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(sm.spawn).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it("does not retry when previous listener session was cleanup-terminated", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });

    const sm = makeSessionManager(
      async () => [],
      vi
        .fn()
        .mockResolvedValueOnce(makeSession("intelas-1", "INT-101"))
        .mockResolvedValueOnce(makeSession("intelas-2", "INT-101")),
    );

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn: vi.fn() },
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    archivedStateBySession["intelas-1"] = {
      status: "cleanup",
      terminationReason: "cleanup",
    };

    await vi.advanceTimersByTimeAsync(60_001);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    controller.stop();
  });

  it("does not retry when previous session status is unknown and warns once", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const warn = vi.fn();

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });

    const sm = makeSessionManager(
      async () => [],
      vi.fn().mockResolvedValue(makeSession("intelas-1", "INT-101")),
    );

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn },
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_001);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    const unknownWarns = warn.mock.calls.filter(([message]) =>
      String(message).includes("unknown terminal status"),
    );
    expect(unknownWarns).toHaveLength(1);

    controller.stop();
  });

  it("prevents duplicate spawn when another process already holds issue lock", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const firstSpawn = createDeferred<Session>();

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });

    const smA = makeSessionManager(async () => [], async () => firstSpawn.promise);
    const smB = makeSessionManager(async () => [], async () => makeSession("intelas-2", "INT-101"));

    const controllerA = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: smA,
      logger: { warn: vi.fn() },
    });

    for (let i = 0; i < 10; i += 1) {
      await flushPromises();
      if ((smA.spawn as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
    }
    expect(smA.spawn).toHaveBeenCalledTimes(1);

    const controllerB = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai-second",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: smB,
      logger: { warn: vi.fn() },
    });

    await flushPromises();
    expect(smB.spawn).not.toHaveBeenCalled();

    firstSpawn.resolve(makeSession("intelas-1", "INT-101"));
    await flushPromises();

    controllerA.stop();
    controllerB.stop();
  });

  it("clears stale pending claim and allows processing on the next poll", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const warn = vi.fn();

    mkdirSync(join(mockedPaths.baseDir, "listeners"), { recursive: true });
    writeFileSync(
      join(mockedPaths.baseDir, "listeners", "jira-broai.json"),
      JSON.stringify(
        {
          version: 1,
          issues: {
            "INT-101": {
              lastSessionId: "pending-123",
              updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }]),
    });

    const sm = makeSessionManager(
      async () => [],
      vi.fn().mockResolvedValue(makeSession("intelas-2", "INT-101")),
    );

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn },
    });

    await vi.runOnlyPendingTimersAsync();
    expect(sm.spawn).toHaveBeenCalledTimes(1);
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("Clearing stale pending claim for INT-101"),
      ),
    ).toBe(true);

    controller.stop();
  });

  it("does not spawn additional issues after stop is requested mid-poll", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const firstSpawn = createDeferred<Session>();

    jiraMock.mockResolvedValue({
      stdout: JSON.stringify([{ key: "INT-101" }, { key: "INT-102" }]),
    });

    const sm = makeSessionManager(
      async () => [],
      vi
        .fn()
        .mockImplementationOnce(async () => firstSpawn.promise)
        .mockResolvedValueOnce(makeSession("intelas-2", "INT-102")),
    );

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn: vi.fn() },
    });

    for (let i = 0; i < 10; i += 1) {
      await flushPromises();
      if ((sm.spawn as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
    }
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    controller.stop();
    firstSpawn.resolve(makeSession("intelas-1", "INT-101"));
    await flushPromises();
    await flushPromises();

    expect(sm.spawn).toHaveBeenCalledTimes(1);
  });

  it("disables listener when jira CLI binary is missing", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["jira-broai"] as ListenerConfig;
    const warn = vi.fn();

    const missingBinary = Object.assign(new Error("spawn jira ENOENT"), { code: "ENOENT" });
    jiraMock.mockRejectedValueOnce(missingBinary);

    const sm = makeSessionManager(async () => [], async () => makeSession("intelas-1", "INT-101"));

    const controller = await jiraBacklogSource.start({
      config,
      listenerId: "jira-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn },
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(jiraMock).toHaveBeenCalledTimes(1);
    expect(sm.spawn).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("jira CLI is not available in PATH; disabling listener"),
      ),
    ).toBe(true);

    controller.stop();
  });
});
