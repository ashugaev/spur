import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_MAX_CONNECTIONS,
  WEBHOOK_MAX_IN_FLIGHT,
  WEBHOOK_MAX_IN_FLIGHT_PER_PEER,
  WEBHOOK_MAX_JSON_DEPTH,
  WEBHOOK_MAX_REQUESTS_PER_PEER,
  WEBHOOK_MAX_TRACKED_PEERS,
  WEBHOOK_RATE_WINDOW_MS,
  webhookSourceModule,
} from "../../src/event-sources/webhook.js";
import type { SourceHandle } from "../../src/event-sources/types.js";

const SECRET = "0123456789abcdef";
const handles: SourceHandle[] = [];

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startSource(options?: {
  emit?: (name: string, data?: unknown) => void;
  port?: number;
  signal?: AbortSignal;
}): Promise<{ port: number; handle: SourceHandle }> {
  const port = options?.port ?? (await freePort());
  const handle = await webhookSourceModule.start({
    sourceId: "incoming",
    projectId: "api",
    dataDir: "/tmp",
    config: {
      type: "webhook",
      host: "127.0.0.1",
      port,
      path: "/hook",
      secret: SECRET,
    },
    listSessions: vi.fn().mockResolvedValue([]),
    emit: options?.emit ?? vi.fn(),
    signal: options?.signal ?? new AbortController().signal,
    logger: {},
    resolveWebBaseUrl: vi.fn().mockResolvedValue(null),
  });
  handles.push(handle);
  return { port, handle };
}

async function request(options: {
  port: number;
  path?: string;
  method?: string;
  body?: string | Buffer;
  headers?: Record<string, string | string[]>;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  const body = options.body ?? "{}";
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/hook",
        method: options.method ?? "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...options.headers,
        },
        agent: false,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
          }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

async function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let output = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(raw));
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(output));
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  vi.restoreAllMocks();
});

