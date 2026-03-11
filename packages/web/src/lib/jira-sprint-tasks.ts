import { existsSync, readFileSync } from "node:fs";
import {
  ACTIVITY_STATE,
  getListenerIssueCachePath,
  TERMINAL_STATUSES,
  type Issue,
  type IssueFilters,
  type ListenerConfig,
  type ListenerIssueCache,
  type OrchestratorConfig,
  type PluginRegistry,
  type ProjectConfig,
  type Session,
  type SessionManager,
  type Tracker,
} from "@composio/ao-core";
import type {
  JiraSprintTask,
  JiraSprintTaskListener,
  JiraSprintTaskSession,
  JiraSprintTasksSnapshot,
} from "./types";
import { buildProjectSessionPath } from "./project-routes";

const TERMINAL_STATUS_SET: ReadonlySet<string> = TERMINAL_STATUSES;
const SPRINT_TASKS_START_ENDPOINT = "/api/tracker/tasks";
type TrackerTaskListenerMode = "spawn" | "observe";

const globalForJiraSprintTasks = globalThis as typeof globalThis & {
  _jiraSprintTaskStartLocks?: Set<string>;
};

interface JiraIssueSummary {
  issueKey: string;
  issueUrl: string | null;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
}

interface ResolveStartContext {
  issueKey: string;
  projectId: string;
  listenerId: string | null;
  triggerAgent: string | null;
  spawnAvailable: boolean;
}

interface ListenerIssueFetcherArgs {
  listener: JiraSprintTaskListener;
  project: ProjectConfig;
}

export interface BuildJiraSprintTasksSnapshotOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  registry?: PluginRegistry;
  projectId?: string;
  issueFetcher?: (args: ListenerIssueFetcherArgs) => Promise<JiraIssueSummary[]>;
}

export interface StartJiraSprintTaskOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  registry?: PluginRegistry;
  issueKey: string;
  projectId?: string;
  listenerId?: string;
  issueFetcher?: (args: ListenerIssueFetcherArgs) => Promise<JiraIssueSummary[]>;
}

export type StartJiraSprintTaskResult =
  | {
      kind: "spawned";
      issueKey: string;
      projectId: string;
      listenerId: string | null;
      session: Session;
    }
  | {
      kind: "already-active";
      issueKey: string;
      projectId: string;
      listenerId: string | null;
      session: Session;
    }
  | {
      kind: "start-in-progress";
      issueKey: string;
      projectId: string;
      listenerId: string | null;
    };

export class JiraSprintTaskError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "JiraSprintTaskError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIssueIdentifier(issueKey: string): string {
  return issueKey.trim();
}

function normalizeJiraIssueKey(issueKey: string): string {
  return issueKey.trim().toUpperCase();
}

function normalizeTrackerIssueId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const jiraLikeMatch = trimmed.match(/([A-Z][A-Z0-9]+-\d+)/i);
  if (jiraLikeMatch?.[1]) {
    return normalizeJiraIssueKey(jiraLikeMatch[1]);
  }

  const githubIssueUrlMatch = trimmed.match(/\/issues\/(\d+)/i);
  if (githubIssueUrlMatch?.[1]) {
    return githubIssueUrlMatch[1];
  }

  const numericMatch = trimmed.match(/^#?(\d+)$/);
  if (numericMatch?.[1]) {
    return numericMatch[1];
  }

  return normalizeIssueIdentifier(trimmed);
}

export function extractJiraIssueKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match?.[1]) return null;
  return normalizeJiraIssueKey(match[1]);
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export function buildListenerEffectiveFilters(listener: ListenerConfig): IssueFilters {
  const rawFilters = isRecord(listener.filters)
    ? (listener.filters as Record<string, unknown>)
    : {};

  const resolvedState = toNullableString(rawFilters["state"] ?? listener["state"]);
  const state: IssueFilters["state"] =
    resolvedState === "open" || resolvedState === "closed" || resolvedState === "all"
      ? resolvedState
      : "open";

  const labels = toStringArray(rawFilters["labels"] ?? listener["labels"]);
  const assignee = toNullableString(rawFilters["assignee"] ?? listener["assignee"]);
  const iteration = toNullableString(rawFilters["iteration"] ?? listener["iteration"]);
  const limit = toPositiveInt(rawFilters["limit"] ?? listener["limit"]) ?? 100;

  return {
    state,
    ...(labels.length > 0 ? { labels } : {}),
    ...(assignee ? { assignee } : {}),
    ...(iteration ? { iteration } : {}),
    limit,
  };
}

