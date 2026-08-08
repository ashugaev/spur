import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import {
  type ConnectProjectConfigRequest,
  type DisconnectProjectConfigRequest,
  type ProjectConfigMutationResponse,
  type ProjectListEntry,
  SPUR_DAEMON_API_VERSION,
  type PreflightRequest,
  type PreflightResponse,
  type RuntimeInfo,
  type OpenPrActionRequiredPayload,
  type SidecarPortConflictPayload,
} from "./types.js";

const DAEMON_STOP_ATTEMPTS = 20;
const DAEMON_STOP_RETRY_DELAY_MS = 100;
const DAEMON_START_ATTEMPTS = 160;
const DAEMON_START_RETRY_DELAY_MS = 250;
const EXTERNAL_DAEMON_RESTART_ATTEMPTS = 20;

function parseJsonText(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Failed to parse daemon JSON response");
  }
}

export function createBaseUrl(configPath?: string): { baseUrl: string; configPath: string } {
  const config = loadConfig(configPath);
  return {
    baseUrl: `http://${config.server.host}:${config.server.port}`,
    configPath: config.configPath,
  };
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  const payload = parseJsonText(text);
  return { response, payload };
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const withOrigin: RequestInit = {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-spur-origin": "cli" },
  };
  const { response, payload } = await fetchJson(baseUrl, path, withOrigin);
  if (!response.ok) {
    const message = formatDaemonError(response.status, payload, path);
    throw new Error(message);
  }

  return payload as T;
}

function isSidecarPortConflictPayload(payload: unknown): payload is SidecarPortConflictPayload {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Partial<SidecarPortConflictPayload>;
  return (
    record.code === "sidecar_port_busy" &&
    typeof record.sidecarName === "string" &&
    Array.isArray(record.candidates)
  );
}

function isOpenPrActionRequiredPayload(payload: unknown): payload is OpenPrActionRequiredPayload {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Partial<OpenPrActionRequiredPayload>;
  const pr = record.pr;
  if (!pr || typeof pr !== "object") return false;
  const prRecord = pr as Partial<OpenPrActionRequiredPayload["pr"]>;
  return (
    record.code === "open_pr_action_required" &&
    typeof record.sessionId === "string" &&
    typeof prRecord.number === "number" &&
    typeof prRecord.title === "string" &&
    typeof prRecord.url === "string"
  );
}

function openPrActionCommand(path: string, sessionId: string): string | null {
  const action = path.match(/^\/sessions\/[^/]+\/(complete|kill)$/)?.[1];
  if (!action) return null;
  return `spur ${action} ${sessionId}`;
}

function formatDaemonError(status: number, payload: unknown, path: string): string {
  if (isSidecarPortConflictPayload(payload)) {
    const ports = payload.candidates
      .map((candidate) => `${candidate.portId}:${candidate.port}`)
      .join(", ");
    return `Sidecar ${payload.sidecarName} port busy (${ports}). Retry with --clear-port <port>.`;
  }
  if (isOpenPrActionRequiredPayload(payload)) {
    const command = openPrActionCommand(path, payload.sessionId);
    const retry = command
      ? `Retry \`${command} --pr-action leave_open\` to keep it open or \`${command} --pr-action close\` to close it.`
      : "Retry with --pr-action leave_open to keep it open or --pr-action close to close it.";
    return `Open pull request action required for ${payload.sessionId}: ${payload.pr.url}. ${retry}`;
  }
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    return String(payload.error);
  }
  return `Request failed with status ${status}`;
}

export type DaemonProbe =
  | { state: "ready"; info: RuntimeInfo }
  | { state: "incompatible"; pid?: number }
  | { state: "starting" }
  | { state: "unreachable" };

// Deliberately loose: this pid is used to stop daemons of ANY older build, so
// it must not require fields (e.g. version) that predate-this-build daemons
// never emit.
export function readDaemonPid(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const runtime = payload as { ok?: unknown; pid?: unknown };
  return runtime.ok === true && typeof runtime.pid === "number" ? runtime.pid : undefined;
}

export function isCompatibleRuntimeInfo(payload: unknown): payload is RuntimeInfo {
  if (!payload || typeof payload !== "object") return false;
  const runtime = payload as { ok?: unknown; apiVersion?: unknown; pid?: unknown };
  return (
    runtime.ok === true &&
    runtime.apiVersion === SPUR_DAEMON_API_VERSION &&
    typeof runtime.pid === "number"
  );
}

