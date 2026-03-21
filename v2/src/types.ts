export type AgentName = "claude" | "codex";
export const SPUR_DAEMON_API_VERSION = 2;

export type SessionStatus = "spawning" | "running" | "errored" | "killed";
export type SessionState = "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
export type BranchSource = "explicit" | "preflight" | "shared_workspace";
export interface SessionLink {
  label: string;
  url: string;
}

export interface SessionSlots {
  title?: string;
  links: SessionLink[];
}

export type SourceType = "cron" | "github";

export type GitHubReviewDecision = "approved" | "changes_requested" | "pending" | "none";
export const GITHUB_SIGNAL_KINDS = ["changes_requested", "ci_failed", "comment"] as const;
export type GitHubSignalKind = (typeof GITHUB_SIGNAL_KINDS)[number];

interface BaseSourceConfig {
  runOnStart: boolean;
}

export interface CronSourceConfig extends BaseSourceConfig {
  type: "cron";
  schedule: string;
}

export interface GitHubSourceConfig extends BaseSourceConfig {
  type: "github";
  intervalMs: number;
}

export type SourceConfig = CronSourceConfig | GitHubSourceConfig;

export interface SpawnOverrides {
  worktree?: boolean;
  defaultBranch?: string;
}

export interface ProjectPreflightConfig {
  prompt: string;
}

export interface TriggerSpawnConfig {
  prompt: string;
  agent?: AgentName;
  branch?: string;
  overrides?: SpawnOverrides;
}

export interface TriggerSendConfig {
  interrupt: boolean;
}

export interface SpawnTriggerConfig {
  source: string;
  event: string;
  spawn: TriggerSpawnConfig;
}

export interface SendTriggerConfig {
  source: string;
  event: string;
  send: TriggerSendConfig;
}

export type TriggerConfig = SpawnTriggerConfig | SendTriggerConfig;

export interface GitHubSignal {
  key: string;
  kind: GitHubSignalKind;
  text: string;
}

export interface GitHubEventData {
  sessionId: string;
  prNumber: number;
  prTitle: string;
  signals: GitHubSignal[];
}

export interface ProjectConfig {
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  worktree: boolean;
  symlinks: string[];
  preflight?: ProjectPreflightConfig;
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
  prompt: string;
  branch: string;
  branchSource?: BranchSource;
  worktree: boolean;
  worktreePath: string;
  tmuxSession: string;
  launchCommand: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  slots?: SessionSlots;
  error?: string;
}

export interface SessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  state: SessionState;
  lastActivityAt: string;
}

export interface SpawnSessionRequest {
  project: string;
  prompt: string;
  agent?: AgentName;
  branch?: string;
  overrides?: SpawnOverrides;
}

export interface SendMessageRequest {
  message: string;
}

export interface UpdateSessionSlotsRequest {
  title?: string;
  clearTitle?: boolean;
  links?: SessionLink[];
  unlinkLabels?: string[];
}

export interface RuntimeInfo {
  ok: true;
  apiVersion: number;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  worktreeDir: string;
  configPath: string;
  startedAt: string;
}
