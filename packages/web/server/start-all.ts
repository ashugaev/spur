import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];
let shuttingDown = false;

function log(label: string, message: string): void {
  process.stdout.write(`[${label}] ${message}\n`);
}

function spawnProcess(label: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    cwd: pkgRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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

const port = process.env["PORT"] || "3000";
spawnProcess("next", resolveNextBin(), ["start", "-p", port]);
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")]);

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
