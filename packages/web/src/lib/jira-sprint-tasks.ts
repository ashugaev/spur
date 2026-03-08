import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ACTIVITY_STATE,
  TERMINAL_STATUSES,
  type ListenerConfig,
  type OrchestratorConfig,
  type Session,
  type SessionManager,
} from "@composio/ao-core";
import type {
  JiraSprintTask,
  JiraSprintTaskListener,
  JiraSprintTaskSession,
  JiraSprintTasksSnapshot,
} from "./types";
import { buildProjectSessionPath } from "./project-routes";

const execFileAsync = promisify(execFile);
const DEFAULT_BACKLOG_STATUS = "Backlog";
const TERMINAL_STATUS_SET: ReadonlySet<string> = TERMINAL_STATUSES;
const SPRINT_TASKS_START_ENDPOINT = "/api/jira/sprint-tasks";
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const globalForJiraSprintTasks = globalThis as typeof globalThis & {
  _jiraSprintTaskStartLocks?: Set<string>;
};

interface ErrorWithStreams {
  message?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  cause?: unknown;
}

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

export interface BuildJiraSprintTasksSnapshotOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  projectId?: string;
  issueFetcher?: (effectiveJql: string) => Promise<JiraIssueSummary[]>;
}

export interface StartJiraSprintTaskOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  issueKey: string;
  projectId?: string;
  listenerId?: string;
  issueFetcher?: (effectiveJql: string) => Promise<JiraIssueSummary[]>;
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

function normalizeIssueKey(issueKey: string): string {
  return issueKey.trim().toUpperCase();
}

export function extractJiraIssueKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match?.[1]) return null;
  return normalizeIssueKey(match[1]);
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function appendJqlCondition(jql: string, clause: string): string {
  const trimmed = jql.trim();
  if (!trimmed) return clause;

  const orderByMatch = /\border\s+by\b/i.exec(trimmed);
  if (!orderByMatch) {
    return `(${trimmed}) AND ${clause}`;
  }

  const orderByIndex = orderByMatch.index;
  const queryPart = trimmed.slice(0, orderByIndex).trim();
  const orderByPart = trimmed.slice(orderByIndex).trim();
  if (!queryPart) {
    return `${clause} ${orderByPart}`;
  }
  return `(${queryPart}) AND ${clause} ${orderByPart}`;
}

export function buildListenerEffectiveJql(jql: string, backlogStatus: string): string {
  return appendJqlCondition(jql, `status = "${escapeJqlString(backlogStatus)}"`);
}

export function buildListenerSprintJql(jql: string): string {
  return appendJqlCondition(jql, "sprint in openSprints()");
}

function isEnabled(listener: ListenerConfig): boolean {
  return listener.enabled !== false;
}

function isJiraBacklogListener(listener: ListenerConfig): boolean {
  return listener.source.toLowerCase() === "jira-backlog";
}

function readTriggerAgent(listener: ListenerConfig): string | null {
  if (!isRecord(listener.trigger)) return null;
  return toNullableString(listener.trigger["agent"]);
}

