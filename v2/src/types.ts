import type { HostMemory } from "./host-memory.js";

export type AgentName = "claude" | "codex" | "cursor" | "opencode";
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
  "stale",
  "stopped",
  "error",
  "killed",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export function isSessionState(value: unknown): value is SessionState {
  return typeof value === "string" && SESSION_STATES.includes(value as SessionState);
}

export function isStaleParked(session: Pick<SessionRecord, "status" | "stopReason">): boolean {
  return session.status === "stopped" && session.stopReason === "stale_timeout";
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

export type SharedMemoryScope = "task" | "project" | "global";

export interface SharedMemoryEntry {
  key: string;
  body: string;
}

export interface SetSharedMemoryRequest {
  body: string;
}

export interface SharedMemoryListResponse {
  scope: SharedMemoryScope;
  keys: string[];
}

export interface SharedMemoryEntryResponse {
  scope: SharedMemoryScope;
  entry: SharedMemoryEntry;
}

export interface SharedMemoryRemoveResponse {
  scope: SharedMemoryScope;
  key: string;
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
  // Applies only to the query-based work-item poll: restricts results to draft PRs; default (unset) excludes drafts.
  draft?: boolean;
}

export interface GitHubAdaptivePollConfig {
  slowIntervalMs: number;
  activeGraceMs: number;
}

export type GitHubSourceConfig = ReviewSourceConfigBase<"github"> & {
  adaptivePoll?: GitHubAdaptivePollConfig;
};
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

export interface BacklogConfig {
  source: string;
  provider: BacklogProviderId;
  query: string;
  intervalMs: number;
  runOnStart: boolean;
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
  autoSpawn?: TelegramAutoSpawnConfig;
}

export interface TelegramAutoSpawnConfig {
  enabled: boolean;
  project: string;
  agent: AgentName;
  model?: string;
  selfDestruct?: SelfDestructConfig;
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
  /** Agents allowed to use this sidecar. Undefined = all agents. */
  agents?: AgentName[];
  /** Present when this sidecar exposes an MCP server to the launching agent. */
  mcp?: SidecarMcpConfig;
  /** Overrides sidecarGc.idleTtlMinutes for this sidecar only. */
  idleTtlMinutes?: number;
}

export interface SidecarPortConfig {
  env: string;
  start: number;
  end: number;
  url?: string;
}

export interface SidecarMcpConfig {
  server: string;
  /** Selects which `ports` entry carries the reserved port for this MCP server. */
  portId: string;
  path: string;
  clientHost?: string;
}

export interface SidecarMcpBinding {
  server: string;
  url: string;
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
  mode?: string;
  branch?: string;
  overrides?: SpawnOverrides;
  selfDestruct?: SelfDestructConfig;
  /** Overrides the spawn-level restrictWrites default for this block. */
  restrictWrites?: boolean;
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

// The PR/MR the snapshot's signals were collected from. `null` covers legacy
// on-disk snapshots (bare array, no PR identity) so callers cannot mistake
// "unknown" for a real number via `=== undefined`.
export interface ReviewSnapshot {
  prNumber: number | null;
  signals: Map<string, ReviewSignal>;
}

// The baseline to diff the next poll's signals against: the stored snapshot's
// signals when it was collected from the same PR/MR, otherwise `undefined` so
// the caller takes the existing first-observation path. A rebind (or a legacy
// snapshot with no recorded PR) must never diff against a different PR's
// signals — `changes_requested`, `ready_for_review`, `approved:<login>`, etc.
// are not PR-unique text, so a stale match would silently suppress the new
// PR's identical-text signal.
export function reviewSnapshotBaseline(
  stored: ReviewSnapshot | undefined,
  prNumber: number,
): Map<string, ReviewSignal> | undefined {
  return stored && stored.prNumber === prNumber ? stored.signals : undefined;
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

export interface SessionModeConfig {
  skill: string;
  default?: boolean;
}

/**
 * Host/global MCP servers suppressed for this project's sessions. Spur's launch
 * plan is authoritative: an excluded server is dropped from the generated agent
 * MCP config, so a project pays no RAM for a globally-configured server it does
 * not use.
 */
export interface ProjectMcpConfig {
  exclude: string[];
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
  reasoningEffort?: AgentReasoningEffortConfig;
  spawn?: ProjectSpawnConfig;
  preflight?: ProjectPreflightConfig;
  branchNaming?: ProjectBranchNamingConfig;
  defaultAgent?: AgentName;
  defaultModels?: Partial<Record<AgentName, string>>;
  workspaceAccess?: WorkspaceAccessConfig;
  modes?: Record<string, SessionModeConfig>;
  sidecars: Record<string, SidecarConfig>;
  mcp?: ProjectMcpConfig;
  sources: Record<string, SourceConfig>;
  backlog: Record<string, BacklogConfig>;
  triggers: Record<string, TriggerConfig>;
  maxLiveSessions?: number;
  staleAfterMinutes?: number;
}

export type ProviderReasoningEffort = "low" | "medium" | "high";
export type AgentReasoningEffortConfig = Partial<
  Record<"claude" | "codex", ProviderReasoningEffort>
>;

export type AdmissionCapSource = "default" | "config" | "derived";

// Instance-only (see config.ts's parseConfigFile): a project spur.yaml's
// `admission` block is ignored before semantic parsing, same footgun as
// rateLimitReactivation/authRotation/tags. All fields are resolved
// (defaults already applied) so callers never re-derive them.
export interface AdmissionConfig {
  enabled: boolean;
  maxLiveSessions: number;
  // Set once at the config boundary (parseAdmission), never re-derived downstream.
  maxLiveSessionsSource: AdmissionCapSource;
  perSessionBytes: number;
  reserveFraction: number;
  memoryGuard: {
    enforce: boolean;
    enforceFloors: boolean;
    shedEnabled: boolean;
    minAvailableBytes: number;
    minFreeSwapBytes: number;
    admissionFloorBytes: number;
    shedCriticalFloorBytes: number;
    restoreFloorBytes: number;
    pressureSomeAvg10Refuse: number;
    shedSwapUsedFraction: number;
  };
}

export interface HeadroomReport {
  cap: {
    global: number;
    source: AdmissionCapSource;
    perSessionBytes: number;
    reserveFraction: number;
  };
  projectCaps: Record<string, number>;
  live: {
    count: number;
    byProject: Record<string, number>;
  };
  projectedRoom: number;
  sessions: Array<{
    id: string;
    project: string;
    status: SessionStatus;
    rssBytes: number;
  }>;
  memory: HostMemory | null;
  guard: {
    enforce: boolean;
    enforceFloors: boolean;
    minAvailableBytes: number;
    minFreeSwapBytes: number;
    admissionFloorBytes: number;
    shedCriticalFloorBytes: number;
    restoreFloorBytes: number;
    pressureSomeAvg10Refuse: number;
    crossed: boolean;
  };
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
  models: {
    codexHome: string;
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
    collapseWindowMs: number;
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
  diskRetention: {
    warnFreeGb: number;
  };
  sessionGc: {
    enabled: boolean;
    olderThanDays: number;
    intervalMinutes: number;
    maxGroupsPerSweep: number;
    statuses: SessionGcStatus[];
  };
  sidecarGc: {
    enabled: boolean;
    idleTtlMinutes: number;
    maxAgeWarnMinutes: number;
  };
  admission: AdmissionConfig;
  staleAfterMinutes: number;
  // Never decide off this snapshot: `readAutoUpdateFlag` in
  // `auto-update-config.ts` re-reads the key from disk, and says why.
  autoUpdate: boolean;
  projects: Record<string, ProjectConfig>;
  tags: TagDefinition[];
}

// The only statuses session GC ever reclaims: a session still `running`,
// `spawning`, `paused`, or `errored` may resume work in its worktree, so GC
// must never treat it as a candidate regardless of age.
export type SessionGcStatus = "completed" | "killed" | "stopped";

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

// View-only shape: `messages` carries only real queued entries (the ones a
// remove/flush control can act on), `pipelineMessages` carries derived future
// pipeline step text separately and is omitted when empty. Kept distinct
// from SessionQueuedMessagesState (the persisted record shape, whitelisted
// to exactly two fields by metadata.ts's normalizeQueuedMessagesState) so a
// pipeline-derived string can never be mistaken for a real queued message at
// the type level.
export interface SessionQueuedMessagesView {
  messages: string[];
  awaitingPrompt: boolean;
  pipelineMessages?: string[];
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

export interface SidecarProcessIdentity {
  /** tmux pane pid at start. On Linux this is also the pane's pgid and sid. */
  pid: number;
  /** Process group id of the pane at start. Signal target for a leaked tree. */
  pgid: number;
  /**
   * /proc/<pid>/stat field 22 (starttime, clock ticks since boot). The only
   * pid-reuse guard: a wall-clock timestamp cannot distinguish a reused pid.
   */
  starttime: number;
}

export interface SessionRecord {
  id: string;
  project: string;
  // The id of the workspace (shared git worktree) this session lives in.
  // Equals the session's own id for a session that does not share a
  // workspace; otherwise the id of the session whose workspace it joined
  // (desk sibling, handoff). Written once at session creation, and filled in
  // for every record by normalizeSessionRecord on write.
  //
  // Optional because this is the on-disk shape and a record written before
  // this field existed genuinely lacks it. Never read it directly — go
  // through `workspaceIdOf` in session-desk.ts, the one accessor that
  // resolves the legacy shapes.
  workspaceId?: string;
  // Legacy input field: the pre-workspaceId name for the same fact. Read
  // for back-compat by normalizeSessionRecord/workspaceIdOf; no longer
  // written by any code path.
  deskId?: string;
  agent: AgentName;
  model?: string;
  mode?: string;
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
  stopReason?: "manual_pause" | "stale_timeout";
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  retainInList?: boolean;
  slots?: SessionSlots;
  selfDestruct?: SelfDestructConfig;
  sidecarNames?: string[];
  // Sidecar names that were tmux-alive at park time (stale_timeout), replayed
  // on wake by finishStaleWake. Absent once the session has woken.
  staleSidecars?: string[];
  sidecarPorts?: Record<string, Record<string, number>>;
  /**
   * Pane identity of each sidecar's CURRENT instance, keyed by sidecar name.
   * Written on the sidecar OWNER's record (the workspace anchor for a
   * desk-shared sidecar, the session itself for an mcp sidecar).
   */
  sidecarProcs?: Record<string, SidecarProcessIdentity>;
  pipeline?: SessionPipelineState;
  queuedMessages?: SessionQueuedMessagesState;
  scheduledWake?: SessionScheduledWakeState;
  intervalWake?: SessionIntervalWakeState;
  dailyWake?: SessionDailyWakeState;
  rateLimitedAt?: string;
  serverErrorAt?: string;
  stateSubscriptions?: SessionStateSubscription[];
  error?: string;
  /** Presence distinguishes initialized ledgers from pre-ToDo records. */
  todoLedgerVersion?: 1;
}

// Terminal-for-lifecycle predicate. Gates ~16 session-service.ts call sites
// and reap.ts's sidecar-claims sweep — one definition, never two copies.
export function isTerminalSessionStatus(
  status: SessionRecord["status"],
): status is "completed" | "killed" {
  return status === "completed" || status === "killed";
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

// A desk-shared (non-mcp) project sidecar's `tmuxSession` is
// `${anchorId}--${name}`; a per-session (mcp) sidecar's is
// `${sessionId}--${name}` — this is the sole source of the pane name outside
// the daemon (web terminal attach, CLI `spur sidecar` commands).
export interface SessionSidecarView {
  name: string;
  alive: boolean;
  ports: SidecarPortView[];
  tmuxSession: string;
  /** Elapsed seconds since the recorded identity's process start; omitted when unresolvable. */
  ageSeconds?: number;
  /** True once ageSeconds has reached sidecarGc.maxAgeWarnMinutes; omitted (falsy) otherwise. */
  ageWarn?: boolean;
}

export interface SessionView extends Omit<SessionRecord, "queuedMessages"> {
  runtimeAlive: boolean;
  workspaceExists: boolean;
  state: SessionState;
  stateHistory?: SessionStateTransition[];
  hasUnseenAttention?: boolean;
  lastActivityAt: string;
  artifacts: SessionArtifact[];
  /** True only when a nested-artifact budget cut the walk short; omitted otherwise. */
  artifactsTruncated?: boolean;
  services: ServiceInstanceView[];
  sidecars: SessionSidecarView[];
  workspaceAccess?: SessionWorkspaceAccess;
  deskGroupMembers?: SessionDeskMember[];
  claudeAccounts?: { id: string; label?: string; authenticated: boolean }[];
  activeClaudeAccountId?: string;
  queuedMessages?: SessionQueuedMessagesView;
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
  mode?: string;
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
  // Claude account whose CLAUDE_CONFIG_DIR the launch binds to. Carried across
  // respawn so a rotated session relaunches onto its current account instead of
  // falling back to the (still-rate-limited) default.
  claudeAccountId?: string;
  subscriptions?: SubscribeSessionStatesRequest[];
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

export type TodoActor =
  | { kind: "agent"; agent: AgentName; sessionId: string }
  | { kind: "human"; origin: "cli" | "ui" }
  | { kind: "system"; source: "spawn" | "legacy_migration" | "handoff" };

export type TodoBlocker = { kind: "external" } | { kind: "human"; requiredAction: string };

interface TodoEventBase {
  version: 1;
  eventId: string;
  sessionId: string;
  at: string;
  actor: TodoActor;
}

export type TodoEvent =
  | (TodoEventBase & {
      type: "item_added";
      itemId: string;
      text: string;
      reason: string;
    })
  | (TodoEventBase & {
      type: "item_completed" | "item_cancelled";
      itemId: string;
      reason: string;
    })
  | (TodoEventBase & {
      type: "item_held";
      itemId: string;
      reason: string;
      blocker: TodoBlocker;
    })
  | (TodoEventBase & {
      type: "item_resumed";
      itemId: string;
    })
  | (TodoEventBase & {
      type: "finish_override_recorded";
      reason: string;
      unfinishedItemIds: string[];
    });

export interface TodoItemProjection {
  id: string;
  text: string;
  status: "open" | "held" | "completed" | "cancelled";
  added: { reason: string; actor: TodoActor; at: string };
  latestTransition?: {
    type: "completed" | "cancelled" | "held" | "resumed";
    reason?: string;
    blocker?: TodoBlocker;
    actor: TodoActor;
    at: string;
  };
  history: TodoEvent[];
}

export interface TodoProjection {
  revision: string;
  status: "active" | "held" | "resolved";
  counts: {
    total: number;
    open: number;
    held: number;
    completed: number;
    cancelled: number;
  };
  items: TodoItemProjection[];
  finishOverrides: TodoEvent[];
}

export type TodoMutationRequest =
  | { action: "add"; text: string; reason: string }
  | { action: "complete"; itemId: string; reason: string }
  | { action: "cancel"; itemId: string; reason: string }
  | {
      action: "hold";
      itemId: string;
      reason: string;
      blocker: "external" | "human";
      requiredHumanAction?: string;
    }
  | { action: "resume"; itemId: string };

export interface KillSessionRequest {
  force?: boolean;
  prAction?: OpenPrAction;
  skipPrCheck?: boolean;
}

// `force`: bypass the P2 (env-rooted) duplicate-agent launch guard — see
// assertNoForeignAgentForSession in session-service.ts. Never bypasses the P1
// (pane-rooted) survivor check; a pid that survives SIGKILL always refuses.
export interface RestoreSessionRequest {
  force?: boolean;
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
  modes?: Record<string, SessionModeConfig>;
}

// What a spawn would resolve to for this project+agent if the request named
// neither field. Lets a client preselect a concrete option instead of a
// "server decides" sentinel; `model` is null when the agent has no configured
// or built-in default.
export interface SpawnDefaultsResponse {
  model: string | null;
  worktree: boolean;
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
  | {
      kind: "tool";
      name: string;
      callId?: string;
      inputSummary?: string;
      output?: string;
      timestampMs?: number;
    }
  | { kind: "reasoning"; text: string; timestampMs?: number }
  | {
      kind: "question";
      header: string;
      prompt: string;
      options?: { label: string; index: number }[];
      multiSelect?: boolean;
      timestampMs?: number;
    };

export interface ConversationResponse {
  messages: ConversationMessage[];
  entries: TranscriptEntry[];
  durationMs: number;
  state: SessionState;
  /** Absolute index of `entries[0]` within the full transcript. */
  startIndex: number;
  /** Total number of entries in the full transcript. */
  totalEntries: number;
  /** True when there are older entries before `startIndex` (startIndex > 0). */
  hasMore?: boolean;
}
