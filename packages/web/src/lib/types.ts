import type { AgentName } from "./agents";

export type SpurSessionStatus =
  | "spawning"
  | "running"
  | "stopped"
  | "paused"
  | "errored"
  | "completed"
  | "killed";

export type SpurSessionState =
  | "working"
  | "waiting"
  | "needs_input"
  | "rate_limited"
  | "stopped"
  | "error"
  | "killed";

export interface BranchExistsResponse {
  exists: boolean;
  remote: boolean;
  checkedOutAt: string | null;
}

export interface AgentModel {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface AgentModelsResponse {
  models: AgentModel[];
}

export interface SpurServiceView {
  serviceId: string;
  status: "running" | "stopped" | "errored";
  state: "running" | "problem" | "stopped" | "error";
  command: string;
  cwd: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  port?: number;
}

export interface SpurSessionLink {
  label: string;
  url: string;
}

export interface SpurTagDefinition {
  name: string;
  description: string;
  color: string;
}

export type SpurSessionArtifactKind = "image" | "video" | "text" | "download";
export type SpurSessionArtifactOrigin = "intentional" | "automatic";

export interface SpurClaudeAccount {
  id: string;
  label?: string;
  authenticated: boolean;
}

export interface ClaudeAccountSummary extends SpurClaudeAccount {
  lastUsedAt?: string;
}

export interface SpurSessionArtifact {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: SpurSessionArtifactKind;
  origin: SpurSessionArtifactOrigin;
  addedByUser?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpurSessionWorkspaceAccess {
  items: Array<{
    label: string;
    kind: "copy" | "link";
    value: string;
  }>;
}

export interface SpurSidecarPort {
  id: string;
  env: string;
  port: number;
}

export interface SpurSidecarPortConflictCandidate {
  portId: string;
  env: string;
  port: number;
  owner?: string;
}

export interface SpurSidecarPortConflict {
  code: "sidecar_port_busy";
  sidecarName: string;
  candidates: SpurSidecarPortConflictCandidate[];
}

export type OpenPrAction = "leave_open" | "close";

export function isOpenPrAction(value: unknown): value is OpenPrAction {
  return value === "leave_open" || value === "close";
}

export interface OpenPrActionRequiredPayload {
  code: "open_pr_action_required";
  sessionId: string;
  pr: {
    number: number;
    title: string;
    url: string;
  };
}

export function isOpenPrActionRequiredPayload(
  value: unknown,
): value is OpenPrActionRequiredPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const pr = record["pr"];
  if (typeof pr !== "object" || pr === null || Array.isArray(pr)) {
    return false;
  }
  const prRecord = pr as Record<string, unknown>;
  return (
    record["code"] === "open_pr_action_required" &&
    typeof record["sessionId"] === "string" &&
    typeof prRecord["number"] === "number" &&
    typeof prRecord["title"] === "string" &&
    typeof prRecord["url"] === "string"
  );
}

export interface GithubPrCheckUnavailablePayload {
  code: "github_pr_check_unavailable";
  sessionId: string;
  pr: {
    number: number;
    repo: string;
    url: string;
  } | null;
  rateLimited: boolean;
}

export function isGithubPrCheckUnavailablePayload(
  value: unknown,
): value is GithubPrCheckUnavailablePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record["code"] !== "github_pr_check_unavailable" ||
    typeof record["sessionId"] !== "string" ||
    typeof record["rateLimited"] !== "boolean"
  ) {
    return false;
  }
  const pr = record["pr"];
  if (pr === null) {
    return true;
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    return false;
  }
  const prRecord = pr as Record<string, unknown>;
  return (
    typeof prRecord["number"] === "number" &&
    typeof prRecord["repo"] === "string" &&
    typeof prRecord["url"] === "string"
  );
}

export interface SessionNotRestorablePayload {
  code: "session_not_restorable";
  sessionId: string;
  reason: string;
  availableActions: ("force_kill" | "respawn")[];
}

export function isSessionNotRestorablePayload(
  value: unknown,
): value is SessionNotRestorablePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const availableActions = record["availableActions"];
  return (
    record["code"] === "session_not_restorable" &&
    typeof record["sessionId"] === "string" &&
    typeof record["reason"] === "string" &&
    Array.isArray(availableActions) &&
    availableActions.every((item) => item === "force_kill" || item === "respawn")
  );
}

