import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getProjectBaseDir, getSessionsDir, readArchivedMetadataRaw } from "@composio/ao-core";
import type { ListenerController, ListenerSource, ListenerStartDeps } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BACKLOG_STATUS = "Backlog";
const DEFAULT_LOCK_STALE_MS = 5 * 60_000;
const DEFAULT_PENDING_CLAIM_TTL_MS = 30 * 60_000;
const LOCK_RETRY_ATTEMPTS = 200;
const LOCK_RETRY_DELAY_MS = 25;
const STATE_VERSION = 1;

interface JiraBacklogListenerState {
  version: number;
  issues: Record<string, { lastSessionId: string; updatedAt: string }>;
}

interface JiraIssueListItem {
  key?: unknown;
}

interface KnownSessionState {
  status?: string;
  terminationReason?: string;
}

interface FileLockHandle {
  refresh(): void;
  release(): void;
}

interface ErrorWithStreams {
  message?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  cause?: unknown;
}

function sanitizeListenerId(listenerId: string): string {
  const sanitized = listenerId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "listener";
}

function normalizeIssueKey(issueKey: string): string {
  return issueKey.trim().toUpperCase();
}

function sanitizeIssueKeyForLock(issueKey: string): string {
  const normalized = normalizeIssueKey(issueKey).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return normalized.length > 0 ? normalized : "issue";
}

function buildStatePath(configPath: string, projectPath: string, listenerId: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  return join(baseDir, "listeners", `${sanitizeListenerId(listenerId)}.json`);
}

function buildIssueLocksDir(configPath: string, projectPath: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  return join(baseDir, "listeners", "_issue-locks");
}

function readState(statePath: string): JiraBacklogListenerState {
  if (!existsSync(statePath)) {
    return { version: STATE_VERSION, issues: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<JiraBacklogListenerState>;
    if (
      parsed &&
      parsed.version === STATE_VERSION &&
      parsed.issues &&
      typeof parsed.issues === "object"
    ) {
      return { version: STATE_VERSION, issues: parsed.issues };
    }
  } catch {
    // Corrupt state will be reset to a clean slate.
  }

  return { version: STATE_VERSION, issues: {} };
}

function writeState(statePath: string, state: JiraBacklogListenerState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, statePath);
}

function parseMetadataContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const delimiter = trimmed.indexOf("=");
    if (delimiter < 0) continue;
    const key = trimmed.slice(0, delimiter).trim();
    const value = trimmed.slice(delimiter + 1).trim();
    if (!key) continue;
    parsed[key] = value;
  }
  return parsed;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isJiraCommandMissingError(error: unknown): boolean {
  if (isNodeErrorWithCode(error, "ENOENT")) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    isNodeErrorWithCode((error as { cause?: unknown }).cause, "ENOENT")
  ) {
    return true;
  }
  return false;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function extractStreamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

function flattenErrorText(error: unknown): string {
  const parts: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const typed = current as ErrorWithStreams;

    if (typeof typed.message === "string" && typed.message.trim().length > 0) {
      parts.push(typed.message);
    }

    const stderr = extractStreamText(typed.stderr);
    if (stderr.trim().length > 0) parts.push(stderr);

    const stdout = extractStreamText(typed.stdout);
    if (stdout.trim().length > 0) parts.push(stdout);

    current = typed.cause;
  }

  return stripAnsi(parts.join("\n")).toLowerCase();
}

function isJiraNoResultsError(error: unknown): boolean {
  const text = flattenErrorText(error);
  return (
    text.includes("no result found for given query") ||
    text.includes("no results found for given query")
  );
}

