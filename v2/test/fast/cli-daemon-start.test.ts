import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ordering is the property under test: a session must not be able to spawn
// before the npm global-prefix pin file exists, so `ensureNpmPinFile` must
// run before `startServer` resolves the daemon's HTTP listener.
const callOrder: string[] = [];

const ensureNpmPinFileMock = vi.fn(() => {
  callOrder.push("ensureNpmPinFile");
});

const startServerMock = vi.fn(async () => {
  callOrder.push("startServer");
  return {
    info: () => ({
      baseUrl: "http://127.0.0.1:4310",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  };
});

const writeStderrMock = vi.fn();

vi.mock("../../src/npm-prefix.js", () => ({
  ensureNpmPinFile: ensureNpmPinFileMock,
}));

vi.mock("../../src/server.js", () => ({
  startServer: startServerMock,
}));

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
  listProjects: vi.fn(),
  postJson: vi.fn(),
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
  findProjectConfigPathInDirectory: vi.fn(),
  loadConfig: vi.fn(() => ({
    tmux: { socketName: "spur-test" },
  })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({
  writeStderr: writeStderrMock,
  writeStdout: vi.fn(),
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

describe("spur daemon start CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    callOrder.length = 0;
    ensureNpmPinFileMock.mockClear();
    ensureNpmPinFileMock.mockImplementation(() => {
      callOrder.push("ensureNpmPinFile");
    });
    startServerMock.mockClear();
    writeStderrMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the npm pin file before starting the HTTP server", async () => {
    await parseCli(["daemon", "start", "--json"]);

    expect(ensureNpmPinFileMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["ensureNpmPinFile", "startServer"]);
  });

  it("reports a pin-file write failure via stderr instead of aborting the boot", async () => {
    ensureNpmPinFileMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await parseCli(["daemon", "start", "--json"]);

    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(writeStderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to write npm global-prefix pin file: EACCES: permission denied",
      ),
    );
  });
});
