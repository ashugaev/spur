export type AgentName = "claude" | "codex" | "cursor";
export const SPUR_DAEMON_API_VERSION = 3;

export type SessionStatus =
  | "spawning"
  | "running"
  | "stopped"
  | "paused"
  | "errored"
  | "completed"
  | "killed";
export const SESSION_STATES = [
  "working",
  "waiting",
  "needs_input",
  "rate_limited",
  "stopped",
  "error",
  "killed",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && SESSION_STATES.includes(value as SessionState);
}

export type StateSource = "jsonl" | "codex_stale" | "hook" | "claude_status" | "status";

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

export type SessionArtifactKind = "image" | "video" | "text" | "download";
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

export type SessionMemoryStatus = "active" | "resolved";
export type SessionMemoryKind = "note";

export interface SessionMemoryRecord {
  key: string;
  kind: SessionMemoryKind;
  body: string;
  status: SessionMemoryStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface SetSessionMemoryRequest {
  body: string;
  kind?: SessionMemoryKind;
  tags?: string[];
}

export interface SessionMemoryListResponse {
  records: SessionMemoryRecord[];
}

export interface SessionMemoryRecordResponse {
  record: SessionMemoryRecord;
}

export type SessionPipelineStatus = "running" | "completed" | "errored";

export interface SessionSlots {
  title?: string;
  links: SessionLink[];
  tags?: string[];
}

export interface TagDefinition {
  name: string;
  description: string;
  color: string;
}

export type ReviewProviderId = "github" | "gitlab";
export type SourceType =
  | "cron"
  | ReviewProviderId
  | "sentry"
  | "service"
  | "telegram"
  | "jira"
  | "github-ci";

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";
export const REVIEW_SIGNAL_KINDS = [
  "changes_requested",
  "ci_failed",
  "comment",
  "merge_conflict",
] as const;
export type ReviewSignalKind = (typeof REVIEW_SIGNAL_KINDS)[number];

export const GITHUB_PR_LIFECYCLE_KINDS = [
  "ready_for_review",
  "approved",
  "merged",
  "closed",
] as const;
export type GitHubLifecycleKind = (typeof GITHUB_PR_LIFECYCLE_KINDS)[number];

export const GITHUB_WORK_ITEM_NEW_EVENT = "github:work_item.new" as const;
export const SENTRY_ISSUE_NEW_EVENT = "sentry:issue.new" as const;
export const TELEGRAM_MESSAGE_EVENT = "telegram:message" as const;
export const GITHUB_CI_RUN_COMPLETED_EVENT = "github-ci:run.completed" as const;

export const WORK_ITEM_NEW_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  GITHUB_WORK_ITEM_NEW_EVENT,
  SENTRY_ISSUE_NEW_EVENT,
  GITHUB_CI_RUN_COMPLETED_EVENT,
]);

export interface WorkItemEventData {
  externalId: string;
  url: string;
  number: number;
  title: string;
  repo: string;
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
  position: number;
}

export interface TakeBacklogItemRequest {
  projectId: string;
  backlogId: string;
  externalId: string;
}

export interface TakeBacklogItemResponse {
  item: AvailableBacklogItem;
  session: SessionView;
}

export type WorkItemLifecycleState = "pending" | "running" | "failed" | "completed";

interface WorkItemLifecycleBase extends WorkItemEventData {
  autoComplete: boolean;
  createdAt: string;
}

export type WorkItemLifecycleRecord = WorkItemLifecycleBase &
  (
    | {
        state: "pending";
      }
    | {
        state: "running";
        sessionId: string;
      }
    | {
        state: "failed";
        error: string;
      }
    | {
        state: "completed";
        sessionId: string;
        completedAt: string;
      }
  );

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
  emitExisting: boolean;
  query?: string;
}

export type GitHubSourceConfig = ReviewSourceConfigBase<"github">;
export type GitLabSourceConfig = ReviewSourceConfigBase<"gitlab">;
export type ReviewSourceConfig = GitHubSourceConfig | GitLabSourceConfig;

export interface SentrySourceConfig extends BaseSourceConfig {
  type: "sentry";
  authToken: string;
  org: string;
  project: string;
  baseUrl: string;
  query: string;
  intervalMs: number;
  emitExisting: boolean;
}

