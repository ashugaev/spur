import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postJsonMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
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
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

describe("restore", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock.mockReset().mockResolvedValue({ id: "api-1", status: "running" });
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads force:true into the restore request body", async () => {
    await parseCli(["restore", "api-1", "--force", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/restore",
      { force: true },
      "/tmp/spur.yaml",
    );
  });

  it("omits force from the restore request body by default", async () => {
    await parseCli(["restore", "api-1", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/restore",
      {},
      "/tmp/spur.yaml",
    );
  });
});
