import type { IncomingMessage, ServerResponse } from "node:http";

// Server-sent event streams. Headers keep proxies (nginx, Next) from buffering or
// transforming the stream.
export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
} as const;

export const SSE_MAX_STREAMS = 64;
export const SSE_HEARTBEAT_MS = 15_000;

export function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = request.headers.accept ?? "";
  return accept.split(",").some((part) => part.trim().split(";")[0] === "text/event-stream");
}

export interface SseStream {
  readonly closed: boolean;
  send(event: string, data: unknown, id?: number): void;
  close(): void;
  onClose(listener: () => void): void;
}

export class SseHub {
  private readonly streams = new Set<SseStream>();

  constructor(private readonly options: { maxStreams?: number; heartbeatMs?: number } = {}) {}

  get size(): number {
    return this.streams.size;
  }

  /** Opens a stream, or answers 503 and returns null when the cap is reached. */
  open(request: IncomingMessage, response: ServerResponse): SseStream | null {
    if (this.streams.size >= (this.options.maxStreams ?? SSE_MAX_STREAMS)) {
      const body = JSON.stringify({ error: "Too many open event streams" }) + "\n";
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
      return null;
    }
    response.writeHead(200, SSE_HEADERS);
    response.write(": open\n\n");
    const closeListeners: Array<() => void> = [];
    let closed = false;
    const heartbeat = setInterval(() => {
      if (closed) return;
      response.write(": ping\n\n");
    }, this.options.heartbeatMs ?? SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const stream: SseStream = {
      get closed() {
        return closed;
      },
      send(event, data, id) {
        if (closed) return;
        const idLine = id === undefined ? "" : `id: ${id}\n`;
        response.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        this.streams.delete(stream);
        if (!response.writableEnded) response.end();
        for (const listener of closeListeners.splice(0)) listener();
      },
      onClose(listener) {
        if (closed) listener();
        else closeListeners.push(listener);
      },
    };
    this.streams.add(stream);
    request.once("close", () => stream.close());
    response.once("close", () => stream.close());
    return stream;
  }

  closeAll(): void {
    for (const stream of [...this.streams]) stream.close();
  }
}
