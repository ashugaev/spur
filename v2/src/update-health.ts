import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { instanceConfigExists, loadConfig } from "./config.js";
import type { SystemdScope } from "./host-install.js";
import { DEFAULT_UI_PORT } from "./ports.js";
import type { HeadroomReport } from "./types.js";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_WEB_PORT = DEFAULT_UI_PORT;
export const DEFAULT_DAEMON_PORT = 4_310;

export type ServiceId = "daemon" | "web";

export type ProbeReason = "connection-refused" | "http-error" | "timeout" | "unknown";

export type ProbeResult = { ok: true } | { ok: false; reason: ProbeReason };

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

// Host-level daemon port resolution: read the bootstrap instance config, same
// as the daemon itself, defaulting to 4310 when it is unset or unreadable.
// `allowBootstrapWrite` gates whether a missing instance config may be
// auto-created by `loadConfig` (its bootstrap side effect) before being read.
function resolveDaemonPortImpl(allowBootstrapWrite: boolean): number {
  try {
    if (!allowBootstrapWrite && !instanceConfigExists()) return DEFAULT_DAEMON_PORT;
    return loadConfig().server.port;
  } catch {
    return DEFAULT_DAEMON_PORT;
  }
}

// Used by `spur update`, which always runs after `spur init` has already
// bootstrapped `~/.spur/config.yaml`, so auto-creating it here is safe.
export function resolveDaemonPort(): number {
  return resolveDaemonPortImpl(true);
}

// Read-only daemon port resolution for `spur doctor`: never triggers
// `loadConfig`'s auto-bootstrap write of `~/.spur/config.yaml` on a host that
// has never run any Spur command before. Falls back to the same default port
// as `resolveDaemonPort` when the instance config does not exist yet.
export function resolveDaemonPortReadOnly(): number {
  return resolveDaemonPortImpl(false);
}

export interface WebUnitOptions {
  webPort: number;
  exposeWeb: boolean;
  tailscale: boolean;
}

// The live web unit is the source of truth for what is currently deployed:
// `Environment=PORT=<n>` is the listen port and `Environment=WEB_HOST=0.0.0.0`
// marks external exposure (set by npm-init.sh --expose-web). Reinit must
// re-apply both so an update or rollback never silently resets to loopback:5555.
// A comma-separated WEB_HOST (e.g. `127.0.0.1,100.64.0.1`) marks a Tailscale
// bind that npm-init.sh already resolved; only re-apply `--tailscale` when one
// is live, so an unattended `spur update` never triggers a fresh Tailscale
// install/lookup on a host that had it declined or not yet up.
// Pre-#573 units set the bind via `HOSTNAME=` rather than `WEB_HOST=`; still
// recognize that legacy var here so updating a `--expose-web` install doesn't
// downgrade its public bind back to loopback.
export function parseWebUnitOptions(unitFileContents: string): WebUnitOptions {
  const exposeWeb = /^Environment=(?:WEB_HOST|HOSTNAME)=0\.0\.0\.0\s*$/m.test(unitFileContents);
  const tailscale = /^Environment=WEB_HOST=127\.0\.0\.1,\S+/m.test(unitFileContents);
  return { webPort: resolveWebPort(unitFileContents), exposeWeb, tailscale };
}

export function readWebUnitOptions(scope: SystemdScope): WebUnitOptions {
  const unitPath = join(scope.unitDir, SERVICE_UNITS.web);
  try {
    return parseWebUnitOptions(readFileSync(unitPath, "utf-8"));
  } catch {
    return { webPort: DEFAULT_WEB_PORT, exposeWeb: false, tailscale: false };
  }
}

export interface ProbePorts {
  daemon: number;
  web: number;
}

