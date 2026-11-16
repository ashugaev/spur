import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  TmuxProbeUnknownError: (await importOriginal<typeof RuntimeTmuxModule>()).TmuxProbeUnknownError,
  setTmuxSocketName: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

const handedOff = {
  id: "api-2",
  agent: "codex",
  project: "api",
  branch: "api-1",
  status: "spawning",
  state: "working",
  services: [],
  sidecars: [],
  worktree: false,
};

describe("handoff", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock.mockReset().mockResolvedValue({ id: "api-2", agent: "codex", status: "spawning" });
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the requested target agent to the handoff endpoint", async () => {
    await parseCli(["handoff", "api-1", "--agent", "codex", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/handoff",
      { agent: "codex" },
      "/tmp/spur.yaml",
    );
  });

  it("includes model and notes when provided", async () => {
    await parseCli([
      "handoff",
      "api-1",
      "--agent",
      "cursor",
      "--model",
      "composer-2.5",
      "--notes",
      "focus on tests",
      "--reasoning-effort",
      "high",
      "--json",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/handoff",
      { agent: "cursor", model: "composer-2.5", notes: "focus on tests", reasoningEffort: "high" },
      "/tmp/spur.yaml",
    );
  });

  it("prints the moved ToDo count", async () => {
    postJsonMock.mockResolvedValue({ ...handedOff, movedTodoItems: 2 });
    await parseCli(["handoff", "api-1", "--agent", "codex"]);
    expect(writeStdoutMock).toHaveBeenCalledWith(
      expect.stringContaining("Handed off to api-2 (codex); moved 2 ToDo items."),
    );
  });

  it("prints the plain line when the daemon omits the count", async () => {
    postJsonMock.mockResolvedValue(handedOff);
    await parseCli(["handoff", "api-1", "--agent", "codex"]);
    const output = writeStdoutMock.mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain("Handed off to api-2 (codex).");
    expect(output).not.toContain("ToDo items");
  });

  it("posts respawn effort while preserving force", async () => {
    await parseCli(["respawn", "api-1", "--reasoning-effort", "max", "--force", "--json"]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/respawn",
      expect.objectContaining({ reasoningEffort: "max", forceKillSource: true }),
      "/tmp/spur.yaml",
    );
  });

  it("omits respawn effort when not selected", async () => {
    await parseCli(["respawn", "api-1", "--json"]);
    expect(postJsonMock.mock.calls[0]?.[2]).not.toHaveProperty("reasoningEffort");
  });
});
