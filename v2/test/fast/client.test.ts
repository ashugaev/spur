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
    version: "0.1.0",
    pid,
    host: "127.0.0.1",
    port: 4310,
    dataDir: "/tmp/data",
    worktreeDir: "/tmp/worktrees",
    configPath: "/tmp/spur.yaml",
    tmuxSocketName: "spur",
    uiPort: 4311,
    startedAt: "2026-03-18T10:00:00.000Z",
  };
}

async function loadClientModule() {
  vi.resetModules();
  return import("../../src/client.js");
}

describe("client.ensureServer", () => {
  beforeEach(() => {
    vi.stubEnv("SPUR_DISABLE_AUTOSTART", undefined);
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
    vi.unstubAllEnvs();
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

  it("replaces a pre-version-field daemon (no version in /info)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { version: _dropped, ...oldDaemonInfo } = runtimeInfo(SPUR_DAEMON_API_VERSION - 1, 7777);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(oldDaemonInfo), { status: 200 }))
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

  it("restarts a running daemon and waits for external restart first", async () => {
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
    // Should NOT spawn — external manager (e.g. systemd) restarted the daemon
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls back to spawnDaemon after a short external restart grace period", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fetchMock = vi.mocked(fetch);
    // Probe: running daemon
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));
    // waitUntilDaemonPidChanges: daemon stopped
    fetchMock.mockRejectedValueOnce(new Error("daemon stopped"));
    // First waitForReadyDaemon: external restart grace period expires without a daemon
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fetchMock.mockRejectedValueOnce(new Error("still down"));
    }
    // Second waitForReadyDaemon (after spawnDaemon): daemon comes up
    fetchMock
      .mockRejectedValueOnce(new Error("starting"))
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

  it("refuses to auto-start the daemon when SPUR_DISABLE_AUTOSTART=1", async () => {
    vi.stubEnv("SPUR_DISABLE_AUTOSTART", "1");
    vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { ensureServer } = await loadClientModule();
    await expect(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml")).rejects.toThrow(
      /SPUR_DISABLE_AUTOSTART/,
    );
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

  it("formats sidecar port conflicts with clear-port guidance", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "sidecar_port_busy",
            sidecarName: "dev",
            candidates: [
              {
                portId: "http",
                env: "SPUR_RESERVED_PORT_DEV",
                port: 3000,
              },
            ],
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/test/sidecars/dev/start", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow("Sidecar dev port busy (http:3000). Retry with --clear-port <port>.");
  });

  it("formats open pull request action errors with retry commands", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "open_pr_action_required",
            sessionId: "api-1",
            pr: {
              number: 42,
              title: "Fix checkout",
              url: "https://github.com/acme/api/pull/42",
            },
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/complete", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "Open pull request action required for api-1: https://github.com/acme/api/pull/42. Retry `spur complete api-1 --pr-action leave_open` to keep it open or `spur complete api-1 --pr-action close` to close it.",
    );
  });
});
