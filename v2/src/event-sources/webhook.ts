import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  WEBHOOK_RECEIVED_EVENT,
  type WebhookReceivedEventData,
  type WebhookSourceConfig,
} from "../types.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";

export const WEBHOOK_MAX_BODY_BYTES = 262_144;
export const WEBHOOK_BODY_TIMEOUT_MS = 15_000;
export const WEBHOOK_HEADERS_TIMEOUT_MS = 15_000;
export const WEBHOOK_MAX_CONNECTIONS = 64;
export const WEBHOOK_MAX_IN_FLIGHT = 32;
export const WEBHOOK_MAX_IN_FLIGHT_PER_PEER = 8;
export const WEBHOOK_RATE_WINDOW_MS = 60_000;
export const WEBHOOK_MAX_REQUESTS_PER_PEER = 60;
export const WEBHOOK_MAX_TRACKED_PEERS = 1_024;
export const WEBHOOK_MAX_JSON_DEPTH = 64;
export const WEBHOOK_RESPONSE_FLUSH_TIMEOUT_MS = 1_000;

interface RateWindow {
  count: number;
  startedAt: number;
}

type RequestMode = "normal" | "continue" | "unsupported";
type BodyResult = { ok: true; body: Buffer } | { ok: false; status?: number };

function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function isJsonContentType(value: string): boolean {
  return /^application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(
    value,
  );
}

function validateJsonTree(value: unknown, depth: number): boolean {
  if (depth > WEBHOOK_MAX_JSON_DEPTH) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.every((entry) => validateJsonTree(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value).every((entry) => validateJsonTree(entry, depth + 1));
  }
  return false;
}

function normalizeJsonObject(body: Buffer): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
  if (text.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!validateJsonTree(parsed, 1)) return undefined;
  return JSON.stringify(parsed);
}

