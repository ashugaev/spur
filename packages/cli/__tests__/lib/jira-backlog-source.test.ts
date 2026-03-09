import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ListenerConfig,
  OrchestratorConfig,
  PluginRegistry,
  Session,
  SessionManager,
  Tracker,
} from "@composio/ao-core";
import type { IntegrationHealthReporter } from "../../src/lib/integration-health.js";
import { trackerTaskSource } from "../../src/lib/listeners/jira-backlog-source.js";

const { mockedPaths, archivedStateBySession } = vi.hoisted(() => ({
  mockedPaths: { baseDir: "", sessionsDir: "" },
  archivedStateBySession: {} as Record<
    string,
    { status?: string; terminationReason?: string } | undefined
  >,
}));

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
      "tracker-broai": {
        source: "tracker-task",
        projectId: "int",
        intervalMs: 60_000,
        filters: {
          state: "open",
          assignee: "aleksey@intelas.com",
          labels: ["BroAI"],
        },
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

function makeRegistry(listIssuesImpl: NonNullable<Tracker["listIssues"]>): PluginRegistry {
  const tracker: Tracker = {
    name: "jira",
    getIssue: vi.fn(),
    isCompleted: vi.fn(),
    issueUrl: vi.fn(),
    issueLabel: vi.fn(),
    branchName: vi.fn(),
    generatePrompt: vi.fn(),
    listIssues: vi.fn(listIssuesImpl),
    updateIssue: vi.fn(),
    createIssue: vi.fn(),
  };

  return {
    register: vi.fn(),
    get: vi.fn((slot: string, name: string) => {
      if (slot === "tracker" && name === "jira") return tracker;
      return null;
    }),
    list: vi.fn(),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  } as unknown as PluginRegistry;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("trackerTaskSource", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = join(tmpdir(), `ao-tracker-listener-${randomUUID()}`);
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

  it("spawns once for issue ids returned by tracker.listIssues", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["tracker-broai"] as ListenerConfig;
    const warn = vi.fn();
    const healthReporter = makeHealthReporterStub();
    const registry = makeRegistry(async () => [
      {
        id: "INT-101",
        title: "Task 101",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-101",
        state: "open",
        labels: [],
      },
    ]);

    const sm = makeSessionManager(async () => [], async () => makeSession("intelas-1", "INT-101"));

    const controller = await trackerTaskSource.start({
      config,
      registry,
      listenerId: "tracker-broai",
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

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sm.spawn).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(healthReporter.markStarting).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:tracker-broai" }),
      expect.stringContaining("Starting"),
    );
    expect(healthReporter.markHealthy).toHaveBeenCalled();
    expect(healthReporter.markInactive).toHaveBeenCalledWith(
      expect.objectContaining({ id: "listener:tracker-broai" }),
      expect.stringContaining("stopped"),
    );
  });

  it("retries the same issue only after previous listener session was killed", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["tracker-broai"] as ListenerConfig;
    const registry = makeRegistry(async () => [
      {
        id: "INT-101",
        title: "Task 101",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-101",
        state: "open",
        labels: [],
      },
    ]);

    const sm = makeSessionManager(
      async () => [],
      vi
        .fn()
        .mockResolvedValueOnce(makeSession("intelas-1", "INT-101"))
        .mockResolvedValueOnce(makeSession("intelas-2", "INT-101")),
    );

    const controller = await trackerTaskSource.start({
      config,
      registry,
      listenerId: "tracker-broai",
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

  it("prevents duplicate spawn when another process already holds issue lock", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["tracker-broai"] as ListenerConfig;
    const firstSpawn = createDeferred<Session>();
    const registry = makeRegistry(async () => [
      {
        id: "INT-101",
        title: "Task 101",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-101",
        state: "open",
        labels: [],
      },
    ]);

    const smA = makeSessionManager(async () => [], async () => firstSpawn.promise);
    const smB = makeSessionManager(async () => [], async () => makeSession("intelas-2", "INT-101"));

    const controllerA = await trackerTaskSource.start({
      config,
      registry,
      listenerId: "tracker-broai",
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

    const controllerB = await trackerTaskSource.start({
      config,
      registry,
      listenerId: "tracker-broai-second",
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

  it("disables listener when tracker dependency is missing", async () => {
    const config = makeConfig(rootDir);
    const listener = config.listeners?.["tracker-broai"] as ListenerConfig;
    const warn = vi.fn();

    const missingBinary = Object.assign(new Error("spawn jira ENOENT"), { code: "ENOENT" });
    const registry = makeRegistry(async () => {
      throw missingBinary;
    });

    const sm = makeSessionManager(async () => [], async () => makeSession("intelas-1", "INT-101"));

    const controller = await trackerTaskSource.start({
      config,
      registry,
      listenerId: "tracker-broai",
      listener,
      projectId: "int",
      project: config.projects.int!,
      sessionManager: sm,
      logger: { warn },
    });

    await flushPromises();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sm.spawn).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("Tracker dependencies are not available; disabling listener"),
      ),
    ).toBe(true);

    controller.stop();
  });
});
