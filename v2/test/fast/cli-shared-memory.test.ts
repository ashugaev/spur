import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJsonMock = vi.fn();
const postJsonMock = vi.fn();
const deleteJsonMock = vi.fn();
const writeStdoutMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  deleteJson: deleteJsonMock,
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

async function parseMemory(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

let tempDir: string;

describe("shared memory CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    getJsonMock.mockReset();
    postJsonMock.mockReset();
    deleteJsonMock.mockReset();
    writeStdoutMock.mockReset();
    setTmuxSocketNameMock.mockReset();
    delete process.env["SPUR_SESSION"];
    tempDir = mkdtempSync(join(tmpdir(), "spur-cli-shared-memory-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["SPUR_SESSION"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists with the exact route and scope passthrough", async () => {
    getJsonMock.mockResolvedValue({ scope: "task", keys: [] });

    await parseMemory(["memory", "list", "--scope", "task", "--session", "api-1", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/shared-memory/task",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith(
      JSON.stringify({ scope: "task", keys: [] }, null, 2),
    );
  });

  it("resolves the session id from SPUR_SESSION when --session is absent", async () => {
    process.env["SPUR_SESSION"] = "env-session";
    getJsonMock.mockResolvedValue({ scope: "project", keys: [] });

    await parseMemory(["memory", "list", "--scope", "project", "--json"]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/env-session/shared-memory/project",
      "/tmp/spur.yaml",
    );
  });

  it("errors when neither --session nor SPUR_SESSION is present", async () => {
    await expect(parseMemory(["memory", "list", "--scope", "global", "--json"])).rejects.toThrow(
      /--session or SPUR_SESSION/,
    );
    expect(getJsonMock).not.toHaveBeenCalled();
  });

  it("gets a key with exact route", async () => {
    getJsonMock.mockResolvedValue({
      scope: "global",
      entry: { key: "preference.style", body: "caveman prose" },
    });

    await parseMemory([
      "memory",
      "get",
      "preference.style",
      "--scope",
      "global",
      "--session",
      "api-1",
      "--json",
    ]);

    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/shared-memory/global/preference.style",
      "/tmp/spur.yaml",
    );
  });

  it("sets a key from the body argument with exact route and payload", async () => {
    postJsonMock.mockResolvedValue({
      scope: "task",
      entry: { key: "decision.api", body: "Use HTTP API" },
    });

    await parseMemory([
      "memory",
      "set",
      "decision.api",
      "Use HTTP API",
      "--scope",
      "task",
      "--session",
      "api-1",
      "--json",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/shared-memory/task/decision.api",
      { body: "Use HTTP API" },
      "/tmp/spur.yaml",
    );
  });

  it("sets a key from --file", async () => {
    postJsonMock.mockResolvedValue({
      scope: "project",
      entry: { key: "gotcha.env", body: "multi\nline\n" },
    });
    const filePath = join(tempDir, "body.md");
    writeFileSync(filePath, "multi\nline\n", "utf-8");

    await parseMemory([
      "memory",
      "set",
      "gotcha.env",
      "--scope",
      "project",
      "--session",
      "api-1",
      "--file",
      filePath,
      "--json",
    ]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/shared-memory/project/gotcha.env",
      { body: "multi\nline\n" },
      "/tmp/spur.yaml",
    );
  });

  it("errors when set gets both a body argument and --file", async () => {
    const filePath = join(tempDir, "body.md");
    writeFileSync(filePath, "body", "utf-8");

    await expect(
      parseMemory([
        "memory",
        "set",
        "decision.api",
        "inline body",
        "--scope",
        "task",
        "--session",
        "api-1",
        "--file",
        filePath,
      ]),
    ).rejects.toThrow(/not both/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("errors when set gets neither a body argument nor --file", async () => {
    await expect(
      parseMemory(["memory", "set", "decision.api", "--scope", "task", "--session", "api-1"]),
    ).rejects.toThrow(/body argument or --file/);
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("removes a key with the exact route via DELETE", async () => {
    deleteJsonMock.mockResolvedValue({ scope: "task", key: "decision.api" });

    await parseMemory([
      "memory",
      "rm",
      "decision.api",
      "--scope",
      "task",
      "--session",
      "api-1",
      "--json",
    ]);

    expect(deleteJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions/api-1/shared-memory/task/decision.api",
      "/tmp/spur.yaml",
    );
  });

  it("rejects an invalid --scope with a CLI-quality message", async () => {
    await expect(
      parseMemory(["memory", "list", "--scope", "bogus", "--session", "api-1", "--json"]),
    ).rejects.toThrow(/--scope must be task, project, or global/);
    expect(getJsonMock).not.toHaveBeenCalled();
  });

  it("prints exactly one line for a non-json remove, no redundant scope line", async () => {
    deleteJsonMock.mockResolvedValue({ scope: "task", key: "decision.api" });

    await parseMemory(["memory", "rm", "decision.api", "--scope", "task", "--session", "api-1"]);

    expect(writeStdoutMock).toHaveBeenCalledTimes(1);
    expect(writeStdoutMock).toHaveBeenCalledWith("Removed decision.api.");
  });

  it("registers a memory command", async () => {
    const { createProgram } = await import("../../src/cli.js");

    expect(
      createProgram("/tmp/dist/cli.js").commands.some((command) => command.name() === "memory"),
    ).toBe(true);
  });
});
