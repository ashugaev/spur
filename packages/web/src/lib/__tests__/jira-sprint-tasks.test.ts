import { describe, it, expect, vi } from "vitest";
import type { OrchestratorConfig, Session, SessionManager } from "@composio/ao-core";
import {
  buildJiraSprintTasksSnapshot,
  buildListenerEffectiveJql,
  buildListenerSprintJql,
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
      "jira-int": {
        enabled: true,
        source: "jira-backlog",
        projectId: "int",
        jql: 'assignee = currentUser() AND sprint in openSprints()',
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
  it("builds effective listener JQL with escaped backlog status", () => {
    const effective = buildListenerEffectiveJql('project = "INT"', 'Backlog "Now"');
    expect(effective).toBe('(project = "INT") AND status = "Backlog \\"Now\\""');
  });

  it("preserves ORDER BY when appending backlog/sprint constraints", () => {
    const base = "project = INT ORDER BY created DESC";
    expect(buildListenerEffectiveJql(base, "Backlog")).toBe(
      '(project = INT) AND status = "Backlog" ORDER BY created DESC',
    );
    expect(buildListenerSprintJql(base)).toBe(
      "(project = INT) AND sprint in openSprints() ORDER BY created DESC",
    );
  });

  it("extracts Jira issue keys from keys and URLs", () => {
    expect(extractJiraIssueKey("INT-123")).toBe("INT-123");
    expect(extractJiraIssueKey(" https://acme.atlassian.net/browse/int-123 ")).toBe("INT-123");
    expect(extractJiraIssueKey("not-an-issue")).toBeNull();
  });

  it("maps jira tasks to related active sessions and spawn availability", async () => {
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
        status: "Backlog",
        statusCategory: "new",
      },
      {
        issueKey: "INT-102",
        issueUrl: "https://acme.atlassian.net/browse/INT-102",
        summary: "Second task",
        status: "Backlog",
        statusCategory: "new",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.listeners).toHaveLength(1);
    expect(snapshot.listeners[0]?.listenerId).toBe("jira-int");
    expect(snapshot.listeners[0]?.effectiveJql).toContain('status = "Backlog"');
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
        "jira-int-a": {
          enabled: true,
          source: "jira-backlog",
          projectId: "int",
          jql: "project = INT",
        },
        "jira-int-b": {
          enabled: true,
          source: "jira-backlog",
          projectId: "int",
          jql: "project = INT",
          backlogStatus: "To Do",
        },
        "jira-ao": {
          enabled: true,
          source: "jira-backlog",
          projectId: "ao",
          jql: "project = AO",
        },
      },
    });
    const sessionManager = makeSessionManager(vi.fn(async () => []));
    const issueFetcher = vi.fn(async (effectiveJql: string) => {
      if (effectiveJql.includes("project = AO")) {
        return [{ issueKey: "AO-1", issueUrl: null, summary: "AO task", status: "Backlog", statusCategory: "new" }];
      }
      return [{ issueKey: "INT-200", issueUrl: null, summary: "INT task", status: "Backlog", statusCategory: "new" }];
    });

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
      projectId: "int",
    });

    expect(snapshot.projectId).toBe("int");
    expect(snapshot.listeners.map((listener) => listener.listenerId)).toEqual(["jira-int-a", "jira-int-b"]);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-200");
    expect(snapshot.tasks[0]?.listenerIds).toEqual(["jira-int-a", "jira-int-b"]);
  });

  it("deduplicates related active sessions across multiple listeners for same issue", async () => {
    const config = makeConfig({
      listeners: {
        "jira-int-a": {
          enabled: true,
          source: "jira-backlog",
          projectId: "int",
          jql: "project = INT",
        },
        "jira-int-b": {
          enabled: true,
          source: "jira-backlog",
          projectId: "int",
          jql: "project = INT",
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
        status: "Backlog",
        statusCategory: "new",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-300");
    expect(snapshot.tasks[0]?.listenerIds).toEqual(["jira-int-a", "jira-int-b"]);
    expect(snapshot.tasks[0]?.relatedActiveSessions.map((session) => session.id)).toEqual([
      "int-dup",
    ]);
    expect(snapshot.tasks[0]?.spawnAvailable).toBe(false);
    expect(issueFetcher).toHaveBeenCalledTimes(2);
    expect(sessionManager.list).toHaveBeenCalledTimes(1);
  });

  it("marks task as non-startable when issue is not in backlog status", async () => {
    const config = makeConfig({
      listeners: {
        "jira-int-a": {
          enabled: true,
          source: "jira-backlog",
          projectId: "int",
          jql: "project = INT",
          backlogStatus: "Backlog",
        },
      },
    });
    const sessionManager = makeSessionManager(vi.fn(async () => []));
    const issueFetcher = vi.fn(async () => [
      {
        issueKey: "INT-301",
        issueUrl: "https://acme.atlassian.net/browse/INT-301",
        summary: "In progress task",
        status: "In Progress",
        statusCategory: "indeterminate",
      },
    ]);

    const snapshot = await buildJiraSprintTasksSnapshot({
      config,
      sessionManager,
      issueFetcher,
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.issueKey).toBe("INT-301");
    expect(snapshot.tasks[0]?.spawnAvailable).toBe(false);
    expect(snapshot.tasks[0]?.canStart).toBe(false);
  });
});
