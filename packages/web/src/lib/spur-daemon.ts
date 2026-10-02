// The daemon URL must be resolved before a route handler runs: web-server.ts
// defaults SPUR_DAEMON_URL from the Spur instance config at boot, and the
// Playwright harness sets it to an isolated target. No fallback here — a
// default would silently retarget an unresolved process at the host's
// production daemon.
function daemonBaseUrl(): string {
  const resolved = process.env["SPUR_DAEMON_URL"]?.trim().replace(/\/+$/, "");
  if (!resolved) {
    throw new Error("SPUR_DAEMON_URL is not set");
  }
  return resolved;
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

export class SpurDaemonError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "SpurDaemonError";
    this.status = status;
    this.payload = payload;
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
    throw new SpurDaemonError(message, response.status, payload);
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
