export type AgentName = "claude" | "codex" | "cursor";
export const SPUR_DAEMON_API_VERSION = 2;

export type SessionStatus =
  | "spawning"
  | "running"
  | "stopped"
  | "paused"
  | "errored"
  | "completed"
  | "killed";
export type SessionState = "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
export type StateSource = "jsonl" | "hook" | "pane" | "status";

export interface SessionStateTransition {
  state: SessionState;
  at: string;
  source: StateSource;
}
export type BranchSource = "explicit" | "preflight" | "shared_workspace";
export type ServiceInstanceStatus = "running" | "stopped" | "errored";
export type ServiceInstanceState = "running" | "problem" | "stopped" | "error";
export type RuntimeLogKind = "service" | "sidecar";
export type SessionLogScope = "all" | "runtime" | "service" | "sidecar";
export interface SessionLink {
  label: string;
  url: string;
}
export interface SessionPrBinding {
  number: number;
  repo: string;
  url: string;
}

export type SessionArtifactKind = "image" | "video" | "download";
export type SessionArtifactOrigin = "intentional" | "automatic";

export interface SessionArtifact {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: SessionArtifactKind;
  origin: SessionArtifactOrigin;
  addedByUser?: boolean;
  createdAt: string;
  updatedAt: string;
}
export type SessionPipelineStatus = "running" | "completed" | "errored";

export interface SessionSlots {
  title?: string;
  links: SessionLink[];
}

export type ReviewProviderId = "github" | "gitlab";
export type SourceType = "cron" | ReviewProviderId | "service";

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";
export const REVIEW_SIGNAL_KINDS = [
  "changes_requested",
  "ci_failed",
  "comment",
  "merge_conflict",
] as const;
export type ReviewSignalKind = (typeof REVIEW_SIGNAL_KINDS)[number];

export const GITHUB_WORK_ITEM_NEW_EVENT = "github:work_item.new" as const;

export interface GitHubWorkItemEventData {
  externalId: string;
  url: string;
  number: number;
  title: string;
  repo: string;
}

interface BaseSourceConfig {
  runOnStart: boolean;
}

export interface CronSourceConfig extends BaseSourceConfig {
  type: "cron";
  schedule: string;
}

interface ReviewSourceConfigBase<TType extends ReviewProviderId> extends BaseSourceConfig {
  type: TType;
  intervalMs: number;
  query?: string;
}

export type GitHubSourceConfig = ReviewSourceConfigBase<"github">;
export type GitLabSourceConfig = ReviewSourceConfigBase<"gitlab">;
export type ReviewSourceConfig = GitHubSourceConfig | GitLabSourceConfig;

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

export type SourceConfig = CronSourceConfig | ReviewSourceConfig | ServiceSourceConfig;

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
  url?: string;
}

export type WorkspaceAccessItemKind = "copy" | "link";

export interface WorkspaceAccessItemConfig {
  label: string;
  kind: WorkspaceAccessItemKind;
  value: string;
}

export interface WorkspaceAccessConfig {
  items: WorkspaceAccessItemConfig[];
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

export interface ReviewSignal {
  key: string;
  kind: ReviewSignalKind;
  text: string;
}

export interface ReviewEventData {
  sessionId: string;
  prNumber: number;
  prTitle: string;
  signals: ReviewSignal[];
}

export interface ReviewRequestSummary {
  number: number;
  title: string;
  url: string;
  reviewDecision: ReviewDecision;
  repo: string;
  mergeable: string;
  mergeStateStatus: string;
}

export interface ReviewCheck {
  name: string;
  state: string;
}

export type GitHubReviewDecision = ReviewDecision;
export type GitHubSignalKind = ReviewSignalKind;
export type GitHubSignal = ReviewSignal;
export type GitHubEventData = ReviewEventData;
export type GitHubPrSummary = ReviewRequestSummary;
export type GitHubCheck = ReviewCheck;

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
  codexArgs?: string[];
  spawn?: ProjectSpawnConfig;
  preflight?: ProjectPreflightConfig;
  defaultAgent?: AgentName;
  workspaceAccess?: WorkspaceAccessConfig;
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
  deskId?: string;
  agent: AgentName;
  planMode?: boolean;
  agentSessionId?: string;
  prompt: string;
  startupAttachmentIds?: string[];
  branch: string;
  branchSource?: BranchSource;
  pr?: SessionPrBinding;
  worktree: boolean;
  worktreePath: string;
  tmuxSession: string;
  launchCommand: string;
  status: SessionStatus;
  stopReason?: "manual_pause";
  createdAt: string;
  updatedAt: string;
  retainInList?: boolean;
  slots?: SessionSlots;
  sidecarNames?: string[];
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
  artifacts: SessionArtifact[];
  services: ServiceInstanceView[];
  sidecars: { name: string; alive: boolean }[];
  workspaceAccess?: SessionWorkspaceAccess;
}

export interface DashboardSessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  state: SessionState;
  lastActivityAt: string;
  slots?: SessionSlots;
  hasServiceIssues?: boolean;
}

export type SessionListView = SessionView | DashboardSessionView;

export interface SessionWorkspaceAccessItem {
  label: string;
  kind: WorkspaceAccessItemKind;
  value: string;
}

export interface SessionWorkspaceAccess {
  items: SessionWorkspaceAccessItem[];
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
  attachments?: SendMessageAttachment[];
  steps?: string[];
  agent?: AgentName;
  planMode?: boolean;
  branch?: string;
  overrides?: SpawnOverrides;
  reuseWorkspaceSessionId?: string;
  configPath?: string;
  slots?: { links?: SessionLink[] };
}

export interface SendMessageAttachment {
  name: string;
  data: string; // base64
}

export interface SendMessageRequest {
  message: string;
  attachments?: SendMessageAttachment[];
  queue?: boolean;
  interrupt?: boolean;
}

export interface RunServiceRequest {
  command: string;
  cwd: string;
  port?: number;
}

export interface StartSidecarRequest {
  callerSidecarName?: string;
  callerSidecarDepth?: number;
}

export interface KillSessionRequest {
  force?: boolean;
}

export interface RespawnSessionRequest {
  prompt?: string;
  attachments?: SendMessageAttachment[];
  startupAttachmentIds?: string[];
  terminateSessionId?: string;
}

export interface UpdateSessionSlotsRequest {
  title?: string;
  clearTitle?: boolean;
  setTitleIfAbsent?: boolean;
  links?: SessionLink[];
  unlinkLabels?: string[];
}

export interface ProjectListEntry {
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
  agent: AgentName;
  commands: AgentSuggestionEntry[];
  skills: AgentSuggestionEntry[];
  agents: AgentSuggestionEntry[];
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

export interface RuntimeLogCursorState {
  lastTailLines: string[];
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
