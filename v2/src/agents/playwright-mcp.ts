import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { SidecarConfig } from "../types.js";

const execFileAsync = promisify(execFile);

export const PLAYWRIGHT_SIDECAR_NAME = "playwright";
export const SPUR_RESERVED_PORT_PLAYWRIGHT = "SPUR_RESERVED_PORT_PLAYWRIGHT";
export const SPUR_PLAYWRIGHT_SESSION_ENV = "SPUR_PLAYWRIGHT_SESSION";

const PLAYWRIGHT_PORT_RANGE = { start: 8730, end: 8799 } as const;
const PLAYWRIGHT_HOST = "127.0.0.1";
const PLAYWRIGHT_ENDPOINT_PATH = "/mcp";

let memoizedBinPath: string | undefined;

/**
 * Resolve the absolute JS entry for the pinned @playwright/mcp bin. Runs the
 * bin directly via `node <entry>` rather than npx, so signals reach the process
 * and it does not re-resolve on every launch.
 */
export function resolvePlaywrightMcpBin(): string {
  if (memoizedBinPath) {
    return memoizedBinPath;
  }
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("@playwright/mcp/package.json");
  const pkgDir = dirname(pkgJsonPath);
  const pkg = require("@playwright/mcp/package.json") as { bin?: Record<string, string> | string };
  const binField = pkg.bin;
  const binRelative =
    typeof binField === "string" ? binField : (binField?.["playwright-mcp"] ?? "cli.js");
  const binPath = isAbsolute(binRelative) ? binRelative : join(pkgDir, binRelative);
  memoizedBinPath = binPath;
  return binPath;
}

export function playwrightMcpUrl(port: number): string {
  return `http://${PLAYWRIGHT_HOST}:${port}${PLAYWRIGHT_ENDPOINT_PATH}`;
}

/**
 * Built-in implicit sidecar for one Spur-owned playwright MCP server bound to
 * loopback. Built per session so the marker env carries the concrete session id
 * (tmux -e passes literal values, not shell-expanded). The port env is expanded
 * at runtime inside the sidecar pane (`bash -lc "exec ..."`).
 */
export function buildPlaywrightSidecarConfig(sessionId: string): SidecarConfig {
  const bin = resolvePlaywrightMcpBin();
  return {
    command: `node ${bin} --headless --isolated --host ${PLAYWRIGHT_HOST} --port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`,
    autoStart: true,
    env: { [SPUR_PLAYWRIGHT_SESSION_ENV]: sessionId },
    ports: {
      http: {
        env: SPUR_RESERVED_PORT_PLAYWRIGHT,
        start: PLAYWRIGHT_PORT_RANGE.start,
        end: PLAYWRIGHT_PORT_RANGE.end,
      },
    },
  };
}

const READINESS_ATTEMPTS = 8;
const READINESS_INTERVAL_MS = 250;

/**
 * Best-effort bounded TCP/HTTP readiness probe (~2s). Returns true once the
 * server accepts a connection (any HTTP response, including 403, counts). Never
 * throws; callers log and continue on timeout.
 */
export async function waitForPlaywrightReady(
  port: number,
  attempts = READINESS_ATTEMPTS,
  intervalMs = READINESS_INTERVAL_MS,
): Promise<boolean> {
  const url = playwrightMcpUrl(port);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), intervalMs);
      try {
        await fetch(url, { method: "GET", signal: controller.signal });
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Connection refused / aborted: server not listening yet.
    }
    await sleep(intervalMs);
  }
  return false;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string;
}

/**
 * Enumerate live processes via `ps` (no shell). Malformed lines are skipped.
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="]));
  } catch {
    return [];
  }
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3] ?? "";
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    processes.push({ pid, ppid, args });
  }
  return processes;
}

function extractPlaywrightPort(args: string): number | undefined {
  const match = /--port\s+(\d+)/.exec(args);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) ? port : undefined;
}

/**
 * A managed playwright server is leaked only when ALL hold:
 *  (a) args run our resolved bin AND bind to loopback (--host 127.0.0.1);
 *  (b) its --port is not reserved by any live session for the playwright sidecar
 *      (so no running/spawning session owns it);
 *  (c) it has been reparented to init (ppid === 1) — an orphan.
 */
export function isLeakedManagedPlaywright(
  proc: ProcessInfo,
  ownedPorts: ReadonlySet<number>,
): boolean {
  const bin = resolvePlaywrightMcpBin();
  if (!proc.args.includes(bin)) return false;
  if (!proc.args.includes(`--host ${PLAYWRIGHT_HOST}`)) return false;
  if (proc.ppid !== 1) return false;
  const port = extractPlaywrightPort(proc.args);
  if (port === undefined) return false;
  return !ownedPorts.has(port);
}

function collectDescendants(rootPid: number, processes: readonly ProcessInfo[]): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const proc of processes) {
    const list = childrenByPpid.get(proc.ppid) ?? [];
    list.push(proc.pid);
    childrenByPpid.set(proc.ppid, list);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) break;
    ordered.push(pid);
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return ordered;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      // Permission or other errors are non-fatal for a best-effort sweep.
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const KILL_TREE_GRACE_MS = 1000;

/**
 * SIGTERM the process and all descendants (catches chromium children), wait a
 * grace period, then SIGKILL survivors. Guards ESRCH for already-dead pids.
 */
export async function killProcessTree(pid: number): Promise<void> {
  const processes = await listProcesses();
  const tree = collectDescendants(pid, processes);
  // Kill leaves first so parents do not respawn children mid-teardown.
  for (const target of [...tree].reverse()) {
    killPid(target, "SIGTERM");
  }
  await sleep(KILL_TREE_GRACE_MS);
  for (const target of [...tree].reverse()) {
    if (processAlive(target)) {
      killPid(target, "SIGKILL");
    }
  }
}

/**
 * Find leaked managed playwright servers (orphaned, our bin, port not owned by
 * a live session) and kill their process trees. Returns the count of leaked
 * roots killed.
 */
export async function sweepLeakedPlaywright(ownedPorts: ReadonlySet<number>): Promise<number> {
  const processes = await listProcesses();
  const leaked = processes.filter((proc) => isLeakedManagedPlaywright(proc, ownedPorts));
  for (const proc of leaked) {
    await killProcessTree(proc.pid);
  }
  return leaked.length;
}
