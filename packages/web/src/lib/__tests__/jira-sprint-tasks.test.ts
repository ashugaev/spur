import { describe, it, expect, vi } from "vitest";
import type { OrchestratorConfig, Session, SessionManager } from "@composio/ao-core";
import {
  buildJiraSprintTasksSnapshot,
  buildListenerEffectiveFilters,
  extractJiraIssueKey,
} from "../jira-sprint-tasks";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    id: overrides.id,
    projectId: "int",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2026-03-06T10:00:00.000Z"),
    lastActivityAt: new Date("2026-03-06T10:05:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      int: {
        name: "Int Project",
        repo: "acme/int",
        path: "/tmp/int",
        defaultBranch: "main",
        sessionPrefix: "int",
        tracker: { plugin: "jira" },
      },
      ao: {
        name: "AO",
        repo: "acme/ao",
        path: "/tmp/ao",
        defaultBranch: "main",
        sessionPrefix: "ao",
        tracker: { plugin: "linear" },
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    listeners: {
      "tracker-int": {
        source: "tracker-task",
        projectId: "int",
        filters: {
          state: "open",
          assignee: "currentUser",
          labels: ["ao"],
        },
      },
    },
    ...overrides,
  };
}

function makeSessionManager(listImpl: SessionManager["list"]): SessionManager {
  return {
    list: listImpl,
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    kill: vi.fn(),
    restore: vi.fn(),
    send: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as SessionManager;
}

describe("jira-sprint-tasks helpers", () => {
  it("builds effective tracker filters with defaults", () => {
    expect(
      buildListenerEffectiveFilters({
        source: "tracker-task",
        projectId: "int",
      }),
    ).toEqual({ state: "open", limit: 100 });

    expect(
      buildListenerEffectiveFilters({
        source: "tracker-task",
        projectId: "int",
        filters: {
          state: "all",
          assignee: "alek",
          labels: ["ao", "ao", "ops"],
          limit: 50,
        },
      }),
    ).toEqual({
      state: "all",
      assignee: "alek",
      labels: ["ao", "ops"],
      limit: 50,
    });
  });

  it("extracts Jira-like issue keys from keys and URLs", () => {
    expect(extractJiraIssueKey("INT-123")).toBe("INT-123");
    expect(extractJiraIssueKey(" https://acme.atlassian.net/browse/int-123 ")).toBe("INT-123");
    expect(extractJiraIssueKey("not-an-issue")).toBeNull();
  });

  it("maps tracker tasks to related active sessions and spawn availability", async () => {
    const config = makeConfig();
    const sessions = [
      makeSession({ id: "int-1", issueId: "INT-101", status: "working", activity: "active" }),
      makeSession({
        id: "int-2",
        issueId: "https://acme.atlassian.net/browse/INT-101",
        status: "killed",
        activity: "exited",
      }),
      makeSession({ id: "int-3", issueId: "INT-102", status: "merged", activity: "exited" }),
    ];
    const sessionManager = makeSessionManager(vi.fn(async () => sessions));
    const issueFetcher = vi.fn(async () => [
      {
        issueKey: "INT-101",
        issueUrl: "https://acme.atlassian.net/browse/INT-101",
        summary: "First task",
        status: "open",
        statusCategory: "open",
      },
      {
        issueKey: "INT-102",
        issueUrl: "https://acme.atlassian.net/browse/INT-102",
        summary: "Second task",
        status: "open",
        statusCategory: "open",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.listeners).toHaveLength(1);
    expect(snapshot.listeners[0]?.listenerId).toBe("tracker-int");
    expect(snapshot.listeners[0]?.filters).toEqual({
      state: "open",
      assignee: "currentUser",
      labels: ["ao"],
      limit: 100,
    });
    expect(snapshot.tasks).toHaveLength(2);

    const firstTask = snapshot.tasks.find((task) => task.issueKey === "INT-101");
    expect(firstTask).toBeDefined();
    expect(firstTask?.relatedActiveSessions.map((session) => session.id)).toEqual(["int-1"]);
    expect(firstTask?.spawnAvailable).toBe(false);

    const secondTask = snapshot.tasks.find((task) => task.issueKey === "INT-102");
    expect(secondTask).toBeDefined();
    expect(secondTask?.relatedActiveSessions).toEqual([]);
    expect(secondTask?.spawnAvailable).toBe(true);
  });

  it("returns empty tasks when issue fetcher has no results", async () => {
    const config = makeConfig();
    const sessionManager = makeSessionManager(vi.fn(async () => []));
    const issueFetcher = vi.fn(async () => []);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.listeners).toHaveLength(1);
    expect(snapshot.tasks).toEqual([]);
    expect(issueFetcher).toHaveBeenCalledTimes(1);
    expect(sessionManager.list).toHaveBeenCalledWith("int");
  });

  it("deduplicates tasks across listeners and supports project filtering", async () => {
    const config = makeConfig({
      listeners: {
        "tracker-int-a": {
          source: "tracker-task",
          projectId: "int",
          filters: { state: "open" },
        },
        "tracker-int-b": {
          source: "tracker-task",
          projectId: "int",
          filters: { state: "open" },
        },
        "tracker-ao": {
          source: "tracker-task",
          projectId: "ao",
          filters: { state: "open" },
        },
      },
    });
    const sessionManager = makeSessionManager(vi.fn(async () => []));
    const issueFetcher = vi.fn(async ({ listener }) => {
      if (listener.projectId === "ao") {
        return [
          {
            issueKey: "AO-1",
            issueUrl: null,
            summary: "AO task",
            status: "open",
            statusCategory: "open",
          },
        ];
      }
      return [
        {
          issueKey: "INT-200",
          issueUrl: null,
          summary: "INT task",
          status: "open",
          statusCategory: "open",
        },
      ];
    });

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
      projectId: "int",
    });

    expect(snapshot.projectId).toBe("int");
    expect(snapshot.listeners.map((listener) => listener.listenerId)).toEqual([
      "tracker-int-a",
      "tracker-int-b",
    ]);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-200");
    expect(snapshot.tasks[0]?.listenerIds).toEqual(["tracker-int-a", "tracker-int-b"]);
  });

  it("deduplicates related active sessions across multiple listeners for same issue", async () => {
    const config = makeConfig({
      listeners: {
        "tracker-int-a": {
          source: "tracker-task",
          projectId: "int",
          filters: { state: "open" },
        },
        "tracker-int-b": {
          source: "tracker-task",
          projectId: "int",
          filters: { state: "open" },
        },
      },
    });
    const sessionManager = makeSessionManager(
      vi.fn(async () => [
        makeSession({ id: "int-dup", issueId: "INT-300", status: "working", activity: "active" }),
      ]),
    );
    const issueFetcher = vi.fn(async () => [
      {
        issueKey: "INT-300",
        issueUrl: "https://acme.atlassian.net/browse/INT-300",
        summary: "Task with active session",
        status: "open",
        statusCategory: "open",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-300");
    expect(snapshot.tasks[0]?.listenerIds).toEqual(["tracker-int-a", "tracker-int-b"]);
    expect(snapshot.tasks[0]?.relatedActiveSessions.map((session) => session.id)).toEqual([
      "int-dup",
    ]);
    expect(snapshot.tasks[0]?.spawnAvailable).toBe(false);
    expect(issueFetcher).toHaveBeenCalledTimes(2);
    expect(sessionManager.list).toHaveBeenCalledTimes(1);
  });

  it("treats task as startable when it is in listener scope and has no active session", async () => {
    const config = makeConfig({
      listeners: {
        "tracker-int-a": {
          source: "tracker-task",
          projectId: "int",
          filters: { state: "open" },
        },
      },
    });
    const sessionManager = makeSessionManager(vi.fn(async () => []));
    const issueFetcher = vi.fn(async () => [
      {
        issueKey: "INT-301",
        issueUrl: "https://acme.atlassian.net/browse/INT-301",
        summary: "In progress task",
        status: "in_progress",
        statusCategory: "in_progress",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-301");
    expect(snapshot.tasks[0]?.spawnAvailable).toBe(true);
    expect(snapshot.tasks[0]?.canStart).toBe(true);
  });
});
