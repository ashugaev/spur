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

export class SpurDaemonError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SpurDaemonError";
    this.status = status;
  }
}

export function isSpurDaemonError(error: unknown): error is SpurDaemonError {
  return error instanceof SpurDaemonError;
}

// timeoutMs is opt-in per call: most spurRequest callers proxy an operation
// the daemon itself already bounds (spawn, kill, restore, ...), so a blanket
// timeout here would risk cutting those off mid-flight. Callers whose daemon
// route can hang on an unbounded external call (e.g. spawn-defaults shelling
// out to `cursor models`) pass one explicitly instead.
export type SpurRequestInit = RequestInit & { timeoutMs?: number };

export async function spurRequest(path: string, init?: SpurRequestInit): Promise<Response> {
  const { timeoutMs, signal, ...requestInit } = init ?? {};
  return fetch(`${daemonBaseUrl()}${path}`, {
    ...requestInit,
    headers: {
      ...(requestInit.headers ?? {}),
      "x-spur-origin": "ui",
    },
    cache: "no-store",
    signal: timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : signal,
  });
}

export async function spurRequestJson<T>(path: string, init?: SpurRequestInit): Promise<T> {
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
    throw new SpurDaemonError(message, response.status);
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