function incompatibleProbe(pid: number | undefined): DaemonProbe {
  return pid === undefined ? { state: "incompatible" } : { state: "incompatible", pid };
}

export async function probeDaemon(baseUrl: string): Promise<DaemonProbe> {
  try {
    const response = await fetch(`${baseUrl}/info`);
    const text = await response.text();
    let payload: unknown = {};
    try {
      payload = parseJsonText(text);
    } catch {
      payload = {};
    }
    if (response.status === 503) {
      return { state: "starting" };
    }
    if (!response.ok) {
      return { state: "unreachable" };
    }
    if (!isCompatibleRuntimeInfo(payload)) {
      return incompatibleProbe(readDaemonPid(payload));
    }

    return { state: "ready", info: payload };
  } catch {
    return { state: "unreachable" };
  }
}

function daemonPidFromProbe(probe: DaemonProbe): number | undefined {
  if (probe.state === "ready") {
    return probe.info.pid;
  }
  if (probe.state === "incompatible") {
    return probe.pid;
  }
  return undefined;
}

async function waitUntilDaemonPidChanges(baseUrl: string, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < DAEMON_STOP_ATTEMPTS; attempt += 1) {
    await sleep(DAEMON_STOP_RETRY_DELAY_MS);
    const probe = await probeDaemon(baseUrl);
    if (probe.state === "unreachable") {
      return true;
    }
    const currentPid = daemonPidFromProbe(probe);
    if (typeof currentPid === "number" && currentPid !== pid) {
      return true;
    }
  }

  return false;
}

async function waitForStableDaemonProbe(baseUrl: string): Promise<DaemonProbe> {
  let probe = await probeDaemon(baseUrl);
  if (probe.state !== "starting") {
    return probe;
  }

  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt += 1) {
    await sleep(DAEMON_START_RETRY_DELAY_MS);
    probe = await probeDaemon(baseUrl);
    if (probe.state !== "starting") {
      return probe;
    }
  }

  throw new Error(`Timed out waiting for daemon at ${baseUrl} to finish starting`);
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ESRCH"
  );
}

async function stopDaemonPid(baseUrl: string, pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isMissingProcessError(error)) {
      return true;
    }
    throw error;
  }

  return waitUntilDaemonPidChanges(baseUrl, pid);
}

async function stopIncompatibleDaemon(baseUrl: string, pid?: number): Promise<void> {
  if (typeof pid !== "number") return;
  const stopped = await stopDaemonPid(baseUrl, pid);
  if (!stopped) {
    throw new Error(`Timed out waiting for incompatible daemon at ${baseUrl} to stop`);
  }
}

