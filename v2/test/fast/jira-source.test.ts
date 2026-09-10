import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JiraSourceConfig } from "../../src/types.js";

const fetchJiraIssuesMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/jira.js", () => ({
  fetchJiraIssues: fetchJiraIssuesMock,
}));
vi.mock("../../src/metadata.js", () => ({
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordWorkItem: recordWorkItemMock,
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

const { jiraSourceModule } = await import("../../src/event-sources/jira.js");

function config(overrides: Partial<JiraSourceConfig> = {}): JiraSourceConfig {
  return {
    type: "jira",
    runOnStart: false,
    baseUrl: "https://jira.example.com/",
    email: "bot@example.com",
    token: "secret",
    query: "project = WEBDEV AND statusCategory != Done",
    intervalMs: 60_000,
    emitExisting: false,
    maxResults: 50,
    ...overrides,
  };
}

async function start(emit: ReturnType<typeof vi.fn>, overrides: Partial<JiraSourceConfig> = {}) {
  return jiraSourceModule.start({
    sourceId: "jira",
    projectId: "backend",
    dataDir: "/tmp/spur-data",
    config: config(overrides),
    emit,
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
    resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
  });
}

describe("jira source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readWorkItemRegistryMock.mockReturnValue(new Set());
  });

  it("emits jira:work_item.new for an unseen issue once the registry has entries", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["WEBDEV#WEBDEV-1"]));
    fetchJiraIssuesMock.mockResolvedValueOnce([
      {
        id: "10001",
        key: "WEBDEV-5236",
        title: "Fix the thing",
        url: "https://jira.example.com/browse/WEBDEV-5236",
      },
    ]);
    const emit = vi.fn();

    const handle = await start(emit, { maxResults: 75 });

    expect(fetchJiraIssuesMock).toHaveBeenCalledWith({
      baseUrl: "https://jira.example.com/",
      email: "bot@example.com",
      token: "secret",
      jql: "project = WEBDEV AND statusCategory != Done",
      maxResults: 75,
    });
    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "backend",
      "jira",
      "WEBDEV#WEBDEV-5236",
    );
    expect(emit).toHaveBeenCalledWith("jira:work_item.new", {
      externalId: "WEBDEV#WEBDEV-5236",
      key: "WEBDEV-5236",
      url: "https://jira.example.com/browse/WEBDEV-5236",
      number: 5236,
      title: "Fix the thing",
      repo: "WEBDEV",
    });

    handle.stop();
  });

  it("suppresses an already-seen issue", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["WEBDEV#WEBDEV-5236"]));
    fetchJiraIssuesMock.mockResolvedValueOnce([
      {
        id: "10001",
        key: "WEBDEV-5236",
        title: "Fix the thing",
        url: "https://jira.example.com/browse/WEBDEV-5236",
      },
    ]);
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("suppresses the first-poll backlog by default but records every issue", async () => {
    fetchJiraIssuesMock.mockResolvedValueOnce([
      { id: "1", key: "WEBDEV-1", title: "A", url: "https://jira.example.com/browse/WEBDEV-1" },
      { id: "2", key: "WEBDEV-2", title: "B", url: "https://jira.example.com/browse/WEBDEV-2" },
    ]);
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("caps the first-poll backlog at 10 per key prefix when emitExisting is true, recording all", async () => {
    const webdevIssues = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      key: `WEBDEV-${index + 1}`,
      title: `Issue ${index + 1}`,
      url: `https://jira.example.com/browse/WEBDEV-${index + 1}`,
    }));
    const infraIssues = Array.from({ length: 3 }, (_, index) => ({
      id: `infra-${index}`,
      key: `INFRA-${index + 1}`,
      title: `Infra issue ${index + 1}`,
      url: `https://jira.example.com/browse/INFRA-${index + 1}`,
    }));
    fetchJiraIssuesMock.mockResolvedValueOnce([...webdevIssues, ...infraIssues]);
    const emit = vi.fn();

    const handle = await start(emit, { emitExisting: true });

    const emits = emit.mock.calls.filter((call) => call[0] === "jira:work_item.new");
    const webdevEmits = emits.filter((call) => (call[1] as { repo: string }).repo === "WEBDEV");
    const infraEmits = emits.filter((call) => (call[1] as { repo: string }).repo === "INFRA");
    expect(webdevEmits).toHaveLength(10);
    expect(infraEmits).toHaveLength(3);
    expect(recordWorkItemMock).toHaveBeenCalledTimes(15);

    handle.stop();
  });

  it("logs one warn and one source.work_item_poll.error on a rejecting fetch, and keeps polling", async () => {
    fetchJiraIssuesMock.mockRejectedValueOnce(
      new Error("Jira search request failed with status 500"),
    );
    fetchJiraIssuesMock.mockResolvedValue([]);
    const emit = vi.fn();
    const warn = vi.fn();

    const handle = await jiraSourceModule.start({
      sourceId: "jira",
      projectId: "backend",
      dataDir: "/tmp/spur-data",
      config: config({ intervalMs: 5 }),
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(logSpurEventMock).toHaveBeenCalledTimes(1);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({ event: "source.work_item_poll.error" }),
    );

    await vi.waitFor(() => {
      expect(fetchJiraIssuesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    handle.stop();
  });
});
