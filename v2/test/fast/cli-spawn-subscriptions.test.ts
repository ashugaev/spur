import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const listProjectsMock = vi.fn();
const writeStdoutMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
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
  setTmuxSocketName: setTmuxSocketNameMock,
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

const PROJECT = { id: "demo", name: "demo", configured: true, prefix: "demo", path: "/repo/demo" };

async function parseSpawn(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

describe("spawn CLI state subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    listProjectsMock.mockReset();
    writeStdoutMock.mockReset();
    setTmuxSocketNameMock.mockReset();
    listProjectsMock.mockResolvedValue([PROJECT]);
    delete process.env["SPUR_SESSION"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["SPUR_SESSION"];
  });

  it("sends the exact subscriptions payload for one target, two states, and a message", async () => {
    postJsonMock.mockResolvedValue({ id: "demo-2", project: "demo" });

    await parseSpawn([
      "spawn",
      "demo",
      "do the thing",
      "--subscribe-to",
      "demo-1",
      "--subscribe-state",
      "waiting",
      "--subscribe-state",
      "stopped",
      "--subscribe-message",
      "target changed",
      "--json",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions",
      expect.objectContaining({
        project: "demo",
        prompt: "do the thing",
        subscriptions: [
          {
            targetSessionId: "demo-1",
            states: ["waiting", "stopped"],
            message: "target changed",
          },
        ],
      }),
      "/tmp/spur.yaml",
    );
  });

  it("rejects --subscribe-state without --subscribe-to, no spawn", async () => {
    await expect(
      parseSpawn(["spawn", "demo", "do the thing", "--subscribe-state", "waiting", "--json"]),
    ).rejects.toThrow(/--subscribe-state and --subscribe-message require --subscribe-to/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects --subscribe-to with zero states, no spawn", async () => {
    await expect(
      parseSpawn(["spawn", "demo", "do the thing", "--subscribe-to", "demo-1", "--json"]),
    ).rejects.toThrow(/--subscribe-to requires at least one --subscribe-state/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown --subscribe-state value, no spawn", async () => {
    await expect(
      parseSpawn([
        "spawn",
        "demo",
        "do the thing",
        "--subscribe-to",
        "demo-1",
        "--subscribe-state",
        "bogus",
        "--json",
      ]),
    ).rejects.toThrow(/state must be one of:/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
