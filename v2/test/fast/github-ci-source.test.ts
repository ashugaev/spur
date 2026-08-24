import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubCiSourceConfig } from "../../src/types.js";

const ghMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();

vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/metadata.js", () => ({
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordWorkItem: recordWorkItemMock,
}));

const { githubCiSourceModule } = await import("../../src/event-sources/github-ci.js");

interface RunFixture {
  databaseId: number;
  conclusion: string | null;
  headBranch: string;
  workflowName: string;
  url: string;
  status: string;
}

function run(overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    databaseId: 100,
    conclusion: "success",
    headBranch: "main",
    workflowName: "CI",
    url: "https://github.com/acme/web/actions/runs/100",
    status: "completed",
    ...overrides,
  };
}

function config(overrides: Partial<GitHubCiSourceConfig> = {}): GitHubCiSourceConfig {
  return {
    type: "github-ci",
    runOnStart: false,
    repo: "acme/web",
    conclusion: "success",
    intervalMs: 60_000,
    emitExisting: false,
    ...overrides,
  };
}

async function start(
  emit: ReturnType<typeof vi.fn>,
  overrides: Partial<GitHubCiSourceConfig> = {},
) {
  return githubCiSourceModule.start({
    sourceId: "ci-green",
    projectId: "api",
    dataDir: "/tmp/spur-data",
    config: config(overrides),
    emit,
    signal: new AbortController().signal,
    logger: { info: vi.fn(), warn: vi.fn() },
    webBaseUrl: null,
  });
}

describe("github-ci source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readWorkItemRegistryMock.mockReturnValue(new Set());
  });

  it("emits github-ci:run.completed for an unseen run once the registry has entries", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-99"]));
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 100 })]));
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "ci-green",
      "acme/web#run-100",
    );
    expect(emit).toHaveBeenCalledWith("github-ci:run.completed", {
      externalId: "acme/web#run-100",
      url: "https://github.com/acme/web/actions/runs/100",
      number: 100,
      title: "CI",
      repo: "acme/web",
    });

    handle.stop();
  });

  it("dedups already-seen run ids", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-100"]));
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 100 })]));
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("suppresses the first-poll backlog by default but records it", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 1 }), run({ databaseId: 2 })]));
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("emits the first-poll backlog when emitExisting is true", async () => {
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 1 }), run({ databaseId: 2 })]));
    const emit = vi.fn();

    const handle = await start(emit, { emitExisting: true });

    const emits = emit.mock.calls.filter((call) => call[0] === "github-ci:run.completed");
    expect(emits).toHaveLength(2);
    expect(recordWorkItemMock).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("filters out a failing run when conclusion is success", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-1"]));
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 100, conclusion: "failure" })]));
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("emits a failing run when conclusion is any", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-1"]));
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 100, conclusion: "failure" })]));
    const emit = vi.fn();

    const handle = await start(emit, { conclusion: "any" });

    expect(emit).toHaveBeenCalledWith(
      "github-ci:run.completed",
      expect.objectContaining({ externalId: "acme/web#run-100" }),
    );

    handle.stop();
  });

  it("filters out runs on a non-matching branch", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-1"]));
    ghMock.mockResolvedValueOnce(JSON.stringify([run({ databaseId: 100, headBranch: "dev" })]));
    const emit = vi.fn();

    const handle = await start(emit, { branch: "main" });

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("never emits an in-progress run", async () => {
    readWorkItemRegistryMock.mockReturnValue(new Set(["acme/web#run-1"]));
    ghMock.mockResolvedValueOnce(
      JSON.stringify([run({ databaseId: 100, status: "in_progress", conclusion: null })]),
    );
    const emit = vi.fn();

    const handle = await start(emit);

    expect(recordWorkItemMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });

  it("logs a poll error and does not throw on invalid gh JSON", async () => {
    ghMock.mockResolvedValueOnce("not json");
    const emit = vi.fn();
    const warn = vi.fn();

    const handle = await githubCiSourceModule.start({
      sourceId: "ci-green",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: config(),
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn },
      webBaseUrl: null,
    });

    expect(warn).toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();

    handle.stop();
  });
});
