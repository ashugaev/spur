import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { EventBus } from "./event-bus.js";
import { errorDetails } from "./event-log.js";
import { startConfiguredSources } from "./event-sources/index.js";
import { SessionService } from "./session-service.js";
import { startConfiguredTriggers } from "./triggers.js";
import type { SendMessageRequest, SpawnSessionRequest } from "./types.js";

interface JsonError {
  error: string;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (!body) {
    return {} as T;
  }

  return JSON.parse(body) as T;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2) + "\n");
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message } satisfies JsonError);
}

export async function startServer(configPath?: string): Promise<SessionService> {
  const service = new SessionService(configPath);
  const bus = new EventBus();
  let ready = false;
  const server = createServer(async (request, response) => {
    try {
      if (!request.method) {
        sendError(response, 400, "Request method is required");
        return;
      }
      if (!request.url) {
        sendError(response, 400, "Request URL is required");
        return;
      }

      const method = request.method;
      const url = new URL(request.url, `http://${service.config.server.host}`);
      const path = url.pathname;

      if (!ready) {
        sendError(response, 503, "Daemon is starting");
        return;
      }

      if (method === "GET" && path === "/info") {
        sendJson(response, 200, service.info());
        return;
      }

      if (method === "GET" && path === "/sessions") {
        sendJson(response, 200, await service.list());
        return;
      }

      const sessionId = path.match(/^\/sessions\/([^/]+)$/)?.[1];
      if (method === "GET" && sessionId) {
        sendJson(response, 200, await service.get(sessionId));
        return;
      }

      if (method === "POST" && path === "/sessions") {
        const body = await readJsonBody<SpawnSessionRequest>(request);
        sendJson(response, 201, await service.spawn(body));
        return;
      }

      const sendSessionId = path.match(/^\/sessions\/([^/]+)\/send$/)?.[1];
      if (method === "POST" && sendSessionId) {
        const body = await readJsonBody<SendMessageRequest>(request);
        sendJson(response, 200, await service.send(sendSessionId, body));
        return;
      }

      const killSessionId = path.match(/^\/sessions\/([^/]+)\/kill$/)?.[1];
      if (method === "POST" && killSessionId) {
        sendJson(response, 200, await service.kill(killSessionId));
        return;
      }

      sendError(response, 404, `Route not found: ${method} ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, 500, message);
    }
  });

  const closeServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(service.config.server.port, service.config.server.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    throw error;
  }

  const triggers = startConfiguredTriggers({
    config: service.config,
    bus,
    sessionService: service,
    logger: console,
  });

  let sources: Awaited<ReturnType<typeof startConfiguredSources>>;
  try {
    sources = await startConfiguredSources({
      config: service.config,
      bus,
      logger: console,
    });
  } catch (error) {
    await triggers.stop();
    await closeServer();
    throw error;
  }

  ready = true;
  service.logEvent({
    event: "daemon.started",
    message: "Spur daemon started",
    details: {
      host: service.config.server.host,
      port: service.config.server.port,
      configPath: service.config.configPath,
      cwd: process.cwd(),
      startedAt: service.startedAt,
    },
  });

  let shuttingDown = false;
  const shutdown = async (reason: string, details?: Record<string, unknown>) => {
    if (shuttingDown) {
      service.logEvent({
        event: "daemon.shutdown.duplicate",
        level: "warn",
        message: "Ignored duplicate daemon shutdown request",
        details: {
          reason,
          ...details,
        },
      });
      return;
    }
    shuttingDown = true;
    ready = false;
    service.logEvent({
      event: "daemon.shutdown.requested",
      level: reason.startsWith("signal:") ? "warn" : "error",
      message: "Stopping Spur daemon",
      details: {
        reason,
        ...details,
      },
    });
    const closePromise = closeServer();
    sources.stop();
    await triggers.stop();
    await closePromise;
    service.logEvent({
      event: "daemon.stopped",
      message: "Stopped Spur daemon",
      details: {
        reason,
        ...details,
      },
    });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("signal:SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("signal:SIGTERM");
  });
  process.on("SIGHUP", () => {
    void shutdown("signal:SIGHUP");
  });
  process.on("uncaughtException", (error) => {
    service.logEvent({
      event: "daemon.uncaught_exception",
      level: "error",
      message: "Uncaught exception in Spur daemon",
      details: errorDetails(error),
    });
    void shutdown("uncaughtException", errorDetails(error));
  });
  process.on("unhandledRejection", (reason) => {
    service.logEvent({
      event: "daemon.unhandled_rejection",
      level: "error",
      message: "Unhandled rejection in Spur daemon",
      details: errorDetails(reason),
    });
    void shutdown("unhandledRejection", errorDetails(reason));
  });

  return service;
}
