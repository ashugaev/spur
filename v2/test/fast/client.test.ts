import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import type * as Config from "../../src/config.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPUR_DAEMON_API_VERSION } from "../../src/types.js";

const spawnMock = vi.fn();
const sleepMock = vi.fn().mockResolvedValue(undefined);
const loadConfigMock = vi.fn();
const isDefaultInstanceConfigPathMock = vi.fn();
const tempDirs: string[] = [];

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock,
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: sleepMock,
}));

vi.mock("../../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Config>()),
  loadConfig: loadConfigMock,
  isDefaultInstanceConfigPath: isDefaultInstanceConfigPathMock,
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
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    isDefaultInstanceConfigPathMock.mockReset().mockReturnValue(false);
    vi.stubEnv("SPUR_DISABLE_AUTOSTART", undefined);
    vi.stubEnv("SPUR_SESSION", "");
    vi.stubEnv("SPUR_SIDECAR_NAME", "");
    spawnMock.mockReset().mockReturnValue({ unref: vi.fn() });
    sleepMock.mockClear();
    loadConfigMock.mockReset().mockReturnValue({
      configPath: "/tmp/spur.yaml",
      server: { host: "127.0.0.1", port: 4310 },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each(["ready", "http-error", "unreachable", "starting", "incompatible", "absent", "invalid"])(
    "getExistingJson reads %s without lifecycle or config effects",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "spur-existing-client-"));
      tempDirs.push(root);
      const configPath = join(root, "config.yaml");
      if (state !== "absent")
        await writeFile(
          configPath,
          state === "invalid" ? "[invalid" : "server: {host: 127.0.0.1, port: 54321}\n",
        );
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      if (state === "unreachable") vi.mocked(fetch).mockRejectedValue(new Error("offline"));
      else
        vi.mocked(fetch)
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify(runtimeInfo(state === "incompatible" ? -1 : SPUR_DAEMON_API_VERSION)),
              { status: state === "starting" ? 503 : 200 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify(
                state === "http-error"
                  ? { error: "Session not found" }
                  : { sessionId: "api-1", source: null },
              ),
              { status: state === "http-error" ? 404 : 200 },
            ),
          );
      const { getExistingJson } = await loadClientModule();
      if (state === "ready")
        expect(await getExistingJson("/sessions/api-1/source-info", configPath)).toEqual({
          sessionId: "api-1",
          source: null,
        });
      else
        await expect(getExistingJson("/sessions/api-1/source-info", configPath)).rejects.toThrow(
          state === "http-error" ? "Session not found" : undefined,
        );
      expect(spawnMock).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(
            ([url, init]) =>
              typeof url === "string" &&
              (url.endsWith("/info") || url.endsWith("/sessions/api-1/source-info")) &&
              !init?.method,
          ),
      ).toBe(true);
      if (state === "absent" || state === "invalid") expect(fetch).not.toHaveBeenCalled();
    },
  );

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

  it("refuses to signal a daemon whose PID changed after MCP admission", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(runtimeInfo(undefined, 8888)), { status: 200 }),
    );
    const { restartDaemonIfRunning } = await loadClientModule();
    await expect(
      restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml", 4242),
    ).rejects.toThrow("identity changed");
    expect(killSpy).not.toHaveBeenCalled();
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

  it.each([
    ["autostart", false],
    ["restart", false],
    ["autostart", true],
    ["restart", true],
  ] as const)(
    "refuses detached %s when a user unit owns the default instance (XDG=%s)",
    async (reason, xdg) => {
      isDefaultInstanceConfigPathMock.mockReturnValue(true);
      const home = await mkdtemp(join(tmpdir(), "spur-client-managed-unit-"));
      tempDirs.push(home);
      const configHome = join(home, xdg ? "xdg" : ".config");
      if (xdg) vi.stubEnv("XDG_CONFIG_HOME", configHome);
      const unitDir = join(configHome, "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(unitDir, "spur-daemon.service"), "[Service]\n", "utf8");
      const configPath = join(home, ".spur", "config.yaml");
      vi.stubEnv("HOME", home);
      loadConfigMock.mockReturnValue({
        configPath,
        server: { host: "127.0.0.1", port: 4310 },
      });
      vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));
      if (reason === "restart") {
        vi.spyOn(process, "kill").mockReturnValue(true);
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response(JSON.stringify(runtimeInfo()), { status: 200 }),
        );
      }

      const { ensureServer, restartDaemonIfRunning } = await loadClientModule();
      const operation = reason === "restart" ? restartDaemonIfRunning : ensureServer;
      await expect(operation("/tmp/dist/cli.js")).rejects.toThrow(/spur-daemon.service/);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("auto-starts a non-default config even when a user systemd unit exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "spur-client-non-default-unit-"));
    tempDirs.push(home);
    const unitDir = join(home, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    await writeFile(join(unitDir, "spur-daemon.service"), "[Service]\n", "utf8");
    vi.stubEnv("HOME", home);
    loadConfigMock.mockReturnValue({
      configPath: "/tmp/spur-alt.yaml",
      server: { host: "127.0.0.1", port: 4312 },
    });
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValue(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));

    const { ensureServer } = await loadClientModule();
    const baseUrl = await ensureServer("/tmp/dist/cli.js", "/tmp/spur-alt.yaml");

    expect(baseUrl).toBe("http://127.0.0.1:4312");
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/dist/cli.js", "--config", "/tmp/spur-alt.yaml", "daemon", "start"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
  });

  it("refuses implicit auto-start from a session pane and never spawns", async () => {
    vi.stubEnv("SPUR_SESSION", "sess-1");
    vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { ensureServer } = await loadClientModule();
    await expect(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml")).rejects.toThrow(
      /session pane must not fork a daemon/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses implicit auto-start from a sidecar and never spawns", async () => {
    vi.stubEnv("SPUR_SIDECAR_NAME", "isolated-daemon");
    vi.mocked(fetch).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { ensureServer } = await loadClientModule();
    await expect(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml")).rejects.toThrow(
      /session pane must not fork a daemon/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("restartDaemonIfRunning still spawns with SPUR_SESSION set", async () => {
    vi.stubEnv("SPUR_SESSION", "sess-1");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));
    fetchMock.mockRejectedValueOnce(new Error("daemon stopped"));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fetchMock.mockRejectedValueOnce(new Error("still down"));
    }
    fetchMock
      .mockRejectedValueOnce(new Error("starting"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runtimeInfo(undefined, 8888)), { status: 200 }),
      );

    const { restartDaemonIfRunning } = await loadClientModule();
    const result = await restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml");

    expect(result.restarted).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("restartDaemonIfRunning still throws under SPUR_DISABLE_AUTOSTART=1 and never spawns", async () => {
    vi.stubEnv("SPUR_DISABLE_AUTOSTART", "1");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));
    fetchMock.mockRejectedValueOnce(new Error("daemon stopped"));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      fetchMock.mockRejectedValueOnce(new Error("still down"));
    }

    const { restartDaemonIfRunning } = await loadClientModule();
    await expect(restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml")).rejects.toThrow(
      /SPUR_DISABLE_AUTOSTART/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, "grant_not_ready", "Grant activation is still finishing; retry the same command"],
    [400, "invalid_request", "Auto-ping scope does not match handle"],
  ])(
    "surfaces structured auto-ping errors with status %s and code %s",
    async (status, code, message) => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code, message } }), { status }),
        );
      const { postJson } = await loadClientModule();
      await expect(
        postJson(
          "/tmp/dist/cli.js",
          "/sessions/test/auto-ping-suppressions/unsubscribe",
          { scope: "event", handle: "ap1_test" },
          "/tmp/spur.yaml",
        ),
      ).rejects.toThrow(message);
    },
  );

  it("retains the HTTP status fallback when no error payload is present", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const { postJson } = await loadClientModule();
    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/test/send", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow("Request failed with status 503");
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

  it("formats github PR check unavailable errors with skip-pr-check guidance", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "github_pr_check_unavailable",
            sessionId: "api-1",
            pr: null,
            rateLimited: false,
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/complete", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "GitHub PR check unavailable for api-1: commonly gh missing, unauthenticated, or unreachable. Retry `spur complete api-1 --skip-pr-check` to skip it.",
    );
  });

  it("formats github PR check unavailable errors as a rate limit when rateLimited is true", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "github_pr_check_unavailable",
            sessionId: "api-1",
            pr: null,
            rateLimited: true,
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/complete", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "GitHub PR check unavailable for api-1: GitHub rate limit. Retry `spur complete api-1 --skip-pr-check` to skip it.",
    );
  });

  it("formats a session-not-restorable error with both restore-recovery commands", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "session_not_restorable",
            sessionId: "api-1",
            reason: "Session api-1 is not restorable",
            availableActions: ["force_kill", "respawn"],
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/restore", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "Session api-1 is not restorable. Try `spur kill api-1 --force` to discard it or `spur respawn api-1` to start a fresh session.",
    );
  });

  it("formats a session-not-restorable error with only force_kill when respawn is unavailable", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "session_not_restorable",
            sessionId: "api-1",
            reason: "Session api-1 is not restorable",
            availableActions: ["force_kill"],
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/restore", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "Session api-1 is not restorable. Try `spur kill api-1 --force` to discard it.",
    );
  });

  it("formats a session-not-restorable error with only respawn when force_kill is unavailable", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(runtimeInfo()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "session_not_restorable",
            sessionId: "api-1",
            reason: "Session api-1 is not restorable",
            availableActions: ["respawn"],
          }),
          { status: 409 },
        ),
      );

    const { postJson } = await loadClientModule();

    await expect(
      postJson("/tmp/dist/cli.js", "/sessions/api-1/restore", {}, "/tmp/spur.yaml"),
    ).rejects.toThrow(
      "Session api-1 is not restorable. Try `spur respawn api-1` to start a fresh session.",
    );
  });
});

