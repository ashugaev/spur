import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SentrySourceConfig } from "../../src/types.js";

const fetchSentryIssuesMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();

vi.mock("../../src/sentry.js", () => ({
  fetchSentryIssues: fetchSentryIssuesMock,
}));
vi.mock("../../src/metadata.js", () => ({
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordWorkItem: recordWorkItemMock,
}));

const { sentrySourceModule } = await import("../../src/event-sources/sentry.js");

function config(overrides: Partial<SentrySourceConfig> = {}): SentrySourceConfig {
  return {
    type: "sentry",
    runOnStart: false,
    authToken: "token",
    org: "acme",
    project: "web",
    baseUrl: "https://sentry.io",
    query: "is:unresolved",
    intervalMs: 60_000,
    emitExisting: false,
    ...overrides,
  };
}

async function start(emit: ReturnType<typeof vi.fn>, overrides: Partial<SentrySourceConfig> = {}) {
  return sentrySourceModule.start({
    sourceId: "sentry-issues",
    projectId: "api",
    dataDir: "/tmp/spur-data",
    config: config(overrides),
    emit,
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
    webBaseUrl: "http://127.0.0.1:5555",
  });
}

describe("sentry source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readWorkItemRegistryMock.mockReturnValue(new Set());
  });

  it("emits sentry:issue.new for unseen issues once the registry has entries", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#WEB-1"]));
    fetchSentryIssuesMock.mockResolvedValueOnce([
      { shortId: "WEB-2", title: "Boom", permalink: "https://sentry.io/issues/2/" },
    ]);
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "sentry-issues",
      "acme/web#WEB-2",
    );
    expect(emit).toHaveBeenCalledWith("sentry:issue.new", {
      externalId: "acme/web#WEB-2",
      url: "https://sentry.io/issues/2/",
      number: 2,
      title: "Boom",
      repo: "acme/web",
    });

    handle.stop();
  });

  it("suppresses already-seen issues", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#WEB-2"]));
    fetchSentryIssuesMock.mockResolvedValueOnce([
      { shortId: "WEB-2", title: "Boom", permalink: "https://sentry.io/issues/2/" },
    ]);
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("suppresses the first-poll backlog by default but records it", async () => {
    fetchSentryIssuesMock.mockResolvedValueOnce([
      { shortId: "WEB-1", title: "A", permalink: "https://sentry.io/issues/1/" },
      { shortId: "WEB-2", title: "B", permalink: "https://sentry.io/issues/2/" },
    ]);
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("emits the first-poll backlog when emitExisting is true", async () => {
    fetchSentryIssuesMock.mockResolvedValueOnce([
      { shortId: "WEB-1", title: "A", permalink: "https://sentry.io/issues/1/" },
      { shortId: "WEB-2", title: "B", permalink: "https://sentry.io/issues/2/" },
    ]);
    const emit = vi.fn();

    const handle = await start(emit, { emitExisting: true });

    const emits = emit.mock.calls.filter((call) => call[0] === "sentry:issue.new");
    expect(emits).toHaveLength(2);
    expect(recordWorkItemMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
