import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postJsonMock = vi.fn();
const listProjectsMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
  listProjects: listProjectsMock,
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
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

describe("spawn", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock
      .mockReset()
      .mockResolvedValue({ id: "api-1", agent: "claude", status: "spawning" });
    listProjectsMock.mockReset().mockResolvedValue([{ id: "api" }]);
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the requested mode to the spawn endpoint", async () => {
    await parseCli(["spawn", "api", "ship it", "--mode", "council", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions",
      expect.objectContaining({ project: "api", prompt: "ship it", mode: "council" }),
      "/tmp/spur.yaml",
    );
  });

  it("omits mode from the spawn body when not provided", async () => {
    await parseCli(["spawn", "api", "ship it", "--json"]);

    const body = postJsonMock.mock.calls[0]?.[2];
    expect(body).not.toHaveProperty("mode");
  });
});
