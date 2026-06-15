import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { EventBus } from "./event-bus.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { startConfiguredSources } from "./event-sources/index.js";
import { initializeGhPath } from "./gh.js";
import { writeStderr } from "./io.js";
import { startRuntimeLogCollector, type RuntimeLogCollector } from "./runtime-log-collector.js";
import {
  InvalidSessionMemoryInputError,
  InvalidClearPortError,
  SessionResourceNotFoundError,
  SessionService,
  SidecarPortConflictError,
} from "./session-service.js";
import { startConfiguredTriggers, type TriggerGroupController } from "./triggers.js";
import type {
  ConnectProjectConfigRequest,
  CreateProjectRequest,
  DisconnectProjectConfigRequest,
  KillSessionRequest,
  PreflightRequest,
  RespawnSessionRequest,
  RunServiceRequest,
  SendMessageRequest,
  StartSidecarRequest,
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

async function readJsonBody<T>(request: IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }

  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (!body) {
    return {} as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2) + "\n");
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  sendJson(response, statusCode, { error: message } satisfies JsonError);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStartSidecarRequest(raw: unknown): StartSidecarRequest {
  if (!isRecord(raw)) {
    return {};
  }
  const request: StartSidecarRequest = {};
  const callerSidecarName = raw["callerSidecarName"];
  if (typeof callerSidecarName === "string") {
    request.callerSidecarName = callerSidecarName;
  }
  const callerSidecarDepth = raw["callerSidecarDepth"];
  if (typeof callerSidecarDepth === "number") {
    request.callerSidecarDepth = callerSidecarDepth;
  }
  const clearPort = raw["clearPort"];
  if (clearPort !== undefined) {
    if (typeof clearPort !== "number" || !Number.isInteger(clearPort)) {
      throw new InvalidClearPortError("clearPort must be an integer");
    }
    request.clearPort = clearPort;
  }
  return request;
}

