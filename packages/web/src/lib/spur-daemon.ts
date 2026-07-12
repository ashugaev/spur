import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const DEFAULT_SPUR_DAEMON_URL = "http://127.0.0.1:4310";
const DEFAULT_SPUR_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");

interface SpurInstanceShape {
  server?: {
    host?: string;
    port?: number;
  };
}

function resolveConfigPath(): string {
  const candidate = process.env["SPUR_CONFIG"]?.trim();
  if (!candidate) {
    return DEFAULT_SPUR_CONFIG_PATH;
  }
  if (candidate.startsWith("~/")) {
    return join(homedir(), candidate.slice(2));
  }
  return candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
}

function daemonBaseUrlFromConfig(): string | null {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as SpurInstanceShape | null;
  const host = parsed?.server?.host?.trim();
  const port = parsed?.server?.port;
  if (!host || typeof port !== "number" || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return `http://${host}:${port}`;
}

function daemonBaseUrl(): string {
  return (
    process.env["SPUR_DAEMON_URL"]?.replace(/\/+$/, "") ||
    daemonBaseUrlFromConfig() ||
    DEFAULT_SPUR_DAEMON_URL
  );
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

export async function spurRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemonBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "x-spur-origin": "ui",
    },
    cache: "no-store",
  });
}

export async function spurRequestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await spurRequest(path, init);
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new Error("Spur daemon returned invalid JSON");
      }
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error?: unknown }).error ?? "Spur daemon request failed")
        : `Spur daemon request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export function spurJsonInit(method: "PATCH" | "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: jsonHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}
