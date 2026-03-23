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

  it("stops a running daemon without auto-starting it", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockRejectedValueOnce(new Error("daemon stopped"));

    const { stopDaemonIfRunning } = await loadClientModule();
    const result = await stopDaemonIfRunning("/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      pid: 4242,
      stopped: true,
    });
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps stop as a no-op when the daemon is already unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const { stopDaemonIfRunning } = await loadClientModule();
    const result = await stopDaemonIfRunning("/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      stopped: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps stop as a no-op for an incompatible endpoint without a Spur runtime pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ pid: 7777 }), { status: 200 }),
    );

    const { stopDaemonIfRunning } = await loadClientModule();
    const result = await stopDaemonIfRunning("/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      stopped: false,
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("restarts a running daemon without using ensureServer as a stop path", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockRejectedValueOnce(new Error("daemon stopped"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runtimeInfo(undefined, 8888)), { status: 200 }),
      );

    const { restartDaemonIfRunning } = await loadClientModule();
    const result = await restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      previousPid: 4242,
      restarted: true,
      runtime: runtimeInfo(undefined, 8888),
    });
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/dist/cli.js", "--config", "/tmp/spur.yaml", "daemon", "start"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  });

  it("waits through an extended starting window after restart", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockRejectedValueOnce(new Error("daemon stopped"));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Daemon is starting" }), { status: 503 }),
      );
    }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(runtimeInfo(undefined, 8888)), { status: 200 }),
    );

    const { restartDaemonIfRunning } = await loadClientModule();
    const result = await restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      previousPid: 4242,
      restarted: true,
      runtime: runtimeInfo(undefined, 8888),
    });
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps restart as a no-op when the daemon is not running", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const { restartDaemonIfRunning } = await loadClientModule();
    const result = await restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      restarted: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("keeps restart as a no-op for an incompatible endpoint without a Spur runtime pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ pid: 7777 }), { status: 200 }),
    );

    const { restartDaemonIfRunning } = await loadClientModule();
    const result = await restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result).toEqual({
      baseUrl: "http://127.0.0.1:4310",
      restarted: false,
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
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
