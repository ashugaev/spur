export type SpurSessionStatus =
  | "spawning"
  | "running"
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

export interface SpurSessionView {
  id: string;
  project: string;
  agent: "claude" | "codex";
  prompt: string;
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
  services: SpurServiceView[];
  sidecars?: { name: string; alive: boolean }[];
  slots?: {
    title?: string;
    links: SpurSessionLink[];
  };
  error?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
}

export interface SpurSessionsResponse {
  sessions: SpurSessionView[];
  projects?: ProjectInfo[];
}

export type AttentionLevel = "respond" | "pending" | "working" | "done";

export interface DashboardSession {
  id: string;
  projectId: string;
  projectName: string;
  agent: "claude" | "codex";
  title: string | null;
  prompt: string;
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
  sidecars: { name: string; alive: boolean }[];
  links: SpurSessionLink[];
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
  return {
    id: session.id,
    projectId: session.project,
    projectName,
    agent: session.agent,
    title: session.slots?.title?.trim() || null,
    prompt: session.prompt,
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
    services: session.services,
    sidecars: session.sidecars ?? [],
    links,
    error: session.error,
  };
}

export function hasServiceProblems(session: Pick<DashboardSession, "services">): boolean {
  return session.services.some(
    (service) =>
      service.status === "errored" ||
      service.state === "problem" ||
      service.state === "error" ||
      !service.runtimeAlive,
  );
}

export function isTerminalSession(session: Pick<DashboardSession, "status">): boolean {
  return session.status === "completed" || session.status === "killed";
}

export function isRestorable(session: DashboardSession): boolean {
  if (isTerminalSession(session)) return false;
  if (session.status === "paused") return true;
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
    !session.workspaceExists ||
    (!session.runtimeAlive && session.status === "running")
  ) {
    return "respond";
  }

  if (
    session.status === "paused" ||
    session.status === "spawning" ||
    session.state === "waiting" ||
    session.state === "stopped"
  ) {
    return "pending";
  }

  return "working";
}
