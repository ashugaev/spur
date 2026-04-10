import { createConnection } from "node:net";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_PORT_START = 4320;
export const AGENT_PORT_END = 4399;
const PROBE_TIMEOUT_MS = 200;

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function findAvailableAgentPort(): Promise<number> {
  for (let port = AGENT_PORT_START; port <= AGENT_PORT_END; port++) {
    const inUse = await probePort("127.0.0.1", port);
    if (!inUse) return port;
  }
  throw new Error(`No available agent port in range ${AGENT_PORT_START}-${AGENT_PORT_END}`);
}

function agentInstanceDir(parentDataDir: string, sessionId: string): string {
  return join(parentDataDir, "agent-instances", sessionId);
}

export function ensureAgentIsolatedConfig(args: {
  parentDataDir: string;
  sessionId: string;
  port: number;
}): string {
  const instanceDir = agentInstanceDir(args.parentDataDir, args.sessionId);
  const configPath = join(instanceDir, "config.yaml");
  mkdirSync(instanceDir, { recursive: true });
  const yaml = [
    "server:",
    "  host: 127.0.0.1",
    `  port: ${args.port}`,
    "",
    `dataDir: ${instanceDir}`,
    `worktreeDir: ${join(instanceDir, "worktrees")}`,
    "defaultAgent: claude",
    "",
    "tmux:",
    `  socketName: spur-${args.port}`,
    "",
  ].join("\n");
  writeFileSync(configPath, yaml, "utf-8");
  return configPath;
}

export function removeAgentIsolatedConfig(parentDataDir: string, sessionId: string): void {
  const instanceDir = agentInstanceDir(parentDataDir, sessionId);
  if (existsSync(instanceDir)) {
    rmSync(instanceDir, { recursive: true, force: true });
  }
}
