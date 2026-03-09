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
import {
  getProjectBaseDir,
  getSessionsDir,
  readArchivedMetadataRaw,
  type IssueFilters,
  type Tracker,
} from "@composio/ao-core";
import type { ListenerController, ListenerSource, ListenerStartDeps } from "./types.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 5 * 60_000;
const DEFAULT_PENDING_CLAIM_TTL_MS = 30 * 60_000;
const DEFAULT_ISSUE_LIMIT = 100;
const LOCK_RETRY_ATTEMPTS = 200;
const LOCK_RETRY_DELAY_MS = 25;
const STATE_VERSION = 1;

interface TrackerTaskListenerState {
  version: number;
  issues: Record<string, { lastSessionId: string; updatedAt: string }>;
}

interface KnownSessionState {
  status?: string;
  terminationReason?: string;
}

interface FileLockHandle {
  refresh(): void;
  release(): void;
}

function sanitizeListenerId(listenerId: string): string {
  const sanitized = listenerId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "listener";
}

function normalizeIssueIdentifier(issueId: string): string {
  return issueId.trim();
}

function canonicalIssueIdentifier(
  issueId: string,
  opts?: { jiraStyleCaseInsensitive?: boolean },
): string {
  const normalized = normalizeIssueIdentifier(issueId);
  if (!normalized) return normalized;

  if (opts?.jiraStyleCaseInsensitive === true) {
    // Keep Jira-style keys case-insensitive, but preserve non-Jira identifiers as-is.
    return /^[A-Z][A-Z0-9]+-\d+$/i.test(normalized) ? normalized.toUpperCase() : normalized;
  }
  return normalized;
}

function sanitizeIssueKeyForLock(
  issueId: string,
  opts?: { jiraStyleCaseInsensitive?: boolean },
): string {
  const canonical = canonicalIssueIdentifier(issueId, opts).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return canonical.length > 0 ? canonical : "issue";
}

function buildStatePath(configPath: string, projectPath: string, listenerId: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  return join(baseDir, "listeners", `${sanitizeListenerId(listenerId)}.json`);
}

function buildIssueLocksDir(configPath: string, projectPath: string): string {
  const baseDir = getProjectBaseDir(configPath, projectPath);
  return join(baseDir, "listeners", "_issue-locks");
}

