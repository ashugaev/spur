import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const postJsonMock = vi.fn();
const postPreflightMock = vi.fn();
const stdinText = vi.hoisted(() => ({ value: "" }));
const listProjectsMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
  listProjects: listProjectsMock,
  postJson: postJsonMock,
  postPreflight: postPreflightMock,
  restartDaemonIfRunning: vi.fn(),
  stopDaemonIfRunning: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
    path === 0
      ? stdinText.value
      : (actual.readFileSync as (...args: unknown[]) => unknown)(
          path,
          ...rest,
        )) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

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

const cardView = {
  id: "api-1",
  agent: "claude",
  project: "api",
  branch: "api-1",
  status: "running",
  state: "working",
  services: [],
  sidecars: [],
  worktree: false,
};

describe("spawn", () => {
  beforeEach(() => {
    vi.resetModules();
    postJsonMock
      .mockReset()
      .mockResolvedValue({ id: "api-1", agent: "claude", status: "spawning" });
    listProjectsMock.mockReset().mockResolvedValue([{ id: "api" }]);
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the requested mode to the spawn endpoint", async () => {
    await parseCli(["spawn", "api", "ship it", "--mode", "council", "--json"]);

    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions",
      expect.objectContaining({ project: "api", prompt: "ship it", mode: "council" }),
      "/tmp/spur.yaml",
    );
  });

  it("omits mode from the spawn body when not provided", async () => {
    await parseCli(["spawn", "api", "ship it", "--json"]);

    const body = postJsonMock.mock.calls[0]?.[2];
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("reasoningEffort");
  });

  it("posts explicit reasoning effort", async () => {
    await parseCli(["spawn", "api", "ship it", "--reasoning-effort", "ultra", "--json"]);
    expect(postJsonMock.mock.calls[0]?.[2]).toMatchObject({ reasoningEffort: "ultra" });
  });

  it("rejects unknown reasoning effort before a request", async () => {
    const { createProgram } = await import("../../src/cli.js");
    const program = createProgram("/tmp/dist/cli.js").exitOverride();
    program.commands.find((command) => command.name() === "spawn")?.exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync([
        "node",
        "spur",
        "spawn",
        "api",
        "--reasoning-effort",
        "invalid",
        "--json",
      ]),
    ).rejects.toThrow("Allowed choices");
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("posts normalized --link values as initial slots links", async () => {
    await parseCli(["spawn", "api", "x", "--link", "Board-Task=https://example.com/t/1", "--json"]);
    expect(postJsonMock.mock.calls[0]?.[2]).toMatchObject({
      slots: { links: [{ label: "board-task", url: "https://example.com/t/1" }] },
    });
  });

  it("omits slots when no --link is given", async () => {
    await parseCli(["spawn", "api", "x", "--json"]);
    expect(postJsonMock.mock.calls[0]?.[2]).not.toHaveProperty("slots");
  });

  it("refuses a repeated --link label before a request", async () => {
    await expect(
      parseCli([
        "spawn",
        "api",
        "x",
        "--link",
        "board-task=https://example.com/a",
        "--link",
        "Board-Task=https://example.com/b",
        "--json",
      ]),
    ).rejects.toThrow("--link label repeated: board-task");
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("reads --prompt-file - from stdin", async () => {
    stdinText.value = "ship from stdin\n";
    await parseCli(["spawn", "api", "--prompt-file", "-", "--json"]);
    expect(postJsonMock.mock.calls[0]?.[2]).toMatchObject({ prompt: "ship from stdin" });
  });

  it("reads --prompt-file <path>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spur-cli-spawn-"));
    try {
      const file = join(dir, "prompt.md");
      writeFileSync(file, "  from a file\n");
      await parseCli(["spawn", "api", "--prompt-file", file, "--json"]);
      expect(postJsonMock.mock.calls[0]?.[2]).toMatchObject({ prompt: "from a file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses --prompt-file with a positional prompt", async () => {
    await expect(
      parseCli(["spawn", "api", "ship it", "--prompt-file", "-", "--json"]),
    ).rejects.toThrow("use either [prompt...] or --prompt-file");
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("sends --idempotency-key, skips the branch prompt and prints the replay line", async () => {
    postJsonMock.mockResolvedValue({ ...cardView, replayed: true });
    const streams = [process.stdin, process.stdout];
    const originals = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
    for (const stream of streams) {
      Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    }
    try {
      await parseCli(["spawn", "api", "ship it", "--idempotency-key", "k"]);
    } finally {
      streams.forEach((stream, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(stream, "isTTY", original);
        else Reflect.deleteProperty(stream, "isTTY");
      });
    }
    expect(postPreflightMock).not.toHaveBeenCalled();
    expect(postJsonMock.mock.calls[0]?.[2]).toMatchObject({ idempotencyKey: "k" });
    expect(writeStdoutMock.mock.calls.flat().join("\n")).toContain(
      "existing session api-1 (same idempotency key)",
    );
  });

  it("omits idempotencyKey and the replay line by default", async () => {
    postJsonMock.mockResolvedValue(cardView);
    await parseCli(["spawn", "api", "ship it"]);
    expect(postJsonMock.mock.calls[0]?.[2]).not.toHaveProperty("idempotencyKey");
    expect(writeStdoutMock.mock.calls.flat().join("\n")).not.toContain("idempotency key");
  });
});