export interface JiraSourceConfig {
  type: "jira";
  baseUrl: string;
  email: string;
  token: string;
}

export interface BacklogSpawnConfig {
  prompt?: string;
  agent?: AgentName;
}

export interface BacklogConfig {
  source: string;
  provider: BacklogProviderId;
  query: string;
  intervalMs: number;
  runOnStart: boolean;
  spawn?: BacklogSpawnConfig;
}

export interface GitHubCiSourceConfig extends BaseSourceConfig {
  type: "github-ci";
  repo: string;
  conclusion: string; // "success" | "any"
  branch?: string;
  intervalMs: number;
  emitExisting: boolean;
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

export interface TelegramSourceConfig extends BaseSourceConfig {
  type: "telegram";
  token: string;
  allowedUsers?: number[];
  allowedChats?: number[];
}

export interface TelegramBinding {
  chatId: number;
  messageThreadId?: number;
  sessionId: string;
}

export interface TelegramReplyTarget extends TelegramBinding {
  projectId: string;
  sourceId: string;
  statusMessageId?: number;
  lastInboundAt?: string;
  lastReplyAt?: string;
  updatedAt: string;
}

export type SourceConfig =
  | CronSourceConfig
  | ReviewSourceConfig
  | SentrySourceConfig
  | ServiceSourceConfig
  | TelegramSourceConfig
  | JiraSourceConfig
  | GitHubCiSourceConfig;

export interface TelegramMessageEventData {
  sessionId: string;
  chatId: number;
  messageThreadId?: number;
  userId: number;
  username?: string;
  messageId: number;
  text: string;
}

export interface SpawnOverrides {
  worktree?: boolean;
  defaultBranch?: string;
}

export interface ProjectPreflightConfig {
  prompt: string;
}

export interface ProjectBranchNamingConfig {
  regex: string;
}

export interface SidecarConfig {
  command: string;
  autoStart: boolean;
  dependsOn?: string[];
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

export interface SelfDestructConfig {
  enabled: boolean;
  conditions?: string;
}

export interface TriggerSpawnBlockConfig {
  prompt: string;
  steps?: string[];
  agent?: AgentName;
  model?: string;
  branch?: string;
  overrides?: SpawnOverrides;
  selfDestruct?: SelfDestructConfig;
}

export interface TriggerSpawnConfig {
  blocks: TriggerSpawnBlockConfig[];
  autoComplete?: boolean;
  restrictWrites?: boolean;
  allowedTriggers?: string[];
}

export interface TriggerSendConfig {
  interrupt: boolean;
  prompt?: string;
}

export interface SpawnTriggerConfig {
  source: string;
  event: string;
  spawnDeskGroup?: boolean;
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
  kind: ReviewSignalKind | GitHubLifecycleKind;
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
  conclusion?: string | null;
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

export type PersistedSendBatch =
  | {
      kind: "review";
      providerId: ReviewProviderId;
      projectId: string;
      sourceId: string;
      prompt?: string;
      sessionId: string;
      prNumber: number;
      prTitle: string;
      signals: ReviewSignal[];
    }
  | {
      kind: "service";
      prompt?: string;
      sessionId: string;
      serviceId: string;
      ruleIds: string[];
    }
  | {
      kind: "telegram";
      prompt?: string;
      sessionId: string;
      messages: TelegramMessageEventData[];
    };

export interface PersistedPendingBatch {
  queueKey: string;
  projectId: string;
  triggerId: string;
  sourceId: string;
  batch: PersistedSendBatch;
}

export interface ProjectConfig {
  name?: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  worktree: boolean;
  restoreAfterReboot: boolean;
  symlinks: string[];
  codexArgs?: string[];
  spawn?: ProjectSpawnConfig;
  preflight?: ProjectPreflightConfig;
  branchNaming?: ProjectBranchNamingConfig;
  defaultAgent?: AgentName;
  defaultModels?: Partial<Record<AgentName, string>>;
  workspaceAccess?: WorkspaceAccessConfig;
  sidecars: Record<string, SidecarConfig>;
  sources: Record<string, SourceConfig>;
  backlog: Record<string, BacklogConfig>;
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
  projectsRoot: string;
  defaultAgent: AgentName;
  tmux: {
    socketName: string;
  };
  ui: {
    port: number;
  };
  voice:
    | {
        provider: "whisper_cpp" | "faster_whisper";
        language: string;
        model: string;
        modelPath?: string;
      }
    | {
        provider: "azure_openai";
        language: string;
        model: string;
        endpoint?: string;
        apiKey?: string;
        apiVersion?: string;
      }
    | {
        provider: "openai_compatible";
        language: string;
        model: string;
        baseUrl: string;
        apiKey: string;
      }
    | {
        provider: "openai_realtime";
        language: string;
        model: string;
      };
  eventLog?: {
    hotBytes: number;
    shardHotBytes: number;
    retainArchives: number;
  };
  userActionLog?: {
    hotBytes: number;
    shardHotBytes: number;
    retainArchives: number;
  };
  rateLimitReactivation: {
    afterHours: number;
  };
  authRotation: {
    autoRotateOnRateLimit: boolean;
    cooldownMinutes: number;
    maxRotationsPerEpisode: number;
  };
  projects: Record<string, ProjectConfig>;
  tags: TagDefinition[];
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

export interface SessionScheduledWakeState {
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

export interface SessionStateSubscription {
  id: string;
  targetSessionId: string;
  states: SessionState[];
  message?: string;
  createdAt: string;
  updatedAt: string;
  lastDeliveredTransitionId?: string;
  lastDeliveredAt?: string;
}

export interface SubscribeSessionStatesRequest {
  targetSessionId: string;
  states: SessionState[];
  message?: string;
}

export interface SessionStateSubscriptionListResponse {
  records: SessionStateSubscription[];
}

export interface SessionStateSubscriptionRecordResponse {
  record: SessionStateSubscription;
}

export interface SessionRecord {
  id: string;
  project: string;
  deskId?: string;
  agent: AgentName;
  model?: string;
  planMode?: boolean;
  restrictWrites?: boolean;
  claudeAccountId?: string;
  allowedTriggers?: string[];
  agentSessionId?: string;
  prompt: string;
  originalTaskPrompt?: string;
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
  lastOpenedAt?: string;
  retainInList?: boolean;
  slots?: SessionSlots;
  selfDestruct?: SelfDestructConfig;
  sidecarNames?: string[];
  sidecarPorts?: Record<string, Record<string, number>>;
  pipeline?: SessionPipelineState;
  queuedMessages?: SessionQueuedMessagesState;
  scheduledWake?: SessionScheduledWakeState;
  intervalWake?: SessionIntervalWakeState;
  dailyWake?: SessionDailyWakeState;
  rateLimitedAt?: string;
  stateSubscriptions?: SessionStateSubscription[];
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

export interface SessionDeskMember {
  id: string;
  agent: AgentName;
  status: SessionStatus;
  state: SessionState;
  runtimeAlive: boolean;
}

export interface CompleteDeskResponse {
  completedIds: string[];
}

export interface SidecarPortView {
  id: string;
  env: string;
  port: number;
}

export interface SessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  state: SessionState;
  stateHistory?: SessionStateTransition[];
  hasUnseenAttention?: boolean;
  lastActivityAt: string;
  artifacts: SessionArtifact[];
  services: ServiceInstanceView[];
  sidecars: { name: string; alive: boolean; ports: SidecarPortView[] }[];
  workspaceAccess?: SessionWorkspaceAccess;
  deskGroupMembers?: SessionDeskMember[];
  claudeAccounts?: { id: string; label?: string; authenticated: boolean }[];
  activeClaudeAccountId?: string;
}

export interface DashboardSessionView extends SessionRecord {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  state: SessionState;
  hasUnseenAttention?: boolean;
  lastActivityAt: string;
  slots?: SessionSlots;
  hasServiceIssues?: boolean;
  runningSidecarNames?: string[];
  deskGroupMembers?: SessionDeskMember[];
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

export interface BranchExistsResponse {
  exists: boolean;
  remote: boolean;
  checkedOutAt: string | null;
}

export interface SpawnSessionRequest {
  project: string;
  prompt?: string;
  attachments?: SendMessageAttachment[];
  steps?: string[];
  agent?: AgentName;
  model?: string;
  planMode?: boolean;
  restrictWrites?: boolean;
  allowedTriggers?: string[];
  branch?: string;
  overrides?: SpawnOverrides;
  reuseWorkspaceSessionId?: string;
  originalTaskPrompt?: string;
  bareSpawnMessage?: boolean;
  configPath?: string;
  slots?: { links?: SessionLink[] };
  selfDestruct?: SelfDestructConfig;
  bootstrap?: boolean;
  allowUnvalidatedFallbackBranch?: boolean;
  // Claude account whose CLAUDE_CONFIG_DIR the launch binds to. Carried across
  // respawn so a rotated session relaunches onto its current account instead of
  // falling back to the (still-rate-limited) default.
  claudeAccountId?: string;
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

export interface SourceReplyRequest {
  message: string;
}

export interface SourceReplyResponse {
  ok: true;
  source: "telegram";
  sessionId: string;
  projectId: string;
  sourceId: string;
  chatId: number;
  messageThreadId?: number;
}

export interface ScheduleSessionWakeRequest {
  at?: string;
  delayMs?: number;
  intervalMs?: number;
  dailyAt?: string[];
  stopCondition?: string;
  message?: string;
}

export interface RunServiceRequest {
  command: string;
  cwd: string;
  port?: number;
}

export interface StartSidecarRequest {
  callerSidecarName?: string;
  callerSidecarDepth?: number;
  clearPort?: number;
}

export interface SidecarPortConflictCandidate {
  portId: string;
  env: string;
  port: number;
  owner?: string;
}

export interface SidecarPortConflictPayload {
  code: "sidecar_port_busy";
  sidecarName: string;
  candidates: SidecarPortConflictCandidate[];
}

export type OpenPrAction = "leave_open" | "close";

export interface CompleteSessionRequest {
  scope?: "session" | "desk";
  prAction?: OpenPrAction;
  skipPrCheck?: boolean;
  skipRuntimeTeardown?: boolean;
}

export interface KillSessionRequest {
  force?: boolean;
  prAction?: OpenPrAction;
  skipPrCheck?: boolean;
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

export interface GithubPrCheckUnavailablePayload {
  code: "github_pr_check_unavailable";
  sessionId: string;
  pr: SessionPrBinding | null;
  rateLimited: boolean;
}

export interface SessionNotRestorablePayload {
  code: "session_not_restorable";
  sessionId: string;
  reason: string;
  availableActions: ("force_kill" | "respawn")[];
}

export interface RespawnSessionRequest {
  prompt?: string;
  attachments?: SendMessageAttachment[];
  startupAttachmentIds?: string[];
  terminateSessionId?: string;
  forceKillSource?: boolean;
  agent?: AgentName;
  model?: string;
}

export interface HandoffSessionRequest {
  agent: AgentName;
  model?: string;
  notes?: string;
}

export interface UpdateSessionSlotsRequest {
  title?: string;
  clearTitle?: boolean;
  setTitleIfAbsent?: boolean;
  links?: SessionLink[];
  unlinkLabels?: string[];
  tags?: string[];
  untags?: string[];
}

export interface ProjectListEntry {
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
  path?: string;
  createMissing?: boolean;
}

export interface CreateProjectResponse {
  id: string;
  entry: ProjectListEntry;
  projects: ProjectListEntry[];
}

export interface UpdateProjectRequest {
  displayName: string;
  prefix: string;
  path: string;
}

export interface UpdateProjectResponse {
  id: string;
  entry: ProjectListEntry;
  projects: ProjectListEntry[];
}

export interface DeleteProjectResponse {
  removedKind: "configured" | "unconfigured";
  projects: ProjectListEntry[];
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
  version: string;
  pid: number;
  host: string;
  port: number;
  dataDir: string;
  worktreeDir: string;
  configPath: string;
  tmuxSocketName: string;
  uiPort: number;
  startedAt: string;
  tags: TagDefinition[];
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

export type TranscriptEntry =
  | { kind: "message"; role: "user" | "assistant"; text: string; timestampMs?: number }
  | { kind: "tool"; name: string; callId?: string; inputSummary?: string; output?: string; timestampMs?: number }
  | { kind: "reasoning"; text: string; timestampMs?: number }
  | { kind: "question"; header: string; prompt: string; options?: { label: string; index: number }[]; multiSelect?: boolean; timestampMs?: number };

export interface ConversationResponse {
  messages: ConversationMessage[];
  entries: TranscriptEntry[];
  durationMs: number;
  state: SessionState;
}
