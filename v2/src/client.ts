import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import type { RuntimeInfo } from "./types.js";

function createBaseUrl(configPath?: string): { baseUrl: string; configPath: string } {
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

type DaemonProbe =
  | { state: "ready"; info: RuntimeInfo }
  | { state: "starting" }
  | { state: "unreachable" };

async function probeDaemon(baseUrl: string): Promise<DaemonProbe> {
  try {
    const { response, payload } = await fetchJson(baseUrl, "/info");
    if (response.status === 503) {
      return { state: "starting" };
    }
    if (!response.ok) {
      return { state: "unreachable" };
    }

    return { state: "ready", info: payload as RuntimeInfo };
  } catch {
    return { state: "unreachable" };
  }
}

export async function ensureServer(
  cliEntrypoint: string,
  configPath?: string,
): Promise<string> {
  const { baseUrl, configPath: resolvedConfigPath } = createBaseUrl(configPath);
  const initialProbe = await probeDaemon(baseUrl);
  if (initialProbe.state === "ready") {
    return baseUrl;
  }

  if (initialProbe.state === "unreachable") {
    const child = spawn(
      process.execPath,
      [cliEntrypoint, "--config", resolvedConfigPath, "daemon", "start"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    const probe = await probeDaemon(baseUrl);
    if (probe.state === "ready") {
      return baseUrl;
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