function isTrackerTaskListener(listener: ListenerConfig): boolean {
  const source = listener.source.toLowerCase();
  return source === "tracker-task";
}

function readTriggerAgent(listener: ListenerConfig): string | null {
  if (!isRecord(listener.trigger)) return null;
  return toNullableString(listener.trigger["agent"]);
}

function readListenerMode(listener: ListenerConfig): TrackerTaskListenerMode {
  const rawMode = toNullableString(listener["mode"]);
  return rawMode === "observe" ? "observe" : "spawn";
}

function isSpawnListenerMode(mode: TrackerTaskListenerMode | null | undefined): boolean {
  return mode !== "observe";
}

function collectTrackerTaskListeners(
  config: OrchestratorConfig,
  projectId?: string,
): JiraSprintTaskListener[] {
  const listeners: JiraSprintTaskListener[] = [];
  const seenListenerIds = new Set<string>();

  for (const [resolvedProjectId, project] of Object.entries(config.projects)) {
    if (projectId && resolvedProjectId !== projectId) continue;
    if (!project.tracker?.plugin) continue;

    const projectListeners =
      (project as { listeners?: Record<string, Omit<ListenerConfig, "projectId">> }).listeners ??
      {};

    for (const [baseListenerId, projectListener] of Object.entries(projectListeners)) {
      const listener = {
        ...projectListener,
        projectId: resolvedProjectId,
      } as ListenerConfig;
      if (!isTrackerTaskListener(listener)) continue;

      const effectiveListenerId = seenListenerIds.has(baseListenerId)
        ? `${resolvedProjectId}:${baseListenerId}`
        : baseListenerId;
      seenListenerIds.add(effectiveListenerId);

      listeners.push({
        source: listener.source,
        listenerId: effectiveListenerId,
        projectId: resolvedProjectId,
        projectName: project.name ?? resolvedProjectId,
        mode: readListenerMode(listener),
        filters: buildListenerEffectiveFilters(listener),
        triggerAgent: readTriggerAgent(listener),
      });
    }
  }

  return listeners.sort((a, b) => a.listenerId.localeCompare(b.listenerId));
}

interface IssuesWithTimestamp {
  summaries: JiraIssueSummary[];
  cachedAt: string | null;
}

function issuesToSummaries(issues: Issue[]): JiraIssueSummary[] {
  const summaries: JiraIssueSummary[] = [];
  const seen = new Set<string>();

  for (const issue of issues) {
    const normalizedIssueKey = normalizeTrackerIssueId(issue.id);
    if (!normalizedIssueKey || seen.has(normalizedIssueKey)) continue;
    seen.add(normalizedIssueKey);

    summaries.push({
      issueKey: normalizedIssueKey,
      issueUrl: issue.url ?? null,
      summary: issue.title ?? null,
      status: issue.statusLabel ?? issue.state ?? null,
      statusCategory: issue.state ?? null,
    });
  }

  return summaries;
}

function readIssueCache(configPath: string, projectPath: string, listenerId: string): ListenerIssueCache | null {
  const cachePath = getListenerIssueCachePath(configPath, projectPath, listenerId);
  if (!existsSync(cachePath)) return null;

  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as Partial<ListenerIssueCache>;
    if (raw && typeof raw.cachedAt === "string" && Array.isArray(raw.issues)) {
      return raw as ListenerIssueCache;
    }
  } catch {
    // Corrupt cache — will fall back to direct API.
  }
  return null;
}

function fetchIssuesFromCache(
  config: OrchestratorConfig,
  project: ProjectConfig,
  listener: JiraSprintTaskListener,
): IssuesWithTimestamp | null {
  const cache = readIssueCache(config.configPath, project.path, listener.listenerId);
  if (!cache) return null;
  return { summaries: issuesToSummaries(cache.issues), cachedAt: cache.cachedAt };
}

