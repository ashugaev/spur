import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  isSessionState,
  type AvailableBacklogItem,
  type PersistedPendingBatch,
  type ReviewProviderId,
  type ReviewSignal,
  type RuntimeLogCursorState,
  type SessionQueuedMessagesState,
  type ServiceInstanceRecord,
  type ServiceSourceState,
  type SessionPipelineState,
  type SessionRecord,
  type SessionStateSubscription,
  type TelegramBinding,
  type TelegramReplyTarget,
  type WorkItemLifecycleRecord,
  type WorkItemLifecycleState,
} from "./types.js";
import { normalizeSessionPrBinding, parseSessionPrBinding } from "./session-pr.js";

function sessionFilePath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "sessions", projectId, `${sessionId}.json`);
}

function sessionIndexFilePath(dataDir: string): string {
  return join(dataDir, "sessions", ".index.json");
}

function reviewSnapshotDir(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
): string {
  return join(dataDir, "source-state", providerId, projectId, sourceId);
}

function workItemRegistryFilePath(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "github-work-items", projectId, `${sourceId}.json`);
}

function availableBacklogFilePath(dataDir: string, projectId: string, backlogId: string): string {
  return join(dataDir, "source-state", "available-backlog", projectId, `${backlogId}.json`);
}

function claimedBacklogFilePath(dataDir: string, projectId: string, backlogId: string): string {
  return join(dataDir, "source-state", "claimed-backlog", projectId, `${backlogId}.json`);
}

function commentSeenRegistryFilePath(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "github-comment-seen", projectId, `${sourceId}.json`);
}

function lifecycleBaselineRegistryFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
): string {
  return join(dataDir, "source-state", "github-lifecycle-baselined", projectId, `${sourceId}.json`);
}

function workItemLifecycleFilePath(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "work-item-lifecycle", projectId, `${sourceId}.json`);
}

// A single shared file, not one file per queueKey: queueKeys contain colons
// (`projectId:triggerId:sessionId`), which aren't filename-safe.
function pendingSendBatchesFilePath(dataDir: string): string {
  return join(dataDir, "pending-send-batches.json");
}

function serviceInstanceDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "services", sessionId);
}

function serviceInstanceFilePath(dataDir: string, sessionId: string, serviceId: string): string {
  return join(serviceInstanceDir(dataDir, sessionId), `${serviceId}.json`);
}

function serviceSourceStateDir(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "service", projectId, sourceId);
}

function telegramBindingFilePath(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "telegram", projectId, `${sourceId}.json`);
}

function telegramReplyTargetFilePath(dataDir: string, sessionId: string): string {
  return join(
    dataDir,
    "source-state",
    "telegram",
    "reply-targets",
    `${encodeURIComponent(sessionId)}.json`,
  );
}

function runtimeLogCursorDir(dataDir: string, sessionId: string): string {
  return join(dataDir, "runtime-log-state", sessionId);
}

function runtimeLogCursorFilePath(dataDir: string, sessionId: string, key: string): string {
  return join(runtimeLogCursorDir(dataDir, sessionId), `${key}.json`);
}

function serviceSourceStateFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): string {
  return join(serviceSourceStateDir(dataDir, projectId, sourceId), `${sessionId}.json`);
}

function reviewSnapshotFilePath(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
  sessionId: string,
): string {
  return join(reviewSnapshotDir(dataDir, providerId, projectId, sourceId), `${sessionId}.json`);
}

function githubMergeConflictRestoreFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): string {
  return join(
    reviewSnapshotDir(dataDir, "github", projectId, sourceId),
    `${sessionId}.merge-conflict`,
  );
}