export interface SessionDeskMember {
  id: string;
  agent: AgentName;
  deskRole?: "babysitter";
  status: SpurSessionStatus;
  state: SpurSessionState;
  runtimeAlive: boolean;
}

export interface SessionWakeState {
  dueAt: string;
  message: string;
}

export interface SessionIntervalWakeState {
  nextDueAt: string;
  intervalMs: number;
  message: string;
  stopCondition: string;
}

export interface SessionDailyWakeState {
  dailyAt: string[];
  nextDueAt: string;
  message: string;
  stopCondition: string;
}
export interface SpurSessionView {
  id: string;
  project: string;
  agent: AgentName;
  model?: string;
  prompt: string;
  originalTaskPrompt?: string;
  startupAttachmentIds?: string[];
  branch: string;
  worktree: boolean;
  tmuxSession: string | null;
  status: SpurSessionStatus;
  state: SpurSessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  workspaceExists: boolean;
  worktreePath: string;
  services?: SpurServiceView[];
  queuedMessages?: {
    messages: string[];
    awaitingPrompt: boolean;
  };
  scheduledWake?: SessionWakeState;
  intervalWake?: SessionIntervalWakeState;
  dailyWake?: SessionDailyWakeState;
  artifacts?: SpurSessionArtifact[];
  sidecars?: { name: string; alive: boolean; ports?: SpurSidecarPort[] }[];
  runningSidecarNames?: string[];
  slots?: {
    title?: string;
    links: SpurSessionLink[];
    tags?: string[];
  };
  hasServiceIssues?: boolean;
  workspaceAccess?: SpurSessionWorkspaceAccess;
  deskId?: string;
  deskGroupMembers?: SessionDeskMember[];
  claudeAccounts?: SpurClaudeAccount[];
  activeClaudeAccountId?: string;
  error?: string;
  selfDestruct?: {
    enabled: boolean;
    conditions?: string;
  };
}

export interface ProjectInfo {
  id: string;
  name: string;
  configured: boolean;
  prefix: string;
  path: string;
  kind?: "project" | "shepherd";
}

export interface CreateProjectRequest {
  displayName: string;
  prefix: string;
  path: string;
  createMissing?: boolean;
}

export interface CreateProjectResponse {
  id: string;
  entry: ProjectInfo;
  projects: ProjectInfo[];
}

export interface UpdateProjectRequest {
  displayName: string;
  prefix: string;
  path: string;
}

export interface UpdateProjectResponse {
  id: string;
  entry: ProjectInfo;
  projects: ProjectInfo[];
}

export interface DeleteProjectResponse {
  removedKind: "configured" | "unconfigured";
  projects: ProjectInfo[];
}

export type AgentSuggestionKind = "command" | "skill" | "agent";

export interface AgentSuggestionEntry {
  id: string;
  label: string;
  insertText: string;
  detail: string;
  source: "built-in" | "project" | "user" | "plugin" | "session";
  kind: AgentSuggestionKind;
}

export interface AgentSuggestionsResponse {
  agent: "claude" | "codex";
  commands: AgentSuggestionEntry[];
  skills: AgentSuggestionEntry[];
  agents: AgentSuggestionEntry[];
}

export interface SpurSessionsResponse {
  sessions: SpurSessionView[];
  projects?: ProjectInfo[];
  backlog?: AvailableBacklogItem[];
  daemonAlive?: boolean;
}

export type BacklogProviderId = "jira";

export interface AvailableBacklogItem {
  provider: BacklogProviderId;
  projectId: string;
  backlogId: string;
  externalId: string;
  key: string;
  title: string;
  url: string;
  fetchedAt: string;
}

export interface TakeBacklogItemResponse {
  item: AvailableBacklogItem;
  session: SpurSessionView;
}

export type AttentionLevel =
  | "error"
  | "rate_limited"
  | "respond"
  | "working"
  | "pending"
  | "stopped"
  | "done";

export const ATTENTION_ZONE_ORDER: AttentionLevel[] = [
  "error",
  "rate_limited",
  "respond",
  "working",
  "pending",
  "stopped",
  "done",
];

