import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSpurInstanceRuntimeConfig } from "./spur-instance.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];
let shuttingDown = false;

function log(label: string, message: string): void {
  process.stdout.write(`[${label}] ${message}\n`);
}

function spawnProcess(
  label: string,
  command: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): ChildProcess {
  const child = spawn(command, args, {
    cwd: pkgRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...envOverrides,
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log(label, line);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log(label, line);
    }
  });

  children.push(child);
  return child;
}

function readHost(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function readPort(value: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? String(parsed)
    : String(fallback);
}

function resolveNextBin(): string {
  const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
  if (existsSync(localBin)) return localBin;

  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    const nextPkg = require.resolve("next/package.json");
    return resolve(dirname(nextPkg), "dist", "bin", "next");
  } catch {
    return "next";
  }
}

function cleanup(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;

  let remaining = children.length;
  if (remaining === 0) {
    process.exit(exitCode);
    return;
  }

  const timer = setTimeout(() => process.exit(exitCode), 5_000);
  timer.unref();

  for (const child of children) {
    child.on("exit", () => {
      remaining -= 1;
      if (remaining === 0) {
        clearTimeout(timer);
        process.exit(exitCode);
      }
    });
    child.kill("SIGTERM");
  }
}

const instanceConfig = readSpurInstanceRuntimeConfig();
const port = process.env["PORT"] || String(instanceConfig.uiPort);
const directTerminalPort = readPort(
  process.env["DIRECT_TERMINAL_BIND_PORT"] ?? process.env["DIRECT_TERMINAL_PORT"],
  instanceConfig.uiPort + 1,
);
const host = readHost(process.env["WEB_HOST"], "0.0.0.0");
const sharedEnv = {
  PORT: port,
  DIRECT_TERMINAL_BIND_PORT: directTerminalPort,
  DIRECT_TERMINAL_PORT: directTerminalPort,
  SPUR_DAEMON_URL: process.env["SPUR_DAEMON_URL"] || instanceConfig.daemonUrl,
  SPUR_TMUX_SOCKET_NAME: process.env["SPUR_TMUX_SOCKET_NAME"] || instanceConfig.tmuxSocketName,
  SPUR_CONFIG: process.env["SPUR_CONFIG"] || instanceConfig.configPath,
};
spawnProcess("next", resolveNextBin(), ["start", "-H", host, "-p", port], sharedEnv);
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], sharedEnv);

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
