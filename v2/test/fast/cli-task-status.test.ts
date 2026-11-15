import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const stdout = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  postJson: postJsonMock,
  listProjects: vi.fn(),
  postPreflight: vi.fn(),
  restartDaemonIfRunning: vi.fn(),
  stopDaemonIfRunning: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  defaultVoiceModelPath: vi.fn(),
  createProjectConfigScaffold: vi.fn(),
  ensureInstanceConfig: vi.fn(() => ({ configPath: "/tmp/task-status.yaml", initialized: false })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({ tmux: { socketName: "spur-test" } })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));
vi.mock("../../src/io.js", () => ({ writeStderr: vi.fn(), writeStdout: stdout }));
vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeTmuxModule>()),
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn(),
  withTmuxSocketArgs: (args: string[]) => args,
}));

async function run(...args: string[]) {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync([
    "node",
    "spur",
    "task-status",
    "--session",
    "api-1",
    ...args,
  ]);
}

describe("task-status CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    stdout.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the task revision without requiring a launch identity", async () => {
    getJsonMock.mockResolvedValue({ revision: 3 });
    await run("--json");
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/task-status",
      "/tmp/task-status.yaml",
    );
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ revision: 3 }, null, 2));
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("posts the retained revision with the process launch identity", async () => {
    vi.stubEnv("SPUR_AGENT_LAUNCH_ID", "launch-a");
    postJsonMock.mockResolvedValue({ revision: 3, state: "completed" });
    await run("completed", "--revision", "3", "--json");
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/task-status",
      { state: "completed", revision: 3, agentLaunchId: "launch-a" },
      "/tmp/task-status.yaml",
    );
  });

  it.each([
    { options: [] },
    { options: ["--revision", "-1"] },
    { options: ["--revision", "oops"] },
  ])("rejects a missing/invalid revision before sending $options", async ({ options }) => {
    vi.stubEnv("SPUR_AGENT_LAUNCH_ID", "launch-a");
    await expect(run("needs_input", ...options)).rejects.toThrow("revision");
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});
