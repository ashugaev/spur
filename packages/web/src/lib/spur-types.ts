export type SpurSessionStatus =
  | "spawning"
  | "running"
  | "paused"
  | "errored"
  | "completed"
  | "killed";

export type SpurSessionState = "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";

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
  status: SpurSessionStatus;
  state: SpurSessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  workspaceExists: boolean;
  worktreePath: string;
  services: SpurServiceView[];
  devServerAlive?: boolean;
  slots?: {
    title?: string;
    links: SpurSessionLink[];
  };
  error?: string;
}

export interface SpurSessionsResponse {
  sessions: SpurSessionView[];
  projects?: Array<{ id: string; label: string }>;
}
