import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type * as NodeOs from "node:os";
import type * as Config from "../../src/config.js";
import type * as RuntimeTmuxModule from "../../src/runtime-tmux.js";

// Ordinary boots materialize the host pin before serving sessions.
// Matching isolated instances leave the host pin alone.
const callOrder: string[] = [];
const fixtureHome = mkdtempSync(join(tmpdir(), "spur-daemon-pin-"));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => fixtureHome,
}));

const ensureNpmPinFileMock = vi.fn(() => {
  callOrder.push("ensureNpmPinFile");
});

const startServerMock = vi.fn(async () => {
  callOrder.push("startServer");
  return {
    info: () => ({
      baseUrl: "http://127.0.0.1:4310",
      pid: 4242,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  };
});

const writeStderrMock = vi.fn();

const ensureInstanceConfigMock = vi.fn(() => ({
  configPath: "/tmp/spur.yaml",
  initialized: false,
}));

const assertConfigMayUseProdSlotMock = vi.fn();
const restartDaemonIfRunningMock = vi.fn();
const stopDaemonIfRunningMock = vi.fn();
const installHostSkillsForDaemonStartMock = vi.fn(() => []);
const setTmuxSocketNameMock = vi.fn();

vi.mock("../../src/npm-prefix.js", () => ({
  ensureNpmPinFile: ensureNpmPinFileMock,
}));

vi.mock("../../src/server.js", () => ({
  startServer: startServerMock,
}));

vi.mock("../../src/client.js", () => ({
  connectProjectConfig: vi.fn(),
  disconnectProjectConfig: vi.fn(),
  getJson: vi.fn(),
  listProjects: vi.fn(),
  postJson: vi.fn(),
  postPreflight: vi.fn(),
  restartDaemonIfRunning: restartDaemonIfRunningMock,
  stopDaemonIfRunning: stopDaemonIfRunningMock,
}));

vi.mock("../../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Config>()),
  defaultVoiceModelPath: vi.fn(),
  assertConfigMayUseProdSlot: assertConfigMayUseProdSlotMock,
  createProjectConfigScaffold: vi.fn(),
  ensureInstanceConfig: ensureInstanceConfigMock,
  findProjectConfigPath: vi.fn(),
  findProjectConfigPathInDirectory: vi.fn(),
  loadConfig: vi.fn(() => ({
    tmux: { socketName: "spur-test" },
  })),
  loadProjectConfig: vi.fn(),
  writeProjectConfigScaffold: vi.fn(),
}));

vi.mock("../../src/io.js", () => ({
  writeStderr: writeStderrMock,
  writeStdout: vi.fn(),
}));

// D2 safety: this file drives `daemon start` for real, so the real
// installer (which would touch this runner's actual `homedir()`) must never
// run here — mock it wholesale.
vi.mock("../../src/host-skills.js", () => ({
  installHostSkillsForDaemonStart: installHostSkillsForDaemonStartMock,
  renderHostSkillWarnings: vi.fn(() => []),
}));

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  TmuxProbeUnknownError: (await importOriginal<typeof RuntimeTmuxModule>()).TmuxProbeUnknownError,
  setTmuxSocketName: setTmuxSocketNameMock,
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  withTmuxSocketArgs: vi.fn((args: string[]) => args),
}));

async function parseCli(args: string[]): Promise<void> {
  const { createProgram } = await import("../../src/cli.js");
  await createProgram("/tmp/dist/cli.js").parseAsync(["node", "spur", ...args]);
}

