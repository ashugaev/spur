import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";

const spawnMock = vi.fn();
const sleepMock = vi.fn().mockResolvedValue(undefined);
const loadConfigMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: sleepMock,
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: loadConfigMock,
}));

function runtimeInfo(apiVersion = SPUR_DAEMON_API_VERSION, pid = 4242) {
  return {
    ok: true,
    apiVersion,
    pid,
    host: "127.0.0.1",
    port: 4310,
    dataDir: "/tmp/data",
    worktreeDir: "/tmp/worktrees",
    configPath: "/tmp/spur.yaml",
    startedAt: "2026-03-18T10:00:00.000Z",
  };
}

async function loadClientModule() {
  vi.resetModules();
  return import("../../src/client.js");
}

describe("client.ensureServer", () => {
  beforeEach(() => {
    spawnMock.mockReset().mockReturnValue({ unref: vi.fn() });
    sleepMock.mockClear();
    loadConfigMock.mockReset().mockReturnValue({
      configPath: "/tmp/spur.yaml",
      server: { host: "127.0.0.1", port: 4310 },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reuses a compatible daemon without spawning a new one", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(runtimeInfo()), { status: 200 }),
    );

    const { ensureServer } = await loadClientModule();
    const baseUrl = await ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(baseUrl).toBe("http://127.0.0.1:4310");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("auto-starts the daemon when the endpoint is unreachable", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValue(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));

    const { ensureServer } = await loadClientModule();
    const baseUrl = await ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(baseUrl).toBe("http://127.0.0.1:4310");
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/dist/cli.js", "--config", "/tmp/spur.yaml", "daemon", "start"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  });

  it("replaces an incompatible daemon before retrying", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runtimeInfo(SPUR_DAEMON_API_VERSION - 1, 7777)), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new Error("daemon stopped"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValue(
        new Response(JSON.stringify(runtimeInfo(SPUR_DAEMON_API_VERSION, 8888)), { status: 200 }),
      );

    const { ensureServer } = await loadClientModule();
    const baseUrl = await ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(baseUrl).toBe("http://127.0.0.1:4310");
    expect(killSpy).toHaveBeenCalledWith(7777, "SIGTERM");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces server error payloads from JSON requests", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad send" }), { status: 500 }));

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/test/send", { message: "hello" }, "/tmp/spur.yaml"),
    ).rejects.toThrow("bad send");
  });
});
