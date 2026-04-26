import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GitHubSignal,
  RuntimeLogCursorState,
  SessionQueuedMessagesState,
  ServiceInstanceRecord,
  ServiceSourceState,
  SessionPipelineState,
  SessionRecord,
} from "./types.js";
import { normalizeSessionPrBinding, parseSessionPrBinding } from "./session-pr.js";

function sessionFilePath(dataDir: string, projectId: string, sessionId: string): string {
  return join(dataDir, "sessions", projectId, `${sessionId}.json`);
}

function githubSnapshotDir(dataDir: string, projectId: string, sourceId: string): string {
  return join(dataDir, "source-state", "github", projectId, sourceId);
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

function githubSnapshotFilePath(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): string {
  return join(githubSnapshotDir(dataDir, projectId, sourceId), `${sessionId}.json`);
}

function hasLegacyNativePrLink(session: SessionRecord): boolean {
  return (
    session.slots?.links.some(
      (link) => link.label === "pr" && parseSessionPrBinding(link.url) !== null,
    ) ?? false
  );
}

function readSessionFile(path: string): SessionRecord {
  const rawSession = JSON.parse(readFileSync(path, "utf-8")) as SessionRecord;
  const normalizedSession = normalizeSessionRecord(rawSession);
  if ((!rawSession.pr && normalizedSession.pr) || hasLegacyNativePrLink(rawSession)) {
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

function readRuntimeLogCursorFile(path: string): RuntimeLogCursorState {
  return JSON.parse(readFileSync(path, "utf-8")) as RuntimeLogCursorState;
}

function findSessionFilePath(dataDir: string, sessionId: string): string | null {
  const rootDir = join(dataDir, "sessions");
  if (!existsSync(rootDir)) return null;

  const fileName = `${sessionId}.json`;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(rootDir, entry.name, fileName);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function parseGitHubSignals(path: string): Map<string, GitHubSignal> {
  const signals = JSON.parse(readFileSync(path, "utf-8")) as GitHubSignal[];
  return new Map(signals.map((signal) => [signal.key, signal] satisfies [string, GitHubSignal]));
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

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const normalizedSession = normalizeSessionPrBinding(session);
  return {
    id: normalizedSession.id,
    project: normalizedSession.project,
    agent: normalizedSession.agent,
    ...(normalizedSession.agentSessionId ? { agentSessionId: normalizedSession.agentSessionId } : {}),
    prompt: normalizedSession.prompt,
    branch: normalizedSession.branch,
    ...(normalizedSession.branchSource ? { branchSource: normalizedSession.branchSource } : {}),
    ...(normalizedSession.pr ? { pr: normalizedSession.pr } : {}),
    worktree: normalizedSession.worktree,
    worktreePath: normalizedSession.worktreePath,
    tmuxSession: normalizedSession.tmuxSession,
    launchCommand: normalizedSession.launchCommand,
    status: normalizedSession.status,
    createdAt: normalizedSession.createdAt,
    updatedAt: normalizedSession.updatedAt,
    ...(normalizedSession.retainInList ? { retainInList: true } : {}),
    ...(normalizedSession.slots ? { slots: normalizedSession.slots } : {}),
    ...(normalizedSession.sidecarNames ? { sidecarNames: normalizedSession.sidecarNames } : {}),
    ...(normalizedSession.sidecarPorts ? { sidecarPorts: normalizedSession.sidecarPorts } : {}),
    ...(normalizedSession.pipeline ? { pipeline: normalizePipelineState(normalizedSession.pipeline) } : {}),
    ...(normalizedSession.queuedMessages
      ? { queuedMessages: normalizeQueuedMessagesState(normalizedSession.queuedMessages) }
      : {}),
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
  writeJsonFile(
    sessionFilePath(dataDir, session.project, session.id),
    normalizeSessionRecord(session),
  );
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

export function readGitHubSourceSnapshots(
  dataDir: string,
  projectId: string,
  sourceId: string,
): Map<string, Map<string, GitHubSignal>> {
  const dir = githubSnapshotDir(dataDir, projectId, sourceId);
  if (!existsSync(dir)) return new Map();

  const snapshots = new Map<string, Map<string, GitHubSignal>>();
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const sessionId = fileName.slice(0, -".json".length);
    snapshots.set(sessionId, parseGitHubSignals(join(dir, fileName)));
  }
  return snapshots;
}

export function readGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): Map<string, GitHubSignal> | null {
  const path = githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId);
  return existsSync(path) ? parseGitHubSignals(path) : null;
}

export function writeGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
  snapshot: Map<string, GitHubSignal>,
): void {
  writeJsonFile(githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId), [
    ...snapshot.values(),
  ]);
}

export function deleteGitHubSourceSnapshot(
  dataDir: string,
  projectId: string,
  sourceId: string,
  sessionId: string,
): void {
  rmSync(githubSnapshotFilePath(dataDir, projectId, sourceId, sessionId), {
    force: true,
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