export function worstAttentionLevel(levels: readonly AttentionLevel[]): AttentionLevel {
  let bestRank = ATTENTION_ZONE_ORDER.length;
  let result: AttentionLevel = "done";
  for (const level of levels) {
    const rank = ATTENTION_ZONE_ORDER.indexOf(level);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      result = level;
    }
  }
  return result;
}

export interface DashboardRunningSidecar {
  name: string;
  url?: string;
}

export interface DashboardSession {
  id: string;
  projectId: string;
  projectName: string;
  agent: AgentName;
  model?: string;
  title: string | null;
  prompt: string;
  originalTaskPrompt: string | null;
  startupAttachmentIds: string[];
  branch: string | null;
  worktree: boolean;
  tmuxSession: string | null;
  status: SpurSessionStatus;
  state: SpurSessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  workspaceExists: boolean;
  worktreePath: string;
  services: SpurServiceView[];
  artifacts: SpurSessionArtifact[];
  queuedMessages: {
    messages: string[];
    awaitingPrompt: boolean;
  };
  scheduledWake?: SessionWakeState;
  intervalWake?: SessionIntervalWakeState;
  dailyWake?: SessionDailyWakeState;
  sidecars: { name: string; alive: boolean; ports?: SpurSidecarPort[] }[];
  runningSidecars: DashboardRunningSidecar[];
  links: SpurSessionLink[];
  tags: string[];
  hasServiceIssues: boolean;
  workspaceAccess?: SpurSessionWorkspaceAccess;
  deskId?: string;
  deskKey: string;
  deskGroupMembers?: SessionDeskMember[];
  claudeAccounts?: SpurClaudeAccount[];
  activeClaudeAccountId?: string;
  error?: string;
  selfDestruct?: {
    enabled: boolean;
    conditions?: string;
  };
}

export interface SpawnOverrides {
  worktree?: boolean;
  defaultBranch?: string;
}

export function toDashboardSession(
  session: SpurSessionView,
  projectName = session.project,
): DashboardSession {
  const links = session.slots?.links ?? [];
  const sidecarLinkUrls = new Map(links.map((link) => [link.label, link.url]));
  const runningSidecarNames = session.runningSidecarNames ?? [];
  const runningSidecars = runningSidecarNames.map((name) => {
    const url = sidecarLinkUrls.get(name);
    return url ? { name, url } : { name };
  });
  const tags = session.slots?.tags ?? [];
  const queuedMessages = session.queuedMessages ?? { messages: [], awaitingPrompt: false };
  return {
    id: session.id,
    projectId: session.project,
    projectName,
    agent: session.agent,
    ...(session.model !== undefined ? { model: session.model } : {}),
    title: session.slots?.title?.trim() || null,
    prompt: session.prompt,
    originalTaskPrompt: session.originalTaskPrompt?.trim() || null,
    startupAttachmentIds: session.startupAttachmentIds ?? [],
    branch: session.branch?.trim() || null,
    worktree: session.worktree,
    tmuxSession: session.tmuxSession ?? null,
    status: session.status,
    state: session.state,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt,
    runtimeAlive: session.runtimeAlive,
    workspaceExists: session.workspaceExists,
    worktreePath: session.worktreePath,
    services: session.services ?? [],
    artifacts: session.artifacts ?? [],
    queuedMessages,
    scheduledWake: session.scheduledWake,
    intervalWake: session.intervalWake,
    dailyWake: session.dailyWake,
    sidecars: session.sidecars ?? [],
    runningSidecars,
    links,
    tags,
    hasServiceIssues: session.hasServiceIssues === true,
    workspaceAccess: session.workspaceAccess,
    deskKey: session.deskId?.trim() || session.id,
    deskId: session.deskId,
    deskGroupMembers: session.deskGroupMembers,
    ...(session.claudeAccounts ? { claudeAccounts: session.claudeAccounts } : {}),
    ...(session.activeClaudeAccountId
      ? { activeClaudeAccountId: session.activeClaudeAccountId }
      : {}),
    error: session.error,
    ...(session.selfDestruct ? { selfDestruct: session.selfDestruct } : {}),
  };
}