function readState(statePath: string): TrackerTaskListenerState {
  if (!existsSync(statePath)) {
    return { version: STATE_VERSION, issues: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<TrackerTaskListenerState>;
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

function writeState(statePath: string, state: TrackerTaskListenerState): void {
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

function isCommandMissingError(error: unknown): boolean {
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
  fn: (state: TrackerTaskListenerState) => T | Promise<T>,
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
  entry: TrackerTaskListenerState["issues"][string],
  lockStaleMs: number,
): Promise<void> {
  await withLockedState(statePath, lockStaleMs, (latestState) => {
    latestState.issues[issueKey] = entry;
  });
}

async function restoreIssueStateEntry(
  statePath: string,
  issueKey: string,
  previousEntry: TrackerTaskListenerState["issues"][string] | null,
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

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return [...new Set(values)];
}

function readListenerIssueFilters(listener: ListenerStartDeps["listener"]): IssueFilters {
  const rawFilters =
    typeof listener.filters === "object" && listener.filters !== null
      ? (listener.filters as Record<string, unknown>)
      : {};

  const resolvedState = toNonEmptyString(rawFilters["state"] ?? listener["state"]);
  const state: IssueFilters["state"] =
    resolvedState === "closed" || resolvedState === "all" || resolvedState === "open"
      ? resolvedState
      : "open";

  const labels = toStringArray(rawFilters["labels"] ?? listener["labels"]);
  const assignee = toNonEmptyString(rawFilters["assignee"] ?? listener["assignee"]);
  const limit =
    toPositiveNumber(rawFilters["limit"] ?? listener["limit"]) ?? DEFAULT_ISSUE_LIMIT;

  return {
    state,
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    limit,
  };
}

function assertNoLegacyListenerFields(
  listener: ListenerStartDeps["listener"],
  listenerId: string,
): void {
  const legacyFields = ["enabled", "jql", "backlogStatus"] as const;
  const present = legacyFields.filter((field) => Object.prototype.hasOwnProperty.call(listener, field));
  if (present.length === 0) return;

  throw new Error(
    `[listener:${listenerId}] Legacy listener field(s) not supported: ${present.join(", ")}. ` +
      `Use source: tracker-task and filters.{state,labels,assignee,limit}.`,
  );
}

async function listIssueIdentifiersByFilters(
  tracker: Tracker,
  filters: IssueFilters,
  project: ListenerStartDeps["project"],
  opts?: { jiraStyleCaseInsensitive?: boolean },
): Promise<Map<string, string>> {
  if (typeof tracker.listIssues !== "function") {
    throw new Error(
      `tracker plugin "${tracker.name}" does not implement listIssues(), required by tracker-task listener`,
    );
  }

  const issues = await tracker.listIssues(filters, project);
  const byCanonicalId = new Map<string, string>();

  for (const issue of issues) {
    const issueId = normalizeIssueIdentifier(issue.id);
    if (!issueId) continue;

    const canonicalId = canonicalIssueIdentifier(issueId, opts);
    if (!canonicalId || byCanonicalId.has(canonicalId)) continue;

    byCanonicalId.set(canonicalId, issueId);
  }

  return byCanonicalId;
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
  opts?: { jiraStyleCaseInsensitive?: boolean },
): KnownSessionState {
  const archiveDir = join(sessionsDir, "archive");
  if (!existsSync(archiveDir)) return {};

  let latestMtimeMs = -1;
  let latestState: KnownSessionState = {};

  for (const filename of readdirSync(archiveDir)) {
    try {
      const archivePath = join(archiveDir, filename);
      const raw = parseMetadataContent(readFileSync(archivePath, "utf-8"));
      if (canonicalIssueIdentifier(raw["issue"] ?? "", opts) !== issueKey) continue;
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

function currentIsoTime(): string {
  return new Date().toISOString();
}

async function startTrackerTaskListener(deps: ListenerStartDeps): Promise<ListenerController> {
  const {
    listener,
    listenerId,
    sessionManager,
    logger,
    config,
    registry,
    projectId,
    project,
    healthReporter,
    healthIdentity,
  } = deps;
  const intervalMs =
    typeof listener.intervalMs === "number" && listener.intervalMs > 0
      ? listener.intervalMs
      : DEFAULT_INTERVAL_MS;
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

  if (triggerType !== "spawn-session") {
    throw new Error(
      `[listener:${listenerId}] Unsupported trigger type "${triggerType}" for tracker-task`,
    );
  }

  if (!registry) {
    throw new Error(`[listener:${listenerId}] tracker-task listener requires plugin registry`);
  }

  const trackerPluginName = toNonEmptyString(project.tracker?.plugin);
  if (!trackerPluginName) {
    throw new Error(
      `[listener:${listenerId}] tracker-task listener requires tracker.plugin for project "${projectId}"`,
    );
  }

  const tracker = registry.get<Tracker>("tracker", trackerPluginName);
  if (!tracker) {
    throw new Error(
      `[listener:${listenerId}] tracker plugin "${trackerPluginName}" is not registered`,
    );
  }

  const issueFilters = readListenerIssueFilters(listener);
  assertNoLegacyListenerFields(listener, listenerId);
  const jiraStyleCaseInsensitive = trackerPluginName.toLowerCase() === "jira";
  const statePath = buildStatePath(config.configPath, project.path, listenerId);
  const issueLocksDir = buildIssueLocksDir(config.configPath, project.path);
  const sessionsDir = getSessionsDir(config.configPath, project.path);
  const warnedUnknownStatuses = new Set<string>();
  const integrationIdentity = healthIdentity ?? {
    id: `listener:${listenerId}`,
    label: `Listener ${listenerId} (${listener.source})`,
    service: "tracker" as const,
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
    healthReporter?.markInactive(integrationIdentity, "Tracker task listener stopped");
  };

  healthReporter?.markStarting(integrationIdentity, "Starting tracker task listener");

  const pollOnce = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let cycleHadErrors = false;
    let cycleIssueCount: number;

    try {
      const [issueIdMap, sessions] = await Promise.all([
        listIssueIdentifiersByFilters(tracker, issueFilters, project, { jiraStyleCaseInsensitive }),
        sessionManager.list(projectId),
      ]);
      cycleIssueCount = issueIdMap.size;
      if (stopped) return;

      const sessionsByIssue = new Map<string, KnownSessionState[]>();
      const sessionsById = new Map<string, KnownSessionState>();

      for (const session of sessions) {
        if (!session.issueId) continue;
        const issueKey = canonicalIssueIdentifier(session.issueId, { jiraStyleCaseInsensitive });
        if (!issueKey) continue;

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

      for (const [issueKey, issueIdentifier] of issueIdMap.entries()) {
        if (stopped) break;

        const issueLockPath = join(
          issueLocksDir,
          `${sanitizeIssueKeyForLock(issueKey, { jiraStyleCaseInsensitive })}.lock`,
        );
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
                { jiraStyleCaseInsensitive },
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
                      `[listener:${listenerId}] Clearing stale pending claim for ${issueIdentifier} (age ${ageMs}ms)`,
                    );
                    continue;
                  }
                }
                const warningId = `${issueKey}:${entry.lastSessionId}`;
                if (!warnedUnknownStatuses.has(warningId)) {
                  warnedUnknownStatuses.add(warningId);
                  logger.warn(
                    `[listener:${listenerId}] Blocking retry for ${issueIdentifier}: previous session ${entry.lastSessionId} has unknown terminal status`,
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
              issueId: issueIdentifier,
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
                  `[listener:${listenerId}] Spawned session ${spawnedSessionId} for ${issueIdentifier}, but failed to persist listener state: ${persistMsg}. Disabling listener to avoid duplicate processing.`,
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
                  `[listener:${listenerId}] Failed to rollback claim for ${issueIdentifier}: ${restoreMsg}`,
                );
              }
            }

            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[listener:${listenerId}] Failed to spawn session for ${issueIdentifier}: ${msg}`,
            );
            cycleHadErrors = true;
          } finally {
            clearInterval(lockHeartbeat);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            `[listener:${listenerId}] Failed to process issue ${issueIdentifier}: ${msg}`,
          );
          cycleHadErrors = true;
        } finally {
          issueLock.release();
        }
      }

      if (cycleHadErrors) {
        healthReporter?.markDegraded(
          integrationIdentity,
          "Tracker task listener cycle completed with errors",
        );
      } else {
        healthReporter?.markHealthy(
          integrationIdentity,
          `Listener active; cycle completed (${cycleIssueCount} issues checked)`,
        );
      }
    } catch (err) {
      if (isCommandMissingError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[listener:${listenerId}] Tracker dependencies are not available; disabling listener (${msg})`,
        );
        healthReporter?.markInactive(
          integrationIdentity,
          "Tracker task listener inactive: required tracker dependencies are not available",
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

export const trackerTaskSource: ListenerSource = {
  source: "tracker-task",
  start: startTrackerTaskListener,
};

// Legacy aliases for old source names.
export const jiraTaskSource: ListenerSource = {
  source: "jira-task",
  start: startTrackerTaskListener,
};

export const jiraBacklogSource: ListenerSource = {
  source: "jira-backlog",
  start: startTrackerTaskListener,
};