function hasLegacyPrSlotAlias(session: SessionRecord): boolean {
  return (
    session.slots?.links.some(
      (link) =>
        link.label === "github-pr" ||
        link.label === "github_pr" ||
        (link.label === "pr" && parseSessionPrBinding(link.url) !== null),
    ) ?? false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Shallow guard only: the queue metadata (queueKey/projectId/triggerId/sourceId)
// plus a `batch.kind` check. Deep validation of the batch payload itself is
// `restoreSendBatch`'s job (send-batches.ts), not this module's.
function isPersistedPendingBatch(value: unknown): value is PersistedPendingBatch {
  if (!isRecord(value)) return false;
  if (
    typeof value["queueKey"] !== "string" ||
    typeof value["projectId"] !== "string" ||
    typeof value["triggerId"] !== "string" ||
    typeof value["sourceId"] !== "string"
  ) {
    return false;
  }
  const batch = value["batch"];
  if (!isRecord(batch)) return false;
  return batch["kind"] === "review" || batch["kind"] === "service" || batch["kind"] === "telegram";
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["project"] === "string";
}

function readSessionFile(path: string): SessionRecord {
  let rawSession: unknown;
  try {
    rawSession = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid session metadata JSON at ${path}: ${message}`, {
      cause: error,
    });
  }
  if (!isSessionRecord(rawSession)) {
    throw new Error(`Invalid session metadata shape at ${path}`);
  }
  const normalizedSession = normalizeSessionRecord(rawSession);
  if ((!rawSession.pr && normalizedSession.pr) || hasLegacyPrSlotAlias(rawSession)) {
    writeJsonFile(path, normalizedSession);
  }
  return normalizedSession;
}

function readServiceInstanceFile(path: string): ServiceInstanceRecord {
  return JSON.parse(readFileSync(path, "utf-8")) as ServiceInstanceRecord;
}

function readServiceSourceStateFile(path: string): ServiceSourceState {
  return JSON.parse(readFileSync(path, "utf-8")) as ServiceSourceState;
}

function readTelegramBindingKey(chatId: number, messageThreadId?: number): string {
  return `${chatId}:${messageThreadId ?? "main"}`;
}

function readTelegramStateFile(path: string): { bindings?: unknown; lastUpdateId?: unknown } {
  return JSON.parse(readFileSync(path, "utf-8")) as {
    bindings?: unknown;
    lastUpdateId?: unknown;
  };
}

function isTelegramBinding(value: unknown): value is TelegramBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<TelegramBinding>;
  return (
    typeof binding.chatId === "number" &&
    Number.isInteger(binding.chatId) &&
    (binding.messageThreadId === undefined ||
      (typeof binding.messageThreadId === "number" && Number.isInteger(binding.messageThreadId))) &&
    typeof binding.sessionId === "string" &&
    binding.sessionId.trim().length > 0
  );
}

function isTelegramReplyTarget(value: unknown): value is TelegramReplyTarget {
  if (!isTelegramBinding(value)) return false;
  const target = value as Partial<TelegramReplyTarget>;
  return (
    typeof target.projectId === "string" &&
    target.projectId.trim().length > 0 &&
    typeof target.sourceId === "string" &&
    target.sourceId.trim().length > 0 &&
    (target.statusMessageId === undefined ||
      (typeof target.statusMessageId === "number" && Number.isInteger(target.statusMessageId))) &&
    (target.lastInboundAt === undefined || typeof target.lastInboundAt === "string") &&
    (target.lastReplyAt === undefined || typeof target.lastReplyAt === "string") &&
    typeof target.updatedAt === "string"
  );
}

function readRuntimeLogCursorFile(path: string): RuntimeLogCursorState {
  return JSON.parse(readFileSync(path, "utf-8")) as RuntimeLogCursorState;
}

function readSessionIndex(dataDir: string): Record<string, string> {
  const path = sessionIndexFilePath(dataDir);
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function isAvailableBacklogItem(value: unknown): value is AvailableBacklogItem {
  if (!isRecord(value)) return false;
  return (
    typeof value["provider"] === "string" &&
    typeof value["projectId"] === "string" &&
    typeof value["backlogId"] === "string" &&
    typeof value["externalId"] === "string" &&
    typeof value["key"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["url"] === "string" &&
    typeof value["fetchedAt"] === "string"
  );
}

function readAvailableBacklogFile(path: string): Map<string, AvailableBacklogItem> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed["items"])) return new Map();
    const result = new Map<string, AvailableBacklogItem>();
    for (const item of parsed["items"]) {
      if (isAvailableBacklogItem(item)) {
        result.set(item.externalId, item);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

function writeSessionIndexEntry(dataDir: string, sessionId: string, filePath: string): void {
  const index = readSessionIndex(dataDir);
  index[sessionId] = relative(dataDir, filePath);
  writeJsonFile(sessionIndexFilePath(dataDir), index);
}

function deleteSessionIndexEntry(dataDir: string, sessionId: string): void {
  const index = readSessionIndex(dataDir);
  if (!(sessionId in index)) {
    return;
  }
  const { [sessionId]: _removed, ...nextIndex } = index;
  writeJsonFile(sessionIndexFilePath(dataDir), nextIndex);
}

function readWorkItemLifecycleFile(path: string): Map<string, WorkItemLifecycleRecord> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return new Map();
    const records = (parsed as { records?: unknown }).records;
    if (!Array.isArray(records)) return new Map();
    const result = new Map<string, WorkItemLifecycleRecord>();
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const raw = record as Record<string, unknown>;
      if (
        typeof raw.externalId !== "string" ||
        typeof raw.url !== "string" ||
        typeof raw.number !== "number" ||
        typeof raw.title !== "string" ||
        typeof raw.repo !== "string" ||
        typeof raw.createdAt !== "string"
      ) {
        continue;
      }
      const base = {
        externalId: raw.externalId,
        url: raw.url,
        number: raw.number,
        title: raw.title,
        repo: raw.repo,
        createdAt: raw.createdAt,
        autoComplete: typeof raw.autoComplete === "boolean" ? raw.autoComplete : true,
      };
      const state = isWorkItemLifecycleState(raw.state) ? raw.state : "running";
      if (state === "pending") {
        result.set(raw.externalId, {
          ...base,
          state,
        });
        continue;
      }
      if (state === "failed") {
        if (typeof raw.error !== "string") continue;
        result.set(raw.externalId, {
          ...base,
          state,
          error: raw.error,
        });
        continue;
      }
      if (typeof raw.sessionId !== "string") continue;
      if (state === "completed") {
        result.set(raw.externalId, {
          ...base,
          state,
          sessionId: raw.sessionId,
          completedAt: typeof raw.completedAt === "string" ? raw.completedAt : raw.createdAt,
        });
        continue;
      }
      result.set(raw.externalId, {
        ...base,
        state: "running",
        sessionId: raw.sessionId,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

function isWorkItemLifecycleState(value: unknown): value is WorkItemLifecycleState {
  return value === "pending" || value === "running" || value === "failed" || value === "completed";
}

function readPendingSendBatchesFile(path: string): Map<string, PersistedPendingBatch> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(parsed)) return new Map();
    const records = parsed["records"];
    if (!Array.isArray(records)) return new Map();
    const result = new Map<string, PersistedPendingBatch>();
    for (const record of records) {
      if (!isPersistedPendingBatch(record)) continue;
      result.set(record.queueKey, record);
    }
    return result;
  } catch {
    return new Map();
  }
}

function findSessionFilePath(dataDir: string, sessionId: string): string | null {
  const indexedPath = readSessionIndex(dataDir)[sessionId];
  if (indexedPath) {
    const resolvedPath = join(dataDir, indexedPath);
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  const rootDir = join(dataDir, "sessions");
  if (!existsSync(rootDir)) {
    if (indexedPath) {
      deleteSessionIndexEntry(dataDir, sessionId);
    }
    return null;
  }

  const fileName = `${sessionId}.json`;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rootDir, entry.name, fileName);
    if (existsSync(path)) {
      writeSessionIndexEntry(dataDir, sessionId, path);
      return path;
    }
  }

  if (indexedPath) {
    deleteSessionIndexEntry(dataDir, sessionId);
  }
  return null;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function parseReviewSignals(path: string): Map<string, ReviewSignal> {
  const signals = JSON.parse(readFileSync(path, "utf-8")) as ReviewSignal[];
  return new Map(signals.map((signal) => [signal.key, signal] satisfies [string, ReviewSignal]));
}

function normalizePipelineState(pipeline: SessionPipelineState): SessionPipelineState {
  return {
    steps: pipeline.steps,
    nextStepIndex: pipeline.nextStepIndex,
    ...(pipeline.awaitingStepIndex !== undefined
      ? { awaitingStepIndex: pipeline.awaitingStepIndex }
      : {}),
    ...(pipeline.nextStepNotBefore !== undefined
      ? { nextStepNotBefore: pipeline.nextStepNotBefore }
      : {}),
    status: pipeline.status,
    ...(pipeline.error !== undefined ? { error: pipeline.error } : {}),
  };
}

function normalizeQueuedMessagesState(
  queuedMessages: SessionQueuedMessagesState,
): SessionQueuedMessagesState {
  return {
    messages: queuedMessages.messages,
    awaitingPrompt: queuedMessages.awaitingPrompt,
  };
}

function normalizeStateSubscriptions(
  subscriptions: SessionStateSubscription[] | undefined,
): SessionStateSubscription[] | undefined {
  if (!subscriptions || subscriptions.length === 0) {
    return undefined;
  }
  const normalized = subscriptions
    .filter(
      (subscription) =>
        typeof subscription.id === "string" &&
        typeof subscription.targetSessionId === "string" &&
        Array.isArray(subscription.states) &&
        typeof subscription.createdAt === "string" &&
        typeof subscription.updatedAt === "string",
    )
    .map((subscription) => ({
      id: subscription.id,
      targetSessionId: subscription.targetSessionId,
      states: subscription.states.filter(isSessionState),
      ...(subscription.message ? { message: subscription.message } : {}),
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      ...(subscription.lastDeliveredTransitionId
        ? { lastDeliveredTransitionId: subscription.lastDeliveredTransitionId }
        : {}),
      ...(subscription.lastDeliveredAt ? { lastDeliveredAt: subscription.lastDeliveredAt } : {}),
    }))
    .filter((subscription) => subscription.states.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const normalizedSession = normalizeSessionPrBinding(session);
  const stateSubscriptions = normalizeStateSubscriptions(normalizedSession.stateSubscriptions);
  return {
    id: normalizedSession.id,
    project: normalizedSession.project,
    agent: normalizedSession.agent,
    ...(normalizedSession.planMode !== undefined ? { planMode: normalizedSession.planMode } : {}),
    ...(normalizedSession.restrictWrites !== undefined
      ? { restrictWrites: normalizedSession.restrictWrites }
      : {}),
    ...(normalizedSession.allowedTriggers !== undefined
      ? { allowedTriggers: normalizedSession.allowedTriggers }
      : {}),
    ...(normalizedSession.selfDestruct ? { selfDestruct: normalizedSession.selfDestruct } : {}),
    ...(normalizedSession.agentSessionId
      ? { agentSessionId: normalizedSession.agentSessionId }
      : {}),
    prompt: normalizedSession.prompt,
    ...(normalizedSession.startupAttachmentIds
      ? { startupAttachmentIds: normalizedSession.startupAttachmentIds }
      : {}),
    branch: normalizedSession.branch,
    ...(normalizedSession.branchSource ? { branchSource: normalizedSession.branchSource } : {}),
    ...(normalizedSession.pr ? { pr: normalizedSession.pr } : {}),
    worktree: normalizedSession.worktree,
    worktreePath: normalizedSession.worktreePath,
    tmuxSession: normalizedSession.tmuxSession,
    launchCommand: normalizedSession.launchCommand,
    status: normalizedSession.status,
    ...(normalizedSession.stopReason ? { stopReason: normalizedSession.stopReason } : {}),
    createdAt: normalizedSession.createdAt,
    updatedAt: normalizedSession.updatedAt,
    ...(normalizedSession.retainInList ? { retainInList: true } : {}),
    ...(normalizedSession.deskId ? { deskId: normalizedSession.deskId } : {}),
    ...(normalizedSession.slots ? { slots: normalizedSession.slots } : {}),
    ...(normalizedSession.sidecarNames ? { sidecarNames: normalizedSession.sidecarNames } : {}),
    ...(normalizedSession.sidecarPorts ? { sidecarPorts: normalizedSession.sidecarPorts } : {}),
    ...(normalizedSession.pipeline
      ? { pipeline: normalizePipelineState(normalizedSession.pipeline) }
      : {}),
    ...(normalizedSession.queuedMessages
      ? { queuedMessages: normalizeQueuedMessagesState(normalizedSession.queuedMessages) }
      : {}),
    ...(normalizedSession.scheduledWake ? { scheduledWake: normalizedSession.scheduledWake } : {}),
    ...(normalizedSession.intervalWake ? { intervalWake: normalizedSession.intervalWake } : {}),
    ...(normalizedSession.dailyWake ? { dailyWake: normalizedSession.dailyWake } : {}),
    ...(normalizedSession.rateLimitedAt ? { rateLimitedAt: normalizedSession.rateLimitedAt } : {}),
    ...(stateSubscriptions ? { stateSubscriptions } : {}),
    ...(normalizedSession.error ? { error: normalizedSession.error } : {}),
  };
}

function normalizeServiceInstanceRecord(service: ServiceInstanceRecord): ServiceInstanceRecord {
  return {
    sessionId: service.sessionId,
    project: service.project,
    serviceId: service.serviceId,
    ...(service.port !== undefined ? { port: service.port } : {}),
    command: service.command,
    cwd: service.cwd,
    tmuxSession: service.tmuxSession,
    status: service.status,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    ...(service.error ? { error: service.error } : {}),
  };
}

export function writeSession(dataDir: string, session: SessionRecord): void {
  const path = sessionFilePath(dataDir, session.project, session.id);
  writeJsonFile(path, normalizeSessionRecord(session));
  writeSessionIndexEntry(dataDir, session.id, path);
}

export function listSessions(dataDir: string): SessionRecord[] {
  const rootDir = join(dataDir, "sessions");
  if (!existsSync(rootDir)) return [];

  const sessions: SessionRecord[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(rootDir, entry.name);
    for (const fileName of readdirSync(projectDir)) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = join(projectDir, fileName);
      sessions.push(readSessionFile(filePath));
    }
  }

  sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return sessions;
}

export function readSession(dataDir: string, sessionId: string): SessionRecord | null {
  const path = findSessionFilePath(dataDir, sessionId);
  return path ? readSessionFile(path) : null;
}

export function writeServiceInstance(dataDir: string, service: ServiceInstanceRecord): void {
  writeJsonFile(
    serviceInstanceFilePath(dataDir, service.sessionId, service.serviceId),
    normalizeServiceInstanceRecord(service),
  );
}

export function listServiceInstances(dataDir: string): ServiceInstanceRecord[] {
  const rootDir = join(dataDir, "services");
  if (!existsSync(rootDir)) return [];

  const services: ServiceInstanceRecord[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(rootDir, entry.name);
    for (const fileName of readdirSync(sessionDir)) {
      if (!fileName.endsWith(".json")) continue;
      services.push(readServiceInstanceFile(join(sessionDir, fileName)));
    }
  }

  services.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return services;
}

export function listServiceInstancesForSession(
  dataDir: string,
  sessionId: string,
): ServiceInstanceRecord[] {
  const dir = serviceInstanceDir(dataDir, sessionId);
  if (!existsSync(dir)) return [];

  const services: ServiceInstanceRecord[] = [];
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    services.push(readServiceInstanceFile(join(dir, fileName)));
  }
  services.sort((left, right) => left.serviceId.localeCompare(right.serviceId));
  return services;
}

export function readServiceInstance(
  dataDir: string,
  sessionId: string,
  serviceId: string,
): ServiceInstanceRecord | null {
  const path = serviceInstanceFilePath(dataDir, sessionId, serviceId);
  return existsSync(path) ? readServiceInstanceFile(path) : null;
}

export function deleteServiceInstance(dataDir: string, sessionId: string, serviceId: string): void {
  rmSync(serviceInstanceFilePath(dataDir, sessionId, serviceId), { force: true });
}

export function deleteServiceInstancesForSession(dataDir: string, sessionId: string): void {
  rmSync(serviceInstanceDir(dataDir, sessionId), {
    force: true,
    recursive: true,
  });
}

export function writeRuntimeLogCursor(
  dataDir: string,
  sessionId: string,
  key: string,
  state: RuntimeLogCursorState,
): void {
  writeJsonFile(runtimeLogCursorFilePath(dataDir, sessionId, key), state);
}

export function readRuntimeLogCursor(
  dataDir: string,
  sessionId: string,
  key: string,
): RuntimeLogCursorState | null {
  const path = runtimeLogCursorFilePath(dataDir, sessionId, key);
  return existsSync(path) ? readRuntimeLogCursorFile(path) : null;
}

export function deleteRuntimeLogCursor(dataDir: string, sessionId: string, key: string): void {
  rmSync(runtimeLogCursorFilePath(dataDir, sessionId, key), { force: true });
}

export function deleteRuntimeLogCursorsForSession(dataDir: string, sessionId: string): void {
  rmSync(runtimeLogCursorDir(dataDir, sessionId), {
    force: true,
    recursive: true,
  });
}

export function listRuntimeLogCursorKeys(
  dataDir: string,
): Array<{ sessionId: string; key: string }> {
  const rootDir = join(dataDir, "runtime-log-state");
  if (!existsSync(rootDir)) return [];

  const keys: Array<{ sessionId: string; key: string }> = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(rootDir, entry.name);
    for (const fileName of readdirSync(sessionDir)) {
      if (!fileName.endsWith(".json")) continue;
      keys.push({
        sessionId: entry.name,
        key: fileName.slice(0, -".json".length),
      });
    }
  }
  return keys;
}

export function readReviewSourceSnapshots(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
): Map<string, Map<string, ReviewSignal>> {
  const dir = reviewSnapshotDir(dataDir, providerId, projectId, sourceId);
  if (!existsSync(dir)) return new Map();

  const snapshots = new Map<string, Map<string, ReviewSignal>>();
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const sessionId = fileName.slice(0, -".json".length);
    snapshots.set(sessionId, parseReviewSignals(join(dir, fileName)));
  }
  return snapshots;
}

export function readReviewSourceSnapshot(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
  sessionId: string,
): Map<string, ReviewSignal> | null {
  const path = reviewSnapshotFilePath(dataDir, providerId, projectId, sourceId, sessionId);
  return existsSync(path) ? parseReviewSignals(path) : null;
}

export function writeReviewSourceSnapshot(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
  sessionId: string,
  snapshot: Map<string, ReviewSignal>,
): void {
  writeJsonFile(reviewSnapshotFilePath(dataDir, providerId, projectId, sourceId, sessionId), [
    ...snapshot.values(),
  ]);
}

export function deleteReviewSourceSnapshot(
  dataDir: string,
  providerId: ReviewProviderId,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  rmSync(reviewSnapshotFilePath(dataDir, providerId, projectId, sourceId, sessionId), {
    force: true,
  });
}

export function readGitHubSourceSnapshots(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Map<string, Map<string, ReviewSignal>> {
  return readReviewSourceSnapshots(dataDir, "github", projectId, sourceId);
}

export function readGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): Map<string, ReviewSignal> | null {
  return readReviewSourceSnapshot(dataDir, "github", projectId, sourceId, sessionId);
}

export function writeGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
  snapshot: Map<string, ReviewSignal>,
): void {
  writeReviewSourceSnapshot(dataDir, "github", projectId, sourceId, sessionId, snapshot);
}

export function deleteGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  deleteReviewSourceSnapshot(dataDir, "github", projectId, sourceId, sessionId);
}

export function hasGitHubMergeConflictRestoreReplay(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): boolean {
  return existsSync(githubMergeConflictRestoreFilePath(dataDir, projectId, sourceId, sessionId));
}

export function requestGitHubMergeConflictRestoreReplay(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  writeJsonFile(githubMergeConflictRestoreFilePath(dataDir, projectId, sourceId, sessionId), true);
}

export function clearGitHubMergeConflictRestoreReplay(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  rmSync(githubMergeConflictRestoreFilePath(dataDir, projectId, sourceId, sessionId), {
    force: true,
  });
}

function readIdRegistry(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return new Set();
    const ids = (parsed as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function readClaimedBacklogRegistry(
  dataDir: string,
  projectId: string,
  backlogId: string,
): Set<string> {
  return readIdRegistry(claimedBacklogFilePath(dataDir, projectId, backlogId));
}

export function readAvailableBacklogItems(
  dataDir: string,
  projectId: string,
  backlogId: string,
): AvailableBacklogItem[] {
  const path = availableBacklogFilePath(dataDir, projectId, backlogId);
  if (!existsSync(path)) return [];
  const claimed = readClaimedBacklogRegistry(dataDir, projectId, backlogId);
  return [...readAvailableBacklogFile(path).values()]
    .filter((item) => !claimed.has(item.externalId))
    .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
}

export function replaceAvailableBacklogItems(
  dataDir: string,
  projectId: string,
  backlogId: string,
  items: readonly AvailableBacklogItem[],
): void {
  const claimed = readClaimedBacklogRegistry(dataDir, projectId, backlogId);
  writeJsonFile(availableBacklogFilePath(dataDir, projectId, backlogId), {
    items: items
      .filter((item) => !claimed.has(item.externalId))
      .sort((left, right) => left.externalId.localeCompare(right.externalId)),
  });
}

export function claimAvailableBacklogItem(
  dataDir: string,
  projectId: string,
  backlogId: string,
  externalId: string,
): AvailableBacklogItem | null {
  const item = readAvailableBacklogFile(
    availableBacklogFilePath(dataDir, projectId, backlogId),
  ).get(externalId);
  if (!item) return null;
  const claimed = readClaimedBacklogRegistry(dataDir, projectId, backlogId);
  if (claimed.has(externalId)) return null;
  claimed.add(externalId);
  writeJsonFile(claimedBacklogFilePath(dataDir, projectId, backlogId), {
    ids: [...claimed].sort(),
  });
  return item;
}

export function readWorkItemRegistry(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Set<string> {
  return readIdRegistry(workItemRegistryFilePath(dataDir, projectId, sourceId));
}

export function recordWorkItem(
  dataDir: string,
  projectId: string,
  sourceId: string,
  externalId: string,
): void {
  const ids = readWorkItemRegistry(dataDir, projectId, sourceId);
  if (ids.has(externalId)) return;
  ids.add(externalId);
  writeJsonFile(workItemRegistryFilePath(dataDir, projectId, sourceId), {
    ids: [...ids].sort(),
  });
}

export function readLifecycleBaselinedSessions(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Set<string> {
  return readIdRegistry(lifecycleBaselineRegistryFilePath(dataDir, projectId, sourceId));
}

export function recordLifecycleBaselinedSession(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  const ids = readLifecycleBaselinedSessions(dataDir, projectId, sourceId);
  if (ids.has(sessionId)) return;
  ids.add(sessionId);
  writeJsonFile(lifecycleBaselineRegistryFilePath(dataDir, projectId, sourceId), {
    ids: [...ids].sort(),
  });
}

export function removeLifecycleBaselinedSession(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  const ids = readLifecycleBaselinedSessions(dataDir, projectId, sourceId);
  if (!ids.delete(sessionId)) return;
  writeJsonFile(lifecycleBaselineRegistryFilePath(dataDir, projectId, sourceId), {
    ids: [...ids].sort(),
  });
}

export function readCommentSeenRegistry(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Set<string> {
  return readIdRegistry(commentSeenRegistryFilePath(dataDir, projectId, sourceId));
}

export function recordCommentSeen(
  dataDir: string,
  projectId: string,
  sourceId: string,
  ids: readonly string[],
): void {
  const known = readCommentSeenRegistry(dataDir, projectId, sourceId);
  const before = known.size;
  for (const id of ids) known.add(id);
  if (known.size === before) return;
  writeJsonFile(commentSeenRegistryFilePath(dataDir, projectId, sourceId), {
    ids: [...known].sort(),
  });
}

export function readWorkItemLifecycles(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Map<string, WorkItemLifecycleRecord> {
  const path = workItemLifecycleFilePath(dataDir, projectId, sourceId);
  return existsSync(path) ? readWorkItemLifecycleFile(path) : new Map();
}

export function recordWorkItemLifecycle(
  dataDir: string,
  projectId: string,
  sourceId: string,
  record: WorkItemLifecycleRecord,
): void {
  const records = readWorkItemLifecycles(dataDir, projectId, sourceId);
  records.set(record.externalId, record);
  writeJsonFile(workItemLifecycleFilePath(dataDir, projectId, sourceId), {
    records: [...records.values()].sort((left, right) =>
      left.externalId.localeCompare(right.externalId),
    ),
  });
}

export function deleteWorkItemLifecycle(
  dataDir: string,
  projectId: string,
  sourceId: string,
  externalId: string,
): void {
  const records = readWorkItemLifecycles(dataDir, projectId, sourceId);
  if (!records.delete(externalId)) return;
  writeJsonFile(workItemLifecycleFilePath(dataDir, projectId, sourceId), {
    records: [...records.values()].sort((left, right) =>
      left.externalId.localeCompare(right.externalId),
    ),
  });
}

export function readPendingSendBatches(dataDir: string): Map<string, PersistedPendingBatch> {
  const path = pendingSendBatchesFilePath(dataDir);
  return existsSync(path) ? readPendingSendBatchesFile(path) : new Map();
}

export function recordPendingSendBatch(dataDir: string, record: PersistedPendingBatch): void {
  const records = readPendingSendBatches(dataDir);
  records.set(record.queueKey, record);
  writeJsonFile(pendingSendBatchesFilePath(dataDir), {
    records: [...records.values()].sort((left, right) =>
      left.queueKey.localeCompare(right.queueKey),
    ),
  });
}

export function deletePendingSendBatch(dataDir: string, queueKey: string): void {
  const records = readPendingSendBatches(dataDir);
  if (!records.delete(queueKey)) return;
  writeJsonFile(pendingSendBatchesFilePath(dataDir), {
    records: [...records.values()].sort((left, right) =>
      left.queueKey.localeCompare(right.queueKey),
    ),
  });
}

export function readServiceSourceState(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): ServiceSourceState | null {
  const path = serviceSourceStateFilePath(dataDir, projectId, sourceId, sessionId);
  return existsSync(path) ? readServiceSourceStateFile(path) : null;
}

export function writeServiceSourceState(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
  state: ServiceSourceState,
): void {
  writeJsonFile(serviceSourceStateFilePath(dataDir, projectId, sourceId, sessionId), state);
}

export function deleteServiceSourceState(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  rmSync(serviceSourceStateFilePath(dataDir, projectId, sourceId, sessionId), {
    force: true,
  });
}

export function readTelegramBindings(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Map<string, TelegramBinding> {
  const path = telegramBindingFilePath(dataDir, projectId, sourceId);
  if (!existsSync(path)) return new Map();
  try {
    const parsed = readTelegramStateFile(path);
    const values = Array.isArray(parsed.bindings) ? parsed.bindings : [];
    return new Map(
      values
        .filter(isTelegramBinding)
        .map((binding) => [
          readTelegramBindingKey(binding.chatId, binding.messageThreadId),
          binding,
        ]),
    );
  } catch {
    return new Map();
  }
}

export function readTelegramLastUpdateId(
  dataDir: string,
  projectId: string,
  sourceId: string,
): number | undefined {
  const path = telegramBindingFilePath(dataDir, projectId, sourceId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = readTelegramStateFile(path);
    return typeof parsed.lastUpdateId === "number" && Number.isInteger(parsed.lastUpdateId)
      ? parsed.lastUpdateId
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeTelegramBindings(
  dataDir: string,
  projectId: string,
  sourceId: string,
  bindings: Iterable<TelegramBinding>,
  options: {
    lastUpdateId?: number;
    preserveExisting?: boolean;
    removeKeys?: Iterable<string>;
  } = {},
): void {
  const existing = options.preserveExisting
    ? readTelegramBindings(dataDir, projectId, sourceId)
    : new Map<string, TelegramBinding>();
  const removedKeys = new Set(options.removeKeys ?? []);
  for (const key of removedKeys) {
    existing.delete(key);
  }
  for (const binding of bindings) {
    existing.set(readTelegramBindingKey(binding.chatId, binding.messageThreadId), binding);
  }
  const existingLastUpdateId = readTelegramLastUpdateId(dataDir, projectId, sourceId);
  writeJsonFile(telegramBindingFilePath(dataDir, projectId, sourceId), {
    bindings: [...existing.values()].sort((left, right) => {
      const chatOrder = left.chatId - right.chatId;
      if (chatOrder !== 0) return chatOrder;
      return (left.messageThreadId ?? 0) - (right.messageThreadId ?? 0);
    }),
    ...(options.lastUpdateId !== undefined
      ? { lastUpdateId: options.lastUpdateId }
      : existingLastUpdateId !== undefined
        ? { lastUpdateId: existingLastUpdateId }
        : {}),
  });
}

export function readTelegramReplyTarget(
  dataDir: string,
  sessionId: string,
): TelegramReplyTarget | null {
  const path = telegramReplyTargetFilePath(dataDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isTelegramReplyTarget(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeTelegramReplyTarget(
  dataDir: string,
  target: Omit<TelegramReplyTarget, "updatedAt">,
): void {
  writeJsonFile(telegramReplyTargetFilePath(dataDir, target.sessionId), {
    ...target,
    updatedAt: new Date().toISOString(),
  });
}

export function deleteTelegramReplyTarget(dataDir: string, sessionId: string): void {
  rmSync(telegramReplyTargetFilePath(dataDir, sessionId), { force: true });
}

export function deleteTelegramSourceStateForSession(
  dataDir: string,
  projectId: string,
  sessionId: string,
): void {
  const dir = join(dataDir, "source-state", "telegram", projectId);
  if (!existsSync(dir)) {
    deleteTelegramReplyTarget(dataDir, sessionId);
    return;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sourceId = entry.name.slice(0, -".json".length);
    const bindings = readTelegramBindings(dataDir, projectId, sourceId);
    const remaining = [...bindings.values()].filter((binding) => binding.sessionId !== sessionId);
    if (remaining.length !== bindings.size) {
      const lastUpdateId = readTelegramLastUpdateId(dataDir, projectId, sourceId);
      writeTelegramBindings(
        dataDir,
        projectId,
        sourceId,
        remaining,
        lastUpdateId === undefined ? {} : { lastUpdateId },
      );
    }
  }
  deleteTelegramReplyTarget(dataDir, sessionId);
}

export function listActiveServiceProblems(
  dataDir: string,
  projectId: string,
  sessionId: string,
  serviceId: string,
): string[] {
  const dir = join(dataDir, "source-state", "service", projectId);
  if (!existsSync(dir)) return [];

  const activeRules = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, `${sessionId}.json`);
    if (!existsSync(path)) continue;
    const state = readServiceSourceStateFile(path);
    if (state.serviceId !== serviceId) continue;
    for (const [ruleId, ruleState] of Object.entries(state.rules)) {
      if (ruleState.active) {
        activeRules.add(ruleId);
      }
    }
  }
  return [...activeRules].sort();
}

export function deleteServiceSourceStatesForSession(
  dataDir: string,
  projectId: string,
  sessionId: string,
): void {
  const dir = join(dataDir, "source-state", "service", projectId);
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rmSync(join(dir, entry.name, `${sessionId}.json`), { force: true });
  }
}

export function deleteServiceSourceStatesForService(
  dataDir: string,
  projectId: string,
  sessionId: string,
  serviceId: string,
): void {
  const dir = join(dataDir, "source-state", "service", projectId);
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, `${sessionId}.json`);
    if (!existsSync(path)) continue;
    const state = readServiceSourceStateFile(path);
    if (state.serviceId === serviceId) {
      rmSync(path, { force: true });
    }
  }
}
