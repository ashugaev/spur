import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: vi.fn(),
  postJson: postJsonMock,
  postPreflight: vi.fn(),
  restartDaemonIfRunning: vi.fn(),
  stopDaemonIfRunning: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  defaultVoiceModelPath: vi.fn(),
  createProjectConfigScaffold: vi.fn(),
  ensureInstanceConfig: vi.fn(() => ({
    configPath: "/tmp/spur.yaml",
    initialized: false,
  })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({
    tmux: { socketName: "spur-test" },
  })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({
  writeStderr: vi.fn(),
  writeStdout: writeStdoutMock,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  setTmuxSocketName: setTmuxSocketNameMock,
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseQueue(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

function sessionWithQueue(messages: string[], pipelineMessages?: string[]) {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "ship it",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    state: "waiting",
    runtimeAlive: true,
    workspaceExists: true,
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
    lastActivityAt: "2026-06-15T10:00:00.000Z",
    artifacts: [],
    services: [],
    sidecars: [],
    queuedMessages: {
      messages,
      awaitingPrompt: false,
      ...(pipelineMessages ? { pipelineMessages } : {}),
    },
  };
}

describe("queue CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    writeStdoutMock.mockReset();
    setTmuxSocketNameMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the queue via a plain GET /sessions/:id", async () => {
    getJsonMock.mockResolvedValue(sessionWithQueue(["first", "second"]));

    await parseQueue(["queue", "api-1", "list", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1",
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects an index argument on list", async () => {
    await expect(parseQueue(["queue", "api-1", "list", "1", "--json"])).rejects.toThrow(
      "queue list does not accept an index",
    );
    expect(getJsonMock).not.toHaveBeenCalled();
  });

  it("resolves a 1-based index to exact text and sends the text, not the index, in the POST body", async () => {
    getJsonMock.mockResolvedValue(sessionWithQueue(["first", "second", "third"]));
    postJsonMock.mockResolvedValue(sessionWithQueue(["first", "third"]));

    await parseQueue(["queue", "api-1", "remove", "2", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1",
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/queue/remove",
      { message: "second" },
      "/tmp/spur.yaml",
    );
  });

  it("resolves flush the same way, against the flush route", async () => {
    getJsonMock.mockResolvedValue(sessionWithQueue(["first", "second"]));
    postJsonMock.mockResolvedValue(sessionWithQueue(["second"]));

    await parseQueue(["queue", "api-1", "flush", "1", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/queue/flush",
      { message: "first" },
      "/tmp/spur.yaml",
    );
  });

  it("rejects an out-of-range index before any POST", async () => {
    getJsonMock.mockResolvedValue(sessionWithQueue(["first"]));

    await expect(parseQueue(["queue", "api-1", "remove", "5", "--json"])).rejects.toThrow(
      /out of range/,
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric index before any GET or POST", async () => {
    await expect(parseQueue(["queue", "api-1", "flush", "abc", "--json"])).rejects.toThrow(
      "queue flush requires a 1-based index",
    );
    expect(getJsonMock).not.toHaveBeenCalled();
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("never targets a pipeline-derived string: an out-of-range index past the real queue rejects before POST", async () => {
    getJsonMock.mockResolvedValue(
      sessionWithQueue(["first"], ["Ship the feature — step 2/3: implement"]),
    );

    await expect(parseQueue(["queue", "api-1", "flush", "2", "--json"])).rejects.toThrow(
      /out of range/,
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown verb", async () => {
    await expect(parseQueue(["queue", "api-1", "bogus", "--json"])).rejects.toThrow(
      "queue action must be list, remove, or flush",
    );
    expect(getJsonMock).not.toHaveBeenCalled();
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("registers the queue command", async () => {
    const { createProgram } = await import("../../src/cli.js");

    expect(
      createProgram("/tmp/dist/cli.js").commands.some((command) => command.name() === "queue"),
    ).toBe(true);
  });
});
