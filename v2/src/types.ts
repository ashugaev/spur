export type AgentName = "claude" | "codex";

export type SessionStatus = "spawning" | "running" | "stopped" | "errored" | "killed";
export type SessionActivity = "active" | "ready" | "idle" | "waiting_input" | "exited";

export type SourceType = "cron";

interface BaseSourceConfig {
  runOnStart: boolean;
}

export interface CronSourceConfig extends BaseSourceConfig {
  type: "cron";
  schedule: string;
}

export type SourceConfig = CronSourceConfig;

export interface TriggerSpawnConfig {
  prompt: string;
  agent?: AgentName;
  branch?: string;
}

export interface TriggerConfig {
  source: string;
  event: string;
  spawn: TriggerSpawnConfig;
}

export interface ProjectConfig {
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  symlinks: string[];
  defaultAgent?: AgentName;
  sources: Record<string, SourceConfig>;
  triggers: Record<string, TriggerConfig>;
}

export interface AppConfig {
  configPath: string;
  server: {
    host: string;
    port: number;
  };
  dataDir: string;
  worktreeDir: string;
  defaultAgent: AgentName;
  projects: Record<string, ProjectConfig>;
}

export interface SessionRecord {
  id: string;
  project: string;
  agent: AgentName;
  agentSessionId?: string;
  prompt: string;
  branch: string;
  worktreePath: string;
  tmuxSession: string;
  launchCommand: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  activity: SessionActivity;
  lastActivityAt: string;
}

export interface SpawnSessionRequest {
  project: string;
  prompt: string;
  agent?: AgentName;
  branch?: string;
}

export interface SendMessageRequest {
  message: string;
}

export interface RuntimeInfo {
  ok: true;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  worktreeDir: string;
  configPath: string;
  startedAt: string;
}
