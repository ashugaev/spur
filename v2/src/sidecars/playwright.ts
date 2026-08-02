import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { SidecarConfig } from "../types.js";
import { shellEscape } from "../agents/shell-escape.js";
import {
  collectTree,
  killTree,
  snapshotProcesses,
  type ProcessInfo,
  type ProcSnapshot,
} from "./reap.js";

// Re-exported for callers/tests that import the shared process-info shape
// through this module; the one process-tree path lives in ./reap.js.
export type { ProcessInfo };

export const PLAYWRIGHT_SIDECAR_NAME = "playwright";
export const SPUR_RESERVED_PORT_PLAYWRIGHT = "SPUR_RESERVED_PORT_PLAYWRIGHT";

const PLAYWRIGHT_PORT_RANGE = { start: 8730, end: 8799 } as const;
// Host used to BIND the server process (--host). Keep on loopback IP.
const PLAYWRIGHT_HOST = "127.0.0.1";
// Host used in the CLIENT-FACING URL handed to agents. Must be "localhost", not
// the bare IP: @playwright/mcp's DNS-rebinding protection checks the Host header
// and rejects "127.0.0.1:<port>" with HTTP 403 while accepting "localhost:<port>".
// The server binds IPv4 loopback only (PLAYWRIGHT_HOST) while "localhost" may
// resolve ::1 first; every consumer here is Node >=20 (MCP HTTP clients + the
// fetch readiness probe), whose Happy Eyeballs (autoSelectFamily) falls back to
// IPv4, so this stays reachable without widening the bind past loopback.
export const PLAYWRIGHT_CLIENT_HOST = "localhost";
const PLAYWRIGHT_ENDPOINT_PATH = "/mcp";

let memoizedBinPath: string | undefined;

/**
 * Resolve the absolute JS entry for the pinned @playwright/mcp bin. Runs the
 * bin directly via `node <entry>` rather than npx, so signals reach the process
 * and it does not re-resolve on every launch. Touches the filesystem
 * (require.resolve) — callers must only invoke this at sidecar-start time,
 * never at module import or config parse time (see PLAYWRIGHT_SIDECAR_CONFIG).
 */
export function resolvePlaywrightMcpBin(): string {
  if (memoizedBinPath) {
    return memoizedBinPath;
  }
  const require = createRequire(import.meta.url);
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve("@playwright/mcp/package.json");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Playwright MCP sidecar unavailable: @playwright/mcp is not installed (${message})`,
      { cause: error },
    );
  }
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
  return `http://${PLAYWRIGHT_CLIENT_HOST}:${port}${PLAYWRIGHT_ENDPOINT_PATH}`;
}

function buildPlaywrightCommand(bin: string): string {
  return `node ${shellEscape(bin)} --headless --isolated --host ${PLAYWRIGHT_HOST} --port $${SPUR_RESERVED_PORT_PLAYWRIGHT}`;
}

/**
 * Resolve the real launch command at sidecar-start time. Touches the
 * filesystem (via resolvePlaywrightMcpBin) and throws a clear error if
 * @playwright/mcp is not installed. Wired in as BUILTIN_SIDECARS.resolveCommand
 * (builtins.ts) and called generically by session-service right before the
 * sidecar pane actually starts — never at config load.
 */
export function resolvePlaywrightSidecarCommand(): string {
  return buildPlaywrightCommand(resolvePlaywrightMcpBin());
}

/**
 * Built-in implicit sidecar def for one Spur-owned playwright MCP server bound
 * to loopback. A static template (no per-session state): the port env is
 * expanded at runtime inside the sidecar pane (`sh -lc <command>`, no `exec`).
 * Off by default; a project opts in via `sidecars.playwright.autoStart: true`,
 * and `agents` scopes it to claude/codex — cursor never gets it.
 *
 * `command` here is a static placeholder (the bin path is never resolved from
 * the filesystem) so importing this module, and loading config for any
 * project, never pays the @playwright/mcp resolution cost or fails when it is
 * missing. The real command is resolved lazily via
 * resolvePlaywrightSidecarCommand right before the sidecar actually starts.
 */
export const PLAYWRIGHT_SIDECAR_CONFIG: SidecarConfig = {
  command: buildPlaywrightCommand("@playwright/mcp/cli.js"),
  autoStart: false,
  agents: ["claude", "codex"],
  ports: {
    http: {
      env: SPUR_RESERVED_PORT_PLAYWRIGHT,
      start: PLAYWRIGHT_PORT_RANGE.start,
      end: PLAYWRIGHT_PORT_RANGE.end,
    },
  },
  mcp: {
    server: PLAYWRIGHT_SIDECAR_NAME,
    portId: "http",
    path: PLAYWRIGHT_ENDPOINT_PATH,
    clientHost: PLAYWRIGHT_CLIENT_HOST,
  },
};

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

const KILL_TREE_GRACE_MS = 1000;

/**
 * SIGTERM the process and all descendants (catches chromium children) from a
 * single shared snapshot, wait a grace period, then SIGKILL survivors.
 * `killTree` (../sidecars/reap.js) already swallows ESRCH for already-dead
 * pids, so the second pass is unconditional.
 */
async function killProcessTree(pid: number, snapshot: ProcSnapshot): Promise<void> {
  const tree = collectTree(pid, snapshot);
  killTree(tree, "SIGTERM");
  await sleep(KILL_TREE_GRACE_MS);
  killTree(tree, "SIGKILL");
}

/**
 * Find leaked managed playwright servers (orphaned, our bin, port not owned by
 * a live session) and kill their process trees. Returns the count of leaked
 * roots killed.
 */
export async function sweepLeakedPlaywright(ownedPorts: ReadonlySet<number>): Promise<number> {
  // Nothing this daemon started can be running if the package cannot be
  // resolved, so there is nothing to sweep. Bail before isLeakedManagedPlaywright
  // resolves it per process and throws: this runs from the boot sweep (whose
  // caller would leave driftedSessions empty and silently skip
  // restoreAfterReboot) and from every 60s reaper tick.
  try {
    resolvePlaywrightMcpBin();
  } catch {
    return 0;
  }
  const snapshot = await snapshotProcesses();
  if (!snapshot.ok) {
    return 0;
  }
  const leaked = [...snapshot.byPid.values()].filter((proc) =>
    isLeakedManagedPlaywright(proc, ownedPorts),
  );
  for (const proc of leaked) {
    await killProcessTree(proc.pid, snapshot);
  }
  return leaked.length;
}
