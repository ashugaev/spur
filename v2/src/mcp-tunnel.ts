import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadInstanceConfigReadOnly } from "./config.js";

export function mcpTunnelEnvPath(): string {
  return process.env["SPUR_MCP_TUNNEL_ENV_FILE"] ?? join(homedir(), ".spur", "mcp-tunnel.env");
}

function receiptPaths(dataDir: string) {
  return { receipt: join(dataDir, "mcp-tunnel.json"), url: join(dataDir, "mcp-tunnel.url") };
}

export interface McpTunnelStatus {
  configured: boolean;
  ready: boolean;
  pid?: number;
  error?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readMcpTunnelStatus(
  dataDir: string,
  envPath = mcpTunnelEnvPath(),
): Promise<McpTunnelStatus> {
  if (!existsSync(envPath)) return { configured: false, ready: true };
  try {
    const envStat = statSync(envPath);
    if ((envStat.mode & 0o077) !== 0 || envStat.size === 0) {
      throw new Error("Tunnel environment file must have mode 0600");
    }
    const paths = receiptPaths(dataDir);
    const receipt: unknown = JSON.parse(readFileSync(paths.receipt, "utf8"));
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("pid" in receipt) ||
      typeof receipt.pid !== "number" ||
      !processAlive(receipt.pid) ||
      !("childPid" in receipt) ||
      typeof receipt.childPid !== "number" ||
      !processAlive(receipt.childPid) ||
      !("envMtimeMs" in receipt) ||
      receipt.envMtimeMs !== envStat.mtimeMs ||
      !("envIno" in receipt) ||
      receipt.envIno !== envStat.ino
    ) {
      throw new Error("Tunnel process is unavailable");
    }
    const url = new URL(readFileSync(paths.url, "utf8").trim());
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Tunnel health receipt is invalid");
    }
    const response = await fetch(new URL("/readyz", url), {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    return response.ok
      ? { configured: true, ready: true, pid: receipt.pid }
      : { configured: true, ready: false, error: "Tunnel is not ready" };
  } catch {
    return {
      configured: true,
      ready: false,
      error: "Tunnel health or private configuration is unavailable",
    };
  }
}

export async function runMcpTunnel(configPath?: string): Promise<void> {
  const loaded = loadInstanceConfigReadOnly(configPath);
  if (loaded.status !== "ok") throw new Error("MCP tunnel requires a valid instance configuration");
  const profile = process.env["SPUR_MCP_TUNNEL_PROFILE"]?.trim();
  const key = process.env["CONTROL_PLANE_API_KEY"]?.trim();
  if (!profile || !key)
    throw new Error("MCP tunnel requires SPUR_MCP_TUNNEL_PROFILE and CONTROL_PLANE_API_KEY");
  const envPath = mcpTunnelEnvPath();
  if (!existsSync(envPath) || (statSync(envPath).mode & 0o077) !== 0) {
    throw new Error("MCP tunnel requires a private environment file with mode 0600");
  }
  const config = loaded.config;
  const envStat = statSync(envPath);
  if (envStat.size === 0) throw new Error("MCP tunnel environment file is empty");
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const paths = receiptPaths(config.dataDir);
  rmSync(paths.url, { force: true });
  rmSync(paths.receipt, { force: true });
  const child = spawn(
    "tunnel-client",
    [
      "run",
      "--profile",
      profile,
      "--mcp-server-url",
      `http://127.0.0.1:${config.mcp.port}/mcp`,
      "--health.listen-addr",
      "127.0.0.1:0",
      "--health.url-file",
      paths.url,
    ],
    { stdio: "inherit" },
  );
  const forwardTerm = () => {
    child.kill("SIGTERM");
  };
  const forwardInt = () => {
    child.kill("SIGINT");
  };
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInt);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Could not launch tunnel-client")));
      child.once("spawn", () => {
        writeFileSync(
          paths.receipt,
          JSON.stringify({
            pid: process.pid,
            childPid: child.pid,
            generation: randomUUID(),
            envMtimeMs: envStat.mtimeMs,
            envIno: envStat.ino,
          }),
          { mode: 0o600 },
        );
      });
      child.once("exit", (code, signal) => {
        if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") resolve();
        else reject(new Error(`tunnel-client exited with status ${code ?? signal}`));
      });
    });
  } finally {
    process.off("SIGTERM", forwardTerm);
    process.off("SIGINT", forwardInt);
    child.kill("SIGTERM");
    rmSync(paths.receipt, { force: true });
    rmSync(paths.url, { force: true });
  }
}