export async function startServer(
  configPath?: string,
  logger: ServiceLogger = DEFAULT_LOGGER,
): Promise<StartedServer> {
  const ghPathState = await initializeGhPath();
  if (ghPathState.status === "unavailable") {
    (logger.warn ?? writeStderr)(
      `${ghPathState.message}; GitHub automation disabled until gh is available`,
    );
  }
  const service = new SessionService(configPath);
  const bus = new EventBus();
  let ready = false;
  let triggers: TriggerGroupController | null = null;
  let sources: Awaited<ReturnType<typeof startConfiguredSources>> | null = null;
  let runtimeLogs: RuntimeLogCollector | null = null;
  const logEvent = (event: string, entry: Omit<SpurLogEntry, "timestamp" | "event">): void => {
    logSpurEvent(service.config.dataDir, { event, ...entry });
  };
  const startAutomation = async (): Promise<void> => {
    const nextTriggers = startConfiguredTriggers({
      config: service.config,
      bus,
      sessionService: service,
      logger: {
        warn: logger.warn ?? writeStderr,
        ...(logger.info ? { info: logger.info } : {}),
      },
    });
    try {
      const nextSources = await startConfiguredSources({
        config: service.config,
        bus,
        logger: {
          ...(logger.info ? { info: logger.info } : {}),
          ...(logger.warn ? { warn: logger.warn } : {}),
        },
      });
      triggers = nextTriggers;
      sources = nextSources;
      runtimeLogs = startRuntimeLogCollector(service.config);
    } catch (error) {
      await nextTriggers.stop();
      throw error;
    }
  };
  const reloadAutomation = async (
    preview: ReturnType<SessionService["previewConfigConnect"]>,
    requestConfigPath: string,
    action: "connect" | "disconnect",
  ): Promise<void> => {
    for (const message of preview.warnings) {
      logEvent("daemon.registry.warning", {
        level: "warn",
        message,
      });
    }
    if (!preview.changed) {
      return;
    }

    ready = false;
    const previousConfig = service.config;
    const previousRegistryPaths = service.getRegistryPaths();

    sources?.stop();
    sources = null;
    runtimeLogs?.stop();
    runtimeLogs = null;
    if (triggers) {
      await triggers.stop();
      triggers = null;
    }

    service.applyConfig(preview.config, preview.registryPaths, {
      unconfiguredToRemove: preview.unconfiguredToRemove,
    });
    try {
      await startAutomation();
    } catch (error) {
      service.applyConfig(previousConfig, previousRegistryPaths);
      await startAutomation();
      ready = true;
      throw error;
    }

    logEvent("daemon.registry.reloaded", {
      level: "info",
      message:
        action === "connect"
          ? `Connected daemon project registry from ${requestConfigPath}`
          : `Disconnected daemon project registry from ${requestConfigPath}`,
      details: {
        configPaths: preview.registryPaths,
        projectCount: Object.keys(preview.config.projects).length,
      },
    });
    ready = true;
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
        const includeCompleted =
          (url.searchParams.get("includeCompleted")?.trim().toLowerCase() ?? "") === "1" ||
          (url.searchParams.get("includeCompleted")?.trim().toLowerCase() ?? "") === "true";
        const requestedView = url.searchParams.get("view")?.trim().toLowerCase();
        const view = requestedView === "dashboard" ? "dashboard" : "full";
        sendJson(response, 200, await service.list({ includeCompleted, view }));
        return;
      }

      if (method === "GET" && path === "/projects") {
        sendJson(response, 200, service.listProjects());
        return;
      }

      if (method === "POST" && path === "/projects") {
        const body = await readJsonBody<CreateProjectRequest>(request);
        for (const field of ["displayName", "prefix", "path"] as const) {
          const value = body[field];
          if (typeof value !== "string" || !value.trim()) {
            sendError(response, 400, `${field} must be a non-empty string`);
            return;
          }
        }
        try {
          const result = service.createUnconfiguredProject(body);
          sendJson(response, 201, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(response, 400, message);
        }
        return;
      }

      const deleteProjectId = path.match(/^\/projects\/([^/]+)$/)?.[1];
      if (method === "DELETE" && deleteProjectId) {
        const projectId = decodeURIComponent(deleteProjectId);
        const configuredConfigPath = service.resolveConfiguredProjectConfigPath(projectId);
        if (configuredConfigPath) {
          const preview = service.previewConfigDisconnect(configuredConfigPath);
          await reloadAutomation(preview, configuredConfigPath, "disconnect");
          sendJson(response, 200, {
            removedKind: "configured",
            projects: service.listProjects(),
          });
          return;
        }
        try {
          const result = service.deleteUnconfiguredProject(projectId);
          sendJson(response, 200, result);
        } catch (error) {
          if (error instanceof SessionResourceNotFoundError) {
            sendError(response, 404, error.message);
            return;
          }
          throw error;
        }
        return;
      }

      if (method === "POST" && path === "/projects/connect") {
        const body = await readJsonBody<ConnectProjectConfigRequest>(request);
        if (typeof body.configPath !== "string" || !body.configPath.trim()) {
          throw new Error("configPath must be a non-empty string");
        }
        const preview = service.previewConfigConnect(body.configPath);
        await reloadAutomation(preview, body.configPath, "connect");
        sendJson(response, 200, {
          ok: true,
          changed: preview.changed,
          configPath: body.configPath,
          projects: service.listProjects(),
        });
        return;
      }

      if (method === "POST" && path === "/projects/disconnect") {
        const body = await readJsonBody<DisconnectProjectConfigRequest>(request);
        if (typeof body.configPath !== "string" || !body.configPath.trim()) {
          throw new Error("configPath must be a non-empty string");
        }
        const preview = service.previewConfigDisconnect(body.configPath);
        await reloadAutomation(preview, body.configPath, "disconnect");
        sendJson(response, 200, {
          ok: true,
          changed: preview.changed,
          configPath: body.configPath,
          projects: service.listProjects(),
        });
        return;
      }

      const preflightProjectId = path.match(/^\/projects\/([^/]+)\/preflight$/)?.[1];
      if (method === "POST" && preflightProjectId) {
        const body = await readJsonBody<PreflightRequest>(request);
        sendJson(response, 200, await service.preflight({ ...body, project: preflightProjectId }));
        return;
      }

      const projectSuggestionsId = path.match(/^\/projects\/([^/]+)\/slash-commands$/)?.[1];
      if (method === "GET" && projectSuggestionsId) {
        sendJson(
          response,
          200,
          await service.getProjectSuggestions(
            projectSuggestionsId,
            url.searchParams.get("agent")?.trim() || undefined,
          ),
        );
        return;
      }

      const sessionId = path.match(/^\/sessions\/([^/]+)$/)?.[1];
      if (method === "GET" && sessionId) {
        sendJson(response, 200, await service.get(sessionId));
        return;
      }

      const sessionMemoryListId = path.match(/^\/sessions\/([^/]+)\/session-memory$/)?.[1];
      if (method === "GET" && sessionMemoryListId) {
        sendJson(
          response,
          200,
          service.listSessionMemory(decodeURIComponent(sessionMemoryListId)),
        );
        return;
      }

      const sessionMemoryResolveMatch = path.match(
        /^\/sessions\/([^/]+)\/session-memory\/([^/]+)\/resolve$/,
      );
      if (
        method === "POST" &&
        sessionMemoryResolveMatch?.[1] &&
        sessionMemoryResolveMatch[2]
      ) {
        sendJson(
          response,
          200,
          service.resolveSessionMemory(
            decodeURIComponent(sessionMemoryResolveMatch[1]),
            decodeURIComponent(sessionMemoryResolveMatch[2]),
          ),
        );
        return;
      }

      const sessionMemoryRecordMatch = path.match(
        /^\/sessions\/([^/]+)\/session-memory\/([^/]+)$/,
      );
      if (method === "GET" && sessionMemoryRecordMatch?.[1] && sessionMemoryRecordMatch[2]) {
        sendJson(
          response,
          200,
          service.getSessionMemory(
            decodeURIComponent(sessionMemoryRecordMatch[1]),
            decodeURIComponent(sessionMemoryRecordMatch[2]),
          ),
        );
        return;
      }
      if (method === "POST" && sessionMemoryRecordMatch?.[1] && sessionMemoryRecordMatch[2]) {
        const body = await readJsonBody<unknown>(request);
        sendJson(
          response,
          200,
          service.setSessionMemory(
            decodeURIComponent(sessionMemoryRecordMatch[1]),
            decodeURIComponent(sessionMemoryRecordMatch[2]),
            body,
          ),
        );
        return;
      }

      const logsSessionId = path.match(/^\/sessions\/([^/]+)\/logs$/)?.[1];
      if (method === "GET" && logsSessionId) {
        const { readSessionEventLog } = await import("./event-log.js");
        const info = service.info();
        const scopeParam = url.searchParams.get("scope");
        const scope =
          scopeParam === "all" ||
          scopeParam === "runtime" ||
          scopeParam === "service" ||
          scopeParam === "sidecar"
            ? scopeParam
            : undefined;
        const name = url.searchParams.get("name")?.trim() || undefined;
        const limitValue = url.searchParams.get("limit");
        const limit =
          limitValue && /^\d+$/.test(limitValue) ? Number.parseInt(limitValue, 10) : 200;
        const entries = readSessionEventLog(info.dataDir, logsSessionId, {
          limit,
          ...(scope ? { scope } : {}),
          ...(name ? { name } : {}),
        });
        sendJson(response, 200, entries);
        return;
      }

      const conversationSessionId = path.match(/^\/sessions\/([^/]+)\/conversation$/)?.[1];
      if (method === "GET" && conversationSessionId) {
        sendJson(response, 200, await service.getConversation(conversationSessionId));
        return;
      }

      const sessionSuggestionsId = path.match(/^\/sessions\/([^/]+)\/slash-commands$/)?.[1];
      if (method === "GET" && sessionSuggestionsId) {
        sendJson(response, 200, await service.getSessionSuggestions(sessionSuggestionsId));
        return;
      }

      const artifactMatch = path.match(/^\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
      if (method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
        const artifact = service.getArtifact(
          decodeURIComponent(artifactMatch[1]),
          decodeURIComponent(artifactMatch[2]),
        );
        response.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-length": String(artifact.size),
          "content-disposition":
            artifact.kind === "download"
              ? `attachment; filename="${encodeURIComponent(artifact.name)}"`
              : `inline; filename="${encodeURIComponent(artifact.name)}"`,
          "cache-control": "no-store",
        });
        const stream = createReadStream(artifact.path);
        stream.on("error", () => {
          if (!response.headersSent) {
            sendError(response, 500, "Failed to read artifact");
          } else {
            response.destroy();
          }
        });
        stream.pipe(response);
        return;
      }

      if (method === "POST" && path === "/sessions") {
        const body = await readJsonBody<SpawnSessionRequest>(request, 15_000_000);
        sendJson(response, 201, await service.spawn(body));
        return;
      }

      if (method === "POST" && path === "/sessions/background") {
        const body = await readJsonBody<SpawnSessionRequest>(request, 15_000_000);
        sendJson(response, 201, await service.spawnInBackground(body));
        return;
      }

      const sendSessionId = path.match(/^\/sessions\/([^/]+)\/send$/)?.[1];
      if (method === "POST" && sendSessionId) {
        const body = await readJsonBody<SendMessageRequest>(request, 15_000_000);
        sendJson(response, 200, await service.send(sendSessionId, body));
        return;
      }

      const pauseSessionId = path.match(/^\/sessions\/([^/]+)\/pause$/)?.[1];
      if (method === "POST" && pauseSessionId) {
        sendJson(response, 200, await service.pause(pauseSessionId));
        return;
      }

      const completeSessionId = path.match(/^\/sessions\/([^/]+)\/complete$/)?.[1];
      if (method === "POST" && completeSessionId) {
        sendJson(response, 200, await service.complete(completeSessionId));
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

      const respawnSessionId = path.match(/^\/sessions\/([^/]+)\/respawn$/)?.[1];
      if (method === "POST" && respawnSessionId) {
        const body = await readJsonBody<RespawnSessionRequest>(request, 15_000_000);
        const respawned = await service.respawn(respawnSessionId, body);
        sendJson(response, 200, respawned);
        const terminateSessionId = body.terminateSessionId?.trim();
        if (
          terminateSessionId &&
          terminateSessionId !== respawned.id &&
          terminateSessionId !== respawnSessionId
        ) {
          queueMicrotask(() => {
            void service.complete(terminateSessionId, { retainInList: true }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn?.(
                `Respawned ${respawnSessionId} as ${respawned.id}, but failed to complete ${terminateSessionId}: ${message}`,
              );
            });
          });
        }
        return;
      }

      const slotsSessionId = path.match(/^\/sessions\/([^/]+)\/slots$/)?.[1];
      if (method === "POST" && slotsSessionId) {
        const body = await readJsonBody<UpdateSessionSlotsRequest>(request);
        sendJson(response, 200, await service.updateSlots(slotsSessionId, body));
        return;
      }

      const sidecarMatch = path.match(/^\/sessions\/([^/]+)\/sidecars\/([^/]+)\/start$/);
      if (method === "POST" && sidecarMatch?.[1] && sidecarMatch[2]) {
        const body = parseStartSidecarRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.startSidecar(sidecarMatch[1], sidecarMatch[2], body));
        return;
      }

      const stopSidecarMatch = path.match(/^\/sessions\/([^/]+)\/sidecars\/([^/]+)\/stop$/);
      if (method === "POST" && stopSidecarMatch?.[1] && stopSidecarMatch[2]) {
        sendJson(
          response,
          200,
          await service.stopSidecar(stopSidecarMatch[1], stopSidecarMatch[2]),
        );
        return;
      }

      const listServicesSessionId = path.match(/^\/sessions\/([^/]+)\/services$/)?.[1];
      if (method === "GET" && listServicesSessionId) {
        sendJson(response, 200, await service.listServices(listServicesSessionId));
        return;
      }

      const serviceMatch = path.match(/^\/sessions\/([^/]+)\/services\/([^/]+)$/);
      if (method === "GET" && serviceMatch) {
        const sessionId = serviceMatch[1];
        const serviceId = serviceMatch[2];
        if (!sessionId || !serviceId) {
          throw new Error("service route is invalid");
        }
        sendJson(response, 200, await service.getService(sessionId, serviceId));
        return;
      }

      const runServiceMatch = path.match(/^\/sessions\/([^/]+)\/services\/([^/]+)\/run$/);
      if (method === "POST" && runServiceMatch) {
        const sessionId = runServiceMatch[1];
        const serviceId = runServiceMatch[2];
        if (!sessionId || !serviceId) {
          throw new Error("service run route is invalid");
        }
        const body = await readJsonBody<RunServiceRequest>(request);
        sendJson(response, 200, await service.runService(sessionId, serviceId, body));
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
      if (error instanceof SessionResourceNotFoundError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendError(response, error.statusCode, message);
        return;
      }
      if (error instanceof SidecarPortConflictError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, error.payload);
        return;
      }
      if (error instanceof InvalidClearPortError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendError(response, error.statusCode, message);
        return;
      }
      if (error instanceof InvalidSessionMemoryInputError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendError(response, error.statusCode, message);
        return;
      }
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

  try {
    await startAutomation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("daemon.startup.failed", {
      level: "error",
      message: `Spur daemon failed during startup: ${message}`,
    });
    service.dispose();
    await closeServer();
    throw error;
  }

  try {
    const { scanned, alive, drifted } = await service.reconcileStoppedSessions();
    logEvent("daemon.startup.reconciled", {
      level: "info",
      message: `Reconciled sessions at boot: scanned=${scanned}, alive=${alive}, drifted=${drifted}`,
      details: { scanned, alive, drifted },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("daemon.startup.reconcile.failed", {
      level: "warn",
      message: `Reconcile at boot failed: ${message}`,
    });
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
    service.dispose();
    const closePromise = closeServer();
    sources?.stop();
    runtimeLogs?.stop();
    const triggerController = triggers;
    if (triggerController) {
      await triggerController.stop();
    }
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