function acquireFileLock(lockPath: string, staleMs: number): FileLockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const tryCreateLock = (): boolean => {
    try {
      writeFileSync(lockPath, `${lockToken}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
      return true;
    } catch (err) {
      if (isNodeErrorWithCode(err, "EEXIST")) {
        return false;
      }
      throw err;
    }
  };

  if (!tryCreateLock()) {
    let stale = false;
    try {
      const lockStat = statSync(lockPath);
      stale = Date.now() - lockStat.mtimeMs > staleMs;
    } catch (err) {
      if (!isNodeErrorWithCode(err, "ENOENT")) {
        throw err;
      }
    }

    if (!stale) {
      return null;
    }

    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (!isNodeErrorWithCode(err, "ENOENT")) {
        throw err;
      }
    }

    if (!tryCreateLock()) {
      return null;
    }
  }

  const isOwnedByCurrentHandle = (): boolean => {
    try {
      const currentToken = readFileSync(lockPath, "utf-8").trim();
      return currentToken === lockToken;
    } catch {
      return false;
    }
  };

  return {
    refresh(): void {
      if (!isOwnedByCurrentHandle()) return;
      try {
        writeFileSync(lockPath, `${lockToken}\n`, {
          encoding: "utf-8",
          flag: "w",
        });
      } catch {
        // Best effort keepalive.
      }
    },
    release(): void {
      if (!isOwnedByCurrentHandle()) return;
      try {
        unlinkSync(lockPath);
      } catch (err) {
        if (!isNodeErrorWithCode(err, "ENOENT")) {
          throw err;
        }
      }
    },
  };
}

async function withRetriedFileLock<T>(
  lockPath: string,
  staleMs: number,
  fn: () => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const lock = acquireFileLock(lockPath, staleMs);
    if (lock) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }

  throw new Error(`Timed out acquiring lock: ${lockPath}`);
}

async function withLockedState<T>(
  statePath: string,
  lockStaleMs: number,
  fn: (state: JiraBacklogListenerState) => T | Promise<T>,
): Promise<T> {
  const stateLockPath = `${statePath}.lock`;
  return withRetriedFileLock(stateLockPath, lockStaleMs, async () => {
    const latestState = readState(statePath);
    const result = await fn(latestState);
    writeState(statePath, latestState);
    return result;
  });
}

async function setIssueStateEntry(
  statePath: string,
  issueKey: string,
  entry: JiraBacklogListenerState["issues"][string],
  lockStaleMs: number,
): Promise<void> {
  await withLockedState(statePath, lockStaleMs, (latestState) => {
    latestState.issues[issueKey] = entry;
  });
}

async function restoreIssueStateEntry(
  statePath: string,
  issueKey: string,
  previousEntry: JiraBacklogListenerState["issues"][string] | null,
  lockStaleMs: number,
): Promise<void> {
  await withLockedState(statePath, lockStaleMs, (latestState) => {
    if (previousEntry) {
      latestState.issues[issueKey] = previousEntry;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete latestState.issues[issueKey];
    }
  });
}

async function jiraCli(
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("jira", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      ...(env ? { env } : {}),
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`jira ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function listIssueKeysByJql(
  jql: string,
  env?: Record<string, string | undefined>,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await jiraCli(["issue", "list", "-q", jql, "--raw"], env);
  } catch (err) {
    if (isJiraNoResultsError(err)) {
      return [];
    }
    throw err;
  }

  if (!raw) return [];

  const parsed = JSON.parse(raw) as JiraIssueListItem[];
  if (!Array.isArray(parsed)) return [];

  const unique = new Set<string>();
  for (const item of parsed) {
    if (typeof item?.key !== "string") continue;
    const key = normalizeIssueKey(item.key);
    if (key.length > 0) unique.add(key);
  }

  return [...unique];
}

function isBlockingSessionStatus(status: string | undefined): boolean {
  return status !== "killed";
}

function getArchivedSessionState(sessionsDir: string, sessionId: string): KnownSessionState {
  const archived = readArchivedMetadataRaw(sessionsDir, sessionId);
  if (!archived) return {};

  return {
    status: archived["status"],
    terminationReason: archived["terminationReason"],
  };
}

function getLatestArchivedSessionStateForIssue(
  sessionsDir: string,
  issueKey: string,
): KnownSessionState {
  const archiveDir = join(sessionsDir, "archive");
  if (!existsSync(archiveDir)) return {};

  let latestMtimeMs = -1;
  let latestState: KnownSessionState = {};

  for (const filename of readdirSync(archiveDir)) {
    try {
      const archivePath = join(archiveDir, filename);
      const raw = parseMetadataContent(readFileSync(archivePath, "utf-8"));
      if (normalizeIssueKey(raw["issue"] ?? "") !== issueKey) continue;
      const fileMtimeMs = statSync(archivePath).mtimeMs;
      if (fileMtimeMs <= latestMtimeMs) continue;
      latestMtimeMs = fileMtimeMs;
      latestState = {
        status: raw["status"],
        terminationReason: raw["terminationReason"],
      };
    } catch {
      // Ignore malformed archive files.
    }
  }

  return latestState;
}

function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith("pending-");
}

function ageFromIsoString(isoTimestamp: string): number | null {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - parsed;
}

function shouldAllowRetryFromLastSession(state: KnownSessionState): {
  allow: boolean;
  reason: string;
} {
  if (!state.status) {
    return { allow: false, reason: "unknown-status" };
  }

  if (state.status !== "killed") {
    return { allow: false, reason: `terminal-${state.status}` };
  }

  if (state.terminationReason === "cleanup") {
    return { allow: false, reason: "cleanup-termination" };
  }

  if (
    state.terminationReason &&
    state.terminationReason !== "manual" &&
    state.terminationReason !== "system"
  ) {
    return { allow: false, reason: `unsupported-termination-reason-${state.terminationReason}` };
  }

  return { allow: true, reason: "killed" };
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildEffectiveJql(jql: string, backlogStatus: string): string {
  const escapedBacklogStatus = escapeJqlString(backlogStatus);
  return `(${jql}) AND status = "${escapedBacklogStatus}"`;
}

function currentIsoTime(): string {
  return new Date().toISOString();
}

async function startJiraBacklogListener(deps: ListenerStartDeps): Promise<ListenerController> {
  const {
    listener,
    listenerId,
    sessionManager,
    logger,
    config,
    projectId,
    project,
    healthReporter,
    healthIdentity,
  } = deps;
  const intervalMs =
    typeof listener.intervalMs === "number" && listener.intervalMs > 0
      ? listener.intervalMs
      : DEFAULT_INTERVAL_MS;
  const backlogStatus =
    typeof listener.backlogStatus === "string" && listener.backlogStatus.trim()
      ? listener.backlogStatus.trim()
      : DEFAULT_BACKLOG_STATUS;
  const lockStaleMs =
    typeof listener.lockStaleMs === "number" && listener.lockStaleMs > 0
      ? listener.lockStaleMs
      : DEFAULT_LOCK_STALE_MS;
  const pendingClaimTtlMs = Math.max(lockStaleMs * 2, DEFAULT_PENDING_CLAIM_TTL_MS);
  const triggerType =
    typeof listener.trigger === "object" &&
    listener.trigger !== null &&
    "type" in listener.trigger
      ? String(listener.trigger.type)
      : "spawn-session";
  const agentOverride =
    typeof listener.trigger === "object" &&
    listener.trigger !== null &&
    "agent" in listener.trigger &&
    typeof listener.trigger.agent === "string"
      ? listener.trigger.agent
      : undefined;
  const jql = typeof listener.jql === "string" ? listener.jql.trim() : "";

  if (triggerType !== "spawn-session") {
    throw new Error(
      `[listener:${listenerId}] Unsupported trigger type "${triggerType}" for jira-backlog`,
    );
  }

  if (!jql) {
    throw new Error(`[listener:${listenerId}] Missing required field: jql`);
  }

  if (!backlogStatus) {
    throw new Error(`[listener:${listenerId}] Missing required field: backlogStatus`);
  }

  if (project.tracker?.plugin !== "jira") {
    throw new Error(
      `[listener:${listenerId}] jira-backlog listener requires tracker plugin "jira" for project "${projectId}"`,
    );
  }

  // Build child env with per-project Jira credentials (fall back to env vars)
  const tracker = project.tracker as Record<string, unknown> | undefined;
  const jiraEmail =
    toStringOrUndefined(tracker?.["email"]) ||
    process.env["JIRA_EMAIL"] ||
    process.env["JIRA_USER"];
  const jiraToken =
    toStringOrUndefined(tracker?.["apiToken"]) ||
    process.env["JIRA_API_TOKEN"] ||
    process.env["JIRA_TOKEN"];
  const jiraUrl =
    toStringOrUndefined(tracker?.["baseUrl"]) ||
    process.env["JIRA_URL"] ||
    process.env["JIRA_HOST"];

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...(jiraEmail ? { JIRA_EMAIL: jiraEmail, JIRA_USER: jiraEmail } : {}),
    ...(jiraToken ? { JIRA_API_TOKEN: jiraToken, JIRA_TOKEN: jiraToken } : {}),
    ...(jiraUrl ? { JIRA_URL: jiraUrl, JIRA_HOST: jiraUrl } : {}),
  };

  const effectiveJql = buildEffectiveJql(jql, backlogStatus);
  const statePath = buildStatePath(config.configPath, project.path, listenerId);
  const issueLocksDir = buildIssueLocksDir(config.configPath, project.path);
  const sessionsDir = getSessionsDir(config.configPath, project.path);
  const warnedUnknownStatuses = new Set<string>();
  const integrationIdentity = healthIdentity ?? {
    id: `listener:${listenerId}`,
    label: `Listener ${listenerId} (${listener.source})`,
    service: "jira" as const,
    kind: "listener" as const,
  };

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopPolling = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    healthReporter?.markInactive(integrationIdentity, "Jira backlog listener stopped");
  };

  healthReporter?.markStarting(integrationIdentity, "Starting Jira backlog listener");

  const pollOnce = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let cycleHadErrors = false;
    let cycleIssueCount: number;

    try {
      const [issueKeys, sessions] = await Promise.all([
        listIssueKeysByJql(effectiveJql, childEnv),
        sessionManager.list(projectId),
      ]);
      cycleIssueCount = issueKeys.length;
      if (stopped) return;

      const sessionsByIssue = new Map<string, KnownSessionState[]>();
      const sessionsById = new Map<string, KnownSessionState>();

      for (const session of sessions) {
        if (!session.issueId) continue;
        const issueKey = normalizeIssueKey(session.issueId);
        const sessionState: KnownSessionState = {
          status: session.status,
          terminationReason: session.metadata["terminationReason"],
        };
        const list = sessionsByIssue.get(issueKey);
        if (list) {
          list.push(sessionState);
        } else {
          sessionsByIssue.set(issueKey, [sessionState]);
        }
        sessionsById.set(session.id, sessionState);
      }

      for (const issueKey of issueKeys) {
        if (stopped) break;

        const issueLockPath = join(issueLocksDir, `${sanitizeIssueKeyForLock(issueKey)}.lock`);
        const issueLock = acquireFileLock(issueLockPath, lockStaleMs);
        if (!issueLock) {
          continue;
        }

        try {
          if (stopped) break;

          const currentSessions = sessionsByIssue.get(issueKey) ?? [];
          const hasBlockingSession = currentSessions.some((state) =>
            isBlockingSessionStatus(state.status),
          );
          if (hasBlockingSession) {
            continue;
          }

          const state = readState(statePath);
          const entry = state.issues[issueKey];
          const previousEntry = entry ? { ...entry } : null;
          if (entry) {
            const liveState = sessionsById.get(entry.lastSessionId);
            const archivedState = liveState
              ? undefined
              : getArchivedSessionState(sessionsDir, entry.lastSessionId);
            let lastState = liveState ?? archivedState ?? {};
            if (!lastState.status && isPendingSessionId(entry.lastSessionId)) {
              const archivedIssueState = getLatestArchivedSessionStateForIssue(
                sessionsDir,
                issueKey,
              );
              if (archivedIssueState.status) {
                lastState = archivedIssueState;
              }
            }
            const retryDecision = shouldAllowRetryFromLastSession(lastState);
            if (!retryDecision.allow) {
              if (retryDecision.reason === "unknown-status") {
                if (isPendingSessionId(entry.lastSessionId)) {
                  const ageMs = ageFromIsoString(entry.updatedAt);
                  if (ageMs !== null && ageMs > pendingClaimTtlMs) {
                    await restoreIssueStateEntry(statePath, issueKey, null, lockStaleMs);
                    logger.warn(
                      `[listener:${listenerId}] Clearing stale pending claim for ${issueKey} (age ${ageMs}ms)`,
                    );
                    continue;
                  }
                }
                const warningId = `${issueKey}:${entry.lastSessionId}`;
                if (!warnedUnknownStatuses.has(warningId)) {
                  warnedUnknownStatuses.add(warningId);
                  logger.warn(
                    `[listener:${listenerId}] Blocking retry for ${issueKey}: previous session ${entry.lastSessionId} has unknown terminal status`,
                  );
                }
              }
              continue;
            }
          }

          if (stopped) break;

          const lockHeartbeatIntervalMs = Math.max(1_000, Math.floor(lockStaleMs / 3));
          const lockHeartbeat = setInterval(() => {
            issueLock.refresh();
          }, lockHeartbeatIntervalMs);

          let claimWritten = false;
          let spawnedSessionId: string | null = null;
          const pendingSessionId = `pending-${process.pid}-${Date.now()}`;

          try {
            await setIssueStateEntry(
              statePath,
              issueKey,
              {
                lastSessionId: pendingSessionId,
                updatedAt: currentIsoTime(),
              },
              lockStaleMs,
            );
            claimWritten = true;

            if (stopped) {
              await restoreIssueStateEntry(statePath, issueKey, previousEntry, lockStaleMs);
              break;
            }

            const session = await sessionManager.spawn({
              projectId,
              issueId: issueKey,
              ...(agentOverride ? { agent: agentOverride } : {}),
            });
            spawnedSessionId = session.id;

            await setIssueStateEntry(
              statePath,
              issueKey,
              {
                lastSessionId: session.id,
                updatedAt: currentIsoTime(),
              },
              lockStaleMs,
            );
          } catch (err) {
            if (spawnedSessionId) {
              try {
                await setIssueStateEntry(
                  statePath,
                  issueKey,
                  {
                    lastSessionId: spawnedSessionId,
                    updatedAt: currentIsoTime(),
                  },
                  lockStaleMs,
                );
              } catch (persistErr) {
                const persistMsg =
                  persistErr instanceof Error ? persistErr.message : String(persistErr);
                logger.warn(
                  `[listener:${listenerId}] Spawned session ${spawnedSessionId} for ${issueKey}, but failed to persist listener state: ${persistMsg}. Disabling listener to avoid duplicate processing.`,
                );
                stopPolling();
              }
              continue;
            }

            if (claimWritten) {
              try {
                await restoreIssueStateEntry(statePath, issueKey, previousEntry, lockStaleMs);
              } catch (restoreErr) {
                const restoreMsg =
                  restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
                logger.warn(
                  `[listener:${listenerId}] Failed to rollback claim for ${issueKey}: ${restoreMsg}`,
                );
              }
            }

            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[listener:${listenerId}] Failed to spawn session for ${issueKey}: ${msg}`,
            );
            cycleHadErrors = true;
          } finally {
            clearInterval(lockHeartbeat);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[listener:${listenerId}] Failed to process issue ${issueKey}: ${msg}`,
          );
          cycleHadErrors = true;
        } finally {
          issueLock.release();
        }
      }

      if (cycleHadErrors) {
        healthReporter?.markDegraded(
          integrationIdentity,
          "Jira backlog listener cycle completed with errors",
        );
      } else {
        healthReporter?.markHealthy(
          integrationIdentity,
          `Listener active; cycle completed (${cycleIssueCount} issues checked)`,
        );
      }
    } catch (err) {
      if (isJiraCommandMissingError(err)) {
        logger.warn(
          `[listener:${listenerId}] jira CLI is not available in PATH; disabling listener`,
        );
        healthReporter?.markInactive(
          integrationIdentity,
          "Jira backlog listener inactive: jira CLI is not available in PATH",
        );
        stopPolling();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[listener:${listenerId}] Poll cycle failed: ${msg}`);
      healthReporter?.markDegraded(integrationIdentity, `Poll cycle failed: ${msg}`, err);
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void pollOnce();
  }, intervalMs);

  void pollOnce();

  return {
    stop(): void {
      stopPolling();
    },
  };
}

export const jiraBacklogSource: ListenerSource = {
  source: "jira-backlog",
  start: startJiraBacklogListener,
};