describe("spur daemon CLI", () => {
  beforeEach(() => {
    vi.resetModules();
    mkdirSync(join(fixtureHome, ".spur"), { recursive: true });
    writeFileSync(join(fixtureHome, ".spur", "config.yaml"), "{}");
    vi.stubEnv("SPUR_ISOLATED_CONFIG", "");
    callOrder.length = 0;
    ensureNpmPinFileMock.mockClear();
    ensureNpmPinFileMock.mockImplementation(() => {
      callOrder.push("ensureNpmPinFile");
    });
    startServerMock.mockClear();
    writeStderrMock.mockClear();
    ensureInstanceConfigMock.mockClear();
    ensureInstanceConfigMock.mockReturnValue({
      configPath: "/tmp/spur.yaml",
      initialized: false,
    });
    restartDaemonIfRunningMock.mockClear();
    stopDaemonIfRunningMock.mockClear();
    assertConfigMayUseProdSlotMock.mockClear();
    assertConfigMayUseProdSlotMock.mockImplementation(() => {});
    installHostSkillsForDaemonStartMock.mockClear();
    installHostSkillsForDaemonStartMock.mockImplementation(() => []);
    setTmuxSocketNameMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  it("skips the host npm pin for a matching non-default isolated config", async () => {
    const configPath = join(fixtureHome, "isolated.yaml");
    writeFileSync(configPath, "{}");
    ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
    vi.stubEnv("SPUR_ISOLATED_CONFIG", configPath);

    await parseCli(["daemon", "start", "--config", configPath, "--json"]);

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith(configPath);
    expect(ensureInstanceConfigMock).toHaveBeenCalledTimes(1);
    expect(setTmuxSocketNameMock).toHaveBeenCalledExactlyOnceWith("spur-test");
    expect(ensureNpmPinFileMock).not.toHaveBeenCalled();
    expect(installHostSkillsForDaemonStartMock).toHaveBeenCalledOnce();
    expect(startServerMock).toHaveBeenCalledExactlyOnceWith(configPath, expect.any(Object));
    expect(callOrder).toEqual(["startServer"]);
    expect(assertConfigMayUseProdSlotMock.mock.invocationCallOrder[0]).toBeLessThan(
      ensureInstanceConfigMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each(["relative", "symlink"])(
    "recognizes a matching isolated config through a %s marker",
    async (kind) => {
      const configPath = join(fixtureHome, "isolated.yaml");
      writeFileSync(configPath, "{}");
      const alias = join(fixtureHome, "isolated-link.yaml");
      symlinkSync(configPath, alias);
      ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
      vi.stubEnv(
        "SPUR_ISOLATED_CONFIG",
        kind === "relative" ? relative(process.cwd(), configPath) : alias,
      );

      await parseCli(["daemon", "start", "--config", configPath, "--json"]);

      expect(ensureNpmPinFileMock).not.toHaveBeenCalled();
      expect(startServerMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["absent", "empty", "mismatched"])(
    "refreshes the host pin for an ordinary non-default config with an %s marker",
    async (kind) => {
      const configPath = join(fixtureHome, "isolated.yaml");
      writeFileSync(configPath, "{}");
      ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
      vi.stubEnv(
        "SPUR_ISOLATED_CONFIG",
        kind === "absent" ? undefined : kind === "empty" ? "" : join(fixtureHome, "other.yaml"),
      );

      await parseCli(["daemon", "start", "--config", configPath, "--json"]);

      expect(callOrder).toEqual(["ensureNpmPinFile", "startServer"]);
    },
  );

  it.each(["exact", "normalized", "symlink"])(
    "refreshes the default host pin despite a matching %s isolated marker",
    async (kind) => {
      const defaultPath = join(fixtureHome, ".spur", "config.yaml");
      const alias = join(fixtureHome, "default-link.yaml");
      symlinkSync(defaultPath, alias);
      const configPath =
        kind === "exact"
          ? defaultPath
          : kind === "symlink"
            ? alias
            : `${fixtureHome}/.spur/../.spur/config.yaml`;
      ensureInstanceConfigMock.mockReturnValue({ configPath, initialized: false });
      vi.stubEnv("SPUR_ISOLATED_CONFIG", configPath);

      await parseCli(["daemon", "start", "--config", configPath, "--json"]);

      expect(callOrder).toEqual(["ensureNpmPinFile", "startServer"]);
    },
  );

  it("rejects a matching isolated marker that claims the production slot before bootstrap", async () => {
    const configPath = join(fixtureHome, "rogue.yaml");
    vi.stubEnv("SPUR_ISOLATED_CONFIG", configPath);
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("may not bind the production slot");
    });

    await expect(parseCli(["daemon", "start", "--config", configPath, "--json"])).rejects.toThrow(
      "may not bind the production slot",
    );

    expect(ensureInstanceConfigMock).not.toHaveBeenCalled();
    expect(ensureNpmPinFileMock).not.toHaveBeenCalled();
    expect(installHostSkillsForDaemonStartMock).not.toHaveBeenCalled();
    expect(setTmuxSocketNameMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("reports pin and host-skill failures independently and still starts once", async () => {
    ensureNpmPinFileMock.mockImplementation(() => {
      throw new Error("pin denied");
    });
    installHostSkillsForDaemonStartMock.mockImplementation(() => {
      throw new Error("skills denied");
    });

    await parseCli(["daemon", "start", "--json"]);

    expect(writeStderrMock).toHaveBeenCalledWith(expect.stringContaining("pin denied"));
    expect(writeStderrMock).toHaveBeenCalledWith(expect.stringContaining("skills denied"));
    expect(startServerMock).toHaveBeenCalledOnce();
  });

  it("writes the npm pin file before starting the HTTP server", async () => {
    await parseCli(["daemon", "start", "--json"]);

    expect(ensureNpmPinFileMock).toHaveBeenCalledTimes(1);
    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["ensureNpmPinFile", "startServer"]);
  });

  it("exports the resolved config path as SPUR_CONFIG so daemon children inherit it", async () => {
    const previous = process.env["SPUR_CONFIG"];
    delete process.env["SPUR_CONFIG"];
    let seen: string | undefined;
    startServerMock.mockImplementationOnce(async () => {
      seen = process.env["SPUR_CONFIG"];
      return {
        info: () => ({ baseUrl: "http://127.0.0.1:4310", pid: 4242, startedAt: "2026-01-01" }),
      };
    });
    try {
      await parseCli(["daemon", "start", "--json"]);
    } finally {
      if (previous === undefined) delete process.env["SPUR_CONFIG"];
      else process.env["SPUR_CONFIG"] = previous;
    }
    expect(seen).toBe("/tmp/spur.yaml");
  });

  it("reports a pin-file write failure via stderr instead of aborting the boot", async () => {
    ensureNpmPinFileMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await parseCli(["daemon", "start", "--json"]);

    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect(writeStderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to write npm global-prefix pin file: EACCES: permission denied",
      ),
    );
  });

  it("T7a calls installHostSkillsForDaemonStart exactly once with the resolved configPath", async () => {
    await parseCli(["daemon", "start", "--json"]);

    expect(installHostSkillsForDaemonStartMock).toHaveBeenCalledTimes(1);
    expect(installHostSkillsForDaemonStartMock).toHaveBeenCalledWith("/tmp/spur.yaml");
  });

  it("reaches stopDaemonIfRunning for a plain stop with no --config", async () => {
    stopDaemonIfRunningMock.mockResolvedValueOnce({ stopped: true });

    await parseCli(["daemon", "stop", "--json"]);

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith(undefined);
    expect(stopDaemonIfRunningMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when the --config path does not exist and is not the default", async () => {
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("Instance config /tmp/does-not-exist.yaml does not exist.");
    });

    await expect(
      parseCli(["daemon", "start", "--config", "/tmp/does-not-exist.yaml", "--json"]),
    ).rejects.toThrow("does not exist");

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith("/tmp/does-not-exist.yaml");
    expect(ensureInstanceConfigMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("refuses to stop when the --config path does not exist and is not the default", async () => {
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("Instance config /tmp/does-not-exist.yaml does not exist.");
    });

    await expect(
      parseCli(["daemon", "stop", "--config", "/tmp/does-not-exist.yaml", "--json"]),
    ).rejects.toThrow("does not exist");

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith("/tmp/does-not-exist.yaml");
    expect(ensureInstanceConfigMock).not.toHaveBeenCalled();
    expect(stopDaemonIfRunningMock).not.toHaveBeenCalled();
  });

  it("refuses to restart when the --config path does not exist and is not the default", async () => {
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("Instance config /tmp/does-not-exist.yaml does not exist.");
    });

    await expect(
      parseCli(["daemon", "restart", "--config", "/tmp/does-not-exist.yaml", "--json"]),
    ).rejects.toThrow("does not exist");

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith("/tmp/does-not-exist.yaml");
    expect(ensureInstanceConfigMock).not.toHaveBeenCalled();
    expect(restartDaemonIfRunningMock).not.toHaveBeenCalled();
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it("refuses to stop an existing non-default config that claims the prod slot", async () => {
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("Instance config /tmp/rogue.yaml may not bind the production slot.");
    });

    await expect(
      parseCli(["daemon", "stop", "--config", "/tmp/rogue.yaml", "--json"]),
    ).rejects.toThrow("may not bind the production slot");

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith("/tmp/rogue.yaml");
    expect(stopDaemonIfRunningMock).not.toHaveBeenCalled();
  });

  it("refuses to restart an existing non-default config that claims the prod slot", async () => {
    assertConfigMayUseProdSlotMock.mockImplementation(() => {
      throw new Error("Instance config /tmp/rogue.yaml may not bind the production slot.");
    });

    await expect(
      parseCli(["daemon", "restart", "--config", "/tmp/rogue.yaml", "--json"]),
    ).rejects.toThrow("may not bind the production slot");

    expect(assertConfigMayUseProdSlotMock).toHaveBeenCalledWith("/tmp/rogue.yaml");
    expect(restartDaemonIfRunningMock).not.toHaveBeenCalled();
  });
});
