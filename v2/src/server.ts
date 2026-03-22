import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { EventBus } from "./event-bus.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { startConfiguredSources } from "./event-sources/index.js";
import { writeStderr } from "./io.js";
import { SessionService } from "./session-service.js";
import { startConfiguredTriggers } from "./triggers.js";
import type {
  KillSessionRequest,
  SendMessageRequest,
  SpawnSessionRequest,
  UpdateSessionSlotsRequest,
} from "./types.js";

interface JsonError {
  error: string;
}

interface ServiceLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export type StartedServer = SessionService & {
  stop(): Promise<void>;
};

const DEFAULT_LOGGER: ServiceLogger = {
  info: writeStderr,
  warn: writeStderr,
};

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

export async function startServer(
  configPath?: string,
  logger: ServiceLogger = DEFAULT_LOGGER,
): Promise<StartedServer> {
  const service = new SessionService(configPath);
  const bus = new EventBus();
  let ready = false;
  const logEvent = (
    event: string,
    entry: Omit<SpurLogEntry, "timestamp" | "event">,
  ): void => {
    logSpurEvent(service.config.dataDir, { event, ...entry });
  };
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let method: string | undefined;
    let path: string | undefined;
    try {
      if (!request.method) {
        logEvent("http.request.failed", {
          level: "warn",
          message: "Request method is required",
        });
        sendError(response, 400, "Request method is required");
        return;
      }
      if (!request.url) {
        logEvent("http.request.failed", {
          level: "warn",
          method: request.method,
          message: "Request URL is required",
        });
        sendError(response, 400, "Request URL is required");
        return;
      }

      method = request.method;
      const url = new URL(request.url, `http://${service.config.server.host}`);
      path = url.pathname;

      if (!ready) {
        logEvent("http.request.rejected", {
          level: "warn",
          method,
          path,
          message: "Daemon is starting",
        });
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
        const body = await readJsonBody<KillSessionRequest>(request);
        sendJson(response, 200, await service.kill(killSessionId, body));
        return;
      }

      const restoreSessionId = path.match(/^\/sessions\/([^/]+)\/restore$/)?.[1];
      if (method === "POST" && restoreSessionId) {
        sendJson(response, 200, await service.restore(restoreSessionId));
        return;
      }

      const slotsSessionId = path.match(/^\/sessions\/([^/]+)\/slots$/)?.[1];
      if (method === "POST" && slotsSessionId) {
        const body = await readJsonBody<UpdateSessionSlotsRequest>(request);
        sendJson(response, 200, await service.updateSlots(slotsSessionId, body));
        return;
      }

      logEvent("http.route.not_found", {
        level: "warn",
        method,
        path,
        message: `Route not found: ${method} ${path}`,
      });
      sendError(response, 404, `Route not found: ${method} ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent("http.request.failed", {
        level: "error",
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        message,
      });
      sendError(response, 500, message);
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  const closeServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(service.config.server.port, service.config.server.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const triggers = startConfiguredTriggers({
    config: service.config,
    bus,
    sessionService: service,
    logger: {
      warn: logger.warn ?? writeStderr,
      ...(logger.info ? { info: logger.info } : {}),
    },
  });

  let sources: Awaited<ReturnType<typeof startConfiguredSources>>;
  try {
    sources = await startConfiguredSources({
      config: service.config,
      bus,
      logger: {
        ...(logger.info ? { info: logger.info } : {}),
        ...(logger.warn ? { warn: logger.warn } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("daemon.startup.failed", {
      level: "error",
      message: `Spur daemon failed during startup: ${message}`,
    });
    await triggers.stop();
    await closeServer();
    throw error;
  }

  ready = true;
  logEvent("daemon.started", {
    level: "info",
    message: `Spur daemon listening on ${service.config.server.host}:${service.config.server.port}`,
    details: {
      host: service.config.server.host,
      port: service.config.server.port,
    },
  });

  let shuttingDown = false;
  const shutdown = async (exitProcess: boolean) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    logEvent("daemon.stopping", {
      level: "info",
      message: "Stopping Spur daemon",
    });
    const closePromise = closeServer();
    sources.stop();
    await triggers.stop();
    await closePromise;
    logEvent("daemon.stopped", {
      level: "info",
      message: "Stopped Spur daemon",
    });
    if (exitProcess) {
      process.exit(0);
    }
  };

  const onSigInt = () => {
    void shutdown(true);
  };
  const onSigTerm = () => {
    void shutdown(true);
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  return Object.assign(service, {
    async stop(): Promise<void> {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      await shutdown(false);
    },
  });
}
