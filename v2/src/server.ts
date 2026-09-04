import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import { URL } from "node:url";
import { parseAgentName } from "./agents/index.js";
import { listAgentModels } from "./agents/models.js";
import { readAutoUpdateFlag, writeAutoUpdateFlag } from "./auto-update-config.js";
import { assertConfigMayUseProdSlot } from "./config.js";
import {
  clearFailedDeploySwitchRecord,
  deploySwitchStatePath,
  readUpdateNotice,
  reconcileDeploySwitchState,
} from "./deploy-switch-state.js";
import { startDeploySwitch } from "./deploy-switch.js";
import { EventBus } from "./event-bus.js";
import {
  DEFAULT_EVENT_LOG_CONFIG,
  flushEventLogCollapse,
  logSpurEvent,
  setEventLogConfig,
  type SpurLogEntry,
} from "./event-log.js";
import {
  DEFAULT_USER_ACTION_LOG_CONFIG,
  appendUserAction,
  buildUserActionRecord,
  readSessionUserActions,
  readUserActionLog,
  setUserActionLogConfig,
  type UserActionOrigin,
} from "./user-action-log.js";
import { startConfiguredBacklogs } from "./backlog/index.js";
import { startConfiguredSources } from "./event-sources/index.js";
import { flushGhPollCycles, initializeGhPath, setGhEventSink } from "./gh.js";
import { writeStderr } from "./io.js";
import { withTimeout } from "./promise-timeout.js";
import { startRuntimeLogCollector, type RuntimeLogCollector } from "./runtime-log-collector.js";
import { getReleases } from "./releases-cache.js";
import {
  GithubPrCheckUnavailableError,
  InvalidClearPortError,
  InvalidConfigPathError,
  InvalidSourceReplyInputError,
  InvalidSessionMemoryInputError,
  InvalidSessionSubscriptionInputError,
  OpenPrActionRequiredError,
  QueueDeliveryInFlightError,
  SessionAdmissionDeniedError,
  SessionNotReopenableError,
  SessionNotRestorableError,
  SessionRateLimitedError,
  SessionResourceNotFoundError,
  SessionService,
  SidecarPortConflictError,
} from "./session-service.js";
import { startConfiguredTriggers, type TriggerGroupController } from "./triggers.js";
import { updateLedgerPath } from "./update-ledger.js";
import { getVersion } from "./version.js";
import {
  SESSION_STATES,
  isSessionState,
  type AgentName,
  type CompleteSessionRequest,
  type ConnectProjectConfigRequest,
  type CreateProjectRequest,
  type DisconnectProjectConfigRequest,
  type KillSessionRequest,
  type OpenPrAction,
  type PreflightRequest,
  type HandoffSessionRequest,
  type RespawnSessionRequest,
  type RestoreSessionRequest,
  type RunServiceRequest,
  type ScheduleSessionWakeRequest,
  type SendMessageRequest,
  type SourceReplyRequest,
  type StartSidecarRequest,
  type SpawnSessionRequest,
  type SubscribeSessionStatesRequest,
  type UpdateProjectRequest,
  type UpdateSessionSlotsRequest,
  type TodoActor,
  type TodoMutationRequest,
} from "./types.js";
import {
  InvalidTodoRequestError,
  TodoEmptyLedgerError,
  TodoLedgerCorruptError,
  TodoOpenWorkError,
  TodoTransitionConflictError,
} from "./todo.js";

interface JsonError {
  error: string;
}

interface ServiceLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

class InvalidJsonBodyError extends Error {
  readonly statusCode = 400;
}

// Stashes the parsed request body on the IncomingMessage so the finally-block
// user-action logger can decode params without re-reading the (already-consumed) stream.
const BODY_SYMBOL = Symbol("spurParsedBody");

function stashParsedBody(request: IncomingMessage, value: unknown): void {
  (request as IncomingMessage & { [BODY_SYMBOL]?: unknown })[BODY_SYMBOL] = value;
}

function readParsedBody(request: IncomingMessage): unknown {
  return (request as IncomingMessage & { [BODY_SYMBOL]?: unknown })[BODY_SYMBOL];
}

function parseOrigin(value: string | string[] | undefined): UserActionOrigin {
  if (value === "cli" || value === "ui") return value;
  return "unknown";
}

export async function resolveTodoMutationActor(args: {
  origin: UserActionOrigin;
  callerHeader: string | string[] | undefined;
  targetSessionId: string;
  lookup: (sessionId: string) => Promise<{ id: string; agent: AgentName }>;
}): Promise<TodoActor> {
  const { origin, callerHeader, targetSessionId, lookup } = args;
  if (Array.isArray(callerHeader))
    throw new InvalidTodoRequestError("Caller session header is invalid");
  if (callerHeader) {
    if (origin !== "cli") throw new InvalidTodoRequestError("Caller session requires CLI origin");
    if (callerHeader !== targetSessionId)
      throw new InvalidTodoRequestError("Caller session does not match ToDo owner");
    const caller = await lookup(callerHeader);
    return { kind: "agent", agent: caller.agent, sessionId: caller.id };
  }
  if (origin === "cli" || origin === "ui") return { kind: "human", origin };
  throw new InvalidTodoRequestError("ToDo mutation origin is invalid");
}

// ToDo state gates the agent, never the person driving Spur: a CLI or UI
// request that no session made on its own behalf carries a human actor, and
// the service skips the empty/unfinished ledger block for it.
function humanTodoOptions(
  origin: UserActionOrigin,
  callerHeader: string | string[] | undefined,
): { todoActor: TodoActor } | undefined {
  if (callerHeader || (origin !== "cli" && origin !== "ui")) return undefined;
  return { todoActor: { kind: "human", origin } };
}

export type StartedServer = SessionService & {
  stop(): Promise<void>;
};

const DEFAULT_LOGGER: ServiceLogger = {
  info: writeStderr,
  warn: writeStderr,
};
const SHUTDOWN_GRACE_MS = 5_000;

// Total budget for a shutdown, measured from the signal to the last teardown step.
// Every await inside shutdown() is bounded by what is left of it, so no single step
// (source poller stop, trigger drain, connection close) can overrun the service
// manager's stop timeout. The packaged systemd unit uses the default
// TimeoutStopSec=90s; overrunning that means SIGKILL, which skips teardown entirely
// and leaves half-written state behind. 45s leaves room for the slowest healthy
// teardown observed in production (~17s) while keeping a wide margin under 90s.
const SHUTDOWN_DEADLINE_MS = 45_000;

// Hard backstop for the signal path: if teardown itself wedges past the budget (a step
// that never yields back, a pending microtask chain), exit anyway and log the handles
// still open. Sits above SHUTDOWN_DEADLINE_MS so the bounded path always wins the race
// when it is working, and far below TimeoutStopSec so systemd never has to SIGKILL.
const SHUTDOWN_FORCE_EXIT_MS = 60_000;

// Upper bound on how long a reload waits for triggers.stop() to drain in-flight
// deliveries. A blocked delivery (e.g. one awaiting a submit-ack that never matches)
// would otherwise hang stop() forever and leave the daemon stuck on 503. The bound
// exceeds a delivery's own ack timeout (~2 min observed) so natural completion wins
// the race in the common case; pathological reloads unblock within an operator-
// tolerable window. Shutdown does NOT use this bound: it exceeds TimeoutStopSec, so
// shutdown passes its own remaining budget instead.
const TRIGGERS_STOP_TIMEOUT_MS = 180_000;

