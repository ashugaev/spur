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

async function parseSessionMemory(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

function memoryRecord(status: "active" | "resolved" = "active") {
  return {
    key: "decision.api",
    kind: "note",
    body: "Use HTTP API",
    status,
    tags: [],
    createdAt: "2026-06-15T10:00:00.000Z",
    updatedAt: "2026-06-15T10:00:00.000Z",
  };
}

describe("session-memory CLI", () => {
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

  it("lists with exact session-memory <sessionId> list order", async () => {
    getJsonMock.mockResolvedValue({ records: [] });

    await parseSessionMemory(["session-memory", "api-1", "list", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/session-memory",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith(JSON.stringify({ records: [] }, null, 2));
  });

  it("gets, sets, and resolves records with exact command order", async () => {
    getJsonMock.mockResolvedValue({ record: memoryRecord() });
    postJsonMock
      .mockResolvedValueOnce({ record: memoryRecord() })
      .mockResolvedValueOnce({ record: memoryRecord("resolved") });

    await parseSessionMemory(["session-memory", "api-1", "get", "decision.api", "--json"]);
    await parseSessionMemory([
      "session-memory",
      "api-1",
      "set",
      "decision.api",
      "Use HTTP API",
      "--json",
    ]);
    await parseSessionMemory(["session-memory", "api-1", "resolve", "decision.api", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/session-memory/decision.api",
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).toHaveBeenNthCalledWith(
      1,
      "/tmp/dist/cli.js",
      "/sessions/api-1/session-memory/decision.api",
      { body: "Use HTTP API" },
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).toHaveBeenNthCalledWith(
      2,
      "/tmp/dist/cli.js",
      "/sessions/api-1/session-memory/decision.api/resolve",
      {},
      "/tmp/spur.yaml",
    );
  });

  it("registers the shared memory command alongside session-memory", async () => {
    const { createProgram } = await import("../../src/cli.js");

    expect(
      createProgram("/tmp/dist/cli.js").commands.some((command) => command.name() === "memory"),
    ).toBe(true);
  });
});