describe("client deadlines", () => {
  const ready = () => Promise.resolve(new Response(JSON.stringify(runtimeInfo()), { status: 200 }));
  const pendingUntilAbort = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const stalledMessage = (seconds: number, method: string, path: string, retry: boolean) =>
    `Spur daemon at http://127.0.0.1:4310 stopped answering /info after ${seconds}s waiting on ${method} ${path}.${
      retry ? " The daemon may still apply this request; check its state before retrying." : ""
    }`;

  function routeFetch(info: (call: number, init?: RequestInit) => Promise<Response>) {
    let infoCalls = 0;
    const requestInits: Array<RequestInit | undefined> = [];
    let respond: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).endsWith("/info")) {
        infoCalls += 1;
        return info(infoCalls, init);
      }
      requestInits.push(init);
      return new Promise<Response>((resolve, reject) => {
        respond = resolve;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    });
    return { requestInits, respond: (response: Response) => respond?.(response) };
  }

  // Settles tracking so a still-pending promise can be asserted without awaiting it.
  function track<T>(promise: Promise<T>) {
    const state: { settled: boolean; error?: Error } = { settled: false };
    const assertion = promise.then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.settled = true;
        state.error = error as Error;
      },
    );
    return { state, done: () => assertion };
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    isDefaultInstanceConfigPathMock.mockReset().mockReturnValue(false);
    vi.stubEnv("SPUR_DISABLE_AUTOSTART", undefined);
    vi.stubEnv("SPUR_SESSION", "");
    vi.stubEnv("SPUR_SIDECAR_NAME", "");
    spawnMock.mockReset().mockReturnValue({ unref: vi.fn() });
    sleepMock.mockClear();
    loadConfigMock.mockReset().mockReturnValue({
      configPath: "/tmp/spur.yaml",
      server: { host: "127.0.0.1", port: 4310 },
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("probe reports unresponsive when /info does not answer within 10s", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => pendingUntilAbort(init));
    const { probeDaemon } = await loadClientModule();
    const result = probeDaemon("http://127.0.0.1:4310");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ state: "unresponsive" });
  });

  it("getExistingJson rejects an unresponsive initial probe without lifecycle effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "spur-existing-unresponsive-"));
    const configPath = join(root, "config.yaml");
    try {
      await writeFile(configPath, "server: {host: 127.0.0.1, port: 54321}\n");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.mocked(fetch).mockImplementation((_input, init) => pendingUntilAbort(init));
      const { getExistingJson } = await loadClientModule();
      const result = track(getExistingJson("/sessions/api-1/source-info", configPath));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(result.state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await result.done();
      expect(result.state.error?.message).toBe("Existing daemon is unresponsive");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:54321/info",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(spawnMock).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(loadConfigMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("probe reports unreachable on a connection error", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const { probeDaemon } = await loadClientModule();
    await expect(probeDaemon("http://127.0.0.1:4310")).resolves.toEqual({ state: "unreachable" });
  });

  it("ensureServer rejects on an unresponsive initial probe and never spawns", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => pendingUntilAbort(init));
    const { ensureServer } = await loadClientModule();
    const assertion = expect(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml")).rejects.toThrow(
      /did not answer GET \/info within 10s/,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("stopDaemonIfRunning rejects on an unresponsive probe", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(fetch).mockImplementation((_input, init) => pendingUntilAbort(init));
    const { stopDaemonIfRunning } = await loadClientModule();
    const assertion = expect(stopDaemonIfRunning("/tmp/spur.yaml")).rejects.toThrow(
      /did not answer GET \/info within 10s/,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("stop keeps polling a slow-shutdown daemon on a 1s probe deadline, then times out", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const { stopDaemonIfRunning } = await loadClientModule();
    routeFetch((call, init) => (call === 1 ? ready() : pendingUntilAbort(init)));
    const started = Date.now();
    const stop = track(stopDaemonIfRunning("/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(20_000);
    await stop.done();
    expect(stop.state.error?.message).toBe(
      "Timed out waiting for daemon at http://127.0.0.1:4310 to stop",
    );
    expect(Date.now() - started).toBeLessThanOrEqual(32_000);
  });

  it("ensureServer rejects within the wall-clock cap when every post-spawn probe hangs", async () => {
    routeFetch((call, init) =>
      call === 1 ? Promise.reject(new Error("connect ECONNREFUSED")) : pendingUntilAbort(init),
    );
    const { ensureServer } = await loadClientModule();
    const started = Date.now();
    const result = track(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(60_000);
    await result.done();
    expect(result.state.error?.message).toBe(
      "Timed out waiting for daemon at http://127.0.0.1:4310",
    );
    expect(Date.now() - started).toBeLessThanOrEqual(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("restart rejects within the wall-clock cap when every post-spawn probe hangs", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    routeFetch((call, init) => {
      if (call === 1) return ready();
      if (call <= 22) return Promise.reject(new Error("still down"));
      return pendingUntilAbort(init);
    });
    const { restartDaemonIfRunning } = await loadClientModule();
    const started = Date.now();
    const result = track(restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(60_000);
    await result.done();
    expect(result.state.error?.message).toBe(
      "Timed out waiting for daemon restart at http://127.0.0.1:4310",
    );
    expect(Date.now() - started).toBeLessThanOrEqual(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stop rejects within the wall-clock cap when a starting daemon then hangs", async () => {
    routeFetch((call, init) =>
      call === 1 ? Promise.resolve(new Response("{}", { status: 503 })) : pendingUntilAbort(init),
    );
    const { stopDaemonIfRunning } = await loadClientModule();
    const started = Date.now();
    const result = track(stopDaemonIfRunning("/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(60_000);
    await result.done();
    expect(result.state.error?.message).toBe(
      "Timed out waiting for daemon at http://127.0.0.1:4310 to finish starting",
    );
    expect(Date.now() - started).toBeLessThanOrEqual(60_000);
  });

  it("restart keeps polling an externally restarted daemon that is briefly unresponsive", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    routeFetch((call, init) => {
      if (call === 1) return ready();
      if (call === 2) return Promise.reject(new Error("daemon stopped"));
      if (call === 3) return pendingUntilAbort(init);
      return ready();
    });
    const { restartDaemonIfRunning } = await loadClientModule();
    const result = track(restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(10_000);
    await result.done();
    expect(result.state.error).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("restart throws on an unresponsive external-restart wait and never spawns", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    routeFetch((call, init) => {
      if (call === 1) return ready();
      if (call === 2) return Promise.reject(new Error("daemon stopped"));
      return pendingUntilAbort(init);
    });
    const { restartDaemonIfRunning } = await loadClientModule();
    const assertion = expect(
      restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml"),
    ).rejects.toThrow(/did not answer GET \/info within 10s/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("ensureServer keeps polling a daemon it just spawned when a probe is unresponsive", async () => {
    routeFetch((call, init) => {
      if (call === 1) return Promise.reject(new Error("connect ECONNREFUSED"));
      if (call <= 3) return pendingUntilAbort(init);
      return ready();
    });
    const { ensureServer } = await loadClientModule();
    const result = track(ensureServer("/tmp/dist/cli.js", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(20_000);
    await result.done();
    expect(result.state.error).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("restart keeps polling after its own spawn when a probe is unresponsive", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
    routeFetch((call, init) => {
      if (call === 1) return ready();
      if (call <= 22) return Promise.reject(new Error("still down"));
      if (call === 23) return pendingUntilAbort(init);
      return Promise.resolve(
        new Response(JSON.stringify(runtimeInfo(undefined, 8888)), { status: 200 }),
      );
    });
    const { restartDaemonIfRunning } = await loadClientModule();
    const result = track(restartDaemonIfRunning("/tmp/dist/cli.js", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(20_000);
    await result.done();
    expect(result.state.error).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("getJson rejects at 120s when the request is stuck but /info answers", async () => {
    routeFetch(() => ready());
    const { getJson } = await loadClientModule();
    const request = track(getJson("/tmp/dist/cli.js", "/sessions", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(request.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await request.done();
    expect(request.state.error?.message).toBe(
      "Spur daemon at http://127.0.0.1:4310 did not answer GET /sessions within 120s.",
    );
  });

  it("lock-bound GET also hits the 120s ceiling when /info keeps answering", async () => {
    routeFetch((call, init) => (call <= 2 ? ready() : pendingUntilAbort(init)));
    const { getJson } = await loadClientModule();
    const request = track(getJson("/tmp/dist/cli.js", "/sessions/test/todo", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(120_000);
    await request.done();
    expect(request.state.error?.message).toBe(
      "Spur daemon at http://127.0.0.1:4310 did not answer GET /sessions/test/todo within 120s.",
    );
  });

  it("getJson rejects 70s in when /info stops answering", async () => {
    routeFetch((call, init) => (call === 1 ? ready() : pendingUntilAbort(init)));
    const { getJson } = await loadClientModule();
    const request = track(getJson("/tmp/dist/cli.js", "/sessions", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(69_999);
    expect(request.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await request.done();
    expect(request.state.error?.message).toBe(stalledMessage(70, "GET", "/sessions", false));
  });

  it("postJson rejects at the 30 min ceiling with a may-still-apply warning", async () => {
    routeFetch(() => ready());
    const { postJson } = await loadClientModule();
    const request = track(
      postJson("/tmp/dist/cli.js", "/sessions/test/todo", {}, "/tmp/spur.yaml"),
    );
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(request.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await request.done();
    expect(request.state.error?.message).toBe(
      "Spur daemon at http://127.0.0.1:4310 did not answer POST /sessions/test/todo within 1800s. The daemon may still apply this request; check its state before retrying.",
    );
  });

  it("postJson rejects once /info stops answering", async () => {
    routeFetch((call, init) => (call === 1 ? ready() : pendingUntilAbort(init)));
    const { postJson } = await loadClientModule();
    const request = track(
      postJson("/tmp/dist/cli.js", "/sessions/test/todo", {}, "/tmp/spur.yaml"),
    );
    await vi.advanceTimersByTimeAsync(70_000);
    await request.done();
    expect(request.state.error?.message).toBe(
      stalledMessage(70, "POST", "/sessions/test/todo", true),
    );
  });

  it("deleteJson follows the mutation deadline class", async () => {
    routeFetch((call, init) => (call === 1 ? ready() : pendingUntilAbort(init)));
    const { deleteJson } = await loadClientModule();
    const request = track(
      deleteJson("/tmp/dist/cli.js", "/sessions/test/todo/1", "/tmp/spur.yaml"),
    );
    await vi.advanceTimersByTimeAsync(70_000);
    await request.done();
    expect(request.state.error?.message).toBe(
      stalledMessage(70, "DELETE", "/sessions/test/todo/1", true),
    );
  });

  it("cancels an in-flight watchdog probe and leaves no timers when the request settles", async () => {
    let watchdogSignal: AbortSignal | undefined;
    const harness = routeFetch((call, init) => {
      if (call === 1) return ready();
      watchdogSignal = init?.signal ?? undefined;
      return pendingUntilAbort(init);
    });
    const { postJson } = await loadClientModule();
    const request = track(
      postJson("/tmp/dist/cli.js", "/sessions/test/todo", {}, "/tmp/spur.yaml"),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchdogSignal?.aborted).toBe(false);
    harness.respond(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    await request.done();
    expect(request.state.error).toBeUndefined();
    expect(watchdogSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timers after a successful get", async () => {
    const harness = routeFetch(() => ready());
    const { getJson } = await loadClientModule();
    const request = track(getJson("/tmp/dist/cli.js", "/sessions", "/tmp/spur.yaml"));
    await vi.advanceTimersByTimeAsync(0);
    harness.respond(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    await request.done();
    expect(request.state.error).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
