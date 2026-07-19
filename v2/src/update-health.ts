import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SystemdScope } from "./host-install.js";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_WEB_PORT = 4311;

export type ServiceId = "daemon" | "web";

export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "connection-refused" | "http-error" | "timeout" | "unknown" };

export type UnitState = "active" | "activating" | "failed" | "inactive" | "unknown";

export interface PollSample {
  atMs: number;
  health: Record<ServiceId, ProbeResult>;
  units: Record<ServiceId, UnitState>;
}

export interface ProbeTarget {
  id: ServiceId;
  url: string;
}

export const SERVICE_UNITS: Record<ServiceId, string> = {
  daemon: "spur-daemon.service",
  web: "spur-web.service",
};

// The web unit carries its listen port as `Environment=PORT=<n>`; npm-init.sh
// appends a fresh line on re-init, so the last matching line wins.
export function resolveWebPort(unitFileContents: string): number {
  let port = DEFAULT_WEB_PORT;
  for (const line of unitFileContents.split("\n")) {
    const match = /^Environment=PORT=(\d+)\s*$/.exec(line.trim());
    if (match?.[1]) {
      port = Number.parseInt(match[1], 10);
    }
  }
  return port;
}

export function readWebPort(scope: SystemdScope): number {
  const unitPath = join(scope.unitDir, SERVICE_UNITS.web);
  try {
    return resolveWebPort(readFileSync(unitPath, "utf-8"));
  } catch {
    return DEFAULT_WEB_PORT;
  }
}

export interface WebUnitOptions {
  webPort: number;
  exposeWeb: boolean;
}

// The live web unit is the source of truth for what is currently deployed:
// `Environment=PORT=<n>` is the listen port and `Environment=WEB_HOST=0.0.0.0`
// marks external exposure (set by npm-init.sh --expose-web). Reinit must
// re-apply both so an update or rollback never silently resets to loopback:4311.
export function parseWebUnitOptions(unitFileContents: string): WebUnitOptions {
  const exposeWeb = /^Environment=WEB_HOST=0\.0\.0\.0\s*$/m.test(unitFileContents);
  return { webPort: resolveWebPort(unitFileContents), exposeWeb };
}

export function readWebUnitOptions(scope: SystemdScope): WebUnitOptions {
  const unitPath = join(scope.unitDir, SERVICE_UNITS.web);
  try {
    return parseWebUnitOptions(readFileSync(unitPath, "utf-8"));
  } catch {
    return { webPort: DEFAULT_WEB_PORT, exposeWeb: false };
  }
}

export interface ProbePorts {
  daemon: number;
  web: number;
}

export function makeTargets(ports: ProbePorts): Record<ServiceId, ProbeTarget> {
  return {
    daemon: { id: "daemon", url: `http://127.0.0.1:${ports.daemon}/sessions` },
    web: { id: "web", url: `http://127.0.0.1:${ports.web}/` },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  const code =
    (error as { code?: unknown }).code ??
    (typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined);
  return typeof code === "string" ? code : undefined;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>;

// Real probe seam: an HTTP GET with a hard timeout. A refused connection maps
// to `connection-refused` so the decision machine can count it toward the
// hard-failure threshold; an abort maps to `timeout`; any 5xx/4xx to
// `http-error`.
export async function probeWith(fetchLike: FetchLike, target: ProbeTarget): Promise<ProbeResult> {
  try {
    const response = await fetchLike(target.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok ? { ok: true } : { ok: false, reason: "http-error" };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ECONNREFUSED") return { ok: false, reason: "connection-refused" };
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, reason: "timeout" };
    }
    if (code === "ETIMEDOUT") return { ok: false, reason: "timeout" };
    // Any other/unknown transport error stays in a neutral bucket: it resets the
    // healthy streak but must not feed the connection-refused rollback signal.
    return { ok: false, reason: "unknown" };
  }
}

const realFetch: FetchLike = (url, init) => fetch(url, init);

export function probe(target: ProbeTarget): Promise<ProbeResult> {
  return probeWith(realFetch, target);
}

function parseUnitState(raw: string): UnitState {
  const value = raw.trim();
  if (value === "active") return "active";
  if (value === "activating") return "activating";
  if (value === "failed") return "failed";
  if (value === "inactive") return "inactive";
  return "unknown";
}

// Real systemd seam: `systemctl [--user] show <unit> -p ActiveState --value`.
// Any failure (missing systemctl, unknown unit) resolves to `unknown` rather
// than throwing, the same defensive posture as port-probe.ts.
export async function unitStateWith(scope: SystemdScope, unit: string): Promise<UnitState> {
  const [, ...scopeArgs] = scope.ctl;
  try {
    const { stdout } = await execFileAsync("systemctl", [
      ...scopeArgs,
      "show",
      unit,
      "-p",
      "ActiveState",
      "--value",
    ]);
    return parseUnitState(stdout.toString());
  } catch {
    return "unknown";
  }
}