function spawnDaemon(cliEntrypoint: string, configPath: string): void {
  // SPUR_DISABLE_AUTOSTART blocks CLI auto-spawn so the daemon is only ever
  // started by an external manager (e.g. systemd on the prod VM). Without
  // this guard, a CLI invocation during a restart window can fork a daemon
  // outside the service cgroup, win the :4310 bind race, and put
  // spur-daemon.service into an EADDRINUSE crash loop.
  if (process.env.SPUR_DISABLE_AUTOSTART === "1") {
    throw new Error(
      "Spur daemon is unreachable and SPUR_DISABLE_AUTOSTART=1; this managed instance must come back through the repo deploy or service restart flow.",
    );
  }
  const child = spawn(
    process.execPath,
    [cliEntrypoint, "--config", configPath, "daemon", "start"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

async function waitForReadyDaemon(
  baseUrl: string,
  attempts = DAEMON_START_ATTEMPTS,
): Promise<RuntimeInfo | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(DAEMON_START_RETRY_DELAY_MS);
    const probe = await probeDaemon(baseUrl);
    if (probe.state === "ready") {
      return probe.info;
    }
  }

  return undefined;
}

export interface StopDaemonResult {
  baseUrl: string;
  pid?: number;
  stopped: boolean;
}

export interface RestartDaemonResult {
  baseUrl: string;
  previousPid?: number;
  restarted: boolean;
  runtime?: RuntimeInfo;
}

export async function stopDaemonIfRunning(configPath?: string): Promise<StopDaemonResult> {
  const { baseUrl } = createBaseUrl(configPath);
  const probe = await waitForStableDaemonProbe(baseUrl);
  const pid = daemonPidFromProbe(probe);
  if (typeof pid !== "number") {
    return { baseUrl, stopped: false };
  }

  const stopped = await stopDaemonPid(baseUrl, pid);
  if (!stopped) {
    throw new Error(`Timed out waiting for daemon at ${baseUrl} to stop`);
  }
  return { baseUrl, pid, stopped: true };
}

export async function restartDaemonIfRunning(
  cliEntrypoint: string,
  configPath?: string,
): Promise<RestartDaemonResult> {
  const { baseUrl, configPath: resolvedConfigPath } = createBaseUrl(configPath);
  const stopped = await stopDaemonIfRunning(configPath);
  if (!stopped.stopped || typeof stopped.pid !== "number") {
    return { baseUrl, restarted: false };
  }

  // Give an external service manager (e.g. systemd) a short chance to restart the daemon,
  // then fall back to spawning the daemon directly so CLI calls do not sit idle for 40s.
  let runtime = await waitForReadyDaemon(baseUrl, EXTERNAL_DAEMON_RESTART_ATTEMPTS);
  if (!runtime) {
    spawnDaemon(cliEntrypoint, resolvedConfigPath);
    runtime = await waitForReadyDaemon(baseUrl);
  }
  if (!runtime) {
    throw new Error(`Timed out waiting for daemon restart at ${baseUrl}`);
  }

  return {
    baseUrl,
    previousPid: stopped.pid,
    restarted: true,
    runtime,
  };
}

export async function ensureServer(cliEntrypoint: string, configPath?: string): Promise<string> {
  const { baseUrl, configPath: resolvedConfigPath } = createBaseUrl(configPath);
  let probe = await probeDaemon(baseUrl);
  if (probe.state === "ready") {
    return baseUrl;
  }
  if (probe.state === "incompatible") {
    await stopIncompatibleDaemon(baseUrl, probe.pid);
    probe = await probeDaemon(baseUrl);
  }
  if (probe.state === "unreachable") {
    spawnDaemon(cliEntrypoint, resolvedConfigPath);
  }

  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt += 1) {
    await sleep(DAEMON_START_RETRY_DELAY_MS);
    probe = await probeDaemon(baseUrl);
    if (probe.state === "ready") {
      return baseUrl;
    }
    if (probe.state === "incompatible") {
      await stopIncompatibleDaemon(baseUrl, probe.pid);
      probe = await probeDaemon(baseUrl);
      if (probe.state === "unreachable") {
        spawnDaemon(cliEntrypoint, resolvedConfigPath);
      }
    }
  }

  throw new Error(`Timed out waiting for daemon at ${baseUrl}`);
}

export async function getJson<T>(
  cliEntrypoint: string,
  path: string,
  configPath?: string,
): Promise<T> {
  const baseUrl = await ensureServer(cliEntrypoint, configPath);
  return requestJson<T>(baseUrl, path);
}

export async function postJson<T>(
  cliEntrypoint: string,
  path: string,
  body: unknown,
  configPath?: string,
): Promise<T> {
  const baseUrl = await ensureServer(cliEntrypoint, configPath);
  return requestJson<T>(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteJson<T>(
  cliEntrypoint: string,
  path: string,
  configPath?: string,
): Promise<T> {
  const baseUrl = await ensureServer(cliEntrypoint, configPath);
  return requestJson<T>(baseUrl, path, { method: "DELETE" });
}

export async function postPreflight(
  cliEntrypoint: string,
  projectId: string,
  body: Omit<PreflightRequest, "project">,
  configPath?: string,
): Promise<PreflightResponse> {
  return postJson<PreflightResponse>(
    cliEntrypoint,
    `/projects/${encodeURIComponent(projectId)}/preflight`,
    body,
    configPath,
  );
}

export function listProjects(
  cliEntrypoint: string,
  configPath?: string,
): Promise<ProjectListEntry[]> {
  return getJson<ProjectListEntry[]>(cliEntrypoint, "/projects", configPath);
}

export function connectProjectConfig(
  cliEntrypoint: string,
  projectConfigPath: string,
  configPath?: string,
): Promise<ProjectConfigMutationResponse> {
  return postJson<ProjectConfigMutationResponse>(
    cliEntrypoint,
    "/projects/connect",
    { configPath: projectConfigPath } satisfies ConnectProjectConfigRequest,
    configPath,
  );
}

export function disconnectProjectConfig(
  cliEntrypoint: string,
  projectConfigPath: string,
  configPath?: string,
): Promise<ProjectConfigMutationResponse> {
  return postJson<ProjectConfigMutationResponse>(
    cliEntrypoint,
    "/projects/disconnect",
    { configPath: projectConfigPath } satisfies DisconnectProjectConfigRequest,
    configPath,
  );
}
