const DEFAULT_SPUR_DAEMON_URL = "http://127.0.0.1:4310";

function daemonBaseUrl(): string {
  return (process.env["SPUR_DAEMON_URL"] ?? DEFAULT_SPUR_DAEMON_URL).replace(/\/+$/, "");
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

export async function spurRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${daemonBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  return response;
}

export async function spurRequestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await spurRequest(path, init);
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error?: unknown }).error ?? "Spur daemon request failed")
        : `Spur daemon request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export function spurJsonInit(method: "POST", body?: unknown): RequestInit {
  return {
    method,
    headers: jsonHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