async function fetchIssuesFromTracker(
  listener: JiraSprintTaskListener,
  project: ProjectConfig,
  registry: PluginRegistry,
): Promise<IssuesWithTimestamp> {
  const trackerPlugin = toNullableString(project.tracker?.plugin);
  if (!trackerPlugin) return { summaries: [], cachedAt: null };

  const tracker = registry.get<Tracker>("tracker", trackerPlugin);
  if (!tracker || typeof tracker.listIssues !== "function") {
    return { summaries: [], cachedAt: null };
  }

  const issues = await tracker.listIssues(listener.filters, project);
  return { summaries: issuesToSummaries(issues), cachedAt: null };
}

export async function listTrackerIssuesForListener(
  listener: JiraSprintTaskListener,
  project: ProjectConfig,
  registry: PluginRegistry,
  config?: OrchestratorConfig,
): Promise<IssuesWithTimestamp> {
  if (config) {
    const cached = fetchIssuesFromCache(config, project, listener);
    if (cached) return cached;
  }
  return fetchIssuesFromTracker(listener, project, registry);
}

function isActiveSession(session: Session): boolean {
  if (session.activity === ACTIVITY_STATE.EXITED) return false;
  return !TERMINAL_STATUS_SET.has(session.status);
}

function toTaskSession(session: Session): JiraSprintTaskSession {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
}