export function hasServiceProblems(
  session: Pick<DashboardSession, "hasServiceIssues" | "services">,
): boolean {
  return (
    session.hasServiceIssues ||
    session.services.some(
      (service) =>
        service.status === "errored" ||
        service.state === "problem" ||
        service.state === "error" ||
        !service.runtimeAlive,
    )
  );
}

export function hasSessionErrorEvidence(
  session: Pick<DashboardSession, "status" | "state" | "error">,
): boolean {
  return (
    session.status === "errored" ||
    session.state === "error" ||
    (typeof session.error === "string" && session.error.trim().length > 0)
  );
}

export function isTerminalSession(session: Pick<DashboardSession, "status">): boolean {
  return session.status === "completed" || session.status === "killed";
}

export function isRestorable(session: DashboardSession): boolean {
  if (isTerminalSession(session)) return false;
  if (!session.workspaceExists) return false;
  if (session.status === "paused" || session.status === "stopped") return true;
  return !session.runtimeAlive;
}

export function canRecover(session: DashboardSession): boolean {
  return !isTerminalSession(session) && !isRestorable(session) && !session.workspaceExists;
}

export function canPause(session: DashboardSession): boolean {
  return session.status === "running" && session.runtimeAlive;
}

export function canComplete(session: DashboardSession): boolean {
  return !isTerminalSession(session);
}

export function canRespawn(session: DashboardSession): boolean {
  return (
    (session.status === "completed" ||
      session.status === "killed" ||
      session.status === "errored") &&
    !session.runtimeAlive
  );
}

export function canHandoff(session: DashboardSession): boolean {
  return (
    !isTerminalSession(session) &&
    session.workspaceExists &&
    (session.status === "running" ||
      session.status === "spawning" ||
      session.status === "paused" ||
      session.status === "stopped")
  );
}

export function canSendMessage(session: DashboardSession): boolean {
  return session.runtimeAlive && !isTerminalSession(session);
}

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  timestampMs: number;
}

export interface ConversationResponse {
  messages: ConversationMessage[];
  durationMs: number;
  state: SpurSessionState;
}

export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  if (isTerminalSession(session)) {
    return "done";
  }

  if (hasSessionErrorEvidence(session) || hasServiceProblems(session)) {
    return "error";
  }

  if (session.state === "rate_limited") {
    return "rate_limited";
  }

  if (session.state === "needs_input") {
    return "respond";
  }

  if (session.status === "spawning") {
    return "working";
  }

  if (!session.workspaceExists) {
    return "respond";
  }

  if (
    session.status === "paused" ||
    session.status === "stopped" ||
    session.state === "stopped" ||
    !session.runtimeAlive
  ) {
    return "stopped";
  }

  if (session.state === "waiting") {
    return "pending";
  }

  return "working";
}

export interface DeskCollapsedRow {
  session: DashboardSession;
  deskMemberCount: number;
  lane: AttentionLevel;
}

export function collapseDeskRows(sessions: readonly DashboardSession[]): DeskCollapsedRow[] {
  const byDesk = new Map<string, DashboardSession[]>();
  for (const s of sessions) {
    const group = byDesk.get(s.deskKey);
    if (group) {
      group.push(s);
    } else {
      byDesk.set(s.deskKey, [s]);
    }
  }

  const rows: DeskCollapsedRow[] = [];
  for (const [deskKey, members] of byDesk) {
    const activeMembers = members.filter((m) => !isTerminalSession(m));
    const anchor =
      activeMembers.sort((a, b) => {
        const byActivity = b.lastActivityAt.localeCompare(a.lastActivityAt);
        if (byActivity !== 0) return byActivity;
        const byCreated = b.createdAt.localeCompare(a.createdAt);
        if (byCreated !== 0) return byCreated;
        return a.id.localeCompare(b.id);
      })[0] ??
      members.find((m) => m.id === deskKey) ??
      [...members].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!anchor) continue;
    rows.push({
      session: anchor,
      deskMemberCount: activeMembers.length,
      lane: worstAttentionLevel(members.map(getAttentionLevel)),
    });
  }

  rows.sort((a, b) => {
    const byActivity = b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
    if (byActivity !== 0) return byActivity;
    return a.session.id.localeCompare(b.session.id);
  });

  return rows;
}
