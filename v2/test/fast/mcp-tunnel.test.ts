import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMcpTunnelStatus, runMcpTunnel } from "../../src/mcp-tunnel.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  spawnMock.mockReset();
});

describe("configured MCP tunnel health", () => {
  it("supervises one child with explicit loopback binding and cleans receipts on exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-tunnel-runner-"));
    const configPath = join(directory, "config.yaml");
    const envPath = join(directory, "tunnel.env");
    writeFileSync(
      configPath,
      `dataDir: ${directory}\nmcp:\n  port: 43217\nprojects:\n  test:\n    path: ${directory}\n    sources:\n      telegram:\n        type: telegram\n        token: \${TELEGRAM_BOT_TOKEN}\n        allowedUsers: [123]\n`,
    );
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    writeFileSync(envPath, "fixture=true\n", { mode: 0o600 });
    vi.stubEnv("SPUR_MCP_TUNNEL_ENV_FILE", envPath);
    vi.stubEnv("SPUR_MCP_TUNNEL_PROFILE", "test-profile");
    vi.stubEnv("CONTROL_PLANE_API_KEY", "fixture-runtime-key");
    const child = Object.assign(new EventEmitter(), { pid: process.pid, kill: vi.fn() });
    spawnMock.mockReturnValue(child);
    try {
      const running = runMcpTunnel(configPath);
      child.emit("spawn");
      expect(spawnMock).toHaveBeenCalledWith(
        "tunnel-client",
        [
          "run",
          "--profile",
          "test-profile",
          "--mcp-server-url",
          "http://127.0.0.1:43217/mcp",
          "--health.listen-addr",
          "127.0.0.1:0",
          "--health.url-file",
          join(directory, "mcp-tunnel.url"),
        ],
        { stdio: "inherit" },
      );
      expect(statSync(join(directory, "mcp-tunnel.json")).mode & 0o777).toBe(0o600);
      expect(process.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
      child.emit("exit", 0, null);
      await running;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(() => statSync(join(directory, "mcp-tunnel.json"))).toThrow();
      vi.stubEnv("CONTROL_PLANE_API_KEY", "");
      await expect(runMcpTunnel(configPath)).rejects.toThrow("CONTROL_PLANE_API_KEY");
      vi.stubEnv("CONTROL_PLANE_API_KEY", "fixture-runtime-key");
      writeFileSync(envPath, "");
      await expect(runMcpTunnel(configPath)).rejects.toThrow("environment file is empty");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves selected field diagnostics before spawning and keeps syntax contents private", async () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-tunnel-invalid-"));
    const path = join(directory, "config.yaml");
    try {
      writeFileSync(path, "mcp:\n  port: invalid\n");
      await expect(runMcpTunnel(path)).rejects.toThrow("mcp.port");
      writeFileSync(path, 'projects: [private-token: "unterminated\n');
      await expect(runMcpTunnel(path)).rejects.toThrow("YAML is invalid");
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("requires configuration, current live generation and loopback readyz", async () => {
    const directory = mkdtempSync(join(tmpdir(), "spur-tunnel-health-"));
    const env = join(directory, "tunnel.env");
    try {
      expect(await readMcpTunnelStatus(directory, env)).toEqual({ configured: false, ready: true });
      writeFileSync(env, "fixture=true\n", { mode: 0o600 });
      expect(await readMcpTunnelStatus(directory, env)).toMatchObject({
        configured: true,
        ready: false,
      });
      const stat = statSync(env);
      writeFileSync(
        join(directory, "mcp-tunnel.json"),
        JSON.stringify({
          pid: process.pid,
          childPid: process.pid,
          generation: "test",
          envMtimeMs: stat.mtimeMs,
          envIno: stat.ino,
        }),
      );
      writeFileSync(join(directory, "mcp-tunnel.url"), "http://127.0.0.1:43218");
      const probe = vi.fn().mockResolvedValue(new Response("ready"));
      vi.stubGlobal("fetch", probe);
      expect(await readMcpTunnelStatus(directory, env)).toMatchObject({
        configured: true,
        ready: true,
        pid: process.pid,
      });
      expect(String(probe.mock.calls[0]?.[0])).toBe("http://127.0.0.1:43218/readyz");
      probe.mockResolvedValue(new Response("unready", { status: 503 }));
      expect(await readMcpTunnelStatus(directory, env)).toMatchObject({ ready: false });
      writeFileSync(join(directory, "mcp-tunnel.url"), "http://example.com:43218");
      expect(await readMcpTunnelStatus(directory, env)).toMatchObject({ ready: false });
      chmodSync(env, 0o644);
      expect(await readMcpTunnelStatus(directory, env)).toMatchObject({ ready: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["../../../deploy/spur-mcp.service", "../../deploy/spur-mcp.npm.service"])(
    "keeps %s independent of daemon stops and tunnel secrets",
    (path) => {
      const unit = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(unit).toContain("Restart=always");
      expect(unit).toContain("RestartSec=3");
      expect(unit).toContain("spur-daemon.service");
      expect(unit).not.toMatch(/^(Requires|BindsTo|EnvironmentFile)=/m);
      expect(unit).toContain("mcp --http");
    },
  );
});