function collectJiraBacklogListeners(
  config: OrchestratorConfig,
  projectId?: string,
): JiraSprintTaskListener[] {
  const listeners: JiraSprintTaskListener[] = [];

  for (const [listenerId, listener] of Object.entries(config.listeners ?? {})) {
    if (!isEnabled(listener)) continue;
    if (!isJiraBacklogListener(listener)) continue;
    if (projectId && listener.projectId !== projectId) continue;

    const project = config.projects[listener.projectId];
    if (!project) continue;
    if (project.tracker?.plugin !== "jira") continue;

    const jql = typeof listener.jql === "string" ? listener.jql.trim() : "";
    if (!jql) continue;

    const backlogStatus =
      typeof listener.backlogStatus === "string" && listener.backlogStatus.trim().length > 0
        ? listener.backlogStatus.trim()
        : DEFAULT_BACKLOG_STATUS;

    listeners.push({
      source: listener.source,
      listenerId,
      projectId: listener.projectId,
      projectName: project.name ?? listener.projectId,
      jql,
      backlogStatus,
      effectiveJql: buildListenerEffectiveJql(jql, backlogStatus),
      sprintJql: buildListenerSprintJql(jql),
      triggerAgent: readTriggerAgent(listener),
    });
  }

  return listeners.sort((a, b) => a.listenerId.localeCompare(b.listenerId));
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
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

async function jiraCli(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("jira", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`jira ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function toIssueBrowseUrl(rawSelf: unknown, issueKey: string): string | null {
  const self = toNullableString(rawSelf);
  if (!self) return null;
  try {
    const url = new URL(self);
    return `${url.origin}/browse/${issueKey}`;
  } catch {
    return null;
  }
}

function parseIssueList(raw: string): JiraIssueSummary[] {
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];

  const issues: JiraIssueSummary[] = [];
  const seenKeys = new Set<string>();

  for (const value of parsed) {
    if (!isRecord(value)) continue;

    const issueKey = toNullableString(value["key"]);
    if (!issueKey) continue;

    const normalizedIssueKey = normalizeIssueKey(issueKey);
    if (seenKeys.has(normalizedIssueKey)) continue;
    seenKeys.add(normalizedIssueKey);

    const fields = isRecord(value["fields"]) ? value["fields"] : null;
    const rawStatus = fields && isRecord(fields["status"]) ? fields["status"] : null;
    const rawCategory =
      rawStatus && isRecord(rawStatus["statusCategory"]) ? rawStatus["statusCategory"] : null;

    issues.push({
      issueKey: normalizedIssueKey,
      issueUrl: toIssueBrowseUrl(value["self"], normalizedIssueKey),
      summary: fields ? toNullableString(fields["summary"]) : null,
      status: rawStatus ? toNullableString(rawStatus["name"]) : null,
      statusCategory: rawCategory ? toNullableString(rawCategory["key"]) : null,
    });
  }

  return issues;
}

export async function listJiraIssuesForJql(jql: string): Promise<JiraIssueSummary[]> {
  let raw: string;
  try {
    raw = await jiraCli(["issue", "list", "-q", jql, "--raw"]);
  } catch (err) {
    if (isJiraNoResultsError(err)) {
      return [];
    }
    throw err;
  }
  return parseIssueList(raw);
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
  task.listenerIds = [...new Set(task.listenerIds)].sort((a, b) => a.localeCompare(b));
  task.projectIds = [...new Set(task.projectIds)].sort((a, b) => a.localeCompare(b));
  task.source = task.source ?? "jira-backlog";
  task.taskManager = task.taskManager ?? "jira";

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

function isBacklogStatusMatch(
  issueStatus: string | null,
  backlogStatus: string,
): boolean {
  if (!issueStatus) return false;
  return issueStatus.trim().toLowerCase() === backlogStatus.trim().toLowerCase();
}

function upsertTask(
  tasksByIssueKey: Map<string, JiraSprintTask>,
  issue: JiraIssueSummary,
  listener: JiraSprintTaskListener,
  relatedActiveSessions: JiraSprintTaskSession[],
): void {
  const existing = tasksByIssueKey.get(issue.issueKey);

  if (!existing) {
    tasksByIssueKey.set(issue.issueKey, {
      source: listener.source,
      taskManager: "jira",
      issueKey: issue.issueKey,
      issueUrl: issue.issueUrl,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      listenerIds: [listener.listenerId],
      projectIds: [listener.projectId],
      relatedActiveSessions: [...relatedActiveSessions],
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
  if (!existing.taskManager) existing.taskManager = "jira";
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

  const existingSessionIds = new Set(existing.relatedActiveSessions.map((session) => session.id));
  for (const session of relatedActiveSessions) {
    if (!existingSessionIds.has(session.id)) {
      existing.relatedActiveSessions.push(session);
      existingSessionIds.add(session.id);
    }
  }
}

export async function buildJiraSprintTasksSnapshot(
  opts: BuildJiraSprintTasksSnapshotOptions,
): Promise<JiraSprintTasksSnapshot> {
  const listeners = collectJiraBacklogListeners(opts.config, opts.projectId);
  const issueFetcher = opts.issueFetcher ?? listJiraIssuesForJql;

  const projectSessionsCache = new Map<string, Session[]>();
  const sessionsByIssueCache = new Map<string, Map<string, Session[]>>();
  const tasksByIssueKey = new Map<string, JiraSprintTask>();
  const startEligibleByIssueKey = new Map<string, boolean>();

  const getSessionsByIssueForProject = async (projectId: string): Promise<Map<string, Session[]>> => {
    const cached = sessionsByIssueCache.get(projectId);
    if (cached) return cached;

    const sessions = projectSessionsCache.get(projectId) ?? (await opts.sessionManager.list(projectId));
    projectSessionsCache.set(projectId, sessions);

    const sessionsByIssue = new Map<string, Session[]>();
    for (const session of sessions) {
      const issueKey = extractJiraIssueKey(session.issueId);
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

  for (const listener of listeners) {
    const [issues, sessionsByIssue] = await Promise.all([
      issueFetcher(listener.sprintJql),
      getSessionsByIssueForProject(listener.projectId),
    ]);

    for (const issue of issues) {
      const relatedSessions = sessionsByIssue.get(issue.issueKey) ?? [];
      const relatedActiveSessions = relatedSessions.filter(isActiveSession).map(toTaskSession);
      const canStartForListener = isBacklogStatusMatch(issue.status, listener.backlogStatus);
      startEligibleByIssueKey.set(
        issue.issueKey,
        (startEligibleByIssueKey.get(issue.issueKey) ?? false) || canStartForListener,
      );
      upsertTask(tasksByIssueKey, issue, listener, relatedActiveSessions);
    }
  }

  for (const task of tasksByIssueKey.values()) {
    const canStartFromStatus = startEligibleByIssueKey.get(task.issueKey) ?? false;
    task.spawnAvailable = canStartFromStatus && task.relatedActiveSessions.length === 0;
    syncTaskComputedFields(task);
  }

  return {
    updatedAt: new Date().toISOString(),
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
  const normalizedIssueKey = normalizeIssueKey(issueKey);

  const active = sessions
    .filter((session) => isActiveSession(session))
    .filter((session) => extractJiraIssueKey(session.issueId) === normalizedIssueKey)
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
    projectId: requestedProjectId,
    issueFetcher: opts.issueFetcher,
  });

  const task = snapshot.tasks.find((entry) => entry.issueKey === opts.normalizedIssueKey);
  const listenersById = new Map(snapshot.listeners.map((listener) => [listener.listenerId, listener]));

  if (!task) {
    throw new JiraSprintTaskError(
      409,
      "out_of_scope",
      `Issue ${opts.normalizedIssueKey} is outside the current sprint backlog scope`,
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

  const projectIds = [...new Set(candidateListeners.map((listener) => listener.projectId))].sort((a, b) =>
    a.localeCompare(b),
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

  const listenerForProject = candidateListeners.find((listener) => listener.projectId === resolvedProjectId);
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

  return {
    issueKey: opts.normalizedIssueKey,
    projectId: resolvedProjectId,
    listenerId: listenerForProject.listenerId,
    triggerAgent: listenerForProject.triggerAgent,
    spawnAvailable: task.spawnAvailable,
  };
}

export async function startJiraSprintTask(
  opts: StartJiraSprintTaskOptions,
): Promise<StartJiraSprintTaskResult> {
  const parsedIssueKey = extractJiraIssueKey(opts.issueKey);
  if (!parsedIssueKey) {
    throw new JiraSprintTaskError(400, "invalid_issue_key", "issueKey must look like ABC-123");
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
      `Issue ${context.issueKey} is not startable right now (must be in backlog and not already active)`,
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
