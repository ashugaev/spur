import { NextResponse } from "next/server";
import { spurRequest } from "@/lib/spur-daemon";

// Shared forwarder for `/p/<id>/...` and `/api/stores/<store>/...`: origin guard on
// mutations, JSON-only bodies, streamed responses, pinned SSE headers.

export const SSE_RESPONSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
} as const;

const MUTATING = new Set(["POST", "PATCH", "DELETE"]);
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control"] as const;

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 403 for a cross-site mutation, 415 for a non-JSON body; null when the request may pass. */
export function checkMutationGuard(request: Request): Response | null {
  if (!MUTATING.has(request.method)) return null;
  const headers = request.headers;
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    if (fetchSite !== "same-origin" && fetchSite !== "none") {
      return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    }
  } else {
    const origin = headers.get("origin");
    if (origin !== null) {
      const host = headers.get("x-forwarded-host") ?? headers.get("host");
      const originHost = hostnameOf(origin);
      if (!host || !originHost || originHost !== hostnameOf(host.split(",")[0]?.trim() ?? "")) {
        return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
      }
    }
  }
  if (request.method !== "DELETE") {
    const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }
  return null;
}

export interface ForwardOptions {
  /** Rewrites a JSON request body before forwarding (page invoke source). */
  transformBody?: (body: unknown) => unknown;
}

export async function forwardToDaemon(
  request: Request,
  daemonPath: string,
  options: ForwardOptions = {},
): Promise<Response> {
  const guard = checkMutationGuard(request);
  if (guard) return guard;
  const search = new URL(request.url).search;
  const headers: Record<string, string> = {};
  for (const name of ["accept", "last-event-id", "content-type"]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  let body: string | undefined;
  if (request.method === "POST" || request.method === "PATCH") {
    body = await request.text();
    if (options.transformBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
      }
      body = JSON.stringify(options.transformBody(parsed));
    }
  }
  let upstream: Response;
  try {
    upstream = await spurRequest(`${daemonPath}${search}`, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: request.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spur daemon unreachable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  const isStream = upstream.headers.get("content-type")?.startsWith("text/event-stream") === true;
  const responseHeaders = new Headers();
  if (isStream) {
    for (const [name, value] of Object.entries(SSE_RESPONSE_HEADERS))
      responseHeaders.set(name, value);
  } else {
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    if (!responseHeaders.has("cache-control")) responseHeaders.set("cache-control", "no-store");
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