describe("webhookSourceModule", () => {
  it("exports the fixed resource limits", () => {
    expect({
      WEBHOOK_MAX_BODY_BYTES,
      WEBHOOK_MAX_CONNECTIONS,
      WEBHOOK_MAX_IN_FLIGHT,
      WEBHOOK_MAX_IN_FLIGHT_PER_PEER,
      WEBHOOK_MAX_JSON_DEPTH,
      WEBHOOK_MAX_REQUESTS_PER_PEER,
      WEBHOOK_MAX_TRACKED_PEERS,
      WEBHOOK_RATE_WINDOW_MS,
    }).toEqual({
      WEBHOOK_MAX_BODY_BYTES: 262_144,
      WEBHOOK_MAX_CONNECTIONS: 64,
      WEBHOOK_MAX_IN_FLIGHT: 32,
      WEBHOOK_MAX_IN_FLIGHT_PER_PEER: 8,
      WEBHOOK_MAX_JSON_DEPTH: 64,
      WEBHOOK_MAX_REQUESTS_PER_PEER: 60,
      WEBHOOK_MAX_TRACKED_PEERS: 1_024,
      WEBHOOK_RATE_WINDOW_MS: 60_000,
    });
  });

  it("emits normalized object JSON and closes the response", async () => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });
    const body =
      '{"10":"ten","2":"two","__proto__":{"safe":true},"constructor":1,"β":2,"α":3,"nested":{"10":10,"2":2}}';

    const response = await request({ port, body });

    expect(response.status).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.connection).toBe("close");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("webhook:received", {
      body: JSON.stringify(JSON.parse(body)),
      receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it.each([
    ["unknown path", { path: "/hook?query=1" }, 404],
    ["missing auth", { headers: { Authorization: [] } }, 404],
    ["wrong auth", { headers: { Authorization: "Bearer wrong-secret-value" } }, 404],
    ["wrong method", { method: "PUT" }, 405],
    ["missing media type", { headers: { "Content-Type": [] } }, 415],
    ["suffix JSON", { headers: { "Content-Type": "application/problem+json" } }, 415],
    ["extra media parameter", { headers: { "Content-Type": "application/json; version=1" } }, 415],
    ["non-UTF-8 charset", { headers: { "Content-Type": "application/json; charset=latin1" } }, 415],
    ["content encoding", { headers: { "Content-Encoding": "gzip" } }, 415],
    ["empty body", { body: "" }, 400],
    ["array body", { body: "[]" }, 400],
    ["invalid JSON", { body: "{" }, 400],
    ["oversized declared body", { body: "", headers: { "Content-Length": "262145" } }, 413],
  ])("rejects %s", async (_name, overrides, status) => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });
    const response = await request({ port, ...(overrides as object) });
    expect(response.status).toBe(status);
    expect(emit).not.toHaveBeenCalled();
  });

  it("accepts the exact JSON media grammar and identity encoding", async () => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });

    await expect(
      request({
        port,
        headers: {
          "Content-Type": 'Application/JSON ; charset = "UTF-8"',
          "Content-Encoding": "IDENTITY",
        },
      }),
    ).resolves.toMatchObject({ status: 202 });
  });

  it("rejects invalid UTF-8 and excessive JSON depth", async () => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });
    const invalidUtf8 = await request({ port, body: Buffer.from([0xc3, 0x28]) });
    let deep = "{}";
    for (let index = 1; index < WEBHOOK_MAX_JSON_DEPTH; index += 1) deep = `{"x":${deep}}`;
    const acceptedDepth = await request({ port, body: deep });
    const tooDeep = await request({ port, body: `{"x":${deep}}` });

    expect(invalidUtf8.status).toBe(400);
    expect(acceptedDepth.status).toBe(202);
    expect(tooDeep.status).toBe(400);
  });

  it("owns parser errors and Expect handling", async () => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });
    const duplicateLength = await rawRequest(
      port,
      `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}`,
    );
    const deniedContinue = await rawRequest(
      port,
      "POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer wrong-secret-value\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n",
    );
    const acceptedContinue = await rawRequest(
      port,
      `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n{}`,
    );
    const unsupported = await rawRequest(
      port,
      `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: magic\r\n\r\n`,
    );

    expect(duplicateLength).toContain("400 Bad Request");
    expect(duplicateLength).toContain("Cache-Control: no-store");
    expect(deniedContinue).toContain("404 Not Found");
    expect(deniedContinue).not.toContain("100 Continue");
    expect(acceptedContinue).toContain("100 Continue");
    expect(acceptedContinue).toContain("202 Accepted");
    expect(unsupported).toContain("417 Expectation Failed");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate authorization and never accepts a pipelined second request", async () => {
    const emit = vi.fn();
    const { port } = await startSource({ emit });
    const duplicateAuth = await rawRequest(
      port,
      `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`,
    );
    const oneRequest = `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
    const pipelined = await rawRequest(port, oneRequest + oneRequest);

    expect(duplicateAuth).toContain("404 Not Found");
    expect(pipelined.match(/202 Accepted/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("returns 500 when synchronous emission throws", async () => {
    const { port } = await startSource({
      emit: () => {
        throw new Error("private failure");
      },
    });

    await expect(request({ port })).resolves.toMatchObject({ status: 500 });
  });

  it("rate-limits every request after the fixed peer window", async () => {
    const { port } = await startSource();
    for (let count = 0; count < WEBHOOK_MAX_REQUESTS_PER_PEER; count += 1) {
      const response = await request({ port });
      expect(response.status).toBe(202);
    }
    const limited = await request({ port });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects occupied ports and releases its bind on idempotent stop", async () => {
    const port = await freePort();
    const first = await startSource({ port });
    await expect(startSource({ port })).rejects.toMatchObject({ code: "EADDRINUSE" });

    await first.handle.stop();
    await first.handle.stop();
    const replacement = await startSource({ port });
    await expect(request({ port })).resolves.toMatchObject({ status: 202 });
    await replacement.handle.stop();
  });

  it("aborts a held body without emission or success", async () => {
    const controller = new AbortController();
    const emit = vi.fn();
    const { port } = await startSource({ emit, signal: controller.signal });
    const pending = rawRequest(
      port,
      `POST /hook HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const output = await pending;
    expect(output).not.toContain("202 Accepted");
    expect(emit).not.toHaveBeenCalled();
  });

  it("suppresses success when emission stops the source reentrantly", async () => {
    const handleRef: { current?: SourceHandle } = {};
    const emit = vi.fn(() => {
      void handleRef.current?.stop();
    });
    const started = await startSource({ emit });
    handleRef.current = started.handle;

    const status = await request({ port: started.port })
      .then((response) => response.status)
      .catch(() => 0);

    expect(status).not.toBe(202);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
