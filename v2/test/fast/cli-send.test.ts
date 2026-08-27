import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/types.js";

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

async function parseSend(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

function baseSession(overrides: Partial<SessionView> = {}): SessionView {
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
    ...overrides,
  };
}

function outputText(): string {
  return writeStdoutMock.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("send CLI", () => {
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

  it("prints the queued line with the exact pending count for N=1 (A1 shape)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({ queuedMessages: { messages: ["hello"], awaitingPrompt: false } }),
    );

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Queued message for api-1 (1 pending).");
  });

  it("prints the queued line with the exact pending count for N=2 (A1)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({ queuedMessages: { messages: ["hello", "world"], awaitingPrompt: false } }),
    );

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Queued message for api-1 (2 pending).");
  });

  it("prints the delivered line when queuedMessages is absent (A2)", async () => {
    postJsonMock.mockResolvedValue(baseSession());

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Delivered message to api-1.");
  });

  it("prints the delivered line, not a pending count, when only pipelineMessages is set (A3)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({
        queuedMessages: { messages: [], awaitingPrompt: false, pipelineMessages: ["auto-step"] },
      }),
    );

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Delivered message to api-1.");
    expect(outputText()).not.toContain("pending");
  });

  it("prints no success line and posts an unchanged body under --json (A4, regression guard)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({ queuedMessages: { messages: ["hello"], awaitingPrompt: false } }),
    );

    await parseSend(["send", "api-1", "hello", "--json"]);

    expect(writeStdoutMock).not.toHaveBeenCalledWith(expect.stringContaining("Delivered"));
    expect(writeStdoutMock).not.toHaveBeenCalledWith(expect.stringContaining("Queued message"));
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/send",
      { message: "hello" },
      "/tmp/spur.yaml",
    );
  });

  it("prints the delivered line for the real post-delivery shape {messages: [], awaitingPrompt: true} (A9)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({ queuedMessages: { messages: [], awaitingPrompt: true } }),
    );

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Delivered message to api-1.");
    expect(outputText()).not.toContain("pending");
  });

  it("prints the queued line for a queue held while the agent is mid-turn (A12)", async () => {
    postJsonMock.mockResolvedValue(
      baseSession({ queuedMessages: { messages: ["a", "b"], awaitingPrompt: true } }),
    );

    await parseSend(["send", "api-1", "hello"]);

    expect(outputText()).toContain("Queued message for api-1 (2 pending).");
  });
});
