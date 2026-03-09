import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry, ProjectConfig, Tracker } from "@composio/ao-core";
import { listTrackerIssuesForListener } from "../jira-sprint-tasks";

function makeProject(plugin = "jira"): ProjectConfig {
  return {
    name: "My App",
    repo: "acme/my-app",
    path: "/tmp/my-app",
    defaultBranch: "main",
    sessionPrefix: "my-app",
    tracker: { plugin },
  };
}

function makeListener() {
  return {
    source: "tracker-task",
    listenerId: "tracker-main",
    projectId: "my-app",
    projectName: "My App",
    filters: { state: "open", limit: 100 },
    triggerAgent: null,
  };
}

function makeRegistry(listIssuesImpl?: Tracker["listIssues"]): PluginRegistry {
  const tracker: Tracker = {
    name: "jira",
    getIssue: vi.fn(),
    isCompleted: vi.fn(),
    issueUrl: vi.fn(),
    issueLabel: vi.fn(),
    branchName: vi.fn(),
    generatePrompt: vi.fn(),
    ...(listIssuesImpl ? { listIssues: listIssuesImpl } : {}),
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

describe("jira-sprint-tasks tracker helpers", () => {
  it("returns empty array when tracker plugin is missing", async () => {
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn(() => null),
      list: vi.fn(),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    } as unknown as PluginRegistry;

    await expect(listTrackerIssuesForListener(makeListener(), makeProject(), registry)).resolves.toEqual([]);
  });

  it("returns empty array when tracker does not implement listIssues", async () => {
    const registry = makeRegistry(undefined);

    await expect(listTrackerIssuesForListener(makeListener(), makeProject(), registry)).resolves.toEqual([]);
  });

  it("normalizes and deduplicates tracker issue ids", async () => {
    const registry = makeRegistry(async () => [
      {
        id: "INT-1",
        title: "First",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-1",
        state: "open",
        labels: [],
      },
      {
        id: "int-1",
        title: "Duplicate by case",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-1",
        state: "open",
        labels: [],
      },
      {
        id: "INT-2",
        title: "Second",
        description: "",
        url: "https://acme.atlassian.net/browse/INT-2",
        state: "in_progress",
        labels: [],
      },
    ]);

    await expect(listTrackerIssuesForListener(makeListener(), makeProject(), registry)).resolves.toEqual([
      {
        issueKey: "INT-1",
        issueUrl: "https://acme.atlassian.net/browse/INT-1",
        summary: "First",
        status: "open",
        statusCategory: "open",
      },
      {
        issueKey: "INT-2",
        issueUrl: "https://acme.atlassian.net/browse/INT-2",
        summary: "Second",
        status: "in_progress",
        statusCategory: "in_progress",
      },
    ]);
  });
});
