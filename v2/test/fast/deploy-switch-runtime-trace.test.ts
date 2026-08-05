import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReleasesCacheForTest } from "../../src/releases-cache.js";
import { findFreePort } from "../helpers/common.js";

const CURRENT_VERSION = "0.2.0";
const RECONNECT_DELAY_MS = 1_000;
const API_POLL_INTERVAL_MS = 50;
const HELPER_OUTAGE_MS = 250;

interface DeploySwitchRuntimeTraceEvent {
  kind: string;
  atMs: number;
  iso: string;
  status?: number;
  error?: string;
  attempt?: number;
  version?: string;
}

interface DeploySwitchRuntimeTrace {
  mode: "restart" | "no-restart";
  currentVersion: string;
  helperSpawnCount: number;
  deployStatus?: number;
  apiPolls: { ok: number; unavailable: number };
  ws: { opens: number; closes: number; reconnectDelayMs: number };
  events: DeploySwitchRuntimeTraceEvent[];
}

interface StoppableServer {
  stop(): Promise<void>;
}

let onHelperSpawn: ((version: string) => void) | null = null;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  return {
    ...actual,
    spawn: (
      command: string,
      args: ReadonlyArray<string>,
      options: { detached?: boolean; stdio?: unknown },
    ) => {
      if (command === "bash" && options.detached === true) {
        const version = args[1];
        if (typeof version === "string") onHelperSpawn?.(version);
      }
      const fake = new EventEmitter() as EventEmitter & { unref: () => void };
      fake.unref = () => undefined;
      return fake;
    },
  };
});

vi.mock("../../src/version.js", () => ({
  getVersion: () => CURRENT_VERSION,
}));

function traceEvent(
  trace: DeploySwitchRuntimeTrace,
  event: Omit<DeploySwitchRuntimeTraceEvent, "atMs" | "iso">,
): void {
  trace.events.push({
    ...event,
    atMs: Number(performance.now().toFixed(3)),
    iso: new Date().toISOString(),
  });
}

function registryResponse(versions: ReadonlyArray<string>): Response {
  const doc = {
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
    time: Object.fromEntries(versions.map((version) => [version, "2026-01-01T00:00:00.000Z"])),
  };
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function websocketAcceptKey(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

async function setupConfig(port: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spur-deploy-switch-runtime-"));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "data");
  const worktreeDir = join(root, "worktrees");
  await mkdir(repoDir, { recursive: true });
  const configPath = join(root, "spur.yaml");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      `dataDir: ${dataDir}`,
      `worktreeDir: ${worktreeDir}`,
      "projects:",
      "  demo:",
      `    path: ${repoDir}`,
    ].join("\n"),
    "utf8",
  );
  return configPath;
}

