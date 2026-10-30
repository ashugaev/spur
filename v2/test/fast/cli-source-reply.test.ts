import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const postJsonMock = vi.fn();
const getExistingJsonMock = vi.fn();
const ensureInstanceConfigMock = vi.fn(() => ({
  configPath: "/tmp/spur.yaml",
  initialized: false,
}));
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
  getExistingJson: getExistingJsonMock,
  listProjects: vi.fn(),
  postJson: postJsonMock,
  postPreflight: vi.fn(),
  restartDaemonIfRunning: vi.fn(),
  stopDaemonIfRunning: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  defaultVoiceModelPath: vi.fn(),
  createProjectConfigScaffold: vi.fn(),
  ensureInstanceConfig: ensureInstanceConfigMock,
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
  // The first `import("../../src/cli.js")` pays a multi-second cold start that
  // otherwise lands inside one case's timeout and flakes under runner load.
  beforeAll(async () => {
    await import("../../src/cli.js");
  });

  beforeEach(() => {
    vi.resetModules();
    postJsonMock.mockReset().mockResolvedValue(replyResponse());
    writeStdoutMock.mockReset();
    getExistingJsonMock.mockReset();
    ensureInstanceConfigMock.mockClear();
    process.env["SPUR_SESSION"] = "api-1";
  });

  afterEach(() => {
    delete process.env["SPUR_SESSION"];
    vi.restoreAllMocks();
  });

  it.each([false, true])("source info reads current or explicit session: %s", async (explicit) => {
    const result = {
      sessionId: "api-1",
      source: "telegram",
      projectId: "api",
      sourceId: "chat",
      chatId: -1001,
      messageThreadId: 22,
      bot: { id: 44, username: "testbot" },
    };
    getExistingJsonMock.mockResolvedValue(result);
    await parseSourceReply([
      "--config",
      "/tmp/existing.yaml",
      "source",
      "info",
      ...(explicit ? ["--session", "api-2", "--json"] : []),
    ]);
    expect(getExistingJsonMock).toHaveBeenCalledWith(
      `/sessions/${explicit ? "api-2" : "api-1"}/source-info`,
      "/tmp/existing.yaml",
    );
    expect(ensureInstanceConfigMock).not.toHaveBeenCalled();
    expect(postJsonMock).not.toHaveBeenCalled();
    expect(writeStdoutMock).toHaveBeenCalledWith(
      explicit
        ? JSON.stringify(result, null, 2)
        : "Telegram api/chat: chat -1001, topic 22; bot @testbot (44).",
    );
  });

  it.each([null, { id: 44 }])("source info renders unavailable or unnamed bot: %s", async (bot) => {
    getExistingJsonMock.mockResolvedValue({
      sessionId: "api-1",
      source: "telegram",
      projectId: "api",
      sourceId: "chat",
      chatId: 42,
      bot,
    });
    await parseSourceReply(["source", "info"]);
    expect(writeStdoutMock).toHaveBeenCalledWith(
      `Telegram api/chat: chat 42; bot ${bot ? "(44)" : "identity unavailable"}.`,
    );
  });

  it("source info renders absent association and requires a session", async () => {
    getExistingJsonMock.mockResolvedValue({ sessionId: "api-1", source: null });
    await parseSourceReply(["source", "info"]);
    expect(writeStdoutMock).toHaveBeenCalledWith("No source association for api-1.");
    delete process.env["SPUR_SESSION"];
    await expect(parseSourceReply(["source", "info"])).rejects.toThrow(
      "source info requires --session or SPUR_SESSION",
    );
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

  it("sends a semantic proposal without manufacturing approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-interface-cli-"));
    const path = join(directory, "manifest.json");
    const manifest = { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] };
    try {
      await writeFile(path, JSON.stringify(manifest));
      await parseSourceReply([
        "source",
        "reply",
        "Review interface",
        "--request-interface-approval",
        path,
        "--json",
      ]);
      expect(postJsonMock).toHaveBeenCalledWith(
        "/tmp/dist/cli.js",
        "/sessions/api-1/source-reply",
        { message: "Review interface", requestInterfaceApproval: manifest },
        "/tmp/spur.yaml",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it("posts repeated --image files as base64 with their base names next to the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spur-image-cli-"));
    const manifestPath = join(directory, "manifest.json");
    const manifest = { version: 1, repository: "owner/repo", baseBranch: "main", surfaces: [] };
    const first = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const second = Buffer.from([0xff, 0xd8, 0xff]);
    try {
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(directory, "a.png"), first);
      await writeFile(join(directory, "b.jpg"), second);
      await parseSourceReply([
        "source",
        "reply",
        "Review",
        "--image",
        join(directory, "a.png"),
        "--image",
        join(directory, "b.jpg"),
        "--request-interface-approval",
        manifestPath,
        "--json",
      ]);
      expect(postJsonMock).toHaveBeenCalledWith(
        "/tmp/dist/cli.js",
        "/sessions/api-1/source-reply",
        {
          message: "Review",
          requestInterfaceApproval: manifest,
          images: [
            { name: "a.png", data: first.toString("base64") },
            { name: "b.jpg", data: second.toString("base64") },
          ],
        },
        "/tmp/spur.yaml",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails before posting when an --image file is missing", async () => {
    await expect(
      parseSourceReply(["source", "reply", "look", "--image", "/nonexistent/spur-shot.png"]),
    ).rejects.toThrow("ENOENT");
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("reports the image count in the human-readable line", async () => {
    postJsonMock.mockResolvedValue({ ...replyResponse(2), images: 3 });

    await parseSourceReply(["source", "reply", "pick", "--button", "Yes", "--button", "No"]);

    expect(writeStdoutMock.mock.calls.flat().join("")).toContain(
      "Sent telegram reply for api-1 with 2 button(s) and 3 image(s).",
    );
  });
});
