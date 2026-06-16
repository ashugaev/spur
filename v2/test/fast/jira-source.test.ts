import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as jiraModule from "../../src/jira.js";
import type { JiraSourceConfig } from "../../src/types.js";

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

const { jiraSourceModule } = await import("../../src/event-sources/jira.js");

function config(overrides: Partial<JiraSourceConfig> = {}): JiraSourceConfig {
  return {
    type: "jira",
    runOnStart: false,
    baseUrl: "https://jira.example.com/",
    email: "bot@example.com",
    token: "token",
    jql: "project = WEB",
    intervalMs: 60_000,
    ...overrides,
  };
}

async function start(overrides: Partial<JiraSourceConfig> = {}) {
  return jiraSourceModule.start({
    sourceId: "jira-backlog",
    projectId: "api",
    dataDir: "/tmp/spur-data",
    config: config(overrides),
    emit: vi.fn(),
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

describe("jira source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores fetched issues as available backlog items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00.000Z"));
    fetchJiraIssuesMock.mockResolvedValueOnce([
      {
        id: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: "https://jira.example.com/browse/WEB-17",
      },
    ]);

    const handle = await start();

    expect(fetchJiraIssuesMock).toHaveBeenCalledWith({
      baseUrl: "https://jira.example.com/",
      email: "bot@example.com",
      token: "token",
      jql: "project = WEB",
      maxResults: 100,
    });
    expect(replaceAvailableBacklogItemsMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "jira-backlog",
      [
        {
          provider: "jira",
          projectId: "api",
          sourceId: "jira-backlog",
          externalId: "10001",
          key: "WEB-17",
          title: "Fix checkout",
          url: "https://jira.example.com/browse/WEB-17",
          fetchedAt: "2026-06-16T12:00:00.000Z",
        },
      ],
    );

    handle.stop();
    vi.useRealTimers();
  });

  it("waits for runOnStart when configured", async () => {
    const handle = await start({ runOnStart: true });

    expect(fetchJiraIssuesMock).not.toHaveBeenCalled();

    handle.runOnStart?.();
    await vi.waitFor(() => expect(fetchJiraIssuesMock).toHaveBeenCalledTimes(1));
    handle.stop();
  });
});