// Bound the shutdown drain of in-flight background spawns so teardown never hangs
// on a spawn that fails to settle.
const BACKGROUND_SPAWN_DRAIN_TIMEOUT_MS = 5_000;

// Sandbox flags for served HTML artifacts. allow-same-origin is deliberately absent:
// scripts run, but in an opaque origin with no access to Spur's cookies or storage.
// The web preview frames mirror this flag list in packages/web/src/lib/artifact-html.ts;
// the server test above asserts the two stay identical.
const ARTIFACT_HTML_SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals";

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
    const empty = {} as T;
    stashParsedBody(request, empty);
    return empty;
  }

  try {
    const parsed = JSON.parse(body) as T;
    stashParsedBody(request, parsed);
    return parsed;
  } catch {
    throw new InvalidJsonBodyError("Invalid JSON in request body");
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

function parseOpenPrAction(value: unknown): OpenPrAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "leave_open" && value !== "close") {
    throw new Error("prAction must be leave_open or close");
  }
  return value;
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

function parseSweepSidecarsRequest(raw: unknown): { reap: boolean } {
  if (!isRecord(raw)) {
    return { reap: false };
  }
  return { reap: raw["reap"] === true };
}

function parseScheduleSessionWakeRequest(raw: unknown): ScheduleSessionWakeRequest {
  if (!isRecord(raw)) {
    return {};
  }
  const request: ScheduleSessionWakeRequest = {};
  const at = raw["at"];
  if (typeof at === "string") {
    request.at = at;
  }
  const delayMs = raw["delayMs"];
  if (typeof delayMs === "number") {
    request.delayMs = delayMs;
  }
  const intervalMs = raw["intervalMs"];
  if (typeof intervalMs === "number") {
    request.intervalMs = intervalMs;
  }
  const dailyAt = raw["dailyAt"];
  if (dailyAt !== undefined) {
    if (!Array.isArray(dailyAt) || dailyAt.some((entry) => typeof entry !== "string")) {
      throw new Error("dailyAt must be an array of HH:MM strings");
    }
    request.dailyAt = dailyAt;
  }
  const stopCondition = raw["stopCondition"];
  if (typeof stopCondition === "string") {
    request.stopCondition = stopCondition;
  }
  const message = raw["message"];
  if (typeof message === "string") {
    request.message = message;
  }
  return request;
}

export function parseCompleteSessionRequest(raw: unknown): CompleteSessionRequest {
  if (!isRecord(raw)) {
    return {};
  }
  const scope = raw["scope"];
  if (scope !== undefined && scope !== "session" && scope !== "desk") {
    throw new Error("Invalid complete scope");
  }
  const prAction = parseOpenPrAction(raw["prAction"]);
  return {
    ...(scope === "session" || scope === "desk" ? { scope } : {}),
    ...(prAction ? { prAction } : {}),
    ...(raw["skipPrCheck"] === true ? { skipPrCheck: true } : {}),
  };
}

