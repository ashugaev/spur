export type AgentName = "claude" | "codex";
export const SPUR_DAEMON_API_VERSION = 2;

export type SessionStatus = "spawning" | "running" | "paused" | "errored" | "completed" | "killed";
export type SessionState = "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
export type StateSource = "jsonl" | "pane" | "status";

export interface SessionStateTransition {
  state: SessionState;
  at: string;
  source: StateSource;
}
export type BranchSource = "explicit" | "preflight" | "shared_workspace";
export type ServiceInstanceStatus = "running" | "stopped" | "errored";
export type ServiceInstanceState = "running" | "problem" | "stopped" | "error";
export interface SessionLink {
  label: string;
  url: string;
}
export type SessionPipelineStatus = "running" | "completed" | "errored";

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

export interface SidecarConfig {
  command: string;
  autoStart: boolean;
  env?: Record<string, string>;
  ports?: Record<string, SidecarPortConfig>;
}

export interface SidecarPortConfig {
  env: string;
  start: number;
  end: number;
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
  name?: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  worktree: boolean;
  symlinks: string[];
  spawn?: ProjectSpawnConfig;
  preflight?: ProjectPreflightConfig;
  defaultAgent?: AgentName;
  sidecars: Record<string, SidecarConfig>;
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
  tmux: {
    socketName: string;
  };
  ui: {
    port: number;
  };
  voice: {
    provider: "whisper_cpp" | "faster_whisper" | "azure_openai";
    language: string;
    model: string;
    modelPath?: string;
  };
  projects: Record<string, ProjectConfig>;
}

export interface SessionPipelineState {
  steps: string[];
  nextStepIndex: number;
  awaitingStepIndex?: number;
  nextStepNotBefore?: string;
  status: SessionPipelineStatus;
  error?: string;
}

export interface SessionQueuedMessagesState {
  messages: string[];
  awaitingPrompt: boolean;
}

export interface SessionRecord {
  id: string;
  project: string;
  agent: AgentName;
  planMode?: boolean;
  agentSessionId?: string;
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
  retainInList?: boolean;
  slots?: SessionSlots;
  sidecarPorts?: Record<string, Record<string, number>>;
  pipeline?: SessionPipelineState;
  queuedMessages?: SessionQueuedMessagesState;
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
  state: SessionState;
  stateHistory?: SessionStateTransition[];
  lastActivityAt: string;
  services: ServiceInstanceView[];
  sidecars: { name: string; alive: boolean }[];
}

export interface ServiceInstanceView extends ServiceInstanceRecord {
  runtimeAlive: boolean;
  state: ServiceInstanceState;
  lastActivityAt: string;
  problemRuleIds: string[];
}

export interface PreflightRequest {
  project: string;
  prompt: string;
  agent?: AgentName;
  overrides?: SpawnOverrides;
}

export interface PreflightResponse {
  branch: string | null;
}

export interface SpawnSessionRequest {
  project: string;
  prompt?: string;
  steps?: string[];
  agent?: AgentName;
  planMode?: boolean;
  branch?: string;
  overrides?: SpawnOverrides;
  configPath?: string;
}

export interface SendMessageAttachment {
  name: string;
  data: string; // base64
}

export interface SendMessageRequest {
  message: string;
  attachments?: SendMessageAttachment[];
}

export interface RunServiceRequest {
  command: string;
  cwd: string;
  port?: number;
}

export interface KillSessionRequest {
  force?: boolean;
}

export interface RespawnSessionRequest {
  terminateSessionId?: string;
}

export interface UpdateSessionSlotsRequest {
  title?: string;
  clearTitle?: boolean;
  links?: SessionLink[];
  unlinkLabels?: string[];
}

export interface ProjectListEntry {
  id: string;
  name: string;
}

export interface ConnectProjectConfigRequest {
  configPath: string;
}

export interface DisconnectProjectConfigRequest {
  configPath: string;
}

export interface ProjectConfigMutationResponse {
  ok: true;
  changed: boolean;
  configPath: string;
  projects: ProjectListEntry[];
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
  tmuxSocketName: string;
  uiPort: number;
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

export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
  timestampMs: number;
}

export interface ConversationResponse {
  messages: ConversationMessage[];
  durationMs: number;
  state: SessionState;
}
