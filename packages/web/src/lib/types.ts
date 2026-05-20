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
  | "stopped"
  | "error"
  | "killed";

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

export type SpurSessionArtifactKind = "image" | "video" | "download";
export type SpurSessionArtifactOrigin = "intentional" | "automatic";

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

export interface SpurSessionView {
  id: string;
  project: string;
  agent: AgentName;
  prompt: string;
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
  artifacts?: SpurSessionArtifact[];
  sidecars?: { name: string; alive: boolean }[];
  slots?: {
    title?: string;
    links: SpurSessionLink[];
  };
  hasServiceIssues?: boolean;
  workspaceAccess?: SpurSessionWorkspaceAccess;
  error?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
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
  daemonAlive?: boolean;
}

export type AttentionLevel = "respond" | "working" | "pending" | "stopped" | "done";

export interface DashboardSession {
  id: string;
  projectId: string;
  projectName: string;
  agent: AgentName;
  title: string | null;
  prompt: string;
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
  sidecars: { name: string; alive: boolean }[];
  links: SpurSessionLink[];
  hasServiceIssues: boolean;
  workspaceAccess?: SpurSessionWorkspaceAccess;
  error?: string;
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
  const queuedMessages = session.queuedMessages ?? { messages: [], awaitingPrompt: false };
  return {
    id: session.id,
    projectId: session.project,
    projectName,
    agent: session.agent,
    title: session.slots?.title?.trim() || null,
    prompt: session.prompt,
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
    sidecars: session.sidecars ?? [],
    links,
    hasServiceIssues: session.hasServiceIssues === true,
    workspaceAccess: session.workspaceAccess,
    error: session.error,
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

export function isTerminalSession(session: Pick<DashboardSession, "status">): boolean {
  return session.status === "completed" || session.status === "killed";
}

export function isRestorable(session: DashboardSession): boolean {
  if (isTerminalSession(session)) return false;
  if (session.status === "errored") return false;
  if (session.status === "paused" || session.status === "stopped") return true;
  return !session.runtimeAlive;
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

  if (
    session.status === "errored" ||
    session.state === "needs_input" ||
    session.state === "error" ||
    Boolean(session.error) ||
    hasServiceProblems(session) ||
    !session.workspaceExists
  ) {
    return "respond";
  }

  if (session.status === "spawning") {
    return "working";
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
