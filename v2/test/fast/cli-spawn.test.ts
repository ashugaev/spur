import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const postJsonMock = vi.fn();
const getJsonMock = vi.fn();
const patchJsonMock = vi.fn();
const postPreflightMock = vi.fn();
const stdinText = vi.hoisted(() => ({ value: "" }));
const listProjectsMock = vi.fn();
const writeStdoutMock = vi.fn();
const writeStderrMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: listProjectsMock,
  patchJson: patchJsonMock,
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
  writeStderr: writeStderrMock,
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
    getJsonMock.mockReset().mockResolvedValue({ accounts: [], pools: {} });
    patchJsonMock.mockReset();
    listProjectsMock.mockReset().mockResolvedValue([{ id: "api" }]);
    writeStdoutMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pins the saved authorization profile requested by an agent", async () => {
    await parseCli([
      "spawn",
      "api",
      "ship it",
      "--agent",
      "codex",
      "--auth-account",
      "saved-work",
      "--json",
    ]);
    expect(postJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/sessions",
      expect.objectContaining({ agent: "codex", authAccountId: "saved-work" }),
      "/tmp/spur.yaml",
    );
  });

  it("discovers provider account IDs through the selected instance", async () => {
    await parseCli(["auth", "accounts", "--agent", "codex", "--json"]);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/auth-accounts?agent=codex",
      "/tmp/spur.yaml",
    );
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("starts profile sign-in without waiting in JSON mode", async () => {
    postJsonMock.mockResolvedValue({ accountId: "saved-work", status: "pending" });
    await parseCli(["auth", "login", "saved-work", "--json"]);
    expect(postJsonMock).toHaveBeenCalledExactlyOnceWith(
      "/tmp/dist/cli.js",
      "/auth-accounts/saved-work/login",
      {},
      "/tmp/spur.yaml",
    );
    expect(getJsonMock).not.toHaveBeenCalled();
  });

  it("adds a Codex profile and starts its sign-in", async () => {
    postJsonMock
      .mockResolvedValueOnce({ account: { id: "new-work", provider: "codex" } })
      .mockResolvedValueOnce({ accountId: "new-work", status: "pending", url: "https://login" });
    await parseCli(["auth", "add", "--agent", "codex", "--json"]);
    expect(postJsonMock.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ["/auth-accounts", { provider: "codex" }],
      ["/auth-accounts/new-work/login", {}],
    ]);
  });

  it("rejects the removed --label option", async () => {
    await expect(
      parseCli(["auth", "add", "--agent", "codex", "--label", "Work", "--json"]),
    ).rejects.toThrow();
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("prints the display name and LEFT column for each account", async () => {
    const reset = new Date(2026, 10, 16, 16, 20).toISOString();
    const base = { provider: "claude", status: "ready", limited: false };
    getJsonMock.mockResolvedValue({
      accounts: [
        {
          ...base,
          id: "a",
          displayName: "alek@x.com",
          quota: { leftPercent: 62, resetsAt: null, windows: [], fetchedAt: reset },
        },
        { ...base, id: "b", displayName: "alek@y.com", limited: true, cooldownUntil: reset },
        { ...base, id: "c", displayName: "API key ····7Q2c" },
      ],
    });
    await parseCli(["auth", "accounts"]);
    expect(writeStdoutMock.mock.calls.map((call) => call[0])).toEqual([
      "a\tclaude\talek@x.com\tready\t62%",
      "b\tclaude\talek@y.com\tready\t0% 16:20",
      "c\tclaude\tAPI key ····7Q2c\tready\t",
    ]);
  });

  it("prints the accounts response unchanged with --json", async () => {
    const response = { accounts: [{ id: "a", displayName: "x", identity: { email: "x" } }] };
    getJsonMock.mockResolvedValue(response);
    await parseCli(["auth", "accounts", "--json"]);
    expect(writeStdoutMock).toHaveBeenCalledWith(expect.stringContaining('"displayName": "x"'));
  });

  it("rejects an unknown provider before creating a profile", async () => {
    await expect(parseCli(["auth", "add", "--agent", "cursor", "--json"])).rejects.toThrow();
    expect(postJsonMock).not.toHaveBeenCalled();
  });

  it("shows a pool without flags and patches it with flags", async () => {
    getJsonMock.mockResolvedValue({
      accounts: [],
      pools: { codex: { defaultAccountId: "a", defaultGeneration: 0, autoRotate: true } },
    });
    await parseCli(["auth", "pool", "codex"]);
    expect(getJsonMock).toHaveBeenCalledWith(
      "/tmp/dist/cli.js",
      "/auth-accounts?agent=codex",
      "/tmp/spur.yaml",
    );
    expect(writeStdoutMock).toHaveBeenCalledWith("codex\tdefault=a\tauto-rotate=on");
    expect(patchJsonMock).not.toHaveBeenCalled();
    patchJsonMock.mockResolvedValue({
      pool: { defaultAccountId: "b", defaultGeneration: 1, autoRotate: false },
    });
    await parseCli(["auth", "pool", "claude", "--auto-rotate", "off", "--default", "b"]);
    expect(patchJsonMock).toHaveBeenCalledExactlyOnceWith(
      "/tmp/dist/cli.js",
      "/auth-pools/claude",
      { autoRotate: false, defaultAccountId: "b" },
      "/tmp/spur.yaml",
    );
    patchJsonMock.mockClear();
    await parseCli(["auth", "pool", "claude", "--default", "b", "--apply-to-active"]);
    expect(patchJsonMock).toHaveBeenCalledExactlyOnceWith(
      "/tmp/dist/cli.js",
      "/auth-pools/claude",
      { defaultAccountId: "b", applyToActive: true },
      "/tmp/spur.yaml",
    );
    await expect(parseCli(["auth", "pool", "claude", "--apply-to-active"])).rejects.toThrow(
      "--apply-to-active requires --default",
    );
    await expect(parseCli(["auth", "pool", "claude", "--auto-rotate", "maybe"])).rejects.toThrow(
      "--auto-rotate must be on or off",
    );
  });

  it("prints a --json command failure as a JSON error body", async () => {
    patchJsonMock.mockRejectedValue(new Error("Default authorization account must be ready"));
    writeStderrMock.mockReset();
    const { run } = await import("../../src/cli.js");
    await run(["node", "/tmp/dist/cli.js", "auth", "pool", "claude", "--default", "bad", "--json"]);
    expect(writeStderrMock).toHaveBeenCalledExactlyOnceWith(
      '{"error":"Default authorization account must be ready"}\n',
    );
    expect(writeStdoutMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cancels the pending sign-in when the CLI receives %s",
    async (signal) => {
      postJsonMock.mockResolvedValue({
        accountId: "work",
        status: "pending",
        url: "https://login",
      });
      getJsonMock.mockResolvedValue({ accountId: "work", status: "pending" });
      const inherited = process.listeners(signal);
      process.removeAllListeners(signal);
      try {
        const login = parseCli(["auth", "login", "work"]);
        await vi.waitFor(() => expect(process.listenerCount(signal)).toBe(1));
        process.emit(signal, signal);
        await expect(login).rejects.toThrow();
        expect(process.listenerCount(signal)).toBe(0);
      } finally {
        for (const listener of inherited) process.on(signal, listener);
      }
      expect(postJsonMock).toHaveBeenLastCalledWith(
        "/tmp/dist/cli.js",
        "/auth-accounts/work/login-input",
        { cancel: true },
        "/tmp/spur.yaml",
      );
    },
  );

  it("switches a session to a profile or back to Auto", async () => {
    postJsonMock.mockResolvedValue({
      id: "api-1",
      auth: { mode: "auto", effectiveAccountId: "a" },
    });
    await parseCli(["auth", "switch", "api-1", "work"]);
    await parseCli(["auth", "switch", "api-1", "auto"]);
    expect(postJsonMock.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ["/sessions/api-1/switch-auth", { accountId: "work" }],
      ["/sessions/api-1/switch-auth", { accountId: null }],
    ]);
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
