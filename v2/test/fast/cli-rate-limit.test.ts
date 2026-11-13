import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

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
  ensureInstanceConfig: vi.fn(() => ({ configPath: "/tmp/spur.yaml", initialized: false })),
  findProjectConfigPath: vi.fn(),
  loadConfig: vi.fn(() => ({ tmux: { socketName: "spur-test" } })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({ writeStderr: vi.fn(), writeStdout: writeStdoutMock }));

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  TmuxProbeUnknownError: (await importOriginal<typeof RuntimeTmuxModule>()).TmuxProbeUnknownError,
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function run(args: string[]): Promise<string> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
  return writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("spur rate-limit clear", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock.mockReset().mockResolvedValue({
      sessionId: "api-1",
      state: "waiting",
      deliveryScheduled: true,
    });
    writeStdoutMock.mockReset();
  });

  it("posts a normal clear for the selected session", async () => {
    const output = await run(["rate-limit", "clear", "api-1", "--json"]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/rate-limit/clear",
      {},
      "/tmp/spur.yaml",
    );
    expect(JSON.parse(output)).toEqual({
      sessionId: "api-1",
      state: "waiting",
      deliveryScheduled: true,
    });
  });

  it("sends force only when requested", async () => {
    await run(["rate-limit", "clear", "api-1", "--force", "--json"]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/rate-limit/clear",
      { force: true },
      "/tmp/spur.yaml",
    );
  });

  it("prints the resulting state and delivery schedule", async () => {
    const output = await run(["rate-limit", "clear", "api-1"]);
    expect(output).toContain("api-1: waiting; delivery scheduled");
  });

  it("retains the daemon's exhausted-window reset message", async () => {
    postJsonMock.mockRejectedValueOnce(new Error("Quota exhausted; resets at 2026-11-14T00:00:00Z"));
    await expect(run(["rate-limit", "clear", "api-1", "--json"])).rejects.toThrow(
      "resets at 2026-11-14T00:00:00Z",
    );
  });
});
