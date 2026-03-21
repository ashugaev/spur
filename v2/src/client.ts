import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { SPUR_DAEMON_API_VERSION, type RuntimeInfo } from "./types.js";

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

export function readDaemonPid(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const pid = (payload as { pid?: unknown }).pid;
  return typeof pid === "number" ? pid : undefined;
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
    const { response, payload } = await fetchJson(baseUrl, "/info");
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

async function stopIncompatibleDaemon(baseUrl: string, pid?: number): Promise<void> {
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    const probe = await probeDaemon(baseUrl);
    if (probe.state === "unreachable") {
      return;
    }
    if (probe.state === "ready" && probe.info.pid !== pid) {
      return;
    }
    if (probe.state === "incompatible" && probe.pid !== pid) {
      return;
    }
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

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
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
