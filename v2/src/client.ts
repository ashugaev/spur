import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { SPUR_DAEMON_API_VERSION, type RuntimeInfo } from "./types.js";

const DAEMON_STOP_ATTEMPTS = 20;
const DAEMON_STOP_RETRY_DELAY_MS = 100;
const DAEMON_START_ATTEMPTS = 80;
const DAEMON_START_RETRY_DELAY_MS = 250;

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
  const payload = text ? (JSON.parse(text) as unknown) : {};
  return { response, payload };
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const { response, payload } = await fetchJson(baseUrl, path, init);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: string }).error)
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

export type DaemonProbe =
  | { state: "ready"; info: RuntimeInfo }
  | { state: "incompatible"; pid?: number }
  | { state: "starting" }
  | { state: "unreachable" };

function hasSpurRuntimeShape(payload: unknown): payload is RuntimeInfo {
  if (!payload || typeof payload !== "object") return false;
  const runtime = payload as Partial<RuntimeInfo>;
  return (
    runtime.ok === true &&
    typeof runtime.pid === "number" &&
    typeof runtime.host === "string" &&
    typeof runtime.port === "number" &&
    typeof runtime.dataDir === "string" &&
    typeof runtime.worktreeDir === "string" &&
    typeof runtime.configPath === "string" &&
    typeof runtime.startedAt === "string"
  );
}

export function readDaemonPid(payload: unknown): number | undefined {
  return hasSpurRuntimeShape(payload) ? payload.pid : undefined;
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
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = {};
      }
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

async function waitForReadyDaemon(baseUrl: string): Promise<RuntimeInfo | undefined> {
  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt += 1) {
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

  spawnDaemon(cliEntrypoint, resolvedConfigPath);
  const runtime = await waitForReadyDaemon(baseUrl);
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