export function makeTargets(ports: ProbePorts): Record<ServiceId, ProbeTarget> {
  return {
    daemon: { id: "daemon", url: `http://127.0.0.1:${ports.daemon}/info` },
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

// Shared transport-error classifier for both `probeWith` and `probeInfoWith`:
// a refused connection maps to `connection-refused` so the decision machine
// can count it toward the hard-failure threshold; an abort maps to `timeout`;
// any other/unknown transport error stays in a neutral bucket that resets the
// healthy streak but must not feed the connection-refused rollback signal.
function classifyTransportError(error: unknown): ProbeReason {
  const code = errorCode(error);
  if (code === "ECONNREFUSED") return "connection-refused";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  if (code === "ETIMEDOUT") return "timeout";
  return "unknown";
}

// Real probe seam: an HTTP GET with a hard timeout. Any 5xx/4xx maps to
// `http-error`; transport failures are classified by `classifyTransportError`.
export async function probeWith(fetchLike: FetchLike, target: ProbeTarget): Promise<ProbeResult> {
  try {
    const response = await fetchLike(target.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok ? { ok: true } : { ok: false, reason: "http-error" };
  } catch (error) {
    return { ok: false, reason: classifyTransportError(error) };
  }
}

const realFetch: FetchLike = (url, init) => fetch(url, init);

export function probe(target: ProbeTarget): Promise<ProbeResult> {
  return probeWith(realFetch, target);
}

export type JsonFetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function isVersionBody(value: unknown): value is { version: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string"
  );
}

export type ProbeInfoResult = { ok: true; version: string } | { ok: false; reason: ProbeReason };

// F8 version-drift probe: fetches a target's JSON body (daemon `/info`) with
// the same hard timeout as `probeWith`, and the same discriminated
// `ok`/`reason` shape — so a caller (`checkServiceHealth`) can tell a
// definitive failure (`connection-refused`) apart from a bare `timeout`
// (may just be slow/under load) without a second round trip.
export async function probeInfoWith(
  fetchLike: JsonFetchLike,
  target: ProbeTarget,
): Promise<ProbeInfoResult> {
  try {
    const response = await fetchLike(target.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: "http-error" };
    const body: unknown = await response.json();
    return isVersionBody(body)
      ? { ok: true, version: body.version }
      : { ok: false, reason: "unknown" };
  } catch (error) {
    return { ok: false, reason: classifyTransportError(error) };
  }
}

const realJsonFetch: JsonFetchLike = (url, init) => fetch(url, init);

export function probeInfo(target: ProbeTarget): Promise<ProbeInfoResult> {
  return probeInfoWith(realJsonFetch, target);
}

function isHeadroomBody(value: unknown): value is HeadroomReport {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  const cap = body["cap"];
  const live = body["live"];
  const guard = body["guard"];
  return (
    typeof cap === "object" &&
    cap !== null &&
    typeof (cap as Record<string, unknown>)["global"] === "number" &&
    typeof live === "object" &&
    live !== null &&
    typeof (live as Record<string, unknown>)["count"] === "number" &&
    Array.isArray(body["sessions"]) &&
    typeof guard === "object" &&
    guard !== null &&
    typeof (guard as Record<string, unknown>)["crossed"] === "boolean" &&
    typeof body["projectedRoom"] === "number"
  );
}

export type ProbeHeadroomResult = { ok: true; body: HeadroomReport } | { ok: false };

// F9-style headroom probe: same injectable JsonFetchLike, timeout, and
// try/catch shape as probeInfoWith — checkServiceHealth calls this only
// after the daemon is already known reachable, so a failure here just means
// "skip the session-headroom check", never a second liveness signal.
export async function probeHeadroomWith(
  fetchLike: JsonFetchLike,
  url: string,
): Promise<ProbeHeadroomResult> {
  try {
    const response = await fetchLike(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false };
    const body: unknown = await response.json();
    return isHeadroomBody(body) ? { ok: true, body } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function probeHeadroom(url: string): Promise<ProbeHeadroomResult> {
  return probeHeadroomWith(realJsonFetch, url);
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
