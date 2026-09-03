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

async function parseSourceReply(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

function replyResponse(buttons?: number) {
  return {
    ok: true,
    source: "telegram",
    sessionId: "api-1",
    projectId: "api",
    sourceId: "tg",
    chatId: -1001,
    ...(buttons !== undefined ? { buttons } : {}),
  };
}

describe("source reply CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock.mockReset().mockResolvedValue(replyResponse());
    writeStdoutMock.mockReset();
    process.env["SPUR_SESSION"] = "api-1";
  });

  afterEach(() => {
    delete process.env["SPUR_SESSION"];
    vi.restoreAllMocks();
  });

  it("posts the message with no buttons field when none are passed", async () => {
    await parseSourceReply(["source", "reply", "all", "green", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/source-reply",
      { message: "all green" },
      "/tmp/spur.yaml",
    );
  });

  it("maps repeated --button flags to labels and values", async () => {
    postJsonMock.mockResolvedValue(replyResponse(2));

    await parseSourceReply([
      "source",
      "reply",
      "Deploy now?",
      "--button",
      "Yes",
      "--button",
      "Later=wait for me",
      "--json",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/source-reply",
      {
        message: "Deploy now?",
        buttons: [
          { text: "Yes", value: "Yes" },
          { text: "Later", value: "wait for me" },
        ],
      },
      "/tmp/spur.yaml",
    );
  });

  it("rejects a --button with an empty label or value", async () => {
    await expect(
      parseSourceReply(["source", "reply", "pick", "--button", "=yes", "--json"]),
    ).rejects.toThrow("--button takes <label> or <label>=<value>");
    await expect(
      parseSourceReply(["source", "reply", "pick", "--button", "Yes=", "--json"]),
    ).rejects.toThrow("--button takes <label> or <label>=<value>");
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("reports the button count in the human-readable line", async () => {
    postJsonMock.mockResolvedValue(replyResponse(2));

    await parseSourceReply(["source", "reply", "pick", "--button", "Yes", "--button", "No"]);

    expect(writeStdoutMock.mock.calls.flat().join("")).toContain(
      "Sent telegram reply for api-1 with 2 button(s).",
    );
  });
});
