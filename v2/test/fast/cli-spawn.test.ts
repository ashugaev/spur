import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

const postJsonMock = vi.fn();
const getJsonMock = vi.fn();
const patchJsonMock = vi.fn();
const listProjectsMock = vi.fn();
const writeStdoutMock = vi.fn();

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: getJsonMock,
  listProjects: listProjectsMock,
  patchJson: patchJsonMock,
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
    await parseCli(["auth", "add", "--agent", "codex", "--label", "Work", "--json"]);
    expect(postJsonMock.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ["/auth-accounts", { provider: "codex", label: "Work" }],
      ["/auth-accounts/new-work/login", {}],
    ]);
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
    await expect(parseCli(["auth", "pool", "claude", "--auto-rotate", "maybe"])).rejects.toThrow(
      "--auto-rotate must be on or off",
    );
  });

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
});
