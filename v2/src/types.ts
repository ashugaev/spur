export type AgentName = "claude" | "codex";
export const SPUR_DAEMON_API_VERSION = 2;

export type SessionStatus =
  | "spawning"
  | "working"
  | "waiting"
  | "needs_input"
  | "paused"
  | "completed"
  | "killed"
  | "exited"
  | "error";
export type SessionStatusUpdateStatus = Extract<
  SessionStatus,
  "working" | "waiting" | "needs_input" | "error"
>;
export type BranchSource = "explicit" | "preflight" | "shared_workspace";
export type ServiceInstanceStatus = "running" | "stopped" | "errored";
export type ServiceInstanceState = "running" | "problem" | "stopped" | "error";
export interface SessionLink {
  label: string;
  url: string;
}

export interface SessionSlots {
  title?: string;
  links: SessionLink[];
}

export type SourceType = "cron" | "github" | "service";

export type GitHubReviewDecision = "approved" | "changes_requested" | "pending" | "none";
export const GITHUB_SIGNAL_KINDS = [
  "changes_requested",
  "ci_failed",
  "comment",
  "merge_conflict",
] as const;
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

export interface ServiceRuleConfig {
  match: string;
  clear?: string;
  cooldownMs: number;
}

export interface ServiceSourceConfig extends BaseSourceConfig {
  type: "service";
  service: string;
  intervalMs: number;
  tailLines: number;
  rules: Record<string, ServiceRuleConfig>;
}

export type SourceConfig = CronSourceConfig | GitHubSourceConfig | ServiceSourceConfig;

export interface SpawnOverrides {
  worktree?: boolean;
  defaultBranch?: string;
}

export interface ProjectPreflightConfig {
  prompt: string;
}

export interface ProjectSpawnConfig {
  steps?: string[];
}

export interface TriggerSpawnConfig {
  prompt: string;
  steps?: string[];
  agent?: AgentName;
  branch?: string;
  overrides?: SpawnOverrides;
}

export interface TriggerSendConfig {
  interrupt: boolean;
  prompt?: string;
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

export interface ServiceProblemEventData {
  sessionId: string;
  serviceId: string;
  ruleId: string;
}

export interface ProjectConfig {
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  worktree: boolean;
  symlinks: string[];
  spawn?: ProjectSpawnConfig;
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

export interface SessionPipelineState {
  steps: string[];
  nextStepIndex: number;
  awaitingStepIndex?: number;
  nextStepNotBefore?: string;
  error?: string;
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
  pipeline?: SessionPipelineState;
  error?: string;
}

export interface ServiceInstanceRecord {
  sessionId: string;
  project: string;
  serviceId: string;
  port?: number;
  command: string;
  cwd: string;
  tmuxSession: string;
  status: ServiceInstanceStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  lastActivityAt: string;
  services: ServiceInstanceView[];
}

export interface ServiceInstanceView extends ServiceInstanceRecord {
  runtimeAlive: boolean;
  state: ServiceInstanceState;
  lastActivityAt: string;
  problemRuleIds: string[];
}

export interface SpawnSessionRequest {
  project: string;
  prompt: string;
  steps?: string[];
  agent?: AgentName;
  branch?: string;
  overrides?: SpawnOverrides;
  configPath?: string;
}

export interface SendMessageRequest {
  message: string;
}

export interface RunServiceRequest {
  command: string;
  cwd: string;
  port?: number;
}

export interface KillSessionRequest {
  force?: boolean;
}

export interface UpdateSessionSlotsRequest {
  title?: string;
  clearTitle?: boolean;
  links?: SessionLink[];
  unlinkLabels?: string[];
}

export interface UpdateSessionStatusRequest {
  status: SessionStatusUpdateStatus;
  error?: string;
}

export interface SyncProjectsRequest {
  configPath: string;
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

export interface ServiceSourceRuleState {
  active: boolean;
  lastAlertAt?: string;
}

export interface ServiceSourceState {
  serviceId: string;
  lastTailLines: string[];
  rules: Record<string, ServiceSourceRuleState>;
}
