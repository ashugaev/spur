import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as jiraModule from "../../src/jira.js";
import type { AppConfig, BacklogConfig, JiraSourceConfig } from "../../src/types.js";

const fetchJiraIssuesMock = vi.fn();
const replaceAvailableBacklogItemsMock = vi.fn();

vi.mock("../../src/jira.js", async (importOriginal) => {
  const actual = await importOriginal<typeof jiraModule>();
  return {
    ...actual,
    fetchJiraIssues: fetchJiraIssuesMock,
  };
});
vi.mock("../../src/metadata.js", () => ({
  replaceAvailableBacklogItems: replaceAvailableBacklogItemsMock,
}));

const { startConfiguredBacklogs } = await import("../../src/backlog/index.js");

const connection: JiraSourceConfig = {
  type: "jira",
  baseUrl: "https://jira.example.com/",
  email: "bot@example.com",
  token: "token",
};

function binding(overrides: Partial<BacklogConfig> = {}): BacklogConfig {
  return {
    source: "jira",
    provider: "jira",
    query: "project = WEB",
    intervalMs: 60_000,
    runOnStart: false,
    ...overrides,
  };
}

function appConfig(backlog: Record<string, BacklogConfig>): AppConfig {
  return {
    configPath: "/tmp/spur.yaml",
    server: { host: "127.0.0.1", port: 4310 },
    dataDir: "/tmp/spur-data",
    worktreeDir: "/tmp/spur-worktrees",
    defaultAgent: "claude",
    tmux: { socketName: "spur-test" },
    ui: { port: 5555 },
    voice: { provider: "whisper_cpp", language: "auto", model: "base" },
    rateLimitReactivation: { afterHours: 0 },
    authRotation: {
      autoRotateOnRateLimit: false,
      cooldownMinutes: 60,
      maxRotationsPerEpisode: 2,
    },
    tags: [],
    projects: {
      api: {
        path: "/tmp/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        restoreAfterReboot: false,
        symlinks: [],
        sidecars: {},
        sources: { jira: connection },
        backlog,
        triggers: {},
      },
    },
  };
}

describe("backlog runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores fetched issues as available backlog items keyed by backlogId", async () => {
    fetchJiraIssuesMock.mockResolvedValueOnce([
      {
        id: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: "https://jira.example.com/browse/WEB-17",
      },
    ]);

    const controller = startConfiguredBacklogs({
      config: appConfig({ features: binding({ runOnStart: true }) }),
      logger: { warn: vi.fn() },
    });

    await vi.waitFor(() => expect(replaceAvailableBacklogItemsMock).toHaveBeenCalledTimes(1));
    controller.stop();

    expect(fetchJiraIssuesMock).toHaveBeenCalledWith({
      baseUrl: "https://jira.example.com/",
      email: "bot@example.com",
      token: "token",
      jql: "project = WEB",
      maxResults: 100,
    });
    const [dataDir, projectId, backlogId, items] =
      replaceAvailableBacklogItemsMock.mock.calls[0] ?? [];
    expect([dataDir, projectId, backlogId]).toEqual(["/tmp/spur-data", "api", "features"]);
    expect(items).toEqual([
      {
        provider: "jira",
        projectId: "api",
        backlogId: "features",
        externalId: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: "https://jira.example.com/browse/WEB-17",
        fetchedAt: expect.any(String),
        position: 0,
      },
    ]);
  });

  it("stamps ascending position matching provider fetch order", async () => {
    fetchJiraIssuesMock.mockResolvedValueOnce([
      { id: "30003", key: "WEB-3", title: "Third", url: "https://jira.example.com/browse/WEB-3" },
      { id: "10001", key: "WEB-1", title: "First", url: "https://jira.example.com/browse/WEB-1" },
      { id: "20002", key: "WEB-2", title: "Second", url: "https://jira.example.com/browse/WEB-2" },
    ]);

    const controller = startConfiguredBacklogs({
      config: appConfig({ features: binding({ runOnStart: true }) }),
      logger: { warn: vi.fn() },
    });

    await vi.waitFor(() => expect(replaceAvailableBacklogItemsMock).toHaveBeenCalledTimes(1));
    controller.stop();

    const [, , , items] = replaceAvailableBacklogItemsMock.mock.calls[0] ?? [];
    expect(
      (items as { externalId: string; position: number }[]).map((item) => [
        item.externalId,
        item.position,
      ]),
    ).toEqual([
      ["30003", 0],
      ["10001", 1],
      ["20002", 2],
    ]);
  });

  it("does not poll before the interval when runOnStart is false", async () => {
    vi.useFakeTimers();
    const controller = startConfiguredBacklogs({
      config: appConfig({ features: binding({ runOnStart: false }) }),
      logger: { warn: vi.fn() },
    });

    expect(fetchJiraIssuesMock).not.toHaveBeenCalled();
    controller.stop();
    vi.useRealTimers();
  });
});
