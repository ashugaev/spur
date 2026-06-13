import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLEAR_PORT_TIMEOUT_MS = 2_000;
const CLEAR_PORT_POLL_MS = 100;

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorStdout(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stdout" in error)) {
    return "";
  }
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" || Buffer.isBuffer(stdout) ? stdout.toString() : "";
}

async function execFileOutput(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args);
    return stdout.toString();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return "";
    }
    return errorStdout(error);
  }
}

function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    pids.add(Number.parseInt(trimmed, 10));
  }
  return [...pids];
}

function parseSsPids(output: string): number[] {
  const pids = new Set<number>();
  const pidPattern = /pid=(\d+)/g;
  for (const match of output.matchAll(pidPattern)) {
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function isHostPortFree(port: number): Promise<boolean> {
  if (!isValidPort(port)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.listen({ port, host: "0.0.0.0", exclusive: true }, () => {
      server.close(() => settle(true));
    });
  });
}

export async function findListenerPids(port: number): Promise<number[]> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`);
  }

  const lsofOutput = await execFileOutput("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const lsofPids = parseLsofPids(lsofOutput);
  if (lsofPids.length > 0) {
    return lsofPids;
  }

  const ssOutput = await execFileOutput("ss", ["-ltnp", "sport", "=", `:${port}`]);
  return parseSsPids(ssOutput);
}

export async function clearPortListener(port: number): Promise<void> {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port: ${port}`);
  }

  const pids = await findListenerPids(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") {
        throw error;
      }
    }
  }

  const deadline = Date.now() + CLEAR_PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHostPortFree(port)) {
      return;
    }
    await sleep(CLEAR_PORT_POLL_MS);
  }

  throw new Error(`Port ${port} is still busy after clearing listener`);
}
