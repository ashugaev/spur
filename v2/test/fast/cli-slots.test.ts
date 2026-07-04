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

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

const runtimeInfo = {
  ok: true as const,
  apiVersion: 1,
  pid: 1234,
  host: "127.0.0.1",
  port: 4000,
  dataDir: "/tmp/spur-data",
  worktreeDir: "/tmp/spur-worktrees",
  configPath: "/tmp/spur.yaml",
  tmuxSocketName: "spur-test",
  uiPort: 4001,
  startedAt: "2026-06-15T10:00:00.000Z",
  tags: [
    { name: "bug", description: "Fixing a defect", color: "hsl(0 62% 64%)" },
    { name: "review", description: "Reviewing a PR", color: "hsl(210 62% 64%)" },
  ],
};

describe("slots --list-tags CLI", () => {
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

  it("prints name — description lines in plain mode without hitting the slots POST endpoint", async () => {
    getJsonMock.mockResolvedValue(runtimeInfo);

    await parseCli(["slots", "--session", "api-1", "--list-tags"]);

    expect(getJsonMock).toHaveBeenCalledWith("/tmp/dist/cli.js", "/info", "/tmp/spur.yaml");
    expect(postJsonMock).not.toHaveBeenCalled();
    const output = writeStdoutMock.mock.calls.map((call) => call[0] as string).join("\n");
    expect(output).toContain("bug — Fixing a defect");
    expect(output).toContain("review — Reviewing a PR");
  });

  it("prints a narrow { tags } shape in --json mode", async () => {
    getJsonMock.mockResolvedValue(runtimeInfo);

    await parseCli(["slots", "--session", "api-1", "--list-tags", "--json"]);

    expect(writeStdoutMock).toHaveBeenCalledWith(
      JSON.stringify({ tags: runtimeInfo.tags }, null, 2),
    );
  });

  it("prints a fallback message when no tags are configured", async () => {
    getJsonMock.mockResolvedValue({ ...runtimeInfo, tags: [] });

    await parseCli(["slots", "--session", "api-1", "--list-tags"]);

    expect(writeStdoutMock).toHaveBeenCalledWith("No tags configured.");
  });
});