function parseTodoMutationRequest(raw: unknown): TodoMutationRequest {
  if (!isRecord(raw)) throw new Error("ToDo request must be an object");
  const action = raw["action"];
  const allowed =
    action === "add"
      ? ["action", "text", "reason"]
      : action === "resume"
        ? ["action", "itemId"]
        : action === "hold"
          ? ["action", "itemId", "reason", "blocker", "requiredHumanAction"]
          : ["action", "itemId", "reason"];
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    throw new Error("ToDo request contains unknown fields");
  const required = (name: string): string => {
    const value = raw[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonblank`);
    return value.trim();
  };
  if (action === "add") return { action, text: required("text"), reason: required("reason") };
  if (action === "complete" || action === "cancel")
    return { action, itemId: required("itemId"), reason: required("reason") };
  if (action === "resume") return { action, itemId: required("itemId") };
  if (action === "hold") {
    const blocker = raw["blocker"];
    if (blocker !== "external" && blocker !== "human")
      throw new Error("blocker must be external or human");
    if (blocker === "external" && raw["requiredHumanAction"] !== undefined)
      throw new Error("requiredHumanAction is valid only for a human blocker");
    const requiredHumanAction = blocker === "human" ? required("requiredHumanAction") : undefined;
    return {
      action,
      itemId: required("itemId"),
      reason: required("reason"),
      blocker,
      ...(requiredHumanAction ? { requiredHumanAction } : {}),
    };
  }
  throw new Error("Unsupported ToDo action");
}

export function parseKillSessionRequest(raw: unknown): KillSessionRequest {
  if (!isRecord(raw)) {
    return {};
  }
  const request: KillSessionRequest = {};
  const force = raw["force"];
  if (typeof force === "boolean") {
    request.force = force;
  }
  const prAction = parseOpenPrAction(raw["prAction"]);
  if (prAction) {
    request.prAction = prAction;
  }
  if (raw["skipPrCheck"] === true) {
    request.skipPrCheck = true;
  }
  return request;
}

export function parseRestoreSessionRequest(raw: unknown): RestoreSessionRequest {
  if (!isRecord(raw)) {
    return {};
  }
  return raw["force"] === true ? { force: true } : {};
}

// Bounds the wait for a trigger controller to drain its in-flight deliveries. Returns
// normally whether stop() completed, overran the timeout, or rejected — teardown is
// best-effort and must never block (or fail) a reload. On timeout/rejection the old
// controller is abandoned and `report` is called with the reason so the daemon can log
// it; its in-flight promise keeps draining in the background.
export async function stopTriggersBounded(
  controller: TriggerGroupController,
  timeoutMs: number,
  report: (message: string) => void,
): Promise<void> {
  try {
    await withTimeout(controller.stop(), timeoutMs, "triggers.stop timeout");
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  }
}

// Counts the handles still keeping the event loop alive, grouped by resource kind
// (e.g. { Timeout: 2, TCPSocketWrap: 7 }). Reported when the shutdown backstop fires so
// a wedged teardown names what held it instead of just "timed out".
export function summarizeActiveResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const resource of process.getActiveResourcesInfo()) {
    counts[resource] = (counts[resource] ?? 0) + 1;
  }
  return counts;
}

// Arms the last-resort exit for the signal path: `onForceExit` runs once `timeoutMs`
// elapses without teardown reaching its disarm call. The timer is unref'd so arming it
// can never be the thing that keeps a healthy process alive. Returns the disarm.
export function armShutdownBackstop(
  timeoutMs: number,
  onForceExit: (activeResources: Record<string, number>) => void,
): () => void {
  const timer = setTimeout(() => {
    onForceExit(summarizeActiveResources());
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

// The backstop's `onForceExit` calls `process.exit(0)` directly and never reaches the
// normal shutdown path's own `flushGhPollCycles()` call in its `finally` — so this
// is its own flush point. `logBeforeExit` runs the caller's own log write between the
// flush and the exit; `flushGhPollCycles()` deletes each run as it flushes, so this can
// never double-emit against a normal-path flush that also ran.
export function forceShutdownExit(logBeforeExit: () => void): void {
  flushGhPollCycles();
  logBeforeExit();
  process.exit(0);
}

export interface ReloadApplyHooks {
  // Swap the registry to the reloaded config, then bring automation up against it.
  applyNext: () => void;
  startAutomation: () => Promise<void>;
  // Restore the previous config when the reloaded one fails to start.
  applyPrevious: () => void;
  onReloaded: () => void;
  // The reloaded config failed AND the rollback failed to restart — automation is now
  // down. Surfaced as a distinct error so a "responsive but running nothing" daemon is
  // observable rather than looking healthy to a liveness probe.
  onRollbackFailed: (message: string) => void;
  setReady: (ready: boolean) => void;
}

// Applies a reloaded config and (re)starts automation, rolling back to the previous
// config if the new one fails to start. Readiness is restored in a finally on every
// path — including a failed rollback — so a broken reload leaves the daemon responsive
// (degraded) instead of wedged on 503; the original error still propagates.
export async function applyReloadedConfig(hooks: ReloadApplyHooks): Promise<void> {
  try {
    hooks.applyNext();
    try {
      await hooks.startAutomation();
    } catch (error) {
      hooks.applyPrevious();
      try {
        await hooks.startAutomation();
      } catch (rollbackError) {
        hooks.onRollbackFailed(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
        throw rollbackError;
      }
      throw error;
    }
    hooks.onReloaded();
  } finally {
    hooks.setReady(true);
  }
}

function parseSubscribeSessionStatesRequest(raw: unknown): SubscribeSessionStatesRequest {
  if (!isRecord(raw)) {
    throw new InvalidSessionSubscriptionInputError("request body must be a JSON object");
  }
  const targetSessionId = raw["targetSessionId"];
  if (typeof targetSessionId !== "string" || !targetSessionId.trim()) {
    throw new InvalidSessionSubscriptionInputError("targetSessionId must be a non-empty string");
  }
  const states = raw["states"];
  if (!Array.isArray(states) || states.length === 0) {
    throw new InvalidSessionSubscriptionInputError("states must be a non-empty array");
  }
  if (!states.every(isSessionState)) {
    throw new InvalidSessionSubscriptionInputError(
      `states must be one of: ${SESSION_STATES.join(", ")}`,
    );
  }
  const message = raw["message"];
  if (message !== undefined && typeof message !== "string") {
    throw new InvalidSessionSubscriptionInputError("message must be a string");
  }
  return {
    targetSessionId,
    states,
    ...(message !== undefined ? { message } : {}),
  };
}

// A CLI spawn only ever sends one entry; this bounds direct API/MCP callers,
// which can pass an arbitrary array. Each entry still does a requireSession
// read on the spawn hot path (the writes are batched into one at the end).
const MAX_SPAWN_STATE_SUBSCRIPTIONS = 20;

function parseSpawnStateSubscriptions(raw: unknown): SubscribeSessionStatesRequest[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new InvalidSessionSubscriptionInputError("subscriptions must be an array");
  }
  if (raw.length > MAX_SPAWN_STATE_SUBSCRIPTIONS) {
    throw new InvalidSessionSubscriptionInputError(
      `subscriptions must not exceed ${MAX_SPAWN_STATE_SUBSCRIPTIONS} entries`,
    );
  }
  const entries = raw.map((entry) => parseSubscribeSessionStatesRequest(entry));
  const targetSessionIds = new Set<string>();
  for (const entry of entries) {
    if (targetSessionIds.has(entry.targetSessionId)) {
      throw new InvalidSessionSubscriptionInputError(
        `subscriptions must not repeat targetSessionId: ${entry.targetSessionId}`,
      );
    }
    targetSessionIds.add(entry.targetSessionId);
  }
  return entries;
}

function mergeSpawnStateSubscriptions(body: SpawnSessionRequest): SpawnSessionRequest {
  const subscriptions = parseSpawnStateSubscriptions(body.subscriptions);
  return { ...body, ...(subscriptions ? { subscriptions } : {}) };
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
  assertConfigMayUseProdSlot(configPath);
  const service = new SessionService(configPath, undefined, { deferBackgroundLoops: true });
  let ready = false;
  const switchStatePath = deploySwitchStatePath(service.config.dataDir);
  const switchLedgerPath = updateLedgerPath(service.config.dataDir);
  // Re-applied on every config (re)load, not just boot, so disk-limit changes take
  // effect without a full daemon restart.
  const applyLogConfigs = (cfg: typeof service.config): void => {
    setEventLogConfig(cfg.eventLog ?? DEFAULT_EVENT_LOG_CONFIG);
    setUserActionLogConfig(cfg.userActionLog ?? DEFAULT_USER_ACTION_LOG_CONFIG);
    setGhEventSink(cfg.dataDir);
  };
  applyLogConfigs(service.config);
  service.startBackgroundLoops();
  const bus = new EventBus();
  let triggers: TriggerGroupController | null = null;
  let sources: Awaited<ReturnType<typeof startConfiguredSources>> | null = null;
  let backlogs: { stop(): void } | null = null;
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
        listSessions: async () =>
          (await service.list({ view: "dashboard" })).map((session) => ({
            id: session.id,
            project: session.project,
            agent: session.agent,
            state: session.state,
            ...(session.slots?.title ? { title: session.slots.title } : {}),
          })),
        spawnSession: async (request) => {
          const session = await service.spawn(request);
          return {
            id: session.id,
            project: session.project,
            agent: session.agent,
            state: session.state,
            ...(session.slots?.title ? { title: session.slots.title } : {}),
          };
        },
      });
      const nextBacklogs = startConfiguredBacklogs({
        config: service.config,
        logger: {
          ...(logger.info ? { info: logger.info } : {}),
          ...(logger.warn ? { warn: logger.warn } : {}),
        },
      });
      triggers = nextTriggers;
      sources = nextSources;
      backlogs = nextBacklogs;
      runtimeLogs = startRuntimeLogCollector(service.config);
    } catch (error) {
      await nextTriggers.stop();
      backlogs?.stop();
      backlogs = null;
      throw error;
    }
  };
  const reloadAutomation = async (
    preview: ReturnType<SessionService["previewConfigConnect"]>,
    requestConfigPath: string,
    action: "connect" | "disconnect",
  ): Promise<void> => {
    // SessionService emits registry warnings while building the preview, so
    // diagnostics still land when no reload is needed.
    if (!preview.changed) {
      return;
    }

    ready = false;
    const previousConfig = service.config;
    const previousRegistryPaths = service.getRegistryPaths();

    await sources?.stop();
    sources = null;
    backlogs?.stop();
    backlogs = null;
    runtimeLogs?.stop();
    runtimeLogs = null;
    if (triggers) {
      // A blocked in-flight delivery must never deadlock the reload and leave the daemon
      // permanently stuck on 503. On timeout the old controller is abandoned but its
      // in-flight promise keeps draining in the background (see stopTriggersBounded), so a
      // delivery is not dropped — it runs to completion concurrently with the new
      // controller. stop() unsubscribes synchronously first, so the abandoned controller
      // takes no new events; only its already-started deliveries race the new one.
      await stopTriggersBounded(triggers, TRIGGERS_STOP_TIMEOUT_MS, (message) =>
        logEvent("daemon.reload.stop_timeout", { level: "warn", message }),
      );
      triggers = null;
    }

    await applyReloadedConfig({
      applyNext: () => {
        service.applyConfig(preview.config, preview.registryPaths, {
          unconfiguredToRemove: preview.unconfiguredToRemove,
        });
        applyLogConfigs(service.config);
      },
      startAutomation,
      applyPrevious: () => {
        service.applyConfig(previousConfig, previousRegistryPaths);
        applyLogConfigs(service.config);
      },
      onReloaded: () =>
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
        }),
      onRollbackFailed: (message) =>
        logEvent("daemon.reload.failed", {
          level: "error",
          message: `Reload rollback failed to restart automation; daemon is responsive but running no automation: ${message}`,
        }),
      setReady: (value) => {
        ready = value;
      },
    });
  };
  // Serialize reloads: preview + reload must be atomic. Handlers are dispatched
  // concurrently, so two overlapping reloads would both snapshot the same previous
  // config and race startAutomation()'s assignment of triggers/sources/runtimeLogs,
  // orphaning a controller (leaked flush/auto-complete timers + bus subscriptions). The
  // bounded stop can now hold a reload for up to TRIGGERS_STOP_TIMEOUT_MS, widening that
  // window, so the gate runs each reload (preview included) strictly after the previous.
  let reloadGate: Promise<unknown> = Promise.resolve();
  const withReloadGate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = reloadGate.then(run, run);
    reloadGate = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const startedAt = performance.now();
    const origin = parseOrigin(request.headers["x-spur-origin"]);
    let method: string | undefined;
    let path: string | undefined;
    let errorMessage: string | undefined;
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

      if (method === "GET" && path === "/headroom") {
        sendJson(response, 200, await service.getHeadroom());
        return;
      }

      if (method === "GET" && path === "/deploy/versions") {
        const releases = await getReleases();
        const autoUpdateFlag = readAutoUpdateFlag(service.config.configPath);
        if (autoUpdateFlag.error) {
          logEvent("daemon.auto_update.config_invalid", {
            level: "warn",
            message: autoUpdateFlag.error,
          });
        }
        // The operator's update notice rides the same payload as the flag, so
        // an unchecked box and the notice can never disagree. Read, never
        // reconciled: a polled GET writes nothing to disk, and reconciliation
        // adds no `failureKind` anyway.
        const current = getVersion();
        const updateFailure = readUpdateNotice(switchStatePath, current);
        sendJson(response, 200, {
          current,
          available: releases.entries,
          autoUpdate: autoUpdateFlag.autoUpdate,
          ...(releases.stale ? { stale: true } : {}),
          ...(releases.error ? { registryError: releases.error } : {}),
          ...(updateFailure ? { updateFailure } : {}),
        });
        return;
      }

      if (method === "GET" && path === "/deploy/switch/status") {
        sendJson(response, 200, reconcileDeploySwitchState(switchStatePath) ?? { phase: "idle" });
        return;
      }

      if (method === "POST" && path === "/deploy/switch") {
        const body = await readJsonBody<{ version?: unknown }>(request);
        const requestedVersion = typeof body.version === "string" ? body.version : "";
        const result = await startDeploySwitch({
          version: requestedVersion,
          initiator: "manual",
          statePath: switchStatePath,
          ledgerPath: switchLedgerPath,
        });
        // The update-path timeline in events.jsonl has to read end to end for
        // every initiator. `user-actions.jsonl` records the press separately
        // as the operator-action audit trail; this is the update timeline.
        if (result.status === "accepted" || result.status === "already_current") {
          logEvent("daemon.deploy_switch.started", {
            level: "info",
            details: { version: result.version, status: result.status, initiator: "manual" },
          });
        } else {
          logEvent("daemon.deploy_switch.rejected", {
            level: "warn",
            details: { version: requestedVersion, status: result.status },
          });
        }
        switch (result.status) {
          case "invalid_version":
            sendError(response, 400, "invalid version");
            return;
          case "in_progress":
            sendJson(response, 409, {
              error: `deploy switch already in progress for ${result.version}`,
              inProgress: true,
              version: result.version,
            });
            return;
          case "source_checkout":
            sendError(response, 409, "running from source checkout");
            return;
          case "registry_unreachable":
            sendError(response, 503, "npm registry unreachable");
            return;
          case "not_in_registry":
            sendError(response, 400, "version not in registry");
            return;
          case "spawn_failed":
            sendError(response, 500, result.message);
            return;
          case "accepted":
          case "already_current": {
            // Any Switch is the operator answering the rollback, so the notice
            // goes. An accepted switch already superseded the record with a
            // `running` one; `already_current` writes no record at all
            // (deploy-switch.ts's early return), so it has to clear here.
            if (result.status === "already_current") {
              clearFailedDeploySwitchRecord(switchStatePath);
            }
            // Disarm on every accepted switch, spawned or already-current:
            // the issue requires auto-update not to re-arm once a pinned
            // version becomes current again. This never lives in
            // `startDeploySwitch` — the auto path must not be able to
            // disarm itself.
            const disarmResult = writeAutoUpdateFlag(service.config.configPath, false);
            if (!disarmResult.ok) {
              logEvent("daemon.auto_update.disarm_failed", {
                level: "warn",
                details: { reason: disarmResult.reason, message: disarmResult.message },
              });
            }
            const autoUpdateAfterDisarm = disarmResult.ok
              ? disarmResult.autoUpdate
              : readAutoUpdateFlag(service.config.configPath).autoUpdate;
            sendJson(response, 202, {
              accepted: true,
              version: result.version,
              autoUpdate: autoUpdateAfterDisarm,
            });
            return;
          }
        }
      }

      if (method === "POST" && path === "/deploy/auto-update") {
        const body = await readJsonBody<{ enabled?: unknown }>(request);
        if (typeof body.enabled !== "boolean") {
          sendError(response, 400, "enabled must be a boolean");
          return;
        }
        const writeResult = writeAutoUpdateFlag(service.config.configPath, body.enabled);
        if (writeResult.ok) {
          // Re-arming is the other operator answer to a rollback: one action
          // both clears the notice and turns automatic updates back on. The
          // version itself stays blocked by the ledger.
          if (writeResult.autoUpdate) {
            clearFailedDeploySwitchRecord(switchStatePath);
          }
          sendJson(response, 200, { autoUpdate: writeResult.autoUpdate });
          return;
        }
        switch (writeResult.reason) {
          case "conflict":
            sendError(response, 409, "config changed on disk");
            return;
          case "config_invalid":
            sendError(response, 409, writeResult.message);
            return;
          case "not_mapping":
            sendError(response, 409, "config is not a YAML mapping");
            return;
          case "missing":
            sendError(response, 409, "config not found");
            return;
          case "invalid_output":
          case "io":
            sendError(response, 500, writeResult.message);
            return;
        }
      }

      if (method === "GET" && path === "/claude-accounts") {
        sendJson(response, 200, { accounts: service.listClaudeAccounts() });
        return;
      }

      if (method === "POST" && path === "/claude-accounts/add") {
        const body = await readJsonBody<{ label?: unknown }>(request);
        const label = typeof body.label === "string" ? body.label.trim() : "";
        const account = service.addClaudeAccount(label ? { label } : {});
        const { loginTmuxSession } = await service.startAccountLogin(account.id);
        // Return the summary shape (no absolute configDir) to match GET /claude-accounts.
        sendJson(response, 201, {
          account: {
            id: account.id,
            label: account.label,
            authenticated: false,
            lastUsedAt: account.lastUsedAt,
          },
          loginTmuxSession,
        });
        return;
      }

      if (method === "POST" && path === "/claude-accounts/remove") {
        const body = await readJsonBody<{ id?: unknown }>(request);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) {
          sendJson(response, 400, { error: "id must be a non-empty string" });
          return;
        }
        try {
          service.removeClaudeAccount(id);
        } catch (error) {
          // In-use guard rejection is a client-correctable conflict, not a 500.
          const message = error instanceof Error ? error.message : String(error);
          sendError(response, 409, message);
          return;
        }
        sendJson(response, 200, { removed: id });
        return;
      }

      const finishLoginAccountId = path.match(/^\/claude-accounts\/([^/]+)\/finish-login$/)?.[1];
      if (method === "POST" && finishLoginAccountId) {
        sendJson(response, 200, await service.finishAccountLogin(finishLoginAccountId));
        return;
      }

      const loginStatusAccountId = path.match(/^\/claude-accounts\/([^/]+)\/login-status$/)?.[1];
      if (method === "GET" && loginStatusAccountId) {
        sendJson(response, 200, await service.getAccountLoginStatus(loginStatusAccountId));
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

      if (method === "GET" && path === "/backlog/available") {
        sendJson(response, 200, service.listAvailableBacklog());
        return;
      }

      if (method === "GET" && path === "/models") {
        const rawAgent = url.searchParams.get("agent")?.trim() ?? "";
        let agent;
        try {
          agent = parseAgentName(rawAgent);
        } catch {
          sendError(response, 400, `Unsupported agent: ${rawAgent}`);
          return;
        }
        sendJson(response, 200, {
          models: await listAgentModels(agent, { codexHomePath: service.config.models.codexHome }),
        });
        return;
      }

      if (method === "POST" && path === "/projects") {
        const body = await readJsonBody<CreateProjectRequest>(request);
        for (const field of ["displayName", "prefix"] as const) {
          const value = body[field];
          if (typeof value !== "string" || !value.trim()) {
            sendError(response, 400, `${field} must be a non-empty string`);
            return;
          }
        }
        const rawPath = body.path;
        if (rawPath !== undefined && (typeof rawPath !== "string" || !rawPath.trim())) {
          sendError(response, 400, "path must be a non-empty string when provided");
          return;
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
      if (method === "PATCH" && deleteProjectId) {
        const projectId = decodeURIComponent(deleteProjectId);
        const body = await readJsonBody<unknown>(request);
        if (!isRecord(body)) {
          sendError(response, 400, "Request body must be a JSON object");
          return;
        }
        const displayName = body.displayName;
        const prefix = body.prefix;
        const projectPath = body.path;
        if (typeof displayName !== "string" || !displayName.trim()) {
          sendError(response, 400, "displayName must be a non-empty string");
          return;
        }
        if (typeof prefix !== "string" || !prefix.trim()) {
          sendError(response, 400, "prefix must be a non-empty string");
          return;
        }
        if (typeof projectPath !== "string" || !projectPath.trim()) {
          sendError(response, 400, "path must be a non-empty string");
          return;
        }
        const update: UpdateProjectRequest = {
          displayName,
          prefix,
          path: projectPath,
        };
        try {
          const result = service.updateUnconfiguredProject(projectId, update);
          sendJson(response, 200, result);
        } catch (error) {
          if (error instanceof SessionResourceNotFoundError) {
            sendError(response, 404, error.message);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          sendError(response, 400, message);
        }
        return;
      }

      if (method === "DELETE" && deleteProjectId) {
        const projectId = decodeURIComponent(deleteProjectId);
        const configuredConfigPath = service.resolveConfiguredProjectConfigPath(projectId);
        if (configuredConfigPath) {
          await withReloadGate(async () => {
            const preview = service.previewConfigDisconnect(configuredConfigPath);
            await reloadAutomation(preview, configuredConfigPath, "disconnect");
          });
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
        const preview = await withReloadGate(async () => {
          const next = service.previewConfigConnect(body.configPath);
          await reloadAutomation(next, body.configPath, "connect");
          return next;
        });
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
        const preview = await withReloadGate(async () => {
          const next = service.previewConfigDisconnect(body.configPath);
          await reloadAutomation(next, body.configPath, "disconnect");
          return next;
        });
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

      const spawnDefaultsProjectId = path.match(/^\/projects\/([^/]+)\/spawn-defaults$/)?.[1];
      if (method === "GET" && spawnDefaultsProjectId) {
        const rawAgent = url.searchParams.get("agent")?.trim() ?? "";
        let agent;
        try {
          agent = parseAgentName(rawAgent);
        } catch {
          sendError(response, 400, `Unsupported agent: ${rawAgent}`);
          return;
        }
        sendJson(response, 200, await service.spawnDefaults(spawnDefaultsProjectId, agent));
        return;
      }

      const branchExistsId = path.match(/^\/projects\/([^/]+)\/branches\/exists$/)?.[1];
      if (method === "GET" && branchExistsId) {
        const name = url.searchParams.get("name")?.trim() ?? "";
        sendJson(response, 200, await service.branchStatus(branchExistsId, name));
        return;
      }

      const sessionId = path.match(/^\/sessions\/([^/]+)$/)?.[1];
      if (method === "GET" && sessionId) {
        sendJson(response, 200, await service.get(sessionId));
        return;
      }

      const sessionMemoryListId = path.match(/^\/sessions\/([^/]+)\/session-memory$/)?.[1];
      if (method === "GET" && sessionMemoryListId) {
        sendJson(response, 200, service.listSessionMemory(decodeURIComponent(sessionMemoryListId)));
        return;
      }

      const sessionMemoryResolveMatch = path.match(
        /^\/sessions\/([^/]+)\/session-memory\/([^/]+)\/resolve$/,
      );
      if (method === "POST" && sessionMemoryResolveMatch?.[1] && sessionMemoryResolveMatch[2]) {
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

      const sessionMemoryRecordMatch = path.match(/^\/sessions\/([^/]+)\/session-memory\/([^/]+)$/);
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

      const sharedMemoryListMatch = path.match(/^\/sessions\/([^/]+)\/shared-memory\/([^/]+)$/);
      if (method === "GET" && sharedMemoryListMatch?.[1] && sharedMemoryListMatch[2]) {
        sendJson(
          response,
          200,
          service.listSharedMemory(
            decodeURIComponent(sharedMemoryListMatch[1]),
            decodeURIComponent(sharedMemoryListMatch[2]),
          ),
        );
        return;
      }

      const sharedMemoryEntryMatch = path.match(
        /^\/sessions\/([^/]+)\/shared-memory\/([^/]+)\/([^/]+)$/,
      );
      if (
        method === "GET" &&
        sharedMemoryEntryMatch?.[1] &&
        sharedMemoryEntryMatch[2] &&
        sharedMemoryEntryMatch[3]
      ) {
        sendJson(
          response,
          200,
          service.getSharedMemory(
            decodeURIComponent(sharedMemoryEntryMatch[1]),
            decodeURIComponent(sharedMemoryEntryMatch[2]),
            decodeURIComponent(sharedMemoryEntryMatch[3]),
          ),
        );
        return;
      }
      if (
        method === "POST" &&
        sharedMemoryEntryMatch?.[1] &&
        sharedMemoryEntryMatch[2] &&
        sharedMemoryEntryMatch[3]
      ) {
        const body = await readJsonBody<unknown>(request);
        sendJson(
          response,
          200,
          service.setSharedMemory(
            decodeURIComponent(sharedMemoryEntryMatch[1]),
            decodeURIComponent(sharedMemoryEntryMatch[2]),
            decodeURIComponent(sharedMemoryEntryMatch[3]),
            body,
          ),
        );
        return;
      }
      if (
        method === "DELETE" &&
        sharedMemoryEntryMatch?.[1] &&
        sharedMemoryEntryMatch[2] &&
        sharedMemoryEntryMatch[3]
      ) {
        sendJson(
          response,
          200,
          service.removeSharedMemory(
            decodeURIComponent(sharedMemoryEntryMatch[1]),
            decodeURIComponent(sharedMemoryEntryMatch[2]),
            decodeURIComponent(sharedMemoryEntryMatch[3]),
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

      const userActionsSessionId = path.match(/^\/sessions\/([^/]+)\/user-actions$/)?.[1];
      if (method === "GET" && userActionsSessionId) {
        const limitValue = url.searchParams.get("limit");
        const limit =
          limitValue && /^\d+$/.test(limitValue) ? Number.parseInt(limitValue, 10) : 200;
        sendJson(
          response,
          200,
          readSessionUserActions(service.info().dataDir, userActionsSessionId, { limit }),
        );
        return;
      }

      if (method === "GET" && path === "/user-actions") {
        const limitValue = url.searchParams.get("limit");
        const limit =
          limitValue && /^\d+$/.test(limitValue) ? Number.parseInt(limitValue, 10) : 200;
        sendJson(response, 200, readUserActionLog(service.info().dataDir, { limit }));
        return;
      }

      const conversationSessionId = path.match(/^\/sessions\/([^/]+)\/conversation$/)?.[1];
      if (method === "GET" && conversationSessionId) {
        const fromValue = url.searchParams.get("from");
        const from =
          fromValue && /^\d+$/.test(fromValue) ? Number.parseInt(fromValue, 10) : undefined;
        sendJson(
          response,
          200,
          await service.getConversation(conversationSessionId, from !== undefined ? { from } : {}),
        );
        return;
      }

      const sessionSuggestionsId = path.match(/^\/sessions\/([^/]+)\/slash-commands$/)?.[1];
      if (method === "GET" && sessionSuggestionsId) {
        sendJson(response, 200, await service.getSessionSuggestions(sessionSuggestionsId));
        return;
      }

      const subscriptionsSessionId = path.match(/^\/sessions\/([^/]+)\/subscriptions$/)?.[1];
      if (method === "GET" && subscriptionsSessionId) {
        sendJson(
          response,
          200,
          service.listStateSubscriptions(decodeURIComponent(subscriptionsSessionId)),
        );
        return;
      }
      if (method === "POST" && subscriptionsSessionId) {
        const body = parseSubscribeSessionStatesRequest(await readJsonBody<unknown>(request));
        sendJson(
          response,
          200,
          service.subscribeToSessionStates(decodeURIComponent(subscriptionsSessionId), body),
        );
        return;
      }

      const removeSubscriptionMatch = path.match(
        /^\/sessions\/([^/]+)\/subscriptions\/([^/]+)\/remove$/,
      );
      if (method === "POST" && removeSubscriptionMatch?.[1] && removeSubscriptionMatch[2]) {
        sendJson(
          response,
          200,
          service.removeStateSubscription(
            decodeURIComponent(removeSubscriptionMatch[1]),
            decodeURIComponent(removeSubscriptionMatch[2]),
          ),
        );
        return;
      }

      const artifactMatch = path.match(/^\/sessions\/([^/]+)\/artifacts\/(.+)$/);
      if (method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
        // An invalid percent-encoding in any segment (decodeURIComponent throws URIError)
        // is not a malformed request — it just can never match a real artifact id. Treat
        // it as a not-found id, same as any other id the store doesn't recognize, rather
        // than letting it fall through to the generic 500 handler.
        let sessionId: string;
        let artifactId: string;
        try {
          sessionId = decodeURIComponent(artifactMatch[1]);
          artifactId = artifactMatch[2]
            .split("/")
            .map((segment) => decodeURIComponent(segment))
            .join("/");
        } catch {
          sendError(response, 404, `Artifact not found: ${artifactMatch[1]}/${artifactMatch[2]}`);
          return;
        }
        const artifact = service.getArtifact(sessionId, artifactId);
        // An SVG opened as a top-level document runs its own scripts on Spur's origin,
        // and browsers ignore a CSP sandbox on image documents, so hand it over as a
        // download instead. <img> previews ignore content-disposition and still render.
        const renderInline = artifact.kind !== "download" && artifact.mimeType !== "image/svg+xml";
        response.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-length": String(artifact.size),
          "content-disposition": `${renderInline ? "inline" : "attachment"}; filename="${encodeURIComponent(basename(artifact.name))}"`,
          "cache-control": "no-store",
          // Artifact HTML is agent-authored: render it in an opaque origin so it can
          // never read Spur's storage or call the API with the operator's session.
          ...(artifact.mimeType.startsWith("text/html")
            ? { "content-security-policy": ARTIFACT_HTML_SANDBOX }
            : {}),
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
        sendJson(response, 201, await service.spawn(mergeSpawnStateSubscriptions(body)));
        return;
      }

      if (method === "POST" && path === "/sessions/background") {
        const body = await readJsonBody<SpawnSessionRequest>(request, 15_000_000);
        sendJson(
          response,
          201,
          await service.spawnInBackground(mergeSpawnStateSubscriptions(body)),
        );
        return;
      }

      if (method === "POST" && path === "/shepherd/spawn") {
        const body = await readJsonBody<{ prompt?: unknown; reportDisposition?: unknown }>(
          request,
          15_000_000,
        );
        const shepherd = await service.spawnShepherd(
          typeof body.prompt === "string" ? { prompt: body.prompt } : {},
        );
        // Legacy callers (web /api/shepherd) still expect the session alone.
        sendJson(response, 201, body.reportDisposition === true ? shepherd : shepherd.session);
        return;
      }

      const sendSessionId = path.match(/^\/sessions\/([^/]+)\/send$/)?.[1];
      if (method === "POST" && sendSessionId) {
        const body = await readJsonBody<SendMessageRequest>(request, 15_000_000);
        sendJson(response, 200, await service.send(sendSessionId, body));
        return;
      }

      const queueOpMatch = path.match(/^\/sessions\/([^/]+)\/queue\/(remove|flush)$/);
      if (method === "POST" && queueOpMatch?.[1]) {
        const body = await readJsonBody<{ message?: unknown }>(request);
        // Forward the same trimmed value validation checks: a queued message
        // is always trimmed at enqueue (send()'s prepareSendMessage and the
        // web proxy's send route both trim before it ever reaches the
        // queue), so an untrimmed value here can never match a real entry —
        // validating trimmed but looking up raw would 404 a caller who
        // padded the text, for no reason.
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendError(response, 400, "message must be a non-empty string");
          return;
        }
        const queueSessionId = queueOpMatch[1];
        sendJson(
          response,
          200,
          queueOpMatch[2] === "remove"
            ? await service.removeQueuedMessage(queueSessionId, message)
            : await service.flushQueuedMessage(queueSessionId, message),
        );
        return;
      }

      const answerSessionId = path.match(/^\/sessions\/([^/]+)\/answer$/)?.[1];
      if (method === "POST" && answerSessionId) {
        const body = await readJsonBody<{ optionIndex?: unknown }>(request);
        const optionIndex = body.optionIndex;
        if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0) {
          sendError(response, 400, "optionIndex must be a non-negative integer");
          return;
        }
        await service.answerQuestion(answerSessionId, optionIndex);
        sendJson(response, 200, { ok: true });
        return;
      }

      const sourceReplySessionId = path.match(/^\/sessions\/([^/]+)\/source-reply$/)?.[1];
      if (method === "POST" && sourceReplySessionId) {
        const body = await readJsonBody<SourceReplyRequest>(request);
        sendJson(response, 200, await service.replyToSource(sourceReplySessionId, body));
        return;
      }

      const wakeSessionId = path.match(/^\/sessions\/([^/]+)\/wake$/)?.[1];
      if (method === "POST" && wakeSessionId) {
        const body = parseScheduleSessionWakeRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.scheduleWake(wakeSessionId, body));
        return;
      }

      const cancelWakeSessionId = path.match(/^\/sessions\/([^/]+)\/wake\/cancel$/)?.[1];
      if (method === "POST" && cancelWakeSessionId) {
        sendJson(response, 200, await service.cancelWake(cancelWakeSessionId));
        return;
      }

      const openedSessionId = path.match(/^\/sessions\/([^/]+)\/opened$/)?.[1];
      if (method === "POST" && openedSessionId) {
        sendJson(response, 200, await service.markOpened(decodeURIComponent(openedSessionId)));
        return;
      }

      const pauseSessionId = path.match(/^\/sessions\/([^/]+)\/pause$/)?.[1];
      if (method === "POST" && pauseSessionId) {
        sendJson(response, 200, await service.pause(pauseSessionId));
        return;
      }

      const todoSessionId = path.match(/^\/sessions\/([^/]+)\/todo$/)?.[1];
      if (method === "GET" && todoSessionId) {
        sendJson(response, 200, await service.readTodo(decodeURIComponent(todoSessionId)));
        return;
      }
      if (method === "POST" && todoSessionId) {
        const targetSessionId = decodeURIComponent(todoSessionId);
        const callerHeader = request.headers["x-spur-caller-session"];
        const actor = await resolveTodoMutationActor({
          origin,
          callerHeader,
          targetSessionId,
          lookup: (callerSessionId) => service.get(callerSessionId),
        });
        let body: TodoMutationRequest;
        try {
          body = parseTodoMutationRequest(await readJsonBody<unknown>(request));
        } catch (parseError) {
          throw new InvalidTodoRequestError(
            parseError instanceof Error ? parseError.message : "Invalid ToDo request",
          );
        }
        sendJson(response, 200, await service.mutateTodo(targetSessionId, body, actor));
        return;
      }

      const completeSessionId = path.match(/^\/sessions\/([^/]+)\/complete$/)?.[1];
      if (method === "POST" && completeSessionId) {
        let body: CompleteSessionRequest;
        try {
          body = parseCompleteSessionRequest(await readJsonBody<unknown>(request));
        } catch (parseError) {
          sendError(
            response,
            400,
            parseError instanceof Error ? parseError.message : "Invalid complete request",
          );
          return;
        }
        const todoOptions = humanTodoOptions(origin, request.headers["x-spur-caller-session"]);
        sendJson(
          response,
          200,
          body.scope === "desk"
            ? await service.completeDesk(completeSessionId, body, todoOptions)
            : await service.complete(completeSessionId, body, todoOptions),
        );
        return;
      }

      const selfDestructSessionId = path.match(/^\/sessions\/([^/]+)\/self-destruct$/)?.[1];
      if (method === "POST" && selfDestructSessionId) {
        sendJson(response, 200, await service.selfDestruct(selfDestructSessionId));
        return;
      }

      const killSessionId = path.match(/^\/sessions\/([^/]+)\/kill$/)?.[1];
      if (method === "POST" && killSessionId) {
        const body = parseKillSessionRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.kill(killSessionId, body));
        return;
      }

      const restoreSessionId = path.match(/^\/sessions\/([^/]+)\/restore$/)?.[1];
      if (method === "POST" && restoreSessionId) {
        const body = parseRestoreSessionRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.restore(restoreSessionId, body));
        return;
      }

      const reopenSessionId = path.match(/^\/sessions\/([^/]+)\/reopen$/)?.[1];
      if (method === "POST" && reopenSessionId) {
        const body = parseRestoreSessionRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.reopen(reopenSessionId, body));
        return;
      }

      const handoffSessionId = path.match(/^\/sessions\/([^/]+)\/handoff$/)?.[1];
      if (method === "POST" && handoffSessionId) {
        const body = await readJsonBody<HandoffSessionRequest>(request);
        sendJson(
          response,
          200,
          await service.handoff(
            handoffSessionId,
            body,
            humanTodoOptions(origin, request.headers["x-spur-caller-session"]),
          ),
        );
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
            void service
              .complete(terminateSessionId, { prAction: "leave_open" }, { retainInList: true })
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn?.(
                  `Respawned ${respawnSessionId} as ${respawned.id}, but failed to complete ${terminateSessionId}: ${message}`,
                );
              });
          });
        }
        return;
      }

      const switchAuthSessionId = path.match(/^\/sessions\/([^/]+)\/switch-auth$/)?.[1];
      if (method === "POST" && switchAuthSessionId) {
        const body = await readJsonBody<{ accountId?: unknown; force?: unknown }>(request);
        const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
        if (!accountId) {
          sendJson(response, 400, { error: "accountId must be a non-empty string" });
          return;
        }
        sendJson(
          response,
          200,
          await service.switchAuth(switchAuthSessionId, accountId, {
            reason: "manual",
            force: body.force === true,
          }),
        );
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

      if (method === "POST" && path === "/sidecars/sweep") {
        const { reap } = parseSweepSidecarsRequest(await readJsonBody<unknown>(request));
        sendJson(response, 200, await service.sweepSidecarProcesses(reap));
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
      errorMessage = message;
      if (
        error instanceof SessionResourceNotFoundError ||
        error instanceof InvalidClearPortError ||
        error instanceof InvalidConfigPathError ||
        error instanceof InvalidSourceReplyInputError ||
        error instanceof InvalidSessionMemoryInputError ||
        error instanceof InvalidSessionSubscriptionInputError ||
        error instanceof InvalidJsonBodyError ||
        error instanceof SessionAdmissionDeniedError ||
        error instanceof SessionRateLimitedError ||
        error instanceof SessionNotReopenableError ||
        error instanceof QueueDeliveryInFlightError
      ) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendError(response, error.statusCode, message);
        return;
      }
      if (
        error instanceof SidecarPortConflictError ||
        error instanceof OpenPrActionRequiredError ||
        error instanceof GithubPrCheckUnavailableError ||
        error instanceof SessionNotRestorableError
      ) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, error.payload);
        return;
      }
      if (error instanceof TodoOpenWorkError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, {
          code: error.code,
          sessions: error.sessions,
          error: error.message,
        });
        return;
      }
      if (error instanceof TodoEmptyLedgerError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, {
          code: error.code,
          ...(error.sessionIds.length === 1
            ? { sessionId: error.sessionIds[0] }
            : { sessionIds: error.sessionIds }),
          error: error.message,
        });
        return;
      }
      if (error instanceof InvalidTodoRequestError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, { code: error.code, error: error.message });
        return;
      }
      if (error instanceof TodoTransitionConflictError) {
        logEvent("http.request.failed", {
          level: "warn",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, {
          code: error.code,
          sessionId: error.sessionId,
          itemId: error.itemId,
          error: error.message,
        });
        return;
      }
      if (error instanceof TodoLedgerCorruptError) {
        logEvent("http.request.failed", {
          level: "error",
          ...(method ? { method } : {}),
          ...(path ? { path } : {}),
          message,
        });
        sendJson(response, error.statusCode, {
          code: error.code,
          sessionId: error.sessionId,
          error: error.message,
          ...(error.line ? { line: error.line } : {}),
        });
        return;
      }
      logEvent("http.request.failed", {
        level: "error",
        ...(method ? { method } : {}),
        ...(path ? { path } : {}),
        message,
      });
      sendError(response, 500, message);
    } finally {
      try {
        if (method && path) {
          const record = buildUserActionRecord({
            method,
            path,
            origin,
            body: readParsedBody(request),
            statusCode: response.statusCode,
            ...(errorMessage ? { error: errorMessage } : {}),
            latencyMs: Math.round(performance.now() - startedAt),
          });
          if (record) {
            appendUserAction(service.info().dataDir, record);
          }
        }
      } catch {
        // User-action logging must never block request handling.
      }
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  const closeServer = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      // server.closeAllConnections() destroys every tracked socket, including
      // in-flight requests, so a stuck handler can't block shutdown past the grace period.
      const forceTimer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      server.close(() => {
        clearTimeout(forceTimer);
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

  let driftedSessions: { id: string; project: string }[] = [];
  try {
    const {
      scanned,
      alive,
      drifted,
      driftedSessions: drifteds,
    } = await service.reconcileStoppedSessions();
    driftedSessions = drifteds;
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

  try {
    const { enabled, cap, liveCount } = service.getAdmissionStartupSummary();
    const atOrOverCap = liveCount >= cap.global;
    logEvent("daemon.admission.startup", {
      level: atOrOverCap ? "warn" : "info",
      message: `Admission at boot: enabled=${enabled}, cap=${cap.global} (${cap.source}), live=${liveCount}`,
      details: {
        enabled,
        cap: cap.global,
        capSource: cap.source,
        live: liveCount,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("daemon.admission.startup", {
      level: "warn",
      message: `Admission headroom check at boot failed: ${message}`,
    });
  }

  const memoryCeilingWarning = service.getMemoryCeilingWarning();
  if (memoryCeilingWarning) {
    const message = `Spur fleet cgroup ${memoryCeilingWarning.cgroupPath} has unlimited memory.max and systemd-oomd is absent`;
    logEvent("daemon.memory.unbounded", {
      level: "warn",
      message,
      details: memoryCeilingWarning,
    });
    process.stderr.write(`${message}\n`);
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

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (exitProcess: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      ready = false;
      logEvent("daemon.stopping", {
        level: "info",
        message: "Stopping Spur daemon",
      });
      const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
      const remainingBudgetMs = (): number => Math.max(0, deadline - Date.now());
      // Every teardown await goes through here: a step that never settles costs its
      // slice of the budget and a warning, never the whole stop window.
      const awaitBounded = async (
        event: string,
        label: string,
        task: Promise<unknown>,
        timeoutMs = remainingBudgetMs(),
      ): Promise<void> => {
        try {
          await withTimeout(task, timeoutMs, `${label} timeout`);
        } catch (error) {
          logEvent(event, {
            level: "warn",
            message: `Shutdown step ${label} did not finish: ${
              error instanceof Error ? error.message : String(error)
            }`,
            details: { step: label, timeoutMs },
          });
        }
      };
      // Armed before the first await so a step that wedges inside its own bound still
      // ends the process well under the service manager's stop timeout.
      const disarmBackstop = exitProcess
        ? armShutdownBackstop(SHUTDOWN_FORCE_EXIT_MS, (activeResources) =>
            forceShutdownExit(() =>
              logEvent("daemon.shutdown.forced_exit", {
                level: "error",
                message: `Graceful shutdown did not finish within ${SHUTDOWN_FORCE_EXIT_MS}ms; exiting with active resources: ${JSON.stringify(
                  activeResources,
                )}`,
                details: { timeoutMs: SHUTDOWN_FORCE_EXIT_MS, activeResources },
              }),
            ),
          )
        : null;
      try {
        // dispose() clears every owned interval — attention monitor, 1s scheduled-wake
        // poll, sidecar reaper, session reaper, 2s dashboard tick — before the first
        // await, so no tick can re-enter teardown or hold the loop open behind it.
        // It also retires the per-session delivery loops, which park on their own
        // poll sleep and would otherwise keep typing into panes after shutdown.
        service.dispose();
        const closePromise = closeServer();
        const sourceController = sources;
        if (sourceController) {
          await awaitBounded(
            "daemon.shutdown.sources_stop_timeout",
            "sources.stop",
            // SourceGroupController.stop() is sync-or-async by contract.
            Promise.resolve(sourceController.stop()),
          );
        }
        backlogs?.stop();
        runtimeLogs?.stop();
        const triggerController = triggers;
        if (triggerController) {
          await stopTriggersBounded(triggerController, remainingBudgetMs(), (message) =>
            logEvent("daemon.shutdown.stop_timeout", { level: "warn", message }),
          );
        }
        await awaitBounded(
          "daemon.shutdown.spawn_drain_timeout",
          "settleBackgroundSpawns",
          service.settleBackgroundSpawns(),
          Math.min(BACKGROUND_SPAWN_DRAIN_TIMEOUT_MS, remainingBudgetMs()),
        );
        await awaitBounded("daemon.shutdown.server_close_timeout", "server.close", closePromise);
        flushEventLogCollapse(service.config.dataDir);
        logEvent("daemon.stopped", {
          level: "info",
          message: "Stopped Spur daemon",
        });
      } finally {
        // Reached even when a teardown step throws, so a failed cleanup costs the signal
        // path nothing: it still exits here instead of waiting out the backstop or
        // systemd's SIGKILL. Note the awaits above swallow their own failures by design —
        // awaitBounded and stopTriggersBounded log and continue, because a best-effort
        // teardown must not abandon the steps behind it. Only a synchronous throw
        // (dispose(), the sync stops) escapes, and only programmatic stop() sees it.
        //
        // Flushed here, last, rather than before dispose(): dispose() only clears the
        // owned intervals, it does not cancel or await an already in-flight
        // runGhPollCycle (e.g. the attention monitor's fire-and-forget call). That
        // call's own `finally` in gh.ts writes into pollCycleRuns whenever it settles,
        // which can happen during any of the awaits above (sources.stop,
        // settleBackgroundSpawns, server.close) or be skipped over entirely by an
        // uncaught synchronous throw from backlogs?.stop() / runtimeLogs?.stop() —
        // both unbounded, unlike the awaitBounded steps around them. A flush placed
        // before dispose() or mid-try misses that write; finally is the one place
        // guaranteed to run after every one of those paths. ghEventSinkDataDir is a
        // module-level value set once at startup and never cleared during teardown, so
        // the sink this flush writes through is still live here.
        flushGhPollCycles();
        disarmBackstop?.();
        if (exitProcess) {
          process.exit(0);
        }
      }
    })();
    return shutdownPromise;
  };

  // Registered with `on` (not `once`): a repeat SIGTERM/SIGINT arriving during the
  // in-flight shutdown must re-enter `shutdown` and get the same shared promise
  // rather than falling through to Node's default terminate-the-process action,
  // which would cut off connection drain / trigger stop mid-teardown. Only the
  // programmatic `stop()` path below removes these listeners.
  const onShutdownSignal = () => {
    void shutdown(true);
  };
  process.on("SIGINT", onShutdownSignal);
  process.on("SIGTERM", onShutdownSignal);

  // Run reboot-restore after shutdown handlers register so mass restore stays interruptible.
  try {
    await service.restoreRebootedSessions(driftedSessions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("daemon.startup.reboot-restore.failed", {
      level: "warn",
      message: `Reboot restore at boot failed: ${message}`,
    });
  }

  return Object.assign(service, {
    async stop(): Promise<void> {
      process.off("SIGINT", onShutdownSignal);
      process.off("SIGTERM", onShutdownSignal);
      await shutdown(false);
    },
  });
}