function compareTaskSessions(a: JiraSprintTaskSession, b: JiraSprintTaskSession): number {
  const timeDiff = Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

function getTaskPrimarySession(task: JiraSprintTask): JiraSprintTaskSession | null {
  if (task.relatedActiveSessions.length === 0) return null;
  return task.relatedActiveSessions[0] ?? null;
}

function syncTaskComputedFields(task: JiraSprintTask): void {
  task.relatedActiveSessions.sort(compareTaskSessions);
  task.relatedDoneSessions.sort(compareTaskSessions);
  task.listenerIds = [...new Set(task.listenerIds)].sort((a, b) => a.localeCompare(b));
  task.projectIds = [...new Set(task.projectIds)].sort((a, b) => a.localeCompare(b));
  task.source = task.source ?? "tracker-task";
  task.taskManager = task.taskManager ?? "tracker";

  const primarySession = getTaskPrimarySession(task);
  const sessionId = primarySession?.id ?? null;

  task.key = task.issueKey;
  task.title = task.summary;
  task.canStart = task.spawnAvailable;
  task.startEndpoint = SPRINT_TASKS_START_ENDPOINT;
  task.listenerId = task.listenerIds.length === 1 ? task.listenerIds[0] : null;
  task.projectId = task.projectIds.length === 1 ? task.projectIds[0] : null;
  task.sessionId = sessionId;
  task.activeSessionId = sessionId;
  task.sessionUrl =
    sessionId && primarySession?.projectId
      ? buildProjectSessionPath(primarySession.projectId, sessionId)
      : null;
}

function getTaskStartLocks(): Set<string> {
  if (!globalForJiraSprintTasks._jiraSprintTaskStartLocks) {
    globalForJiraSprintTasks._jiraSprintTaskStartLocks = new Set<string>();
  }
  return globalForJiraSprintTasks._jiraSprintTaskStartLocks;
}

function acquireTaskStartLock(lockKey: string): boolean {
  const locks = getTaskStartLocks();
  if (locks.has(lockKey)) return false;
  locks.add(lockKey);
  return true;
}

function releaseTaskStartLock(lockKey: string): void {
  getTaskStartLocks().delete(lockKey);
}

function upsertTask(
  tasksByIssueKey: Map<string, JiraSprintTask>,
  issue: JiraIssueSummary,
  listener: JiraSprintTaskListener,
  relatedActiveSessions: JiraSprintTaskSession[],
  relatedDoneSessions: JiraSprintTaskSession[],
): void {
  const existing = tasksByIssueKey.get(issue.issueKey);

  if (!existing) {
    tasksByIssueKey.set(issue.issueKey, {
      source: listener.source,
      taskManager: "tracker",
      issueKey: issue.issueKey,
      issueUrl: issue.issueUrl,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      listenerIds: [listener.listenerId],
      projectIds: [listener.projectId],
      relatedActiveSessions: [...relatedActiveSessions],
      relatedDoneSessions: [...relatedDoneSessions],
      spawnAvailable: false,
      key: issue.issueKey,
      title: issue.summary,
      canStart: false,
      startEndpoint: SPRINT_TASKS_START_ENDPOINT,
      listenerId: listener.listenerId,
      projectId: listener.projectId,
      sessionId: null,
      activeSessionId: null,
      sessionUrl: null,
    });
    return;
  }

  if (!existing.issueUrl && issue.issueUrl) existing.issueUrl = issue.issueUrl;
  if (!existing.source) existing.source = listener.source;
  if (!existing.taskManager) existing.taskManager = "tracker";
  if (!existing.summary && issue.summary) existing.summary = issue.summary;
  if (!existing.status && issue.status) existing.status = issue.status;
  if (!existing.statusCategory && issue.statusCategory) {
    existing.statusCategory = issue.statusCategory;
  }
  if (!existing.listenerIds.includes(listener.listenerId)) {
    existing.listenerIds.push(listener.listenerId);
  }
  if (!existing.projectIds.includes(listener.projectId)) {
    existing.projectIds.push(listener.projectId);
  }

  const existingActiveIds = new Set(existing.relatedActiveSessions.map((s) => s.id));
  for (const session of relatedActiveSessions) {
    if (!existingActiveIds.has(session.id)) {
      existing.relatedActiveSessions.push(session);
      existingActiveIds.add(session.id);
    }
  }

  const existingDoneIds = new Set(existing.relatedDoneSessions.map((s) => s.id));
  for (const session of relatedDoneSessions) {
    if (!existingDoneIds.has(session.id)) {
      existing.relatedDoneSessions.push(session);
      existingDoneIds.add(session.id);
    }
  }
}

export async function buildJiraSprintTasksSnapshot(
  opts: BuildJiraSprintTasksSnapshotOptions,
): Promise<JiraSprintTasksSnapshot> {
  const listeners = collectTrackerTaskListeners(opts.config, opts.projectId);
  const issueFetcher = opts.issueFetcher;
  const registry = opts.registry;

  if (!issueFetcher && !registry) {
    throw new Error("buildJiraSprintTasksSnapshot requires registry or issueFetcher");
  }

  const projectSessionsCache = new Map<string, Session[]>();
  const sessionsByIssueCache = new Map<string, Map<string, Session[]>>();
  const tasksByIssueKey = new Map<string, JiraSprintTask>();
  const startEligibleIssueKeys = new Set<string>();

  const getSessionsByIssueForProject = async (
    projectId: string,
  ): Promise<Map<string, Session[]>> => {
    const cached = sessionsByIssueCache.get(projectId);
    if (cached) return cached;

    const sessions =
      projectSessionsCache.get(projectId) ?? (await opts.sessionManager.list(projectId));
    projectSessionsCache.set(projectId, sessions);

    const sessionsByIssue = new Map<string, Session[]>();
    for (const session of sessions) {
      const issueKey = normalizeTrackerIssueId(session.issueId);
      if (!issueKey) continue;

      const existing = sessionsByIssue.get(issueKey);
      if (existing) {
        existing.push(session);
      } else {
        sessionsByIssue.set(issueKey, [session]);
      }
    }

    sessionsByIssueCache.set(projectId, sessionsByIssue);
    return sessionsByIssue;
  };

  let oldestCachedAt: string | null = null;

  for (const listener of listeners) {
    const project = opts.config.projects[listener.projectId];
    if (!project) continue;

    const issuesFetchPromise = issueFetcher
      ? issueFetcher({ listener, project }).then(
          (summaries) => ({ summaries, cachedAt: null }) as IssuesWithTimestamp,
        )
      : listTrackerIssuesForListener(listener, project, registry as PluginRegistry, opts.config);

    const [issuesResult, sessionsByIssue] = await Promise.all([
      issuesFetchPromise,
      getSessionsByIssueForProject(listener.projectId),
    ]);

    if (issuesResult.cachedAt) {
      if (!oldestCachedAt || issuesResult.cachedAt < oldestCachedAt) {
        oldestCachedAt = issuesResult.cachedAt;
      }
    }

    for (const issue of issuesResult.summaries) {
      const relatedSessions = sessionsByIssue.get(issue.issueKey) ?? [];
      const relatedActiveSessions = relatedSessions.filter(isActiveSession).map(toTaskSession);
      const relatedDoneSessions = relatedSessions.filter((s) => !isActiveSession(s)).map(toTaskSession);
      startEligibleIssueKeys.add(issue.issueKey);
      upsertTask(tasksByIssueKey, issue, listener, relatedActiveSessions, relatedDoneSessions);
    }
  }

  for (const task of tasksByIssueKey.values()) {
    task.spawnAvailable = startEligibleIssueKeys.has(task.issueKey) && task.relatedActiveSessions.length === 0;
    syncTaskComputedFields(task);
  }

  return {
    updatedAt: new Date().toISOString(),
    issuesCachedAt: oldestCachedAt,
    projectId: opts.projectId ?? null,
    listeners,
    tasks: [...tasksByIssueKey.values()].sort((a, b) => a.issueKey.localeCompare(b.issueKey)),
  };
}

function normalizeOptionalIdentifier(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function findActiveSessionForIssue(
  sessionManager: SessionManager,
  projectId: string,
  issueKey: string,
): Promise<Session | null> {
  const sessions = await sessionManager.list(projectId);
  const normalizedIssueKey =
    normalizeTrackerIssueId(issueKey) ?? normalizeIssueIdentifier(issueKey);

  const active = sessions
    .filter((session) => isActiveSession(session))
    .filter((session) => normalizeTrackerIssueId(session.issueId) === normalizedIssueKey)
    .sort((a, b) => {
      const byActivity = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
      if (byActivity !== 0) return byActivity;
      return a.id.localeCompare(b.id);
    });

  return active[0] ?? null;
}

async function resolveStartContext(
  opts: StartJiraSprintTaskOptions & { normalizedIssueKey: string },
): Promise<ResolveStartContext> {
  const requestedProjectId = normalizeOptionalIdentifier(opts.projectId);
  const requestedListenerId = normalizeOptionalIdentifier(opts.listenerId);

  const snapshot = await buildJiraSprintTasksSnapshot({
    config: opts.config,
    sessionManager: opts.sessionManager,
    registry: opts.registry,
    projectId: requestedProjectId,
    issueFetcher: opts.issueFetcher,
  });

  const task = snapshot.tasks.find((entry) => entry.issueKey === opts.normalizedIssueKey);
  const listenersById = new Map(
    snapshot.listeners.map((listener) => [listener.listenerId, listener]),
  );

  if (!task) {
    throw new JiraSprintTaskError(
      409,
      "out_of_scope",
      `Issue ${opts.normalizedIssueKey} is outside the current tracker task scope`,
      {
        projectId: requestedProjectId ?? null,
        listenerId: requestedListenerId ?? null,
      },
    );
  }

  let candidateListenerIds = task.listenerIds;
  if (requestedListenerId) {
    if (!candidateListenerIds.includes(requestedListenerId)) {
      throw new JiraSprintTaskError(
        409,
        "listener_mismatch",
        `Issue ${opts.normalizedIssueKey} is not linked to listener ${requestedListenerId}`,
        {
          listenerIds: task.listenerIds,
        },
      );
    }
    candidateListenerIds = [requestedListenerId];
  }

  const candidateListeners = candidateListenerIds
    .map((listenerId) => listenersById.get(listenerId))
    .filter((listener): listener is JiraSprintTaskListener => Boolean(listener));

  if (candidateListeners.length === 0) {
    throw new JiraSprintTaskError(
      500,
      "invalid_snapshot",
      `Issue ${opts.normalizedIssueKey} listener mapping is inconsistent`,
    );
  }

  const projectIds = [...new Set(candidateListeners.map((listener) => listener.projectId))].sort(
    (a, b) => a.localeCompare(b),
  );

  const resolvedProjectId = requestedProjectId ?? projectIds[0];
  if (!resolvedProjectId) {
    throw new JiraSprintTaskError(
      500,
      "invalid_snapshot",
      `Issue ${opts.normalizedIssueKey} has no linked project`,
    );
  }

  if (requestedProjectId && !projectIds.includes(requestedProjectId)) {
    throw new JiraSprintTaskError(
      409,
      "project_mismatch",
      `Issue ${opts.normalizedIssueKey} is not linked to project ${requestedProjectId}`,
      {
        projectIds,
      },
    );
  }

  if (!requestedProjectId && projectIds.length > 1 && !requestedListenerId) {
    throw new JiraSprintTaskError(
      409,
      "project_ambiguous",
      `Issue ${opts.normalizedIssueKey} is linked to multiple projects; specify projectId or listenerId`,
      {
        projectIds,
        listenerIds: candidateListenerIds,
      },
    );
  }

  const listenerForProject = candidateListeners.find(
    (listener) => listener.projectId === resolvedProjectId,
  );
  if (!listenerForProject) {
    throw new JiraSprintTaskError(
      409,
      "listener_project_mismatch",
      `No listener mapping for issue ${opts.normalizedIssueKey} in project ${resolvedProjectId}`,
      {
        listenerIds: candidateListenerIds,
        projectIds,
      },
    );
  }

  const listenersForProject = candidateListeners.filter(
    (listener) => listener.projectId === resolvedProjectId,
  );
  const requestedListener =
    requestedListenerId !== undefined
      ? (listenersForProject.find((listener) => listener.listenerId === requestedListenerId) ??
        null)
      : null;
  const selectedListener =
    requestedListener ??
    listenersForProject.find((listener) => isSpawnListenerMode(listener.mode)) ??
    listenersForProject[0] ??
    null;

  if (!selectedListener) {
    throw new JiraSprintTaskError(
      500,
      "invalid_snapshot",
      `No listener found for issue ${opts.normalizedIssueKey} in project ${resolvedProjectId}`,
    );
  }

  return {
    issueKey: opts.normalizedIssueKey,
    projectId: resolvedProjectId,
    listenerId: selectedListener.listenerId,
    triggerAgent: selectedListener.triggerAgent,
    spawnAvailable: task.relatedActiveSessions.length === 0,
  };
}

export async function startJiraSprintTask(
  opts: StartJiraSprintTaskOptions,
): Promise<StartJiraSprintTaskResult> {
  const parsedIssueKey = normalizeTrackerIssueId(opts.issueKey);
  if (!parsedIssueKey) {
    throw new JiraSprintTaskError(400, "invalid_issue_key", "issueKey must be non-empty");
  }

  const context = await resolveStartContext({
    ...opts,
    normalizedIssueKey: parsedIssueKey,
  });

  if (!context.spawnAvailable) {
    const activeSession = await findActiveSessionForIssue(
      opts.sessionManager,
      context.projectId,
      context.issueKey,
    );
    if (activeSession) {
      return {
        kind: "already-active",
        issueKey: context.issueKey,
        projectId: context.projectId,
        listenerId: context.listenerId,
        session: activeSession,
      };
    }

    throw new JiraSprintTaskError(
      409,
      "not_startable",
      `Issue ${context.issueKey} is not startable right now (already active or currently starting)`,
    );
  }

  const lockKey = `${context.projectId}:${context.issueKey}`;
  if (!acquireTaskStartLock(lockKey)) {
    const activeSession = await findActiveSessionForIssue(
      opts.sessionManager,
      context.projectId,
      context.issueKey,
    );
    if (activeSession) {
      return {
        kind: "already-active",
        issueKey: context.issueKey,
        projectId: context.projectId,
        listenerId: context.listenerId,
        session: activeSession,
      };
    }
    return {
      kind: "start-in-progress",
      issueKey: context.issueKey,
      projectId: context.projectId,
      listenerId: context.listenerId,
    };
  }

  try {
    const activeSession = await findActiveSessionForIssue(
      opts.sessionManager,
      context.projectId,
      context.issueKey,
    );
    if (activeSession) {
      return {
        kind: "already-active",
        issueKey: context.issueKey,
        projectId: context.projectId,
        listenerId: context.listenerId,
        session: activeSession,
      };
    }

    const session = await opts.sessionManager.spawn({
      projectId: context.projectId,
      issueId: context.issueKey,
      ...(context.triggerAgent ? { agent: context.triggerAgent } : {}),
    });

    return {
      kind: "spawned",
      issueKey: context.issueKey,
      projectId: context.projectId,
      listenerId: context.listenerId,
      session,
    };
  } finally {
    releaseTaskStartLock(lockKey);
  }
}