async function startTraceWsServer(
  port: number,
  trace: DeploySwitchRuntimeTrace,
): Promise<StoppableServer> {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    if (!request.url?.startsWith("/ws?session=")) {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      traceEvent(trace, { kind: "ws.server.up" });
      resolve();
    });
  });
  return {
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await closeHttpServer(server);
      traceEvent(trace, { kind: "ws.server.down" });
    },
  };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function startTraceWsClient(port: number, trace: DeploySwitchRuntimeTrace): { stop(): void } {
  let mounted = true;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const connect = () => {
    if (!mounted) return;
    attempt += 1;
    traceEvent(trace, { kind: "ws.connect", attempt });
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?session=trace`);
    socket.addEventListener("open", () => {
      trace.ws.opens += 1;
      traceEvent(trace, { kind: "ws.open", attempt });
    });
    socket.addEventListener("close", () => {
      if (!mounted) return;
      trace.ws.closes += 1;
      traceEvent(trace, { kind: "ws.close", attempt });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, RECONNECT_DELAY_MS);
      traceEvent(trace, { kind: "ws.reconnect.scheduled", attempt });
    });
    socket.addEventListener("error", () => {
      traceEvent(trace, { kind: "ws.error", attempt });
    });
  };

  connect();
  return {
    stop: () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for runtime trace condition");
}

async function pollApi(
  baseUrl: string,
  trace: DeploySwitchRuntimeTrace,
  stopped: () => boolean,
): Promise<void> {
  while (!stopped()) {
    try {
      const response = await fetch(`${baseUrl}/info`);
      if (response.ok) trace.apiPolls.ok += 1;
      else trace.apiPolls.unavailable += 1;
      traceEvent(trace, { kind: "api.poll", status: response.status });
    } catch (error) {
      trace.apiPolls.unavailable += 1;
      traceEvent(trace, {
        kind: "api.poll",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await delay(API_POLL_INTERVAL_MS);
  }
}

async function runTrace(mode: DeploySwitchRuntimeTrace["mode"]): Promise<DeploySwitchRuntimeTrace> {
  const { startServer } = await import("../../src/server.js");
  const originalFetch = globalThis.fetch;
  const daemonPort = await findFreePort();
  const wsPort = await findFreePort();
  const configPath = await setupConfig(daemonPort);
  const baseUrl = `http://127.0.0.1:${daemonPort}`;
  let daemon: StoppableServer | null = null;
  let wsServer: StoppableServer | null = null;
  let pollStopped = false;
  let helperDone: Promise<void> | null = null;
  const trace: DeploySwitchRuntimeTrace = {
    mode,
    currentVersion: CURRENT_VERSION,
    helperSpawnCount: 0,
    apiPolls: { ok: 0, unavailable: 0 },
    ws: { opens: 0, closes: 0, reconnectDelayMs: RECONNECT_DELAY_MS },
    events: [],
  };

  try {
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("registry.npmjs.org")) {
        return registryResponse([CURRENT_VERSION, "0.1.0"]);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    daemon = await startServer(configPath, { info: () => undefined, warn: () => undefined });
    traceEvent(trace, { kind: "daemon.up" });
    wsServer = await startTraceWsServer(wsPort, trace);
    const wsClient = startTraceWsClient(wsPort, trace);
    await waitFor(() => trace.ws.opens === 1, 1_000);

    onHelperSpawn = (version: string) => {
      trace.helperSpawnCount += 1;
      traceEvent(trace, { kind: "helper.spawn", version });
      helperDone = (async () => {
        await delay(25);
        await wsServer?.stop();
        await daemon?.stop();
        traceEvent(trace, { kind: "daemon.down" });
        await delay(HELPER_OUTAGE_MS);
        daemon = await startServer(configPath, { info: () => undefined, warn: () => undefined });
        traceEvent(trace, { kind: "daemon.up" });
        wsServer = await startTraceWsServer(wsPort, trace);
        traceEvent(trace, { kind: "helper.done", version });
      })();
    };

    const pollPromise = pollApi(baseUrl, trace, () => pollStopped);
    const response = await originalFetch(`${baseUrl}/deploy/switch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: CURRENT_VERSION }),
    });
    trace.deployStatus = response.status;
    traceEvent(trace, { kind: "deploy.response", status: response.status });

    if (mode === "restart") {
      await waitFor(() => helperDone !== null, 500);
      await helperDone;
      await waitFor(() => trace.apiPolls.unavailable > 0 && trace.ws.opens >= 2, 2_000);
    } else {
      await delay(400);
    }

    pollStopped = true;
    await pollPromise;
    wsClient.stop();
    return trace;
  } finally {
    pollStopped = true;
    globalThis.fetch = originalFetch;
    onHelperSpawn = null;
    await wsServer?.stop().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
  }
}

async function writeTraceIfRequested(trace: DeploySwitchRuntimeTrace): Promise<void> {
  const tracePath = process.env["SPUR_DEPLOY_SWITCH_RUNTIME_TRACE"];
  if (!tracePath) return;
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
}

describe("POST /deploy/switch runtime liveness", () => {
  beforeEach(() => {
    __resetReleasesCacheForTest();
    onHelperSpawn = null;
    process.env["SPUR_DEPLOY_SWITCH_FORCE"] = "1";
  });

  afterEach(() => {
    delete process.env["SPUR_DEPLOY_SWITCH_FORCE"];
    delete process.env["SPUR_DEPLOY_SWITCH_RUNTIME_TRACE"];
    delete process.env["SPUR_DEPLOY_SWITCH_RUNTIME_EXPECT"];
  });

  it("keeps API and WebSocket liveness on a current-version switch", async () => {
    const mode =
      process.env["SPUR_DEPLOY_SWITCH_RUNTIME_EXPECT"] === "restart" ? "restart" : "no-restart";
    const trace = await runTrace(mode);
    await writeTraceIfRequested(trace);

    expect(trace.deployStatus).toBe(202);
    if (mode === "restart") {
      expect(trace.helperSpawnCount).toBe(1);
      expect(trace.apiPolls.unavailable).toBeGreaterThan(0);
      expect(trace.ws.closes).toBeGreaterThan(0);
      expect(trace.ws.opens).toBeGreaterThanOrEqual(2);
    } else {
      expect(trace.helperSpawnCount).toBe(0);
      expect(trace.apiPolls.unavailable).toBe(0);
      expect(trace.ws.closes).toBe(0);
      expect(trace.ws.opens).toBe(1);
    }
  });
});