async function startWebhookSource(
  deps: SourceStartDeps<WebhookSourceConfig>,
): Promise<SourceHandle> {
  if (deps.signal.aborted) {
    throw new Error(`Webhook source ${deps.projectId}/${deps.sourceId} cannot start after abort`);
  }

  const expectedAuthorizationDigest = createHash("sha256")
    .update(`Bearer ${deps.config.secret}`)
    .digest();
  const sockets = new Set<Socket>();
  const seenRequestSockets = new WeakSet<Socket>();
  const bodyTimers = new Set<NodeJS.Timeout>();
  const responseTimers = new Set<NodeJS.Timeout>();
  const rateWindows = new Map<string, RateWindow>();
  const inFlightByPeer = new Map<string, number>();
  let inFlight = 0;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const sourceIsStopping = (): boolean => stopping;

  const server = createServer();
  server.headersTimeout = WEBHOOK_HEADERS_TIMEOUT_MS;
  server.maxConnections = WEBHOOK_MAX_CONNECTIONS;

  function clearTrackedTimer(timer: NodeJS.Timeout, timers: Set<NodeJS.Timeout>): void {
    clearTimeout(timer);
    timers.delete(timer);
  }

  function closeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    headers: Record<string, string> = {},
  ): void {
    request.pause();
    if (response.destroyed || request.socket.destroyed) return;
    response.writeHead(status, {
      "Cache-Control": "no-store",
      Connection: "close",
      "Content-Length": "0",
      ...headers,
    });
    const timer = setTimeout(() => request.socket.destroy(), WEBHOOK_RESPONSE_FLUSH_TIMEOUT_MS);
    responseTimers.add(timer);
    request.socket.once("close", () => clearTrackedTimer(timer, responseTimers));
    response.once("finish", () => request.socket.end());
    response.end();
  }

  function authorizationMatches(request: IncomingMessage): boolean {
    const values = headerValues(request, "authorization");
    if (values.length !== 1) return false;
    const receivedDigest = createHash("sha256")
      .update(values[0] ?? "")
      .digest();
    return timingSafeEqual(expectedAuthorizationDigest, receivedDigest);
  }

  function admit(
    peer: string,
  ): { accepted: true; release(): void } | { accepted: false; retryAfter?: number } {
    const now = Date.now();
    for (const [key, window] of rateWindows) {
      if (now - window.startedAt >= WEBHOOK_RATE_WINDOW_MS) rateWindows.delete(key);
    }

    let window = rateWindows.get(peer);
    if (!window) {
      if (rateWindows.size >= WEBHOOK_MAX_TRACKED_PEERS) return { accepted: false };
      window = { count: 0, startedAt: now };
      rateWindows.set(peer, window);
    }
    if (window.count >= WEBHOOK_MAX_REQUESTS_PER_PEER) {
      return {
        accepted: false,
        retryAfter: Math.max(
          1,
          Math.ceil((WEBHOOK_RATE_WINDOW_MS - (now - window.startedAt)) / 1_000),
        ),
      };
    }
    window.count += 1;

    const peerInFlight = inFlightByPeer.get(peer) ?? 0;
    if (inFlight >= WEBHOOK_MAX_IN_FLIGHT || peerInFlight >= WEBHOOK_MAX_IN_FLIGHT_PER_PEER) {
      return { accepted: false };
    }
    inFlight += 1;
    inFlightByPeer.set(peer, peerInFlight + 1);
    let released = false;
    return {
      accepted: true,
      release(): void {
        if (released) return;
        released = true;
        inFlight = Math.max(0, inFlight - 1);
        const remaining = (inFlightByPeer.get(peer) ?? 1) - 1;
        if (remaining > 0) inFlightByPeer.set(peer, remaining);
        else inFlightByPeer.delete(peer);
      },
    };
  }

  function readBody(request: IncomingMessage): Promise<BodyResult> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;

      const finish = (result: BodyResult): void => {
        if (settled) return;
        settled = true;
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("aborted", onAborted);
        request.off("error", onError);
        request.socket.off("close", onClose);
        clearTrackedTimer(timer, bodyTimers);
        resolve(result);
      };
      const onData = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > WEBHOOK_MAX_BODY_BYTES) {
          request.pause();
          finish({ ok: false, status: 413 });
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks) });
      const onAborted = (): void => finish({ ok: false });
      const onError = (): void => finish({ ok: false });
      const onClose = (): void => finish({ ok: false });
      const timer = setTimeout(() => {
        request.pause();
        finish({ ok: false, status: 408 });
      }, WEBHOOK_BODY_TIMEOUT_MS);
      bodyTimers.add(timer);
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("aborted", onAborted);
      request.once("error", onError);
      request.socket.once("close", onClose);
    });
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    mode: RequestMode,
  ): Promise<void> {
    const receivedAt = new Date().toISOString();
    const peer = request.socket.remoteAddress ?? "unknown";
    if (seenRequestSockets.has(request.socket)) {
      request.socket.destroy();
      return;
    }
    seenRequestSockets.add(request.socket);
    if (sourceIsStopping()) {
      closeResponse(request, response, 503);
      return;
    }

    const admission = admit(peer);
    if (!admission.accepted) {
      closeResponse(
        request,
        response,
        429,
        admission.retryAfter === undefined ? {} : { "Retry-After": String(admission.retryAfter) },
      );
      return;
    }

    try {
      if (sourceIsStopping()) {
        closeResponse(request, response, 503);
        return;
      }
      if (request.url !== deps.config.path || !authorizationMatches(request)) {
        closeResponse(request, response, 404);
        return;
      }
      if (mode === "unsupported") {
        closeResponse(request, response, 417);
        return;
      }
      if (request.method !== "POST") {
        closeResponse(request, response, 405, { Allow: "POST" });
        return;
      }

      const contentTypes = headerValues(request, "content-type");
      if (contentTypes.length !== 1 || !isJsonContentType(contentTypes[0] ?? "")) {
        closeResponse(request, response, 415);
        return;
      }
      const contentEncodings = headerValues(request, "content-encoding");
      if (
        contentEncodings.length > 1 ||
        (contentEncodings.length === 1 && contentEncodings[0]?.toLowerCase() !== "identity")
      ) {
        closeResponse(request, response, 415);
        return;
      }

      const contentLengths = headerValues(request, "content-length");
      if (contentLengths.length > 1) {
        closeResponse(request, response, 400);
        return;
      }
      if (contentLengths.length === 1) {
        const value = contentLengths[0] ?? "";
        if (!/^\d+$/.test(value)) {
          closeResponse(request, response, 400);
          return;
        }
        if (Number(value) > WEBHOOK_MAX_BODY_BYTES) {
          closeResponse(request, response, 413);
          return;
        }
      }

      if (mode === "continue") response.writeContinue();
      const result = await readBody(request);
      if (!result.ok) {
        if (result.status !== undefined) closeResponse(request, response, result.status);
        else request.socket.destroy();
        return;
      }
      const body = normalizeJsonObject(result.body);
      if (body === undefined) {
        closeResponse(request, response, 400);
        return;
      }
      if (sourceIsStopping()) {
        closeResponse(request, response, 503);
        return;
      }

      const data: WebhookReceivedEventData = { body, receivedAt };
      deps.emit(WEBHOOK_RECEIVED_EVENT, data);
      if (sourceIsStopping()) {
        closeResponse(request, response, 503);
        return;
      }
      closeResponse(request, response, 202);
    } catch {
      if (sourceIsStopping()) closeResponse(request, response, 503);
      else closeResponse(request, response, 500);
    } finally {
      admission.release();
    }
  }

  server.on("request", (request, response) => {
    void handleRequest(request, response, "normal");
  });
  server.on("checkContinue", (request, response) => {
    void handleRequest(request, response, "continue");
  });
  server.on("checkExpectation", (request, response) => {
    void handleRequest(request, response, "unsupported");
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.destroyed) {
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    socket.end();
    const timer = setTimeout(() => socket.destroy(), WEBHOOK_RESPONSE_FLUSH_TIMEOUT_MS);
    responseTimers.add(timer);
    socket.once("close", () => clearTrackedTimer(timer, responseTimers));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    deps.signal.removeEventListener("abort", abortHandler);
    for (const timer of bodyTimers) clearTimeout(timer);
    bodyTimers.clear();
    for (const timer of responseTimers) clearTimeout(timer);
    responseTimers.clear();
    rateWindows.clear();
    inFlightByPeer.clear();
    inFlight = 0;
    stopPromise = new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });
    return stopPromise;
  };
  const abortHandler = (): void => {
    void stop();
  };
  deps.signal.addEventListener("abort", abortHandler, { once: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        const wrapped = new Error(
          `Webhook source ${deps.projectId}/${deps.sourceId} failed to bind ${deps.config.host}:${deps.config.port}`,
          { cause: error },
        ) as Error & { code?: string };
        if (error.code !== undefined) wrapped.code = error.code;
        reject(wrapped);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: deps.config.host, port: deps.config.port });
    });
  } catch (error) {
    await stop();
    throw error;
  }

  if (sourceIsStopping()) {
    await stop();
    throw new Error(`Webhook source ${deps.projectId}/${deps.sourceId} stopped during startup`);
  }

  deps.logger.info?.(
    `[source:${deps.projectId}/${deps.sourceId}] webhook listening on ${deps.config.host}:${deps.config.port}${deps.config.path}`,
  );

  return { stop };
}

export const webhookSourceModule = {
  type: "webhook",
  start: startWebhookSource,
} satisfies SourceModule<WebhookSourceConfig>;
