import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentBusyQueuedSendAwaitsPrompt,
  agentProcessMatchers,
  agentQueuedSendPromptGraceMs,
  agentSessionConfig,
  agentStateStrategy,
  agentSubmitAckMaxResends,
  agentSubmitAckWindowMs,
  agentWaitsForSubmitAck,
  buildAgentLaunchPlan,
  buildAgentRestorePlan,
  buildAgentResumePlan,
  createAgentSubmitAckBinding,
  findAgentSessionId,
  parseAgentName,
  readAgentConversation,
  setupAgentHooks,
  type SubmitAckBinding,
  type SubmitAckScanResult,
} from "./agents/index.js";
import { shellEscape } from "./agents/shell-escape.js";
import { BUILTIN_SIDECARS } from "./sidecars/builtins.js";
import {
  collectMcpBindings,
  manualSidecarNames,
  resolveSessionSidecars,
} from "./sidecars/index.js";
import {
  assembleSidecarSweepClaims,
  collectTree,
  confirmReaps,
  reapRecordedIdentity,
  reapSidecarPane,
  readProcessStarttime,
  signalSidecarPane,
  snapshotProcesses,
  sweepSidecars,
  type PendingReap,
  type ProcSnapshot,
  type ReapOutcome,
  type SidecarSweepResult,
} from "./sidecars/reap.js";
import {
  planSidecarReap,
  resolveSidecarIdleTtlMinutes,
  type SidecarReapCandidate,
  type SidecarReapPlan,
} from "./sidecars/policy.js";
import {
  deleteAgentHookState,
  readAgentHookState,
  type AgentHookStateRecord,
} from "./agent-hook-state.js";
import {
  assertBranchNameMatches,
  matchesBranchNaming,
  normalizeBranchName,
} from "./branch-name.js";
import {
  findLatestSessionFile as findLatestClaudeSessionFile,
  claudeCommand,
  DEFAULT_CLAUDE_MODEL,
} from "./agents/claude.js";
import { extractGithubErrorText, isGitHubRateLimitError, runGhPollCycle } from "./gh.js";
import {
  codexHookHomePath,
  findLatestCodexSessionFile,
  readCodexRolloutState,
  type CodexRolloutReaderState,
  type CodexRolloutStateRecord,
} from "./agents/codex.js";
import { DEFAULT_CURSOR_MODEL, cursorConfigDirForSession } from "./agents/cursor.js";
import { resolveCursorLaunchModel } from "./agents/models.js";
import {
  claudeUsageMenuOptionOneSelected,
  detectClaudeCompacting,
  detectClaudeUsageLimitMenu,
  detectCodexMcpPermissionDialog,
  scanTmuxRateLimit,
  type RateLimitDetection,
} from "./rate-limit-detect.js";
import { loadProjectSuggestions, loadSessionSuggestions } from "./agent-suggestions.js";
import {
  readClaudeConversation,
  readClaudeJsonlState,
  type ClaudeJsonlReaderState,
} from "./claude-jsonl-state.js";
import { readClaudeSessionStatus } from "./claude-session-status.js";
import {
  addAccount,
  ensureDefaultAccount,
  findAccount,
  isAccountAuthenticated,
  isAccountReady,
  listAccounts,
  removeAccount,
  seedSessionHome,
  sessionClaudeHome,
  swapSessionCredentials,
  touchAccountUsed,
  type ClaudeAccount,
} from "./claude-accounts.js";
import {
  buildSidecarLinkUrl,
  deriveProjectIdFromDisplayName,
  expandHome,
  findProjectConfigPathInDirectory,
  loadProjectConfig,
  PROJECT_ID_PATTERN,
} from "./config.js";
import {
  buildShepherdProject,
  ensureShepherdWorkspace,
  SHEPHERD_PROJECT_ID,
  SHEPHERD_PROJECT_NAME,
} from "./shepherd.js";
import { renderBootstrapPrompt } from "./bootstrap-prompt.js";
import {
  extractBareUserTask,
  renderHandoffPrompt,
  wrapShepherdSpawnPrompt,
} from "./handoff-prompt.js";
import { buildHandoffScreenshotAttachment } from "./handoff-screenshot.js";
import {
  logSpurEvent,
  logUserInputEvent,
  type SpurLogEntry,
  type UserInputKind,
} from "./event-log.js";
import { deleteSessionUserActions } from "./user-action-log.js";
import { reserveNextSessionId } from "./ids.js";
import {
  NPM_GLOBALCONFIG_ENV,
  NPM_GLOBALCONFIG_ENV_LOWER,
  npmPinConfigPath,
} from "./npm-prefix.js";
import { clearPortListener, hasEstablishedConnections, isHostPortFree } from "./port-probe.js";
import { sendDesktopNotification } from "./desktop-notify.js";
import {
  closeTelegramTopic,
  editTelegramTopic,
  sendTelegramReply,
} from "./telegram-source-state.js";
import {
  requestGitHubMergeConflictRestoreReplay,
  deleteRuntimeLogCursorsForSession,
  deleteServiceInstance,
  deleteServiceInstancesForSession,
  deleteServiceSourceStatesForService,
  deleteServiceSourceStatesForSession,
  deleteTelegramSourceStateForSession,
  listActiveServiceProblems,
  readAvailableBacklogItems,
  listServiceInstances,
  listServiceInstancesForSession,
  listSessions,
  readTelegramBindings,
  readServiceInstance,
  readSession,
  readTelegramReplyTarget,
  writeTelegramBindings,
  writeTelegramReplyTarget,
  writeServiceInstance,
  writeSession,
} from "./metadata.js";
import {
  PreflightBranchValidationError,
  runSpawnPreflight,
  type SpawnPreflightResult,
} from "./preflight.js";
import { PREFLIGHT_DEFER_SENTINEL } from "./preflight-contract.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";
import { PIPELINE_STEP_TIMEOUT_MS, formatPipelineStepMessage } from "./pipeline.js";
import {
  captureTmuxPane,
  createTmuxCommandSession,
  createTmuxSidecarSession,
  createTmuxSession,
  sidecarTmuxAlive,
  sidecarTmuxSession,
  getFleetSessionRssBytes,
  getTmuxSessionActivity,
  getTmuxPanePid,
  isProcessRunningInTmux,
  killTmuxSession,
  killTmuxSessionTree,
  listTmuxSessionNames,
  sendSubmitKeyToTmux,
  sendMenuSelectionKeys,
  setTmuxSocketName,
  sendMessageToTmux,
  tmuxPaneDead,
  tmuxSessionExists,
  waitForTmuxReady,
} from "./runtime-tmux.js";
import {
  isSystemdOomdPresent,
  readCgroupMemorySnapshot,
  readCgroupPressure,
  readHostMemory,
  type CgroupMemorySnapshot,
  type HostMemory,
} from "./host-memory.js";
import {
  AGENT_STATE_TOOL_NAME,
  SLOT_TOOL_NAME,
  applySlotsUpdate,
  ensureSessionSlotTool,
  normalizeSlotLinks,
  normalizeSlotsUpdate,
  removeSessionSlotTool,
  withSessionSlotInstructions,
} from "./session-slots.js";
import {
  deleteSessionArtifactsExcept,
  deleteSessionArtifactsDir,
  ensureSessionArtifactsDir,
  isImageArtifactPath,
  listSessionArtifacts,
  readSessionArtifact,
  setSessionArtifactOrigin,
  setSessionArtifactUserAdded,
  type SessionArtifactFile,
  withSessionArtifactInstructions,
} from "./session-artifacts.js";
import { sidecarOwnerId, workspaceIdOf } from "./session-desk.js";
import {
  createGcDeps,
  executeSessionGc,
  planSessionGc,
  resolveSessionCleanupContext,
  type SessionCleanupContext,
} from "./session-gc.js";
import {
  deleteWorkspaceState,
  resolveWorkspaceState,
  writeWorkspaceState,
  type WorkspaceState,
} from "./workspace-store.js";
import { normalizeSelfDestructConfig, withSelfDestructInstructions } from "./self-destruct.js";
import {
  getSessionMemoryRecord,
  listSessionMemoryRecords,
  resolveSessionMemoryRecord,
  setSessionMemoryRecord,
  validateSessionMemoryKey,
  validateSessionMemorySessionId,
} from "./session-memory.js";
import {
  assertValidSharedMemoryScope,
  getSharedMemory as getSharedMemoryEntry,
  listSharedMemoryKeys,
  removeSharedMemory as removeSharedMemoryEntry,
  setSharedMemory as setSharedMemoryEntry,
  validateSharedMemoryKey,
  withSharedMemoryInstructions,
} from "./shared-memory.js";
import {
  closeSessionPr,
  deriveSessionSlots,
  parseSessionPrBinding,
  prLookupBindingOf,
  resolvePrDiscoveryBranch,
  resolveSessionPrBinding,
  viewSessionPrState,
} from "./session-pr.js";
import {
  type PrLookupOutcome,
  cancelPendingPrLookups,
  claimPollPrLookup,
  enqueuePrLookup,
  flushPrLookups,
  resolvePrLookupRepo,
} from "./pr-lookup.js";
import {
  PR_LOOKUP_IDLE_CAP_MS,
  PR_LOOKUP_LIVE_CAP_MS,
  type PrRepoSlug,
  isPrLookupDue,
  readPrLookupEntry,
} from "./pr-lookup-cache.js";
import {
  addUnconfiguredProject,
  buildMergedConfig,
  ConfigRegistryScanner,
  mutateConfigRegistry,
  readConfigRegistryFile,
  removeUnconfiguredProject,
  upsertConfigRegistryPath,
  type RegistryScanResult,
  type UnconfiguredProjectEntry,
} from "./registry.js";
import { normalizeDailyWakeTimes, resolveNextDailyWakeAt } from "./wake-schedule.js";
import {
  SPUR_DAEMON_API_VERSION,
  SESSION_STATES,
  isTerminalSessionStatus,
  type AdmissionCapSource,
  type AgentName,
  type ProviderReasoningEffort,
  type AgentSuggestionsResponse,
  type AppConfig,
  type AvailableBacklogItem,
  type BranchExistsResponse,
  type BranchSource,
  type CompleteDeskResponse,
  type CompleteSessionRequest,
  type ConversationMessage,
  type ConversationResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DashboardSessionView,
  type DeleteProjectResponse,
  type KillSessionRequest,
  type GithubPrCheckUnavailablePayload,
  type HeadroomReport,
  type OpenPrAction,
  type OpenPrActionRequiredPayload,
  type SessionNotRestorablePayload,
  type SessionPrBinding,
  type ProjectListEntry,
  type PreflightRequest,
  type PreflightResponse,
  type ProjectBranchNamingConfig,
  type ProjectConfig,
  type HandoffSessionRequest,
  type RespawnSessionRequest,
  type RunServiceRequest,
  type ScheduleSessionWakeRequest,
  type RuntimeInfo,
  type ServiceInstanceRecord,
  type ServiceInstanceView,
  type SelfDestructConfig,
  type SendMessageAttachment,
  type SendMessageRequest,
  type SidecarConfig,
  type SidecarMcpBinding,
  type SidecarPortConfig,
  type SidecarPortConflictCandidate,
  type SidecarPortConflictPayload,
  type SidecarProcessIdentity,
  type SourceReplyRequest,
  type SourceReplyResponse,
  type SidecarPortView,
  type SessionSidecarView,
  type SessionMemoryListResponse,
  type SessionMemoryRecordResponse,
  type SharedMemoryEntryResponse,
  type SharedMemoryListResponse,
  type SharedMemoryRemoveResponse,
  type SharedMemoryScope,
  type StartSidecarRequest,
  type SessionRecord,
  type SessionSlots,
  type SessionStatus,
  type SessionQueuedMessagesState,
  type SessionState,
  type SessionStateSubscription,
  type SessionStateSubscriptionListResponse,
  type SessionStateSubscriptionRecordResponse,
  type SessionDeskMember,
  type SessionView,
  type SessionListView,
  type SessionStateTransition,
  type SubscribeSessionStatesRequest,
  type SessionWorkspaceAccess,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  type SpawnOverrides,
  type SpawnSessionRequest,
  type StateSource,
  type TagDefinition,
  type TranscriptEntry,
  type UpdateSessionSlotsRequest,
} from "./types.js";
import { readCursorJsonlState, type CursorJsonlReaderState } from "./cursor-jsonl-state.js";
import {
  formatNestedSidecarStartError,
  MAX_SIDECAR_DEPTH,
  nextSidecarDepth,
  ROOT_SIDECAR_DEPTH,
  sidecarCallerContextFromRequest,
  SPUR_SIDECAR_DEPTH_ENV,
  SPUR_SIDECAR_NAME_ENV,
} from "./sidecar-runtime.js";
import {
  branchRefsExist,
  branchStatus,
  createWorktree,
  findWorktreePathForBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  isGitWorktree,
  readCurrentBranch,
  removeWorktree,
  workspaceExists,
  probeWorkspace,
  worktreePathFor,
} from "./workspace.js";
import { orderedReviewProviderIds, reviewProvider } from "./review-providers/index.js";
import { getVersion } from "./version.js";

const KILL_CONFIRMATION_REQUIRED_PREFIX = "Kill confirmation required";
const RATE_LIMIT_REACTIVATION_PROMPT =
  "You were rate limited earlier and should be able to continue now. Please resume the task you were working on and pick up from where you left off.";
const CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT =
  "Claude hit a temporary server error earlier. Please try to continue the task now.";
const CLAUDE_SERVER_ERROR_REACTIVATION_MS = 30 * 60 * 1000;
const PIPELINE_POLL_INTERVAL_MS = 1_000;
const SCHEDULED_WAKE_POLL_INTERVAL_MS = 1_000;
const SIDECAR_REAPER_INTERVAL_MS = 60_000;
const MEMORY_SHED_INTERVAL_MS = 1_000;
const MEMORY_SHED_SESSION_GRACE_MS = 12_000;
const MEMORY_SHED_EMERGENCY_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const PIPELINE_STEP_DELAY_MS = 30_000;
const MESSAGE_READY_GRACE_MS = 15_000;
const STATE_HOLD_MS = 4_000;
// Codex turns that hang after their tool calls complete (model inference dies between/after tools)
// pin state to "working" forever. The rollout JSONL emits no deterministic mid-inference liveness
// signal: token_count event_msg lines fire only at response-step (tool-batch) boundaries, never
// incrementally within a single response, so a hung inference produces no new records at all. tmux
// activity is rejected as a corroborating signal because codex's TUI repaints a per-second
// "Working (… • esc to interrupt)" timer, advancing #{window_activity} every second even while the
// turn is genuinely hung — it would mask exactly this bug. Pending tool calls are excluded (a long
// exec_command is legitimately silent), so this threshold only needs to exceed the longest plausible
// single model inference between tool batches (large context + high reasoning, observed ~tens of
// seconds). A false flip is low-cost but not free: the working->waiting edge lets a queued
// interrupt:false message be typed in after a further idle gate, so we set the threshold well above
// any realistic single inference. 300s makes a false flip on a live inference highly unlikely while
// still clearing an indefinite-"working" hang.
const CODEX_HUNG_AFTER_TOOLS_MS = 300_000;
const RESTORE_WARMUP_MS = 30_000;
const RESTORE_SETTLE_MS = 2_000;
const USAGE_LIMIT_MENU_CONFIRM_COOLDOWN_MS = 10_000;
export const IDLE_WAIT_BEFORE_FLUSH_MS = 30_000;

export function getIdleWaitBeforeFlushMs(): number {
  const raw = Number(process.env.SPUR_IDLE_WAIT_BEFORE_FLUSH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : IDLE_WAIT_BEFORE_FLUSH_MS;
}

const NAME_RE = /^[\w.-]+$/;
const MAX_DECODED_SIZE = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const STATE_HISTORY_LIMIT = 100;
const RESTORE_PLAN_WAIT_MS = 5_000;
const RESTORE_PLAN_POLL_MS = 250;
const AGENT_SESSION_ID_INITIAL_WAIT_MS = 5_000;
const AGENT_SESSION_ID_REFRESH_WAIT_MS = 1_500;
const AGENT_SESSION_ID_POLL_INTERVAL_MS = 250;
const SPAWN_RETRY_ATTEMPTS = 3;
const BACKGROUND_SPAWN_READY_TIMEOUT_MS = 120_000;
const ATTENTION_POLL_INTERVAL_MS = 5_000;
const DASHBOARD_CACHE_INTERVAL_MS = 2_000;
// Idle (non-live) dashboard entries can only drift from filesystem state
// (workspaceExists, hasServiceIssues, workspace slots), never from agent
// activity, so they don't need every-tick re-enrichment — a small bounded
// round-robin corrects that drift without making the tick cost scale with
// total record count. Some of that drift (workspaceExists, runtimeAlive)
// gates real controls (Restore/Recover, the terminal button), so the quota
// scales with the idle set instead of staying fixed: a fixed 4/tick sweeps
// ~2 s worth of idle sessions in a couple of ticks at small fleet sizes but
// takes ~13.5 min to sweep 1612 idle sessions, which is long enough for a
// removed worktree to keep offering Restore. quota = ceil(idle / 60),
// clamped to [MIN, MAX]: at 10 idle that's still the MIN floor of 4 (full
// sweep in 3 ticks, ~6 s); at 1612 idle that's 27/tick (full sweep in 60
// ticks, ~2 min); above ~1920 idle the MAX cap of 32 keeps per-tick cost
// bounded at the price of a sweep slower than 2 min.
const DASHBOARD_IDLE_REFRESH_MIN_PER_TICK = 4;
const DASHBOARD_IDLE_REFRESH_MAX_PER_TICK = 32;
// Divisor for the quota formula above: ceil(idle / this) ticks the quota to
// target a full idle-set sweep in roughly this many ticks (60 ticks * the
// 2 s DASHBOARD_CACHE_INTERVAL_MS tick == a ~2 min sweep) before the MIN/MAX
// clamp takes over at the small and large ends of the fleet-size range.
const DASHBOARD_IDLE_REFRESH_SWEEP_TICKS = 60;
// Must outlast the gap between attention-monitor sweeps (ATTENTION_POLL_INTERVAL_MS)
// with buffer for scheduling jitter, so the scanPane:false dashboard tick keeps
// showing the corrected needs_input state between live pane scans instead of
// reverting to rate_limited every cycle.
const CODEX_MCP_DIALOG_OVERRIDE_TTL_MS = 15_000;
// Same outlast-the-sweep-gap reasoning as CODEX_MCP_DIALOG_OVERRIDE_TTL_MS,
// for the claude compaction spinner override.
const CLAUDE_COMPACTING_OVERRIDE_TTL_MS = 15_000;
const REAP_INTERVAL_MS = 5 * 60 * 1000;
// Fixed tick cadence for the session GC sweep; the actual sweep frequency is
// gated inside the tick by sessionGc.intervalMinutes (re-read from
// this.config on every tick, so a config-only reload takes effect without a
// daemon restart).
const SESSION_GC_TICK_MS = 5 * 60_000;
// isTerminalSessionStatus deliberately excludes "stopped" (used to gate live
// polling loops that must keep tracking a stopped-but-not-yet-reconciled
// session). The reaper needs the full set of statuses that mean "this
// session's runtime is not supposed to exist anymore".
const REAPABLE_SESSION_STATUSES = new Set<SessionStatus>(["killed", "completed", "stopped"]);
const PR_CHECK_THROTTLE_MS = 30_000;
// A session that is not running cannot open a PR by itself, but a user still
// can, by hand, long after the agent stopped. So the cadence drops instead of
// stopping: worst case such a PR binds within this throttle plus the lookup
// backoff cap. isTerminalSessionStatus is deliberately not widened for this —
// 16 other call sites depend on its current meaning.
const PR_CHECK_IDLE_THROTTLE_MS = 30 * 60_000;
// A session's resolved (branch, repo slug) is remembered this long so a session
// whose lookup is not due yet — and a session flapping between working and
// waiting, which resets the throttle — costs zero git spawns. A branch renamed
// inside the window binds one window late at worst.
const PR_DISCOVERY_MEMO_TTL_MS = 5 * 60_000;
// Total wall clock one sweep may spend resolving branches and slugs from git.
// Bounded because the sweep awaits these spawns in sequence: a cold start has no
// memo for any session, and 400 unbudgeted spawns behind a hung mount would
// stall attention detection for the whole fleet. Sessions past the budget keep
// their throttle untouched and are picked up by the next sweep.
const PR_CHECK_GIT_BUDGET_MS = 2_000;
const WORKTREE_PATH_TOKEN = "$" + "{worktreePath}";
const WORKTREE_PATH_SHELL_TOKEN = "$" + "{worktreePathShell}";
const WORKTREE_PATH_URL_TOKEN = "$" + "{worktreePathUrl}";
const PR_CHECK_WAITING_LIMIT = 5;
const DEFAULT_WAKE_MESSAGE = "Scheduled wake-up. Review current state and continue orchestration.";
const DEFAULT_INTERVAL_WAKE_MESSAGE = "Scheduled interval wake-up. Review current state.";

type MemoryShedTrigger =
  | "available_floor"
  | "cgroup_max_headroom"
  | "cgroup_high"
  | "swap_saturation";
type MemoryShedStage = "none" | "sidecar" | "session" | "emergency";
type MemoryShedTier = "mcp_sidecar" | "user_sidecar" | "session";
type MemoryShedExhaustedEdge =
  | "ram:sidecar"
  | "ram:session"
  | "cgroup-high:sidecar"
  | "cgroup-max:emergency"
  | "swap:sidecar";
type MemoryGuardConfig = AppConfig["admission"]["memoryGuard"];

interface MemoryShedEpisode {
  ramContinuousSinceMs: number | null;
  cgroupHighLatched: boolean;
  cgroupMaxLatched: boolean;
  swapState: "armed" | "active" | "spent";
  exhaustedEdges: Set<MemoryShedExhaustedEdge>;
}

interface MemoryPressureState {
  host: HostMemory | null;
  cgroup: CgroupMemorySnapshot | null;
  activeTriggers: MemoryShedTrigger[];
  stage: MemoryShedStage;
  continuousRamPressureMs: number | null;
  emergencyReasons: Array<"host_available" | "cgroup_max_headroom" | "cgroup_high_no_runway">;
  cgroupMaxHeadroomBytes: number | null;
}

function createMemoryShedEpisode(): MemoryShedEpisode {
  return {
    ramContinuousSinceMs: null,
    cgroupHighLatched: false,
    cgroupMaxLatched: false,
    swapState: "spent",
    exhaustedEdges: new Set(),
  };
}

function memoryShedEmergencyBytes(guard: MemoryGuardConfig): number {
  return Math.min(MEMORY_SHED_EMERGENCY_CAP_BYTES, Math.floor(guard.shedCriticalFloorBytes / 2));
}
const DEFAULT_DAILY_WAKE_MESSAGE = "Scheduled daily wake-up. Review current state.";

interface StoredImageAttachment {
  id: string;
  path: string;
  name: string;
}

interface PrCheckTracker {
  waitingChecks: number;
  lastState: SessionState | null;
  lastCheckAt: number;
  found: boolean;
  /** Last git-resolved discovery target, so the cache can be read spawn-free. */
  discovery?: { branch: string; slug: PrRepoSlug | null; resolvedAt: number };
}

export class SessionResourceNotFoundError extends Error {
  readonly statusCode = 404;
}

export class InvalidClearPortError extends Error {
  readonly statusCode = 400;
}

export class InvalidSessionMemoryInputError extends Error {
  readonly statusCode = 400;
}

export class InvalidSourceReplyInputError extends Error {
  readonly statusCode = 400;
}

export class InvalidSessionSubscriptionInputError extends Error {
  readonly statusCode = 400;
}

export class SidecarPortConflictError extends Error {
  readonly statusCode = 409;
  readonly payload: SidecarPortConflictPayload;

  constructor(sidecarName: string, candidates: SidecarPortConflictCandidate[]) {
    super(
      `Sidecar ${sidecarName} has occupied reserved ports: ${candidates
        .map((candidate) => candidate.port)
        .join(", ")}`,
    );
    this.payload = {
      code: "sidecar_port_busy",
      sidecarName,
      candidates,
    };
  }
}

export class OpenPrActionRequiredError extends Error {
  readonly statusCode = 409;
  readonly payload: OpenPrActionRequiredPayload;

  constructor(sessionId: string, pr: OpenPrActionRequiredPayload["pr"]) {
    super(`Open pull request action required for ${sessionId}`);
    this.payload = {
      code: "open_pr_action_required",
      sessionId,
      pr,
    };
  }
}

export class GithubPrCheckUnavailableError extends Error {
  readonly statusCode = 409;
  readonly payload: GithubPrCheckUnavailablePayload;

  constructor(
    sessionId: string,
    pr: SessionPrBinding | null,
    { rateLimited }: { rateLimited: boolean },
  ) {
    super(`GitHub PR check unavailable for ${sessionId}`);
    this.payload = {
      code: "github_pr_check_unavailable",
      sessionId,
      pr,
      rateLimited,
    };
  }
}

export class SessionNotRestorableError extends Error {
  readonly statusCode = 409;
  readonly payload: SessionNotRestorablePayload;

  constructor(
    sessionId: string,
    reason: string,
    availableActions: SessionNotRestorablePayload["availableActions"],
  ) {
    super(reason);
    this.payload = {
      code: "session_not_restorable",
      sessionId,
      reason,
      availableActions,
    };
  }
}

export class SessionRateLimitedError extends Error {
  readonly statusCode = 409;
}

// Message-only (like SessionRateLimitedError): the candidate session ids to
// stop are named directly in the message string, not a structured payload —
// neither client.ts's formatDaemonError nor the web toast decode a payload
// field, so one here would be written and never read.
export class SessionAdmissionDeniedError extends Error {
  readonly statusCode = 429;
}

export class SessionNotReopenableError extends Error {
  readonly statusCode = 409;
}

export class SubmitAckTimeoutError extends Error {
  readonly agent: AgentName;
  readonly lastScannedFile: string | null;
  readonly elapsedMs: number;
  readonly processAlive: boolean;

  constructor(args: {
    sessionId: string;
    agent: AgentName;
    lastScannedFile: string | null;
    elapsedMs: number;
    processAlive: boolean;
  }) {
    super(`Timed out waiting for agent submit acknowledgment for ${args.sessionId}`);
    this.name = "SubmitAckTimeoutError";
    this.agent = args.agent;
    this.lastScannedFile = args.lastScannedFile;
    this.elapsedMs = args.elapsedMs;
    this.processAlive = args.processAlive;
  }
}

const RESTORE_PROMPT_PREFIX =
  'This session was restored after the agent exited. You are back in the same worktree and branch. Pull the latest main first, then check whether the original task is still needed — another agent may have already done it. If it is already done, run `"$SPUR_SESSION_TOOL_DIR/spur-self-destruct"` and close this session\'s pull request if it duplicates that work; if it is not a duplicate but only extends or overlaps work already merged, trim this PR down to the remaining necessary changes. Otherwise continue the original task. Original task:';
const PLAN_MODE_PROMPT_SUFFIX =
  "Plan mode: do not write or modify code. Only plan the task and describe the intended implementation.";
const RESTRICT_WRITES_PROMPT_SUFFIX =
  "Restricted writes mode: do not modify, create, or delete files in the workspace. You may still post GitHub PR review comments via `gh` and call any MCP tool. Use these to communicate review feedback.";
type ManualSessionStatus = "stopped" | "completed";
type AttentionState = "needs_input" | "error" | "rate_limited";
type BackgroundSpawnAttemptResult = "completed" | "retry";
const SPAWN_PREFLIGHT_MAX_ATTEMPTS = 3;
interface SessionRuntimeSnapshot {
  runtimeAlive: boolean;
  paneUsable: boolean;
  processAlive: boolean;
  tmuxActivityAt: Date | null;
}
interface SessionStateResult {
  session: SessionRecord;
  runtime: SessionRuntimeSnapshot;
  state: SessionState;
  source: StateSource;
  historySourcePath?: string | null;
  workspacePresent: boolean;
  serverError: boolean;
  // When the agent last wrote to its own structured artifact (claude transcript
  // JSONL / codex rollout + hook state / cursor transcript JSONL). Null only
  // when the agent has no such artifact yet. Every value here is a byproduct of
  // reads classification already performed, so it costs no extra I/O.
  agentActivityAt: Date | null;
  liveModel?: string;
}

const SIDECAR_PROBE_BUDGET_ITERATIONS = 180;
const SIDECAR_PROBE_INTERVAL_MS = 1_000;
const SIDECAR_PROBE_REQUEST_TIMEOUT_MS = 2_000;
const SIDECAR_PROBE_LIVENESS_CHECK_INTERVAL = 10;

class SidecarUrlProbeSidecarExitedError extends Error {
  constructor(sidecarName: string) {
    super(`Sidecar "${sidecarName}" exited before URL readiness`);
  }
}

function isRestorableStatus(status: SessionStatus): boolean {
  return status === "running" || status === "stopped" || status === "paused";
}

function hasSessionErrorEvidence(session: Pick<SessionRecord, "error">): boolean {
  return typeof session.error === "string" && session.error.trim().length > 0;
}

function statusFallbackState(session: Pick<SessionRecord, "status" | "error">): SessionState {
  const status = session.status;
  if (status === "killed") return "killed";
  if (status === "errored") return "error";
  if (status === "stopped" && hasSessionErrorEvidence(session)) return "error";
  if (status === "stopped" || status === "paused" || status === "completed") return "stopped";
  return "working"; // running, spawning
}

type PipelineWaitOutcome = "ready" | "stopped" | "exited" | "timeout";

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalSubscriptionStates(states: SessionState[]): SessionState[] {
  const requested = new Set(states);
  return SESSION_STATES.filter((state) => requested.has(state));
}

function stateSubscriptionId(targetSessionId: string): string {
  return `state-${targetSessionId}`;
}

function stateTransitionId(
  targetSessionId: string,
  transition: {
    at: string;
    fromState: SessionState;
    toState: SessionState;
    source: StateSource;
  },
): string {
  return `state-${targetSessionId}-${transition.at}-${transition.fromState}-${transition.toState}-${transition.source}`;
}

function formatStateSubscriptionMessage(args: {
  targetSessionId: string;
  transition: {
    at: string;
    fromState: SessionState;
    toState: SessionState;
    source: StateSource;
  };
  customMessage?: string;
}): string {
  const base = `Session ${args.targetSessionId} changed state: ${args.transition.fromState} -> ${args.transition.toState} at ${args.transition.at} (source: ${args.transition.source}).`;
  return args.customMessage ? `${base}\n\n${args.customMessage}` : base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidSessionMemoryTarget(sessionId: string, key?: string): void {
  try {
    validateSessionMemorySessionId(sessionId);
    if (key !== undefined) {
      validateSessionMemoryKey(key);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidSessionMemoryInputError(message);
  }
}

function assertValidSharedMemoryRequest(
  scope: string,
  key?: string,
): asserts scope is SharedMemoryScope {
  try {
    assertValidSharedMemoryScope(scope);
    if (key !== undefined) {
      validateSharedMemoryKey(key);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidSessionMemoryInputError(message);
  }
}

// task = workspace id (matches listDeskSessions); project = session.project; global = constant.
function resolveSharedMemoryStoreId(session: SessionRecord, scope: SharedMemoryScope): string {
  if (scope === "task") {
    return workspaceIdOf(session);
  }
  if (scope === "project") {
    return session.project;
  }
  return "global";
}

function hasUnseenAttention(
  session: Pick<SessionRecord, "lastOpenedAt">,
  state: SessionState,
  lastActivityAt: string,
): boolean {
  if (state !== "needs_input") {
    return false;
  }
  if (!session.lastOpenedAt) {
    return true;
  }
  const openedMs = Date.parse(session.lastOpenedAt);
  const attentionMs = Date.parse(lastActivityAt);
  return Number.isFinite(openedMs) && Number.isFinite(attentionMs) && openedMs < attentionMs;
}

// The writing session's own id is embedded so desk siblings sharing an
// artifacts dir (session-desk.ts) don't collide on indistinguishable history
// dumps.
function stateTransitionArtifactId(
  sessionId: string,
  at: string,
  fromState: SessionState,
  toState: SessionState,
): string {
  const safeTimestamp = at.replaceAll(":", "-").replaceAll(".", "-");
  return `agent-history-${sessionId}-${safeTimestamp}-${fromState}-to-${toState}.jsonl`;
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Cache stamp for a config file: mtime alone can repeat when two writes land
// inside the filesystem's mtime resolution, so size rides along. Any stat
// failure (unlinked mid-call, EACCES, a flaky network mount) yields no stamp
// rather than throwing — callers on the 2s dashboard tick must not abort a
// whole cycle over one unreadable file.
function tryConfigStamp(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }
}

function normalizeSpawnRequest(
  request: SpawnSessionRequest,
  defaultSteps?: string[],
): {
  prompt: string;
  steps?: string[];
  planMode: boolean;
  restrictWrites: boolean;
  allowedTriggers?: string[];
  selfDestruct?: SelfDestructConfig;
} {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const selfDestruct = normalizeSelfDestructConfig(request.selfDestruct);
  const steps = (prompt ? (request.steps ?? defaultSteps) : undefined)?.map((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`steps[${index}] must be a non-empty string`);
    }
    return step.trim();
  });
  const normalized = {
    prompt,
    planMode: request.planMode === true,
    restrictWrites: request.restrictWrites === true,
    ...(request.allowedTriggers !== undefined ? { allowedTriggers: request.allowedTriggers } : {}),
    ...(selfDestruct !== undefined ? { selfDestruct } : {}),
  };
  if (!prompt) {
    return normalized;
  }
  if (normalized.planMode || !steps || steps.length === 0) {
    return normalized;
  }
  return { ...normalized, steps };
}

function resolvePlanMode(session: Pick<SessionRecord, "planMode">): boolean {
  return session.planMode === true;
}

function resolveRestrictWrites(session: Pick<SessionRecord, "restrictWrites">): boolean {
  return session.restrictWrites === true;
}

async function setupSessionAgentHooks(args: {
  agent: AgentName;
  dataDir: string;
  sessionId: string;
  worktreePath: string;
  sessionToolDir: string;
  restrictWrites: boolean;
  modelsCacheHome: string;
  mcpBindings?: SidecarMcpBinding[];
}) {
  // Account-bound claude sessions read their isolated CLAUDE_CONFIG_DIR's
  // .claude.json instead of the host ~/.claude.json when merging MCP
  // servers below. Default (no bound account, or record not yet
  // written at spawn time) falls back to homedir() inside setup().
  const session = readSession(args.dataDir, args.sessionId);
  const claudeConfigDir = session
    ? resolveClaudeAuthPlanOptions(args.dataDir, session).claudeConfigDir
    : undefined;
  const hookArgs = {
    agent: args.agent,
    worktreePath: args.worktreePath,
    sessionToolDir: args.sessionToolDir,
    ...(args.restrictWrites ? { restrictWrites: true as const } : {}),
    ...(args.mcpBindings?.length ? { mcpBindings: args.mcpBindings } : {}),
    ...(args.agent === "codex" ? { modelsCacheHome: args.modelsCacheHome } : {}),
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
  };
  if (args.agent === "cursor") {
    return setupAgentHooks({
      ...hookArgs,
      cursorConfigDir: cursorConfigDirForSession(args.dataDir, args.sessionId),
    });
  }
  return setupAgentHooks(hookArgs);
}

function buildSessionPrompt(prompt: string, planMode: boolean, restrictWrites = false): string {
  if (!prompt.trim()) {
    return prompt;
  }
  if (planMode) {
    return `${prompt}\n\n${PLAN_MODE_PROMPT_SUFFIX}`;
  }
  if (restrictWrites) {
    return `${prompt}\n\n${RESTRICT_WRITES_PROMPT_SUFFIX}`;
  }
  return prompt;
}

function withAgentModeOptions(
  options: {
    claudeSettingsPath?: string;
    codexHomePath?: string;
    cursorConfigDir?: string;
    codexArgs?: string[];
    reasoningEffort?: ProviderReasoningEffort;
  },
  modes: { planMode: boolean; restrictWrites: boolean },
): {
  claudeSettingsPath?: string;
  codexHomePath?: string;
  cursorConfigDir?: string;
  codexArgs?: string[];
  reasoningEffort?: ProviderReasoningEffort;
  planMode?: boolean;
  restrictWrites?: boolean;
} {
  return {
    ...options,
    ...(modes.planMode ? { planMode: true } : {}),
    ...(modes.restrictWrites ? { restrictWrites: true } : {}),
  };
}

function sessionProcessMatchers(session: Pick<SessionRecord, "agent" | "launchCommand">): string[] {
  return agentProcessMatchers(session.agent, session.launchCommand);
}

function withProjectAgentOptions(
  agent: AgentName,
  project: Pick<ProjectConfig, "codexArgs" | "reasoningEffort">,
  options: {
    claudeSettingsPath?: string;
    claudeMcpConfigPath?: string;
    codexHomePath?: string;
    cursorConfigDir?: string;
  },
): {
  claudeSettingsPath?: string;
  claudeMcpConfigPath?: string;
  codexHomePath?: string;
  cursorConfigDir?: string;
  codexArgs?: string[];
  reasoningEffort?: ProviderReasoningEffort;
} {
  const reasoningEffort = agent === "cursor" ? undefined : project.reasoningEffort?.[agent];
  return {
    ...options,
    ...(project.codexArgs ? { codexArgs: project.codexArgs } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function createRuntimeInfo(config: AppConfig, startedAt: string): RuntimeInfo {
  return {
    ok: true,
    apiVersion: SPUR_DAEMON_API_VERSION,
    version: getVersion(),
    pid: process.pid,
    host: config.server.host,
    port: config.server.port,
    dataDir: config.dataDir,
    worktreeDir: config.worktreeDir,
    configPath: config.configPath,
    tmuxSocketName: config.tmux.socketName,
    uiPort: config.ui.port,
    startedAt,
    tags: config.tags,
  };
}

function latestActivityAt(...timestamps: Array<Date | null>): Date | null {
  let latest: Date | null = null;
  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    if (!latest || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

export function isIdleEnoughToReceive(
  lastActivityAt: string | Date | null,
  idleMs: number,
  now: number = Date.now(),
): boolean {
  if (!lastActivityAt) return true;
  const ts =
    typeof lastActivityAt === "string" ? Date.parse(lastActivityAt) : lastActivityAt.getTime();
  return now - ts >= idleMs;
}

function shouldUseCodexRolloutState(
  hookState: { state: SessionState; updatedAt: string; turnId?: string } | null,
  rolloutState: CodexRolloutStateRecord,
): boolean {
  const sameTurn =
    typeof hookState?.turnId === "string" &&
    typeof rolloutState.turnId === "string" &&
    hookState.turnId === rolloutState.turnId;
  const hookUpdatedAtMs = hookState ? new Date(hookState.updatedAt).getTime() : 0;
  const rolloutNewerThanHook = !hookState || rolloutState.timestampMs >= hookUpdatedAtMs;
  if (rolloutState.state === "working" || rolloutState.state === "needs_input") {
    return sameTurn || rolloutNewerThanHook;
  }
  return !hookState || sameTurn || hookState.state === "needs_input";
}

function codexToolExecuting(hookState: AgentHookStateRecord | null): boolean {
  // A dangling/pending rollout function_call alone is NOT proof a tool is running:
  // the rollout records the call line before the tool returns, and a turn can stall
  // there indefinitely. The deterministic "tool currently running" signal is the
  // PreToolUse hook, which codex registers and which stays PreToolUse until the tool
  // returns (PostToolUse). This protects genuine long-running exec_commands while
  // letting a stale dangling function_call under a non-PreToolUse hook age out.
  return hookState?.hookEvent === "PreToolUse";
}

function isFresh(timestamp: Date, thresholdMs: number): boolean {
  return Date.now() - timestamp.getTime() <= thresholdMs;
}

function buildInitialMessage(
  initialMessage: string,
  sidecarNames: string[],
  tags: TagDefinition[],
  branchNamingRegex?: string,
  selfDestruct?: SelfDestructConfig,
): string {
  if (!initialMessage.trim()) return "";
  let base = withSelfDestructInstructions(
    withSharedMemoryInstructions(
      withSessionArtifactInstructions(withSessionSlotInstructions(initialMessage, tags)),
    ),
    selfDestruct,
  );
  if (branchNamingRegex) {
    base = `${base}\n\nBranch naming:\n- Current project requires branch names to match \`${branchNamingRegex}\`.\n- Use \`spur-branch create <name>\` or \`spur-branch rename <name>\`; it rejects invalid names. \`git push\` is blocked when the current branch does not match.`;
  }
  if (sidecarNames.length === 0) return base;
  const names = sidecarNames.map((n) => `\`${n}\``).join(", ");
  return `${base}\n\nSidecars: use Sidecar for testing by default. Run \`"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>\` to start one, or \`"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>\` to stop one. Do not start app, dev server, or test helper processes directly with \`pnpm\`, \`next\`, or similar commands unless the user explicitly tells you to bypass Sidecar. Auto-start applies only when the main session spawns. From inside a sidecar, nested sidecars are manual-only and stop after one more level. See \`docs/commands.md\` for sidecar usage. Available: ${names}.`;
}

function buildAttachmentReferenceLines(attachmentIds: string[]): string[] {
  return attachmentIds.map(
    (attachmentId) => `[Attached file: $SPUR_SESSION_ARTIFACTS_DIR/${attachmentId}]`,
  );
}

function baseAttachmentName(artifactId: string): string {
  const match = artifactId.match(/^\d+(?:-\d+)?-(.+)$/);
  return match?.[1] ?? artifactId;
}

function pipelineDelayRemainingMs(nextStepNotBefore: string | undefined): number {
  if (!nextStepNotBefore) {
    return 0;
  }
  const timestamp = Date.parse(nextStepNotBefore);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  return Math.max(0, timestamp - Date.now());
}

function queuedMessages(session: SessionRecord): string[] {
  return session.queuedMessages?.messages ?? [];
}

function hasQueuedMessages(session: SessionRecord): boolean {
  return queuedMessages(session).length > 0;
}

function queuedPipelineMessages(session: Pick<SessionRecord, "prompt" | "pipeline">): string[] {
  const pipeline = session.pipeline;
  if (!pipeline || pipeline.status !== "running") {
    return [];
  }
  return pipeline.steps
    .slice(pipeline.nextStepIndex)
    .map((step, offset) =>
      formatPipelineStepMessage(
        session.prompt,
        step,
        pipeline.nextStepIndex + offset,
        pipeline.steps.length,
      ),
    );
}

function displayQueuedMessages(session: SessionRecord): SessionQueuedMessagesState | undefined {
  const messages = [...queuedMessages(session), ...queuedPipelineMessages(session)];
  const awaitingPrompt = session.queuedMessages?.awaitingPrompt ?? false;
  if (messages.length === 0 && !awaitingPrompt) {
    return undefined;
  }
  return { messages, awaitingPrompt };
}

function withQueuedMessages(
  session: SessionRecord,
  messages: string[],
  awaitingPrompt = session.queuedMessages?.awaitingPrompt ?? false,
): SessionRecord {
  if (messages.length === 0 && !awaitingPrompt) {
    const next = { ...session };
    delete next.queuedMessages;
    return next;
  }
  return {
    ...session,
    queuedMessages: {
      messages,
      awaitingPrompt,
    },
  };
}

// Resolve the CLAUDE_CONFIG_DIR for a claude session from the runtime account
// store. When an account is bound, seeds the per-session claude home under
// session-tools/<id>/claude-home and returns it as claudeConfigDir. Session
// homes isolate credential writeback from the source account directory.
// Returns {} when no account is bound or the account no longer exists.
export function resolveClaudeAuthPlanOptions(
  dataDir: string,
  session: Pick<SessionRecord, "agent" | "claudeAccountId" | "id">,
): { claudeConfigDir?: string } {
  if (session.agent !== "claude" || !session.claudeAccountId) {
    return {};
  }
  const account = findAccount(dataDir, session.claudeAccountId);
  if (!account) {
    return {};
  }
  const sessionToolDir = join(dataDir, "session-tools", session.id);
  const sessionHome = sessionClaudeHome(sessionToolDir);
  seedSessionHome(sessionHome, account);
  return { claudeConfigDir: sessionHome };
}

export function isRestorableSession(
  session: Pick<SessionView, "status" | "state" | "workspaceExists">,
): boolean {
  return (
    ((isRestorableStatus(session.status) &&
      (session.state === "stopped" || session.state === "error")) ||
      (session.status === "errored" && session.state === "error")) &&
    session.workspaceExists
  );
}

export function buildRestorePrompt(
  prompt: string,
  planMode = false,
  restrictWrites = false,
): string {
  return `${RESTORE_PROMPT_PREFIX}\n\n${buildSessionPrompt(prompt, planMode, restrictWrites)}`;
}

function joinReasons(reasons: string[]): string {
  if (reasons.length <= 1) {
    return reasons[0] ?? "";
  }
  if (reasons.length === 2) {
    return `${reasons[0]} and ${reasons[1]}`;
  }
  return `${reasons.slice(0, -1).join(", ")}, and ${reasons.at(-1)}`;
}

export function buildKillConfirmationRequiredMessage(sessionId: string, reasons: string[]): string {
  return `${KILL_CONFIRMATION_REQUIRED_PREFIX} for ${sessionId}: ${joinReasons(reasons)}`;
}

export function isKillConfirmationRequiredMessage(message: string): boolean {
  return message.startsWith(KILL_CONFIRMATION_REQUIRED_PREFIX);
}

function buildSessionEnv(args: {
  agent: SessionRecord["agent"];
  projectId: string;
  sessionId: string;
  // Desk-shared artifacts dir owner — the desk anchor's id, or the session's
  // own id when it is not a desk sibling. Kept separate from `sessionId`
  // (which always stays the session's own id) so `SPUR_SESSION` never
  // silently becomes another session's id.
  artifactsSessionId: string;
  sessionToolDir: string;
  dataDir: string;
  repoPath: string;
  symlinks: string[];
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    SPUR_SESSION: args.sessionId,
    SPUR_PROJECT: args.projectId,
    SPUR_AGENT: args.agent,
    SPUR_SESSION_TOOL_DIR: args.sessionToolDir,
    SPUR_SESSION_ARTIFACTS_DIR: ensureSessionArtifactsDir(args.dataDir, args.artifactsSessionId),
    SPUR_SLOT_COMMAND: join(args.sessionToolDir, SLOT_TOOL_NAME),
    SPUR_AGENT_STATE_COMMAND: join(args.sessionToolDir, AGENT_STATE_TOOL_NAME),
    SPUR_AGENT_STATE_FILE: join(args.dataDir, "session-agent-state", `${args.sessionId}.json`),
    // Real HOME from /etc/passwd, unaffected by sandboxes that remap $HOME to a scratch dir.
    // Sidecars that need `~/.nvm`, `~/.bashrc`, etc. should source "$SPUR_REAL_HOME/..." instead of "$HOME/...".
    SPUR_REAL_HOME: userInfo().homedir,
    PATH: `${args.sessionToolDir}:${process.env["PATH"] ?? ""}`,
    // Pins agent self-update (`npm install -g ...`) to `~/.local` even when
    // `~/.npmrc` has been clobbered down to just a registry `_authToken`
    // line. Points at the Spur-owned globalconfig file (`ensureNpmPinFile` in
    // npm-prefix.ts writes it on every daemon boot) rather than setting
    // npm's plain (non-globalconfig) prefix env var directly:
    // nvm refuses to load whenever it sees that var set (any casing) or a
    // `prefix=`/`globalconfig=` line in `~/.npmrc`, and a session pane that
    // sources `~/.nvm/nvm.sh` (e.g. a sidecar) would hit that guard on every
    // launch. A `*_GLOBALCONFIG` env var is invisible to both of nvm's
    // guards. `buildEnvArgs` (runtime-tmux.ts) merges the daemon's full
    // `process.env` before this pin, and npm lowercases every one of its env
    // keys when resolving a config option — so an inherited lowercase
    // globalconfig key collides with this uppercase one and whichever one
    // iterates last wins (measured). Setting both casings to the identical
    // value removes that ordering dependence. Non-agent panes (sidecars,
    // project services, the Claude OAuth login pane) go through
    // `createTmuxCommandSession`, which strips this pin along with npm's
    // plain prefix var and `PREFIX` so nvm loads there instead — see
    // `NPM_PIN_SANITIZE_ENV_KEYS` (npm-prefix.ts).
    [NPM_GLOBALCONFIG_ENV]: npmPinConfigPath(),
    [NPM_GLOBALCONFIG_ENV_LOWER]: npmPinConfigPath(),
  };
  if (
    args.symlinks.includes("node_modules") &&
    (existsSync(join(args.repoPath, "pnpm-lock.yaml")) ||
      existsSync(join(args.repoPath, "pnpm-workspace.yaml")))
  ) {
    env["npm_config_virtual_store_dir"] = join(args.repoPath, "node_modules/.pnpm");
  }
  return {
    ...env,
    ...(args.extraEnv ?? {}),
  };
}

// Test-only: lets the real-npm regression test exercise the exact env
// buildSessionEnv produces without standing up a full SessionService mock
// harness (all other assertions on it go through the SessionService.spawn/
// restore/send call sites instead, per the rest of this file's tests).
export const _buildSessionEnvForTests = buildSessionEnv;

function sidecarViewPorts(
  session: Pick<SessionRecord, "sidecarPorts">,
  sidecarName: string,
  sidecar?: ProjectConfig["sidecars"][string],
): SidecarPortView[] {
  const entries = Object.entries(session.sidecarPorts?.[sidecarName] ?? {});
  return entries.map(([env, port]) => {
    const id =
      Object.entries(sidecar?.ports ?? {}).find(([, portConfig]) => portConfig.env === env)?.[0] ??
      env;
    return { id, env, port };
  });
}

function sidecarPortEnv(
  session: Pick<SessionRecord, "sidecarPorts">,
  sidecarName: string,
): Record<string, string> {
  const entries = Object.entries(session.sidecarPorts?.[sidecarName] ?? {});
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function withSessionSlots(record: SessionRecord, slots: SessionRecord["slots"]): SessionRecord {
  if (slots) return { ...record, slots };
  const { slots: _drop, ...rest } = record;
  return rest;
}

function githubReplaySourceIds(config: AppConfig, projectId: string): string[] {
  const project = config.projects[projectId];
  if (!project) return [];
  const sourceIds: string[] = [];
  for (const [sourceId, source] of Object.entries(project.sources)) {
    if (source.type !== "github") continue;
    sourceIds.push(sourceId);
  }
  return sourceIds;
}

function requestGitHubMergeConflictRestoreReplays(
  config: AppConfig,
  projectId: string,
  sessionId: string,
): void {
  for (const sourceId of githubReplaySourceIds(config, projectId)) {
    requestGitHubMergeConflictRestoreReplay(config.dataDir, projectId, sourceId, sessionId);
  }
}

function buildSidecarRuntimeEnv(
  sessionEnv: Record<string, string>,
  session: Pick<SessionRecord, "sidecarPorts">,
  sidecarName: string,
  sidecarEnv: Record<string, string> | undefined,
  sidecarDepth: number,
): Record<string, string> {
  return {
    ...sessionEnv,
    ...(sidecarEnv ?? {}),
    [SPUR_SIDECAR_NAME_ENV]: sidecarName,
    [SPUR_SIDECAR_DEPTH_ENV]: String(sidecarDepth),
    ...sidecarPortEnv(session, sidecarName),
  };
}

const SIDECAR_STARTUP_VERIFY_MS = 600;
const SIDECAR_STARTUP_TAIL_LINES = 40;
const ATTENTION_PANE_TAIL_LINES = 15;

async function verifySidecarStartup(sessionId: string, sidecarName: string): Promise<void> {
  const tmuxSession = sidecarTmuxSession(sessionId, sidecarName);
  await sleep(SIDECAR_STARTUP_VERIFY_MS);
  if (!(await tmuxPaneDead(tmuxSession))) return;
  const output = (await captureTmuxPane(tmuxSession, SIDECAR_STARTUP_TAIL_LINES)).trim();
  await killTmuxSession(tmuxSession);
  const detail = output ? `\nLast output:\n${output}` : "";
  throw new Error(`Sidecar "${sidecarName}" exited immediately after launch.${detail}`);
}

// Exported for unit testing. Names come solely from project config, filtered
// to the session's agent (a built-in scoped away from an agent, e.g. cursor,
// is never enumerated) — there is no per-session sidecar override state.
export function sessionSidecarNames(
  session: Pick<SessionRecord, "sidecarNames" | "agent">,
  project?: Pick<ProjectConfig, "sidecars">,
): string[] {
  return session.sidecarNames ?? Object.keys(resolveSessionSidecars(session, project));
}

function buildWorkspaceAccess(
  session: Pick<SessionRecord, "worktreePath">,
  project?: Pick<ProjectConfig, "workspaceAccess">,
  workspaceExistsForSession = true,
): SessionWorkspaceAccess | undefined {
  const worktreePath = session.worktreePath.trim();
  if (!workspaceExistsForSession || !worktreePath || !project?.workspaceAccess) {
    return undefined;
  }

  const items = project.workspaceAccess.items.flatMap((item) => {
    const value = item.value
      .replaceAll(WORKTREE_PATH_TOKEN, worktreePath)
      .replaceAll(WORKTREE_PATH_SHELL_TOKEN, shellEscape(worktreePath))
      .replaceAll(WORKTREE_PATH_URL_TOKEN, encodeURIComponent(worktreePath));

    if (item.kind === "link") {
      try {
        return [{ ...item, value: new URL(value).toString() }];
      } catch {
        return [];
      }
    }

    return [{ ...item, value }];
  });

  return items.length > 0 ? { items } : undefined;
}

// Activity means "the agent did something", so it must be identical whether or
// not a browser has the session open.
//
// The agent's own structured artifact is the only source that satisfies that.
// Both tmux clocks are polluted by merely attaching a terminal, measured on
// tmux 3.4: `#{session_activity}` is a pure client-attach clock (it jumps to
// now on `attach-session` and never moves for pane output), and
// `#{window_activity}` jumps too because attaching resizes the window and the
// agent's TUI repaints on SIGWINCH — genuine pane output triggered by the act
// of opening. A silent (non-TUI) pane shows no window_activity bump on attach,
// which is what pins the cause on the redraw.
//
// So tmux activity is the fallback only, for a session whose agent has not yet
// produced a structured artifact. That matches the standing repo rule: detect
// session state from structured agent sources first, tmux only as a fallback.
// 0 means "no structured artifact": codex reports it when it has neither a
// rollout nor hook state. The claude/cursor readers cannot produce it in
// practice — they return either a real stat mtime or null — so for them this is
// only a floor against a nonsense epoch timestamp. Either way 0 is never a real
// activity time, so it must not pin activity to 1970; let the tmux fallback
// stand instead.
function activityAtFromMs(activityMs: number): Date | null {
  return activityMs > 0 ? new Date(activityMs) : null;
}

// Single source of truth for "when did the agent last do something", shared by
// the dashboard's lastActivityAt and the delivery idle gate so the two can
// never disagree about what counts as activity.
//
// Strictly `??`, never `max(agentActivityAt, tmuxActivityAt)`. A max would let
// the attach-driven tmux bump win again whenever it is newer than the last
// transcript write, which is exactly the bug this resolver exists to fix. The
// accepted cost is that activity lags within a long single tool call, since
// claude only appends at tool boundaries — a stale-looking timestamp next to a
// "working" badge. Nothing treats that staleness as death: the stop/stale
// reconcilers read runtimeAlive/paneUsable/processAlive, never this value.
function resolveAgentActivityAt(
  classified: Pick<SessionStateResult, "runtime" | "agentActivityAt">,
): Date | null {
  return classified.agentActivityAt ?? classified.runtime.tmuxActivityAt;
}

function buildLastActivityAt(
  session: Pick<SessionRecord, "updatedAt">,
  classified: Pick<SessionStateResult, "runtime" | "agentActivityAt">,
): string {
  const updatedAt = new Date(session.updatedAt);
  return (
    latestActivityAt(updatedAt, resolveAgentActivityAt(classified)) ?? updatedAt
  ).toISOString();
}

// A terminating record's sidecarPorts can hold BOTH desk-shared (anchor-
// owned, non-mcp) and per-session (mcp) entries, so a going-terminal write
// must strip per-name, not wholesale: an anchor-owned entry survives while
// another desk member's agent is still running and using it; every mcp entry
// (always per-session) is dropped along with the record it belongs to.
// `project` undefined, or a name no longer present in it, drops that entry
// too — no config to prove it is desk-shared. Returns undefined when nothing
// survives, so callers can `delete` the field outright.
function releasableSidecarPorts(
  session: Pick<SessionRecord, "sidecarPorts">,
  project: Pick<ProjectConfig, "sidecars"> | undefined,
  hasRunningWorkspaceMembers: boolean,
): SessionRecord["sidecarPorts"] {
  if (!session.sidecarPorts || !hasRunningWorkspaceMembers) {
    return undefined;
  }
  const kept = Object.fromEntries(
    Object.entries(session.sidecarPorts).filter(([name]) => {
      const sidecar = project?.sidecars[name];
      return sidecar !== undefined && !sidecar.mcp;
    }),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

async function waitForRestorePlan(
  agent: SessionRecord["agent"],
  worktreePath: string,
  restoreMessage: string,
  options?: {
    claudeSettingsPath?: string;
    codexHomePath?: string;
    cursorConfigDir?: string;
    codexArgs?: string[];
    planMode?: boolean;
    restrictWrites?: boolean;
  },
) {
  const deadline = Date.now() + RESTORE_PLAN_WAIT_MS;
  let plan = await buildAgentRestorePlan(agent, worktreePath, restoreMessage, options);
  while (!plan && Date.now() < deadline) {
    await sleep(RESTORE_PLAN_POLL_MS);
    plan = await buildAgentRestorePlan(agent, worktreePath, restoreMessage, options);
  }
  return plan;
}

function resolveSpawnWorktree(
  project: ProjectConfig,
  overrides: SpawnOverrides | undefined,
): boolean {
  return overrides?.worktree ?? project.worktree;
}

// Spur's built-in default model per agent, applied when neither the request nor
// the project config names one. codex has no Spur default (uses its own).
const SPUR_DEFAULT_MODELS: Partial<Record<AgentName, string>> = {
  claude: DEFAULT_CLAUDE_MODEL,
  cursor: DEFAULT_CURSOR_MODEL,
};

// A model only ever applies to the agent it belongs to. An explicit request
// model wins; otherwise the project defaultModels entry for the resolved agent
// applies, then Spur's built-in default for that agent. The map is keyed by
// agent, so it never bleeds onto another agent.
export function resolveSpawnModel(args: {
  requestModel: string | undefined;
  resolvedAgent: AgentName;
  project: ProjectConfig;
}): string | undefined {
  return (
    args.requestModel ??
    args.project.defaultModels?.[args.resolvedAgent] ??
    SPUR_DEFAULT_MODELS[args.resolvedAgent]
  );
}

async function resolveAgentLaunchModel(
  agent: AgentName,
  model: string | undefined,
): Promise<string | undefined> {
  if (agent !== "cursor") {
    return model;
  }
  return resolveCursorLaunchModel(model);
}

function resolveSpawnDefaultBranch(args: {
  project: ProjectConfig;
  worktree: boolean;
  overrides: SpawnOverrides | undefined;
}): string {
  if (!args.worktree && args.overrides?.defaultBranch !== undefined) {
    throw new Error("defaultBranch override requires worktree=true");
  }
  return args.overrides?.defaultBranch ?? args.project.defaultBranch;
}

function normalizeShepherdSpawnRequest(request: SpawnSessionRequest): SpawnSessionRequest {
  if (request.project !== SHEPHERD_PROJECT_ID) {
    return request;
  }
  return {
    ...request,
    overrides: { ...(request.overrides ?? {}), worktree: false },
  };
}

interface ResolvedSpawnBranch {
  branch: string;
  branchSource?: BranchSource;
}

type SpawnPreflightSelection =
  | {
      outcome: "branch";
      branch: string;
      attempts: number;
    }
  | {
      outcome: "fallback-branch";
      branch: string;
      attempts: number;
      deferReason?: string;
    }
  | {
      outcome: "defer";
      attempts: number;
      deferReason?: string;
      unvalidated?: true;
    };

function spawnPreflightDeferLogMessage(
  preflight: Extract<SpawnPreflightSelection, { outcome: "defer" }>,
): string {
  if (!preflight.deferReason) {
    return "Spawn preflight: agent deferred branch naming (NO_PROJECT_RULES); using default naming";
  }
  if (preflight.attempts < SPAWN_PREFLIGHT_MAX_ATTEMPTS) {
    return `Spawn preflight failed; deferring to default naming: ${preflight.deferReason}`;
  }
  return `Spawn preflight exhausted ${preflight.attempts} attempts; deferring to default naming: ${preflight.deferReason}`;
}

function isFeedbackRetryablePreflightError(message: string): boolean {
  return (
    message.startsWith("preflight branch ") ||
    message.startsWith("Spawn preflight must return exactly one branch name")
  );
}

interface PreparedSpawn {
  request: SpawnSessionRequest;
  project: ProjectConfig;
  agent: SessionRecord["agent"];
  prompt: string;
  steps?: string[];
  planMode: boolean;
  restrictWrites: boolean;
  allowedTriggers?: string[];
  selfDestruct?: SelfDestructConfig;
  worktree: boolean;
  defaultBranch: string;
  sessionId: string;
  resolvedBranch?: ResolvedSpawnBranch;
  reuseWorkspacePath?: string;
  placeholder: SessionRecord;
  sessionToolDir: string;
  startupAttachments: StoredImageAttachment[];
}

function resolveCarriedSpawnModel(
  session: SessionRecord,
  targetAgent: AgentName,
  explicitModel?: string,
): string | undefined {
  return explicitModel ?? (targetAgent === session.agent ? session.model : undefined);
}

export function resolveRespawnRequest(
  session: SessionRecord,
  options?: {
    prompt?: string;
    attachments?: SendMessageAttachment[];
    agent?: AgentName;
    model?: string;
    bootstrap?: boolean;
  },
): SpawnSessionRequest {
  const agent = options?.agent ?? session.agent;
  const model = resolveCarriedSpawnModel(session, agent, options?.model);
  return {
    project: session.project,
    prompt: options?.prompt ?? session.prompt,
    ...(options?.bootstrap ? { bootstrap: true } : {}),
    ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
    agent,
    ...(model !== undefined ? { model } : {}),
    ...(session.claudeAccountId ? { claudeAccountId: session.claudeAccountId } : {}),
    ...(session.planMode !== undefined && { planMode: session.planMode }),
    ...(session.restrictWrites !== undefined && { restrictWrites: session.restrictWrites }),
    ...(session.allowedTriggers !== undefined && { allowedTriggers: session.allowedTriggers }),
    ...(session.pipeline?.steps && { steps: session.pipeline.steps }),
    overrides: { worktree: session.worktree },
    ...(session.worktree &&
    session.branchSource === "explicit" &&
    isTerminalSessionStatus(session.status)
      ? { branch: session.branch }
      : {}),
  };
}

function resolveOriginalTaskPrompt(
  request: Pick<
    SpawnSessionRequest,
    "project" | "prompt" | "originalTaskPrompt" | "bareSpawnMessage"
  >,
  resolvedPrompt: string,
): string {
  return (
    request.originalTaskPrompt ??
    (request.project === SHEPHERD_PROJECT_ID && request.prompt?.trim() && !request.bareSpawnMessage
      ? request.prompt.trim()
      : extractBareUserTask(resolvedPrompt))
  );
}

function resolveHandoffSpawnRequest(
  session: SessionRecord,
  options: {
    prompt: string;
    agent: AgentName;
    model?: string;
    originalTaskPrompt: string;
    attachments?: SendMessageAttachment[];
    pipelineSteps?: string[];
  },
): SpawnSessionRequest {
  return {
    project: session.project,
    prompt: options.prompt,
    agent: options.agent,
    ...(options.model !== undefined ? { model: options.model } : {}),
    reuseWorkspaceSessionId: session.id,
    originalTaskPrompt: options.originalTaskPrompt,
    ...(session.project === SHEPHERD_PROJECT_ID ? { bareSpawnMessage: true } : {}),
    overrides: { worktree: session.worktree },
    ...(session.slots?.links.length ? { slots: { links: session.slots.links } } : {}),
    ...(session.planMode !== undefined && { planMode: session.planMode }),
    ...(session.restrictWrites !== undefined && { restrictWrites: session.restrictWrites }),
    ...(session.allowedTriggers !== undefined && { allowedTriggers: session.allowedTriggers }),
    ...(session.selfDestruct !== undefined && { selfDestruct: session.selfDestruct }),
    ...(options.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options.pipelineSteps?.length ? { steps: options.pipelineSteps } : {}),
  };
}

// An explicit, user-typed branch that already satisfies branchNaming is kept
// verbatim (only trimmed) so strict, case-sensitive schemes like "^[A-Z]+-[0-9]+$"
// survive. Otherwise fall back to slugifying; the later assertBranchNameMatches
// still rejects input that does not match after normalization.
function resolveExplicitBranch(
  requestBranch: string,
  branchNaming: ProjectBranchNamingConfig | undefined,
): string | undefined {
  const trimmed = requestBranch.trim();
  if (branchNaming && matchesBranchNaming(trimmed, branchNaming)) return trimmed;
  return normalizeBranchName(trimmed) || undefined;
}

async function resolveSpawnBranch(args: {
  repoPath: string;
  requestBranch: string | undefined;
  requestBranchSource?: Extract<BranchSource, "explicit" | "preflight">;
  worktree: boolean;
  fallbackBranch: string;
  project: ProjectConfig;
  skipBranchNamingValidation?: boolean;
}): Promise<ResolvedSpawnBranch> {
  const fallback = (): ResolvedSpawnBranch => {
    if (args.skipBranchNamingValidation !== true) {
      assertBranchNameMatches(args.fallbackBranch, args.project.branchNaming, "fallback branch");
    }
    return { branch: args.fallbackBranch };
  };

  // Normalize explicit, user-typed input once up front so the worktree and
  // shared paths agree. Preflight branches are already validated and
  // conflict-checked, so leave them as-is to avoid desyncing those checks.
  const requestedBranch =
    args.requestBranch === undefined
      ? undefined
      : args.requestBranchSource === "preflight"
        ? args.requestBranch.trim()
        : resolveExplicitBranch(args.requestBranch, args.project.branchNaming);

  if (args.worktree) {
    if (requestedBranch) {
      const label = args.requestBranchSource === "preflight" ? "preflight branch" : "branch";
      const skipValidation =
        args.skipBranchNamingValidation === true && args.requestBranchSource === "preflight";
      if (!skipValidation) {
        assertBranchNameMatches(requestedBranch, args.project.branchNaming, label);
      }
      return args.requestBranchSource
        ? { branch: requestedBranch, branchSource: args.requestBranchSource }
        : { branch: requestedBranch };
    }
    return fallback();
  }

  let currentBranch: string;
  try {
    currentBranch = await readCurrentBranch(args.repoPath);
  } catch {
    if (requestedBranch) {
      throw new Error(`branch override requires a git repository at ${args.repoPath}`);
    }
    return fallback();
  }
  if (requestedBranch) {
    assertBranchNameMatches(requestedBranch, args.project.branchNaming, "branch");
  }
  if (requestedBranch && requestedBranch !== currentBranch) {
    throw new Error(
      `branch override requires worktree=true; shared workspace is on branch ${currentBranch}`,
    );
  }
  return { branch: currentBranch, branchSource: "shared_workspace" };
}

async function runSpawnPreflightForSpawn(args: {
  agent: AgentName;
  projectId: string;
  project: ProjectConfig;
  baseBranch: string;
  worktree: boolean;
  prompt: string;
}): Promise<SpawnPreflightSelection> {
  let feedback: string | undefined;
  let lastError: Error | undefined;
  let lastProposedBranch: string | undefined;

  const branchRule = args.project.branchNaming?.regex;
  const ruleHint = branchRule
    ? ` The branch name must match the regular expression ${branchRule}.`
    : "";

  for (let attempt = 1; attempt <= SPAWN_PREFLIGHT_MAX_ATTEMPTS; attempt += 1) {
    let preflight: SpawnPreflightResult;
    try {
      preflight = await runSpawnPreflight({
        agent: args.agent,
        projectId: args.projectId,
        project: args.project,
        baseBranch: args.baseBranch,
        worktree: args.worktree,
        prompt: args.prompt,
        ...(feedback ? { feedback } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      if (error instanceof PreflightBranchValidationError) {
        lastProposedBranch = error.branch;
      }
      if (!isFeedbackRetryablePreflightError(message)) {
        return {
          outcome: "defer",
          attempts: attempt,
          deferReason: message,
        };
      }
      feedback = `${message}.${ruleHint} Return a corrected branch name, or return ${PREFLIGHT_DEFER_SENTINEL} if project rules do not define one.`;
      continue;
    }

    if (!preflight.branch) {
      return { outcome: "defer", attempts: attempt, unvalidated: true };
    }

    const branchConflictPath = await findWorktreePathForBranch(args.project.path, preflight.branch);
    if (!branchConflictPath) {
      return { outcome: "branch", branch: preflight.branch, attempts: attempt };
    }

    lastProposedBranch = preflight.branch;
    const message = `preflight branch "${preflight.branch}" is already checked out in worktree ${branchConflictPath}`;
    lastError = new Error(message);
    feedback = `${message}.${ruleHint} Return a different branch name that is not checked out in another worktree.`;
  }

  const deferReason = lastError instanceof Error ? lastError.message : String(lastError);
  if (lastProposedBranch) {
    return {
      outcome: "fallback-branch",
      branch: lastProposedBranch,
      attempts: SPAWN_PREFLIGHT_MAX_ATTEMPTS,
      deferReason,
    };
  }

  return {
    outcome: "defer",
    attempts: SPAWN_PREFLIGHT_MAX_ATTEMPTS,
    deferReason,
    unvalidated: true,
  };
}

function projectHasService(project: ProjectConfig, serviceId: string): boolean {
  return Object.values(project.sources).some(
    (source) => source.type === "service" && source.service === serviceId,
  );
}

function telegramStatusEmoji(state: string): string {
  if (state === "working") return "🟢";
  if (state === "waiting") return "🟡";
  if (state === "needs_input") return "🔴";
  if (state === "error" || state === "killed" || state === "stopped") return "⚫";
  return "⚪";
}

function telegramTopicName(session: Pick<SessionView, "id" | "agent" | "state">): string {
  return `${telegramStatusEmoji(session.state)} ${session.id} ${session.agent}`;
}

export class SessionService {
  readonly bootstrapConfigPath: string;
  readonly startedAt: string;
  config: AppConfig;
  private registryPaths: string[];
  // Shared by boot and later rescans. Keeps path-local loads hot and bounds
  // registry warnings to one per canonical path for this daemon process.
  private readonly registryScanner = new ConfigRegistryScanner();
  private readonly deliveryRuns = new Map<string, Promise<void>>();
  private readonly attentionStates = new Map<string, AttentionState>();
  private readonly lastObservedRunStates = new Map<string, SessionState>();
  // Last live (scanPane:true) pane-scan confirmation of an active codex MCP
  // permission dialog, keyed by session id, value = expiry epoch ms. Lets the
  // scanPane:false dashboard tick apply the same needs_input demotion without
  // forking a capture-pane (the tick's whole reason for existing).
  private readonly codexMcpDialogOverrides = new Map<string, number>();
  // Same pattern for an active claude compaction spinner. Compaction never
  // reaches the persisted claude status (it stays idle throughout, which the
  // scanPane:false dashboard tick maps to waiting), so without this the tick's
  // own idle re-read would keep refreshing stabilizeState's hold window every
  // DASHBOARD_CACHE_INTERVAL_MS — faster than the live pane scan's cadence —
  // and the working override could never outlast the hold.
  private readonly claudeCompactingOverrides = new Map<string, number>();
  // Dedupes session.state.classified: emit once per classify call only when
  // the raw classified state actually changed since the last classify call
  // for that session (not the message, so a detail-only churn like
  // records=50 -> records=17 stays silent). Swept alongside the other
  // classification-scoped maps in pollAttentionStates.
  private readonly lastClassifiedLogStates = new Map<string, SessionState>();
  private attentionMonitorTimer: NodeJS.Timeout | null = null;
  private attentionMonitorRunning = false;
  private dashboardCache: Map<string, DashboardSessionView> = new Map();
  // Records the exact record object last handed to enrichDashboard for each
  // id. Since listSessions() now returns the SAME object for an unchanged
  // file (see metadata.ts), object-identity inequality against this map is an
  // exact, free "did this session's record change since we last enriched it"
  // check — no re-serialisation, no extra reads.
  private readonly dashboardEnrichedRecords = new Map<string, SessionRecord>();
  // Rotating cursor into the idle (non-live) id array for the bounded
  // round-robin refresh; see DASHBOARD_IDLE_REFRESH_MIN_PER_TICK.
  private dashboardIdleCursor = 0;
  private dashboardCacheTimer: NodeJS.Timeout | null = null;
  private dashboardLoopRunning: boolean = false;
  private dashboardCacheReady: Promise<void> | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private reaperRunning = false;
  private sessionGcTimer: NodeJS.Timeout | null = null;
  private sessionGcRunning = false;
  private backgroundLoopsStarted = false;
  // Construction time, not epoch 0: a daemon restart must not treat "never
  // swept before" as "due immediately" — the first tick after a restart
  // waits out a full intervalMinutes like every other tick.
  private lastSessionGcSweepAt = Date.now();
  private scheduledWakeTimer: NodeJS.Timeout | null = null;
  private scheduledWakeMonitorRunning = false;
  private sidecarReaperTimer: NodeJS.Timeout | null = null;
  private sidecarReaperRunning = false;
  private memoryShedTimer: NodeJS.Timeout | null = null;
  private memoryShedRunning = false;
  private memoryShedEpisode = createMemoryShedEpisode();
  private readonly stateCache = new Map<string, { state: SessionState; classifiedAt: number }>();
  // Local (in-worktree) project config resolved per session. The 2s dashboard
  // tick resolves a project for every session, so without this each tick
  // re-parsed the same YAML for the whole fleet — and re-logged the same parse
  // failure forever. A cache hit costs one statSync and no parse. Keyed by
  // session id, invalidated by config path or stamp change (see
  // tryConfigStamp), pruned against the included id set in runDashboardCacheTick.
  private readonly sessionProjectCache = new Map<
    string,
    { configPath: string; stamp: string; project: ProjectConfig | undefined }
  >();
  private readonly restoreWarmupUntil = new Map<string, number>();
  // Session ids this process is actively spawning. A spawning session tracked
  // here still has its spawn pipeline running (worktree/tools/tmux setup), so
  // its dead runtime is expected and must not be reconciled to stopped.
  private readonly spawnsInFlight = new Set<string>();
  private readonly backgroundSpawnRuns = new Set<Promise<void>>();
  // Every spawn owns one future live-session slot from its synchronous
  // admission check until its spawning record is written. Other admissions
  // count the slot; a handoff passes its existing reservation to its successor.
  private readonly admissionReservations = new Map<symbol, string>();
  // Session ids this process is actively reopening. Guards against two
  // overlapping reopen() calls both passing the completed-status check and
  // racing into restore() for the same tmux session and worktree.
  private readonly reopensInFlight = new Set<string>();
  private readonly claudeJsonlReaders = new Map<string, ClaudeJsonlReaderState>();
  private readonly usageMenuConfirmedAt = new Map<string, number>();
  private readonly cursorJsonlReaders = new Map<string, CursorJsonlReaderState>();
  private readonly codexRolloutReaders = new Map<string, CodexRolloutReaderState>();
  private readonly stateHistory = new Map<string, SessionStateTransition[]>();
  private readonly stateSubscriptionIndex = new Map<string, Set<string>>();
  private stateSubscriptionIndexReady = false;
  private stateSubscriptionDispatchDepth = 0;
  private readonly prCheckTrackers = new Map<string, PrCheckTracker>();
  private readonly prCheckRuns = new Set<Promise<void>>();
  /** Git wall clock spent by the current sweep resolving PR discovery targets. */
  private prCheckGitSpentMs = 0;
  // Auto-rotation bookkeeping: accountId -> epoch ms until which the account is
  // considered rate-limited; sessionId -> per-episode rotation count.
  private readonly claudeAccountRateLimit = new Map<string, number>();
  private readonly claudeRotationEpisode = new Map<string, { episode: string; count: number }>();
  private sidecarPortLock: Promise<void> = Promise.resolve();
  private readonly sidecarUrlProbeControllers = new Map<string, AbortController>();
  // Serializes sendAgentMessage per tmux pane so two trigger batches on one
  // session queue instead of racing two pastes into the same composer.
  private readonly paneWriteLocks = new Map<string, Promise<void>>();

  constructor(
    configPath?: string,
    startedAt = nowIso(),
    options: { deferBackgroundLoops?: boolean } = {},
  ) {
    const bootstrap = buildMergedConfig(configPath ?? process.env["SPUR_CONFIG"], [], {
      skipInvalid: false,
    });
    this.bootstrapConfigPath = bootstrap.config.configPath;
    this.startedAt = startedAt;
    mkdirSync(bootstrap.config.dataDir, { recursive: true });
    mkdirSync(bootstrap.config.worktreeDir, { recursive: true });
    this.registryPaths = upsertConfigRegistryPath(
      bootstrap.config.dataDir,
      bootstrap.config.configPath,
    );
    const scan = this.registryScanner.scan({
      bootstrapConfigPath: this.bootstrapConfigPath,
      configPaths: this.registryPaths,
      protectedPaths: [bootstrap.config.configPath],
    });
    this.emitRegistryScan(bootstrap.config.dataDir, scan);
    this.config = bootstrap.config;
    this.applyConfig(scan.config, scan.configPaths);
    if (!options.deferBackgroundLoops) this.startBackgroundLoops();
  }

  startBackgroundLoops(): void {
    if (this.backgroundLoopsStarted) return;
    this.backgroundLoopsStarted = true;
    this.startAttentionMonitor();
    this.startScheduledWakeMonitor();
    this.startSidecarReaper();
    this.startMemoryShedLoop();
    this.dashboardCacheReady = this.runDashboardCacheTick();
    this.startDashboardCacheLoop();
    this.startReaperLoop();
    this.startSessionGcLoop();
  }

  /**
   * Resolves once every in-flight fire-and-forget run has settled: background
   * spawns, PR auto-detect checks, and the dashboard cache tick. Lets teardown
   * drain async work whose writes and `gh` calls would otherwise land after the
   * caller is gone.
   */
  async settleBackgroundSpawns(): Promise<void> {
    await Promise.allSettled([
      ...this.backgroundSpawnRuns,
      ...this.prCheckRuns,
      ...(this.dashboardCacheReady ? [this.dashboardCacheReady] : []),
    ]);
  }

  dispose(): void {
    // Settles every queued lookup as skipped:cancelled so a prCheckRuns drain
    // cannot hang on a batch that will never flush.
    cancelPendingPrLookups();
    if (this.attentionMonitorTimer) {
      clearInterval(this.attentionMonitorTimer);
      this.attentionMonitorTimer = null;
    }
    if (this.scheduledWakeTimer) {
      clearInterval(this.scheduledWakeTimer);
      this.scheduledWakeTimer = null;
    }
    if (this.sidecarReaperTimer) {
      clearInterval(this.sidecarReaperTimer);
      this.sidecarReaperTimer = null;
    }
    if (this.memoryShedTimer) {
      clearInterval(this.memoryShedTimer);
      this.memoryShedTimer = null;
    }
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    if (this.sessionGcTimer) {
      clearInterval(this.sessionGcTimer);
      this.sessionGcTimer = null;
    }
    this.stopDashboardCacheLoop();
  }

  private startSidecarReaper(): void {
    if (this.sidecarReaperTimer) {
      return;
    }
    this.sidecarReaperTimer = setInterval(() => {
      void this.runSidecarReaper();
    }, SIDECAR_REAPER_INTERVAL_MS);
    this.sidecarReaperTimer.unref();
  }

  private startMemoryShedLoop(): void {
    if (this.memoryShedTimer) return;
    this.memoryShedTimer = setInterval(() => {
      void this.runMemoryShedTick();
    }, MEMORY_SHED_INTERVAL_MS);
    this.memoryShedTimer.unref();
  }

  private async runMemoryShedTick(): Promise<void> {
    try {
      await this.runMemoryShed();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("daemon.memory.shed.failed", {
        level: "warn",
        message: `Memory shed failed: ${message}`,
        details: { message },
      });
    }
  }

  private async runSidecarReaper(): Promise<void> {
    try {
      await this.reapDeadSessionSidecars();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.sidecar_reaper.failed", {
        level: "warn",
        message: `Sidecar reaper failed: ${message}`,
      });
    }
  }

  private readMemoryPressure(nowMs: number): MemoryPressureState {
    const host = readHostMemory();
    const cgroup = readCgroupMemorySnapshot();
    const guard = this.config.admission.memoryGuard;
    const episode = this.memoryShedEpisode;
    const emergencyBytes = memoryShedEmergencyBytes(guard);

    let ramActive = false;
    let ramEmergency = false;
    if (!host) {
      episode.ramContinuousSinceMs = null;
    } else if (host.availableBytes >= guard.admissionFloorBytes) {
      episode.ramContinuousSinceMs = null;
      episode.exhaustedEdges.delete("ram:sidecar");
      episode.exhaustedEdges.delete("ram:session");
    } else if (host.availableBytes < guard.shedCriticalFloorBytes) {
      ramActive = true;
      ramEmergency = host.availableBytes <= emergencyBytes;
      episode.ramContinuousSinceMs ??= nowMs;
    } else {
      episode.ramContinuousSinceMs = null;
    }

    let cgroupMaxHeadroomBytes: number | null = null;
    if (cgroup) {
      const highBytes = cgroup.highBytes;
      const usableHigh =
        highBytes !== null && (cgroup.maxBytes === null || highBytes < cgroup.maxBytes);
      if (!usableHigh) {
        episode.cgroupHighLatched = false;
        episode.exhaustedEdges.delete("cgroup-high:sidecar");
      } else if (cgroup.currentBytes >= highBytes) {
        episode.cgroupHighLatched = true;
      } else {
        const recoveryBytes = Math.min(emergencyBytes, Math.floor(highBytes / 10));
        if (cgroup.currentBytes <= highBytes - recoveryBytes) {
          episode.cgroupHighLatched = false;
          episode.exhaustedEdges.delete("cgroup-high:sidecar");
        }
      }

      if (cgroup.maxBytes === null) {
        episode.cgroupMaxLatched = false;
        episode.exhaustedEdges.delete("cgroup-max:emergency");
      } else {
        cgroupMaxHeadroomBytes = Math.max(0, cgroup.maxBytes - cgroup.currentBytes);
        if (cgroupMaxHeadroomBytes <= emergencyBytes) {
          episode.cgroupMaxLatched = true;
        } else if (cgroupMaxHeadroomBytes > 2 * emergencyBytes) {
          episode.cgroupMaxLatched = false;
          episode.exhaustedEdges.delete("cgroup-max:emergency");
        }
      }
    }

    if (host) {
      const swapUsedFraction =
        host.swapTotalBytes === 0
          ? 0
          : Math.min(
              1,
              Math.max(0, (host.swapTotalBytes - host.swapFreeBytes) / host.swapTotalBytes),
            );
      const swapRecovery = Math.max(0, guard.shedSwapUsedFraction - 0.1);
      if (swapUsedFraction <= swapRecovery) {
        episode.swapState = "armed";
        episode.exhaustedEdges.delete("swap:sidecar");
      } else if (swapUsedFraction >= guard.shedSwapUsedFraction && episode.swapState === "armed") {
        episode.swapState = "active";
      }
    }

    const continuousRamPressureMs =
      ramActive && episode.ramContinuousSinceMs !== null
        ? Math.max(0, nowMs - episode.ramContinuousSinceMs)
        : null;
    const cgroupHighActive = cgroup !== null && episode.cgroupHighLatched;
    const cgroupMaxActive = cgroup !== null && episode.cgroupMaxLatched;
    const swapActive = host !== null && episode.swapState === "active";
    const activeTriggers: MemoryShedTrigger[] = [];
    if (ramActive) activeTriggers.push("available_floor");
    if (cgroupMaxActive) activeTriggers.push("cgroup_max_headroom");
    if (cgroupHighActive) activeTriggers.push("cgroup_high");
    if (swapActive) activeTriggers.push("swap_saturation");

    const emergencyReasons: MemoryPressureState["emergencyReasons"] = [];
    if (ramEmergency) emergencyReasons.push("host_available");
    if (cgroupMaxActive) emergencyReasons.push("cgroup_max_headroom");
    if (
      cgroup !== null &&
      cgroup.highBytes !== null &&
      cgroup.maxBytes !== null &&
      cgroup.highBytes < cgroup.maxBytes &&
      cgroup.currentBytes >= cgroup.highBytes &&
      cgroup.maxBytes - cgroup.highBytes <= emergencyBytes
    ) {
      emergencyReasons.push("cgroup_high_no_runway");
    }

    let stage: MemoryShedStage = "none";
    if (ramEmergency || cgroupMaxActive) stage = "emergency";
    else if (
      ramActive &&
      continuousRamPressureMs !== null &&
      continuousRamPressureMs >= MEMORY_SHED_SESSION_GRACE_MS
    ) {
      stage = "session";
    } else if (ramActive || cgroupHighActive || swapActive) {
      stage = "sidecar";
    }

    return {
      host,
      cgroup,
      activeTriggers,
      stage,
      continuousRamPressureMs,
      emergencyReasons,
      cgroupMaxHeadroomBytes,
    };
  }

  private async memoryShedCandidates(): Promise<SessionRecord[]> {
    const candidates: Array<{ session: SessionRecord; state: "rate_limited" | "waiting" }> = [];
    for (const session of this.countLiveSessions().records) {
      if (this.isInRestoreWarmup(session.id)) continue;
      try {
        const state = (await this.classifySessionRecord(session, { scanPane: false })).state;
        if (state === "rate_limited" || state === "waiting") candidates.push({ session, state });
      } catch {
        // Fail closed: an unclassifiable session is treated as working.
      }
    }
    return candidates
      .sort((a, b) => {
        if (a.state !== b.state) return a.state === "rate_limited" ? -1 : 1;
        return a.session.updatedAt.localeCompare(b.session.updatedAt);
      })
      .map(({ session }) => session);
  }

  private async memoryShedEligibleRecord(sessionId: string): Promise<SessionRecord | null> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session || this.isInRestoreWarmup(session.id)) return null;
    try {
      const state = (await this.classifySessionRecord(session, { scanPane: false })).state;
      return state === "rate_limited" || state === "waiting" ? session : null;
    } catch {
      return null;
    }
  }

  private async memoryShedSidecarTarget(
    candidateId: string,
    sidecarName: string,
  ): Promise<string | null> {
    const candidate = await this.memoryShedEligibleRecord(candidateId);
    if (!candidate) return null;
    const project = this.resolveProjectForSession(candidate);
    const sidecar = project?.sidecars[sidecarName];
    if (!sidecar) return null;
    const ownerId = this.sidecarOwnerIdForName(candidate, project, sidecarName);
    if (!sidecar.mcp) {
      const workspaceId = workspaceIdOf(candidate);
      const liveMembers = listSessions(this.config.dataDir).filter(
        (session) =>
          session.project === candidate.project &&
          workspaceIdOf(session) === workspaceId &&
          (session.status === "running" ||
            session.status === "spawning" ||
            this.isInRestoreWarmup(session.id)),
      );
      for (const member of liveMembers) {
        if (!(await this.memoryShedEligibleRecord(member.id))) return null;
      }
    }
    return sidecarTmuxSession(ownerId, sidecarName);
  }

  private logMemoryShedResult(args: {
    pressure: MemoryPressureState;
    afterHost: HostMemory | null;
    tier: MemoryShedTier;
    stoppedTmux: string[];
    stoppedSessions: string[];
    exhausted?: boolean;
    failure?: string;
  }): void {
    const trigger = args.pressure.activeTriggers[0];
    if (!trigger) return;
    const cgroup = args.pressure.cgroup;
    this.logEvent("daemon.memory.shed", {
      level: "warn",
      message: args.failure
        ? `Memory shed stopped after a partial failure: ${args.failure}`
        : `Memory shed ${args.exhausted ? "exhausted safe candidates" : "recovered host headroom"}`,
      details: {
        trigger,
        tier: args.tier,
        stage: args.pressure.stage,
        activeTriggers: args.pressure.activeTriggers,
        stoppedTmux: args.stoppedTmux,
        stoppedSessions: args.stoppedSessions,
        ...(args.pressure.host
          ? {
              availableBytesBefore: args.pressure.host.availableBytes,
              availableBytesAfter: args.afterHost?.availableBytes ?? null,
            }
          : {}),
        ...(args.pressure.continuousRamPressureMs !== null
          ? { continuousRamPressureMs: args.pressure.continuousRamPressureMs }
          : {}),
        ...(cgroup
          ? {
              cgroupCurrentBytes: cgroup.currentBytes,
              cgroupHighBytes: cgroup.highBytes,
              cgroupMaxBytes: cgroup.maxBytes,
              ...(args.pressure.cgroupMaxHeadroomBytes !== null
                ? { cgroupMaxHeadroomBytes: args.pressure.cgroupMaxHeadroomBytes }
                : {}),
            }
          : {}),
        ...(args.pressure.emergencyReasons.length > 0
          ? { emergencyReasons: args.pressure.emergencyReasons }
          : {}),
        ...(args.exhausted ? { exhausted: true } : {}),
        ...(args.failure ? { partial: true, failure: args.failure } : {}),
      },
    });
  }

  private async shedOneMemorySidecar(
    candidates: SessionRecord[],
    liveTmux: Set<string>,
  ): Promise<{ attempted: boolean; stoppedTmux: string | null; tier: MemoryShedTier }> {
    for (const mcp of [true, false]) {
      for (const candidate of candidates) {
        const project = this.resolveProjectForSession(candidate);
        for (const name of sessionSidecarNames(candidate, project)) {
          if (Boolean(BUILTIN_SIDECARS[name]?.config.mcp) !== mcp) continue;
          const tmuxName = await this.memoryShedSidecarTarget(candidate.id, name);
          if (!tmuxName || !liveTmux.has(tmuxName)) continue;
          const stopped = await killTmuxSessionTree(tmuxName);
          // Drop the owner's sidecarProcs entry the same way every other
          // sidecar kill site does — otherwise its dead pane's pgid stays
          // "live" to buildSidecarClaims/findLeakedSidecarTrees until the
          // sidecar restarts, masking the orphan from the sweep and doctor.
          const ownerId = this.sidecarOwnerIdForName(candidate, project, name);
          this.clearSidecarProcEntry(ownerId, name);
          return {
            attempted: true,
            stoppedTmux: stopped ? tmuxName : null,
            tier: mcp ? "mcp_sidecar" : "user_sidecar",
          };
        }
      }
    }
    return { attempted: false, stoppedTmux: null, tier: "user_sidecar" };
  }

  private memoryShedExhaustionEdges(pressure: MemoryPressureState): MemoryShedExhaustedEdge[] {
    const edges: MemoryShedExhaustedEdge[] = [];
    if (pressure.stage === "sidecar" || pressure.stage === "emergency") {
      if (pressure.activeTriggers.includes("available_floor")) edges.push("ram:sidecar");
      if (pressure.activeTriggers.includes("cgroup_high")) edges.push("cgroup-high:sidecar");
      if (pressure.activeTriggers.includes("swap_saturation")) edges.push("swap:sidecar");
    }
    if (pressure.stage === "session" || pressure.stage === "emergency") {
      if (pressure.activeTriggers.includes("available_floor")) edges.push("ram:session");
      if (pressure.activeTriggers.includes("cgroup_max_headroom")) {
        edges.push("cgroup-max:emergency");
      }
    }
    return edges;
  }

  private async runMemoryShed(): Promise<void> {
    if (this.memoryShedRunning) return;
    const guard = this.config.admission.memoryGuard;
    if (!this.config.admission.enabled || !guard.shedEnabled) {
      this.memoryShedEpisode = createMemoryShedEpisode();
      return;
    }
    this.memoryShedRunning = true;
    let pressure: MemoryPressureState | null = null;
    let afterPressure: MemoryPressureState | null = null;
    const stoppedTmux: string[] = [];
    const stoppedSessions: string[] = [];
    let tier: MemoryShedTier = "mcp_sidecar";
    let candidateProvenExhausted = false;
    try {
      pressure = this.readMemoryPressure(Date.now());
      if (pressure.stage === "none") return;
      const candidates = await this.memoryShedCandidates();
      const liveTmux = await listTmuxSessionNames();
      let sidecarAttempted = false;
      let sessionAttempted = false;

      if (pressure.stage === "sidecar" || pressure.stage === "emergency") {
        const result = await this.shedOneMemorySidecar(candidates, liveTmux);
        sidecarAttempted = result.attempted;
        tier = result.tier;
        if (result.stoppedTmux) stoppedTmux.push(result.stoppedTmux);
        if (this.memoryShedEpisode.swapState === "active") {
          this.memoryShedEpisode.swapState = "spent";
        }
        if (!result.attempted) candidateProvenExhausted = true;
        if (result.attempted) afterPressure = this.readMemoryPressure(Date.now());
      }

      if (pressure.stage === "session" || pressure.stage === "emergency") {
        const currentPressure = afterPressure ?? pressure;
        const hostStillAuthorizes =
          currentPressure.host !== null &&
          (currentPressure.host.availableBytes <= memoryShedEmergencyBytes(guard) ||
            (currentPressure.host.availableBytes < guard.shedCriticalFloorBytes &&
              currentPressure.continuousRamPressureMs !== null &&
              currentPressure.continuousRamPressureMs >= MEMORY_SHED_SESSION_GRACE_MS));
        const cgroupStillAuthorizes =
          currentPressure.cgroup !== null && this.memoryShedEpisode.cgroupMaxLatched;
        const canStopSession =
          pressure.stage === "session" || hostStillAuthorizes || cgroupStillAuthorizes;
        if (canStopSession) {
          tier = "session";
          for (const candidate of candidates) {
            if (!(await this.memoryShedEligibleRecord(candidate.id))) continue;
            sessionAttempted = true;
            await this.applyManualStatus(candidate.id, "stopped", {}, { skipEnrichment: true });
            stoppedSessions.push(candidate.id);
            afterPressure = this.readMemoryPressure(Date.now());
            break;
          }
        }
        if (pressure.stage === "session") candidateProvenExhausted = !sessionAttempted;
        if (pressure.stage === "emergency") {
          candidateProvenExhausted = canStopSession && !sidecarAttempted && !sessionAttempted;
        }
      }

      const exhaustionEdges = this.memoryShedExhaustionEdges(pressure);
      const newExhaustionEdge =
        candidateProvenExhausted &&
        exhaustionEdges.some((edge) => !this.memoryShedEpisode.exhaustedEdges.has(edge));
      if (candidateProvenExhausted) {
        for (const edge of exhaustionEdges) this.memoryShedEpisode.exhaustedEdges.add(edge);
      }
      if (stoppedTmux.length > 0 || stoppedSessions.length > 0 || newExhaustionEdge) {
        this.logMemoryShedResult({
          pressure,
          afterHost: afterPressure ? afterPressure.host : pressure.host,
          tier,
          stoppedTmux,
          stoppedSessions,
          ...(newExhaustionEdge ? { exhausted: true } : {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (pressure && (stoppedTmux.length > 0 || stoppedSessions.length > 0)) {
        afterPressure ??= this.readMemoryPressure(Date.now());
        this.logMemoryShedResult({
          pressure,
          afterHost: afterPressure.host,
          tier,
          stoppedTmux,
          stoppedSessions,
          failure: message,
        });
      }
      throw error;
    } finally {
      this.memoryShedRunning = false;
    }
  }

  // Periodic sweep for built-in sidecar (registry-driven over BUILTIN_SIDECARS)
  // tmux sessions whose owning session record is gone or terminal. Keyed on
  // tmux ownership (not process ppid) so a transient empty listSessions read
  // can never reap a live sidecar. Guarded against re-entrancy: a slow pass
  // (large tmux fleet) must not overlap the next interval tick.
  private async reapDeadSessionSidecars(): Promise<void> {
    if (this.sidecarReaperRunning) {
      return;
    }
    this.sidecarReaperRunning = true;
    try {
      const builtinNames = Object.keys(BUILTIN_SIDECARS);
      // Also protect a session mid restore/recover: its on-disk status stays
      // stopped/errored until the restore completes, but startMcpSidecars may
      // already have started its sidecar tmux pane (see restore() and
      // ensureSessionReadyForSend(), which set restoreWarmupUntil before that
      // call for exactly this gap).
      const allSessions = listSessions(this.config.dataDir);
      const liveSessions = allSessions.filter((session) => this.isLiveSessionRecord(session));
      // Protect every sidecar tmux name a live session is entitled to (agent
      // built-in sidecars plus any project-declared user sidecar), and also
      // the raw `${id}--` prefix as a belt-and-suspenders guard against
      // config drift where a live session's sidecar name isn't enumerated by
      // sessionSidecarNames.
      const protectedTmux = this.buildProtectedSidecarTmux(liveSessions);
      const liveIdPrefixes = new Set<string>();
      for (const session of liveSessions) {
        liveIdPrefixes.add(`${session.id}--`);
      }

      const names = await listTmuxSessionNames();
      for (const name of names) {
        const builtinName = builtinNames.find((n) => name.endsWith(`--${n}`));
        if (!builtinName) {
          continue;
        }
        if (protectedTmux.has(name)) {
          continue;
        }
        let ownedByLiveSession = false;
        for (const prefix of liveIdPrefixes) {
          if (name.startsWith(prefix)) {
            ownedByLiveSession = true;
            break;
          }
        }
        if (ownedByLiveSession) {
          continue;
        }
        const sessionId = name.slice(0, -`--${builtinName}`.length);
        await this.reapSidecarByName(sessionId, builtinName);
        this.clearSidecarProcEntry(sessionId, builtinName);
      }
      // Built-in (always mcp, per-session) sidecars are fully handled above
      // and by sweepLeakedBuiltinSidecars below; this second pass is scoped
      // to project (non-builtin) sidecars — the desk-shared shape the
      // builtin-name loop above can never see (it walks tmux names, not
      // records, and only ever matches a `--${builtinName}` suffix).
      await this.collectAndExecuteSidecarReapPass(allSessions, names);
      await this.sweepLeakedBuiltinSidecars("reaper");
    } finally {
      this.sidecarReaperRunning = false;
    }
  }

  // Every sidecar tmux name a live session is entitled to (agent built-in
  // sidecars plus any project-declared user sidecar), keyed on the SESSION's
  // own id rather than its sidecar owner id. That makes this an effective
  // guard for a per-session (mcp/builtin) sidecar or a non-desk session
  // (ownerId === session.id); a desk-shared sidecar's real owner-keyed pane
  // name is protected instead by planSidecarReap's own workspaceRunning +
  // idle-TTL + connection-veto rules, not by this set.
  private buildProtectedSidecarTmux(liveSessions: readonly SessionRecord[]): Set<string> {
    const protectedTmux = new Set<string>();
    for (const session of liveSessions) {
      let project: ProjectConfig | undefined;
      try {
        project = this.resolveProjectForSession(session);
      } catch {
        project = undefined;
      }
      for (const scName of sessionSidecarNames(session, project)) {
        protectedTmux.add(sidecarTmuxSession(session.id, scName));
      }
    }
    return protectedTmux;
  }

  // Records-driven candidate enumeration for the project-sidecar reap pass.
  // Built-in sidecars are always mcp and per-session, and already have their
  // own dedicated reap path (the builtin-name tmux loop plus
  // sweepLeakedBuiltinSidecars); this scopes to exactly the leak's shape —
  // non-builtin, desk-shareable project sidecars — never by parsing a tmux
  // name (a `--svc--` service pane can never be produced by this
  // construction: `name` only ever comes from sessionSidecarNames).
  // Deliberately does NOT consult the builtin-loop's protectedTmux set
  // (buildProtectedSidecarTmux): that set blanket-protects every LIVE
  // session's own sidecar names, which is correct for the builtin sweep's
  // "no policy, just don't touch a live session" rule but would blanket-
  // protect exactly the shape this pass exists to reap — a live (running),
  // non-desk session's own idle sidecar (the measured intelas-0bf7 leak).
  // Safety for a live session instead comes from this pass's own
  // ownership/idle/connection reasoning (planSidecarReap).
  private async collectSidecarReapCandidates(
    tmuxNames: ReadonlySet<string>,
    sessions: readonly SessionRecord[],
  ): Promise<SidecarReapCandidate[]> {
    const psSnapshot = await snapshotProcesses();
    const seenTmuxNames = new Set<string>();
    const connectionCache = new Map<number, Promise<"established" | "none" | "unknown">>();
    const probeConnections = (port: number): Promise<"established" | "none" | "unknown"> => {
      let pending = connectionCache.get(port);
      if (!pending) {
        // hasEstablishedConnections is designed to never reject, but a
        // thrown probe must degrade to "unknown" (keep), never propagate
        // and never read as "none" (which would authorize a reap) — belt
        // and braces on top of that contract, not a substitute for it.
        pending = hasEstablishedConnections(port).catch(() => "unknown" as const);
        connectionCache.set(port, pending);
      }
      return pending;
    };

    const candidates: SidecarReapCandidate[] = [];
    for (const session of sessions) {
      let project: ProjectConfig | undefined;
      try {
        project = this.resolveProjectForSession(session);
      } catch {
        project = undefined;
      }
      for (const sidecarName of sessionSidecarNames(session, project)) {
        const sidecar = project?.sidecars[sidecarName];
        if (!sidecar || Object.hasOwn(BUILTIN_SIDECARS, sidecarName)) {
          continue;
        }
        const ownerId = this.sidecarOwnerIdForName(session, project, sidecarName);
        const tmuxName = sidecarTmuxSession(ownerId, sidecarName);
        if (seenTmuxNames.has(tmuxName)) {
          continue;
        }
        seenTmuxNames.add(tmuxName);

        const owner = ownerId === session.id ? session : readSession(this.config.dataDir, ownerId);
        const identity = owner?.sidecarProcs?.[sidecarName];
        const paneAlive = tmuxNames.has(tmuxName);

        // No reservation recorded at all reads as "none" without a probe —
        // there is no live socket for a debugger to be attached to. When
        // more than one port is reserved, any single "unknown" outranks
        // every other result (never authorize a reap on a partial read) and
        // any single "established" outranks "none".
        const reservedPorts = Object.values(owner?.sidecarPorts?.[sidecarName] ?? {});
        let connections: "established" | "none" | "unknown" = "none";
        if (reservedPorts.length > 0) {
          const results = await Promise.all(reservedPorts.map((port) => probeConnections(port)));
          connections = results.includes("unknown")
            ? "unknown"
            : results.includes("established")
              ? "established"
              : "none";
        }

        // Inclusive of the owner itself, unlike hasRunningWorkspaceMembers
        // (which excludes the passed-in session by design, for its own
        // sibling-only call sites) — a single-member workspace whose sole
        // session is itself running must read as workspace-running here.
        const workspaceMembers = owner ? this.listDeskSessions(owner) : [];
        const workspaceRunning =
          workspaceMembers.some((m) => m.status === "running" || m.status === "spawning") ||
          workspaceMembers.some((m) => this.isInRestoreWarmup(m.id));

        let lastActivityAtMs: number | null = null;
        for (const member of workspaceMembers) {
          const iso = this.dashboardCache.get(member.id)?.lastActivityAt ?? member.updatedAt;
          const ms = Date.parse(iso);
          if (Number.isFinite(ms) && (lastActivityAtMs === null || ms > lastActivityAtMs)) {
            lastActivityAtMs = ms;
          }
        }

        candidates.push({
          ownerId,
          sidecarName,
          tmuxName,
          paneAlive,
          mcp: Boolean(sidecar.mcp),
          ownerExists: owner !== undefined,
          worktreeExists: owner ? workspaceExists(owner.worktreePath) : false,
          workspaceRunning,
          hasRecordedIdentity: identity !== undefined,
          lastActivityAtMs,
          idleTtlMinutes: resolveSidecarIdleTtlMinutes(
            sidecar.idleTtlMinutes,
            this.config.sidecarGc.idleTtlMinutes,
          ),
          connections,
          ageSeconds: identity ? (psSnapshot.byPid.get(identity.pid)?.etimes ?? null) : null,
        });
      }
    }
    return candidates;
  }

  // Signals every `reap` entry (pane-alive routes through reapSidecarByName;
  // pane-gone falls back to the recorded identity, mirroring
  // killSidecarAndUnlinkSlot) and logs a warn-only event for every `age_cap`
  // entry. Never throws — reapSidecarByName/reapRecordedIdentity already
  // degrade a survivor to a log, not a rejected promise.
  private async executeSidecarReapPlan(plan: SidecarReapPlan): Promise<void> {
    if (plan.reap.length === 0 && plan.warn.length === 0) {
      return;
    }
    // ONE pre-signal snapshot for the whole pass's treeRssKb accounting —
    // taken before any entry is signaled, since a signaled tree's
    // descendants reparent immediately after and a later snapshot could
    // never attribute them back to this pass.
    const preSignalSnapshot: ProcSnapshot =
      plan.reap.length > 0 ? await snapshotProcesses() : { ok: false, byPid: new Map(), byPgid: new Map() };
    for (const entry of plan.reap) {
      const owner = readSession(this.config.dataDir, entry.ownerId);
      const identity = owner?.sidecarProcs?.[entry.sidecarName];
      const treeRssKb =
        identity && preSignalSnapshot.ok
          ? collectTree(identity.pid, preSignalSnapshot).reduce(
              (sum, pid) => sum + (preSignalSnapshot.byPid.get(pid)?.rssKb ?? 0),
              0,
            )
          : 0;

      let outcome: ReapOutcome | null;
      if (await sidecarTmuxAlive(entry.ownerId, entry.sidecarName)) {
        outcome = await this.reapSidecarByName(entry.ownerId, entry.sidecarName);
      } else if (owner && identity) {
        outcome = await reapRecordedIdentity(identity, owner.worktreePath);
        this.logSidecarReapSurvivors(entry.ownerId, entry.sidecarName, outcome);
      } else {
        outcome = null;
      }
      this.clearSidecarProcEntry(entry.ownerId, entry.sidecarName);
      this.logEvent("session.sidecar.reaped", {
        level: "info",
        sessionId: entry.ownerId,
        message: `Sidecar ${entry.sidecarName} on ${entry.ownerId} reaped (${entry.reason}).`,
        details: {
          sidecarName: entry.sidecarName,
          reason: entry.reason,
          treeRssKb,
          survivors: outcome?.survivors ?? [],
        },
      });
    }
    for (const entry of plan.warn) {
      this.logEvent("session.sidecar.age_warning", {
        level: "warn",
        sessionId: entry.ownerId,
        message: `Sidecar ${entry.sidecarName} on ${entry.ownerId} is past the age-warning threshold; still kept (${entry.reason} never kills).`,
        details: { sidecarName: entry.sidecarName, reason: entry.reason },
      });
    }
  }

  // Shared by the 5-minute reaper tick and boot: records-driven candidate
  // collection, the pure policy, then execution. Callers pass in the
  // sessions/tmux-name snapshots they already hold to avoid a second listing
  // pass in the reaper tick, which runs this right next to the builtin-name
  // loop above.
  private async collectAndExecuteSidecarReapPass(
    sessions: readonly SessionRecord[],
    tmuxNames: ReadonlySet<string>,
  ): Promise<SidecarReapPlan> {
    const candidates = await this.collectSidecarReapCandidates(tmuxNames, sessions);
    const plan = planSidecarReap({
      nowMs: Date.now(),
      config: this.config.sidecarGc,
      candidates,
    });
    await this.executeSidecarReapPlan(plan);
    return plan;
  }

  private startScheduledWakeMonitor(): void {
    if (this.scheduledWakeTimer) {
      return;
    }
    this.scheduledWakeTimer = setInterval(() => {
      void this.runScheduledWakeMonitor();
    }, SCHEDULED_WAKE_POLL_INTERVAL_MS);
    this.scheduledWakeTimer.unref();
  }

  private async runScheduledWakeMonitor(): Promise<void> {
    try {
      await this.processScheduledWakes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.wake.monitor_failed", {
        level: "warn",
        message: `Scheduled wake monitor failed: ${message}`,
      });
    }
  }

  private resolveWakeDueAt(request: ScheduleSessionWakeRequest): Date {
    const hasAt = typeof request.at === "string" && request.at.trim().length > 0;
    const hasDelay = request.delayMs !== undefined;
    if (hasAt === hasDelay) {
      throw new Error("exactly one of at or delayMs is required");
    }
    const dueAt = hasAt
      ? new Date(request.at?.trim() ?? "")
      : new Date(Date.now() + Number(request.delayMs));
    if (Number.isNaN(dueAt.getTime())) {
      throw new Error("wake time is invalid");
    }
    if (!hasAt && (!Number.isFinite(request.delayMs) || Number(request.delayMs) <= 0)) {
      throw new Error("delayMs must be a positive number");
    }
    if (dueAt.getTime() <= Date.now()) {
      throw new Error("wake time must be in the future");
    }
    return dueAt;
  }

  private resolveIntervalWakeDueAt(request: ScheduleSessionWakeRequest): Date {
    const hasAt = typeof request.at === "string" && request.at.trim().length > 0;
    const hasDelay = request.delayMs !== undefined;
    if (hasAt && hasDelay) {
      throw new Error("only one of at or delayMs can be used with intervalMs");
    }
    const dueAt = hasAt
      ? new Date(request.at?.trim() ?? "")
      : new Date(Date.now() + Number(request.delayMs ?? request.intervalMs));
    if (Number.isNaN(dueAt.getTime())) {
      throw new Error("wake time is invalid");
    }
    if (
      !hasAt &&
      request.delayMs !== undefined &&
      (!Number.isFinite(request.delayMs) || Number(request.delayMs) <= 0)
    ) {
      throw new Error("delayMs must be a positive number");
    }
    if (dueAt.getTime() <= Date.now()) {
      throw new Error("wake time must be in the future");
    }
    return dueAt;
  }

  private formatIntervalWakeMessage(
    sessionId: string,
    message: string,
    stopCondition: string,
  ): string {
    return [
      "Scheduled interval wake-up.",
      `Stop condition: ${stopCondition}`,
      "",
      message,
      "",
      `If the stop condition is satisfied, cancel this interval with \`spur wake ${sessionId} --cancel\`.`,
    ].join("\n");
  }

  private formatDailyWakeMessage(
    sessionId: string,
    message: string,
    stopCondition: string,
  ): string {
    return [
      "Scheduled daily wake-up.",
      `Stop condition: ${stopCondition}`,
      "",
      message,
      "",
      `If the stop condition is satisfied, cancel this daily wake with \`spur wake ${sessionId} --cancel\`.`,
    ].join("\n");
  }

  private async processScheduledWakes(): Promise<void> {
    if (this.scheduledWakeMonitorRunning) {
      return;
    }
    this.scheduledWakeMonitorRunning = true;
    try {
      const now = Date.now();
      for (const session of listSessions(this.config.dataDir)) {
        const scheduledWake = session.scheduledWake;
        if (scheduledWake && Date.parse(scheduledWake.dueAt) <= now) {
          // Claim the due occurrence BEFORE sending: clear scheduledWake and
          // persist it first. A slow or failing send must not leave the wake
          // due, or the `<= now` guard stays true and it re-fires every tick
          // forever.
          const current = readSession(this.config.dataDir, session.id) ?? session;
          // CAS: only claim if the wake is unchanged (no concurrent re-arm/cancel).
          const claimed =
            current.scheduledWake?.dueAt === scheduledWake.dueAt &&
            current.scheduledWake.message === scheduledWake.message;
          if (claimed) {
            const { scheduledWake: _scheduledWake, ...base } = current;
            const cleared: SessionRecord = { ...base, updatedAt: nowIso() };
            writeSession(this.config.dataDir, cleared);
            try {
              await this.send(session.id, { message: scheduledWake.message });
              this.logEvent("session.wake.sent", {
                level: "info",
                sessionId: session.id,
                projectId: session.project,
                message: `Sent scheduled wake to ${session.id}`,
                details: {
                  dueAt: scheduledWake.dueAt,
                },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logEvent("session.wake.failed", {
                level: "error",
                sessionId: session.id,
                projectId: session.project,
                message: `Failed to send scheduled wake to ${session.id}: ${message}`,
                details: {
                  dueAt: scheduledWake.dueAt,
                },
              });
            }
          }
        }

        const intervalWake = session.intervalWake;
        if (intervalWake && Date.parse(intervalWake.nextDueAt) <= now) {
          // Claim the due tick BEFORE sending: advance nextDueAt to the next
          // future interval (catching up past any missed intervals) and persist
          // it first. A slow or failing send must not leave the wake due, or the
          // `<= now` guard stays true and it re-fires every tick forever.
          let nextDueMs = Date.parse(intervalWake.nextDueAt);
          do {
            nextDueMs += intervalWake.intervalMs;
          } while (nextDueMs <= now);
          const nextDueAt = new Date(nextDueMs).toISOString();
          const current = readSession(this.config.dataDir, session.id) ?? session;
          // CAS: only claim if the wake is unchanged (no concurrent re-arm/cancel).
          const claimed =
            current.intervalWake?.nextDueAt === intervalWake.nextDueAt &&
            current.intervalWake.intervalMs === intervalWake.intervalMs &&
            current.intervalWake.message === intervalWake.message &&
            current.intervalWake.stopCondition === intervalWake.stopCondition;
          if (claimed) {
            const updated: SessionRecord = {
              ...current,
              intervalWake: {
                ...intervalWake,
                nextDueAt,
              },
              updatedAt: nowIso(),
            };
            writeSession(this.config.dataDir, updated);
            try {
              await this.send(session.id, {
                message: this.formatIntervalWakeMessage(
                  session.id,
                  intervalWake.message,
                  intervalWake.stopCondition,
                ),
              });
              this.logEvent("session.wake.interval_sent", {
                level: "info",
                sessionId: session.id,
                projectId: session.project,
                message: `Sent interval wake to ${session.id}`,
                details: {
                  nextDueAt,
                  intervalMs: intervalWake.intervalMs,
                },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logEvent("session.wake.interval_failed", {
                level: "error",
                sessionId: session.id,
                projectId: session.project,
                message: `Failed to send interval wake to ${session.id}: ${message}`,
                details: {
                  nextDueAt,
                  intervalMs: intervalWake.intervalMs,
                },
              });
            }
          }
        }

        const liveState = this.stateHistory.get(session.id)?.at(-1)?.state;
        // Auto-rotate a rate-limited claude session onto a fresh authenticated
        // account PROMPTLY, independent of rateLimitReactivation.afterHours. The
        // helper is fully self-gating (autoRotateOnRateLimit toggle, per-account
        // cooldown, per-episode cap, and all-accounts-limited fall-through) and
        // returns true only when a rotation happened. A successful rotation
        // suppresses the afterHours nudge below.
        // switchAuth (invoked inside tryAutoRotateClaudeAccount) can throw on a
        // dirty-worktree kill-confirmation, a stale-liveState race, or a
        // concurrently-removed account. Scope the catch to this session so one
        // bad session does not propagate out of the loop and starve every later
        // session of its wake this tick. On error treat rotated=false so the
        // afterHours nudge fallback below still runs.
        let rotated = false;
        if (liveState === "rate_limited") {
          try {
            rotated = await this.tryAutoRotateClaudeAccount(session);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logEvent("session.wake.failed", {
              level: "warn",
              sessionId: session.id,
              projectId: session.project,
              message: `Failed to auto-rotate claude account for ${session.id}: ${message}`,
            });
          }
        }

        const afterHours = this.config.rateLimitReactivation.afterHours;
        if (!rotated && afterHours > 0 && session.rateLimitedAt) {
          const thresholdMs = afterHours * 60 * 60 * 1000;
          if (now - Date.parse(session.rateLimitedAt) >= thresholdMs) {
            // Undefined liveState means classification has not populated stateHistory
            // yet (e.g. a fresh post-restart tick). Skip both the send and the clear so
            // rateLimitedAt stays set and a later tick can still fire this episode.
            if (liveState !== undefined) {
              if (liveState === "rate_limited") {
                // The interactive stop-and-wait menu is an arrow-key/Enter modal, not a
                // chat prompt: typing the reactivation sentence into it could garble input
                // or select the wrong option. Skip the typed nudge in that case. Only
                // claude sessions can show this menu; scope the pane capture accordingly.
                // classifySessionRecord's per-tick confirmClaudeUsageLimitMenu now dismisses
                // this menu long before afterHours elapses, so this branch is defense-in-depth
                // for the rare case that confirm keeps failing (e.g. tmux errors) rather than
                // the primary path.
                const isClaudeMenu =
                  agentStateStrategy(session.agent) === "claude_jsonl" &&
                  detectClaudeUsageLimitMenu(await captureTmuxPane(session.tmuxSession))?.limited;
                if (isClaudeMenu) {
                  this.logEvent("session.rate_limit.reactivation_skipped", {
                    level: "info",
                    sessionId: session.id,
                    projectId: session.project,
                    message: `Skipped rate-limit reactivation for ${session.id}: pane shows the interactive usage-limit menu`,
                    details: {
                      rateLimitedAt: session.rateLimitedAt,
                      afterHours,
                    },
                  });
                } else {
                  try {
                    await this.send(session.id, { message: RATE_LIMIT_REACTIVATION_PROMPT });
                    this.logEvent("session.rate_limit.reactivated", {
                      level: "info",
                      sessionId: session.id,
                      projectId: session.project,
                      message: `Sent rate-limit reactivation to ${session.id}`,
                      details: {
                        rateLimitedAt: session.rateLimitedAt,
                        afterHours,
                      },
                    });
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logEvent("session.rate_limit.reactivation_failed", {
                      level: "error",
                      sessionId: session.id,
                      projectId: session.project,
                      message: `Failed to send rate-limit reactivation to ${session.id}: ${message}`,
                      details: {
                        rateLimitedAt: session.rateLimitedAt,
                        afterHours,
                      },
                    });
                  }
                }
              }
              const current = readSession(this.config.dataDir, session.id) ?? session;
              if (current.rateLimitedAt === session.rateLimitedAt) {
                const { rateLimitedAt: _rateLimitedAt, ...base } = current;
                writeSession(this.config.dataDir, { ...base, updatedAt: nowIso() });
              }
            }
          }
        }

        // Nudge a claude session wedged on a transient server error (5xx /
        // connection failure): typed, not queued (queued delivery requires
        // "waiting", which this session never reaches while wedged). Gated on
        // liveState === "error" so an undefined liveState (fresh post-restart
        // tick) or a liveState that already moved on both skip the send —
        // clearing serverErrorAt is updateStateHistory's job alone, not this
        // loop's, so a non-"error" liveState leaves the marker untouched here.
        if (session.serverErrorAt) {
          const serverErrorAgeMs = now - Date.parse(session.serverErrorAt);
          if (serverErrorAgeMs >= CLAUDE_SERVER_ERROR_REACTIVATION_MS && liveState === "error") {
            try {
              await this.send(session.id, {
                message: CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT,
                queue: false,
              });
              this.logEvent("session.server_error.reactivated", {
                level: "info",
                sessionId: session.id,
                projectId: session.project,
                message: `Sent server-error reactivation to ${session.id}`,
                details: {
                  serverErrorAt: session.serverErrorAt,
                },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.logEvent("session.server_error.reactivation_failed", {
                level: "error",
                sessionId: session.id,
                projectId: session.project,
                message: `Failed to send server-error reactivation to ${session.id}: ${message}`,
                details: {
                  serverErrorAt: session.serverErrorAt,
                },
              });
            }
            // Re-arm under CAS: only if the marker is still what this tick read
            // (a concurrent clear/re-arm wins otherwise), so the next attempt is
            // a fresh 30 minutes out.
            const current = readSession(this.config.dataDir, session.id) ?? session;
            if (current.serverErrorAt === session.serverErrorAt) {
              writeSession(this.config.dataDir, {
                ...current,
                serverErrorAt: new Date(now).toISOString(),
                updatedAt: nowIso(),
              });
            }
          }
        }

        const dailyWake = session.dailyWake;
        if (!dailyWake || Date.parse(dailyWake.nextDueAt) > now) {
          continue;
        }
        // Claim the due occurrence BEFORE sending: advance nextDueAt to the
        // next future scheduled time and persist it first. A slow or failing
        // send must not leave the wake due, or the `<= now` guard stays true
        // and it re-fires every tick forever.
        const currentDailyWakeSession = readSession(this.config.dataDir, session.id) ?? session;
        // CAS: only claim if the wake is unchanged (no concurrent re-arm/cancel).
        const dailyWakeClaimed =
          currentDailyWakeSession.dailyWake?.nextDueAt === dailyWake.nextDueAt &&
          currentDailyWakeSession.dailyWake.dailyAt.join(",") === dailyWake.dailyAt.join(",") &&
          currentDailyWakeSession.dailyWake.message === dailyWake.message &&
          currentDailyWakeSession.dailyWake.stopCondition === dailyWake.stopCondition;
        if (dailyWakeClaimed) {
          // Resolving the next occurrence can throw on a malformed dailyAt
          // (e.g. a stray "99:99" that slipped into an existing record
          // before validation covered it). Scope this to the session,
          // mirroring the auto-rotate catch above: one bad record must not
          // escape the loop and starve every later session's wake
          // processing this tick. Unlike a delivery failure, a malformed
          // dailyAt has no next occurrence to advance to, so skip 24h ahead
          // instead of clearing the schedule -- an absent dailyWake is
          // invisible in the web UI and in `spur list`, and disabling a
          // schedule is meant to be an explicit user action (cancelWake).
          // This bounds the storm to one failure event per day and keeps
          // message/stopCondition intact for repair via re-arm.
          let nextDueAt: Date;
          try {
            nextDueAt = resolveNextDailyWakeAt(dailyWake.dailyAt, new Date(now));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const skipped: SessionRecord = {
              ...currentDailyWakeSession,
              dailyWake: {
                ...dailyWake,
                nextDueAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
              },
              updatedAt: nowIso(),
            };
            writeSession(this.config.dataDir, skipped);
            this.logEvent("session.wake.daily_failed", {
              level: "error",
              sessionId: session.id,
              projectId: session.project,
              message: `Failed to resolve next daily wake time for ${session.id}: ${message}`,
              details: {
                nextDueAt: dailyWake.nextDueAt,
                dailyAt: dailyWake.dailyAt,
              },
            });
            continue;
          }
          const updated: SessionRecord = {
            ...currentDailyWakeSession,
            dailyWake: {
              ...dailyWake,
              nextDueAt: nextDueAt.toISOString(),
            },
            updatedAt: nowIso(),
          };
          writeSession(this.config.dataDir, updated);
          try {
            await this.send(session.id, {
              message: this.formatDailyWakeMessage(
                session.id,
                dailyWake.message,
                dailyWake.stopCondition,
              ),
            });
            this.logEvent("session.wake.daily_sent", {
              level: "info",
              sessionId: session.id,
              projectId: session.project,
              message: `Sent daily wake to ${session.id}`,
              details: {
                nextDueAt: dailyWake.nextDueAt,
                dailyAt: dailyWake.dailyAt,
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logEvent("session.wake.daily_failed", {
              level: "error",
              sessionId: session.id,
              projectId: session.project,
              message: `Failed to send daily wake to ${session.id}: ${message}`,
              details: {
                nextDueAt: dailyWake.nextDueAt,
                dailyAt: dailyWake.dailyAt,
              },
            });
          }
        }
      }
    } finally {
      this.scheduledWakeMonitorRunning = false;
    }
  }

  previewConfigConnect(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    unconfiguredToRemove: string[];
  } {
    const canonicalPath = this.registryScanner.canonicalizePath(configPath);
    return this.previewRegistryPaths(
      this.registryPaths.includes(canonicalPath)
        ? this.registryPaths
        : [...this.registryPaths, canonicalPath],
    );
  }

  previewConfigDisconnect(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    unconfiguredToRemove: string[];
  } {
    const canonicalPath = this.registryScanner.canonicalizePath(configPath);
    return this.previewRegistryPaths(this.registryPaths.filter((path) => path !== canonicalPath));
  }

  private previewRegistryPaths(nextRegistryPaths: string[]): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    unconfiguredToRemove: string[];
  } {
    const scan = this.registryScanner.scan({
      bootstrapConfigPath: this.bootstrapConfigPath,
      configPaths: nextRegistryPaths,
      protectedPaths: [this.bootstrapConfigPath],
    });
    this.emitRegistryScan(this.config.dataDir, scan);
    const currentSignature = JSON.stringify(this.config.projects);
    const nextSignature = JSON.stringify(scan.config.projects);
    const unconfiguredIds = new Set(this.listUnconfiguredProjects().map((entry) => entry.id));
    const unconfiguredToRemove = Object.keys(scan.config.projects).filter((id) =>
      unconfiguredIds.has(id),
    );
    return {
      config: scan.config,
      registryPaths: scan.configPaths,
      changed:
        currentSignature !== nextSignature ||
        scan.configPaths.length !== this.registryPaths.length ||
        scan.configPaths.some((path, index) => path !== this.registryPaths[index]) ||
        unconfiguredToRemove.length > 0,
      unconfiguredToRemove,
    };
  }

  private emitRegistryScan(dataDir: string, scan: RegistryScanResult): void {
    for (const diagnostic of scan.newDiagnostics) {
      logSpurEvent(dataDir, {
        event: "daemon.registry.warning",
        level: "warn",
        message: diagnostic.message,
      });
    }
  }

  applyConfig(
    config: AppConfig,
    registryPaths: string[],
    options: { unconfiguredToRemove?: string[] } = {},
  ): void {
    const nextRegistryPaths = [...new Set(registryPaths)];
    this.registryScanner.invalidateRemovedPaths(this.registryPaths, nextRegistryPaths);
    this.config = config;
    // Local project configs are parsed with the daemon config as defaults, so
    // every cached resolution is stale the moment the daemon config changes.
    this.sessionProjectCache.clear();
    this.registryPaths = nextRegistryPaths;
    setTmuxSocketName(this.config.tmux.socketName);
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
    const removeIds = new Set(options.unconfiguredToRemove ?? []);
    mutateConfigRegistry(this.config.dataDir, (current) => ({
      configPaths: this.registryPaths,
      unconfiguredProjects: current.unconfiguredProjects.filter(
        (entry) => !removeIds.has(entry.id),
      ),
    }));
    this.resumeSessionDelivery();
  }

  getRegistryPaths(): string[] {
    return [...this.registryPaths];
  }

  listProjects(): ProjectListEntry[] {
    const configured: ProjectListEntry[] = Object.entries(this.config.projects).map(
      ([id, project]) => ({
        id,
        name: project.name?.trim() || id,
        configured: true,
        prefix: project.sessionPrefix,
        path: project.path,
      }),
    );
    const unconfigured: ProjectListEntry[] = this.listUnconfiguredProjects().map((entry) => ({
      id: entry.id,
      name: entry.displayName?.trim() || entry.id,
      configured: false,
      prefix: entry.prefix,
      path: entry.path,
    }));
    const shepherdProject = buildShepherdProject(this.config.dataDir);
    const shepherd: ProjectListEntry = {
      id: SHEPHERD_PROJECT_ID,
      name: SHEPHERD_PROJECT_NAME,
      configured: true,
      prefix: shepherdProject.sessionPrefix,
      path: shepherdProject.path,
      kind: "shepherd",
    };
    return [...configured, shepherd, ...unconfigured].sort((left, right) => {
      if (left.kind === "shepherd") return -1;
      if (right.kind === "shepherd") return 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  listUnconfiguredProjects(): UnconfiguredProjectEntry[] {
    return readConfigRegistryFile(this.config.dataDir).unconfiguredProjects;
  }

  private isUnconfiguredProjectId(id: string): boolean {
    return (
      !this.config.projects[id] && this.listUnconfiguredProjects().some((entry) => entry.id === id)
    );
  }

  createUnconfiguredProject(request: CreateProjectRequest): CreateProjectResponse {
    const displayName = request.displayName.trim();
    const prefix = request.prefix.trim();
    const rawPath = request.path?.trim() ?? "";
    if (!displayName) {
      throw new Error("displayName must be a non-empty string");
    }
    if (!PROJECT_ID_PATTERN.test(prefix)) {
      throw new Error(`prefix must match ${PROJECT_ID_PATTERN.source}`);
    }

    const existingUnconfigured = this.listUnconfiguredProjects();
    const usedIds = new Set([
      ...Object.keys(this.config.projects),
      ...existingUnconfigured.map((entry) => entry.id),
    ]);
    const usedPrefixes = new Set([
      ...Object.values(this.config.projects).map((project) => project.sessionPrefix),
      ...existingUnconfigured.map((entry) => entry.prefix),
    ]);

    if (usedPrefixes.has(prefix)) {
      throw new Error(`sessionPrefix "${prefix}" is already in use`);
    }

    const baseId = deriveProjectIdFromDisplayName(displayName);
    let candidateId = baseId;
    let suffix = 2;
    while (usedIds.has(candidateId)) {
      candidateId = `${baseId}-${suffix}`;
      suffix += 1;
    }

    let absolutePath: string;
    if (rawPath) {
      absolutePath = resolvePath(expandHome(rawPath));
      if (!existsSync(absolutePath)) {
        if (request.createMissing === true) {
          mkdirSync(absolutePath, { recursive: true });
        } else {
          throw new Error(`path does not exist: ${absolutePath}`);
        }
      } else if (!statSync(absolutePath).isDirectory()) {
        throw new Error(`path is not a directory: ${absolutePath}`);
      }
    } else {
      absolutePath = join(this.config.projectsRoot, candidateId);
      if (existsSync(absolutePath)) {
        throw new Error(`derived project folder already exists: ${absolutePath}`);
      }
      mkdirSync(absolutePath, { recursive: true });
    }

    addUnconfiguredProject(this.config.dataDir, {
      id: candidateId,
      displayName,
      prefix,
      path: absolutePath,
    });

    const projects = this.listProjects();
    const projectEntry = projects.find((project) => project.id === candidateId);
    if (!projectEntry) {
      throw new Error(`Failed to persist unconfigured project ${candidateId}`);
    }
    this.logEvent("project.unconfigured.created", {
      level: "info",
      projectId: candidateId,
      message: `Created unconfigured project ${candidateId}`,
      details: { displayName, prefix, path: absolutePath },
    });
    return { id: candidateId, entry: projectEntry, projects };
  }

  updateUnconfiguredProject(id: string, request: UpdateProjectRequest): UpdateProjectResponse {
    const displayName = request.displayName.trim();
    const prefix = request.prefix.trim();
    const rawPath = request.path.trim();
    if (!displayName || !rawPath) {
      throw new Error("displayName and path must be non-empty strings");
    }
    if (!PROJECT_ID_PATTERN.test(prefix)) {
      throw new Error(`prefix must match ${PROJECT_ID_PATTERN.source}`);
    }
    const absolutePath = resolvePath(expandHome(rawPath));
    if (!existsSync(absolutePath)) {
      throw new Error(`path does not exist: ${absolutePath}`);
    }
    if (!statSync(absolutePath).isDirectory()) {
      throw new Error(`path is not a directory: ${absolutePath}`);
    }

    const existingUnconfigured = this.listUnconfiguredProjects();
    if (!existingUnconfigured.some((entry) => entry.id === id)) {
      throw new SessionResourceNotFoundError(`Unknown unconfigured project: ${id}`);
    }
    const configuredPrefixes = Object.values(this.config.projects).map(
      (project) => project.sessionPrefix,
    );
    const duplicateUnconfigured = existingUnconfigured.find(
      (entry) => entry.id !== id && entry.prefix === prefix,
    );
    if (configuredPrefixes.includes(prefix) || duplicateUnconfigured) {
      throw new Error(`sessionPrefix "${prefix}" is already in use`);
    }

    addUnconfiguredProject(this.config.dataDir, {
      id,
      displayName,
      prefix,
      path: absolutePath,
    });

    const projects = this.listProjects();
    const projectEntry = projects.find((project) => project.id === id);
    if (!projectEntry) {
      throw new Error(`Failed to persist unconfigured project ${id}`);
    }
    this.logEvent("project.unconfigured.updated", {
      level: "info",
      projectId: id,
      message: `Updated unconfigured project ${id}`,
      details: { displayName, prefix, path: absolutePath },
    });
    return { id, entry: projectEntry, projects };
  }

  resolveConfiguredProjectConfigPath(projectId: string): string | undefined {
    const project = this.config.projects[projectId];
    if (!project) return undefined;
    for (const configPath of [this.bootstrapConfigPath, ...this.registryPaths]) {
      try {
        const candidate = loadProjectConfig(configPath);
        if (Object.prototype.hasOwnProperty.call(candidate.projects, projectId)) {
          return configPath;
        }
      } catch {
        // Skip configs that fail to load; another candidate may own the project.
      }
    }
    return undefined;
  }

  deleteUnconfiguredProject(id: string): DeleteProjectResponse {
    if (!this.listUnconfiguredProjects().some((entry) => entry.id === id)) {
      throw new SessionResourceNotFoundError(`Unknown unconfigured project: ${id}`);
    }
    removeUnconfiguredProject(this.config.dataDir, id);
    this.logEvent("project.unconfigured.removed", {
      level: "info",
      projectId: id,
      message: `Removed unconfigured project ${id}`,
    });
    return { removedKind: "unconfigured", projects: this.listProjects() };
  }

  info(): RuntimeInfo {
    return createRuntimeInfo(this.config, this.startedAt);
  }

  private logEvent(
    event: string,
    entry: Omit<SpurLogEntry, "event" | "timestamp"> & { timestamp?: string } = {
      level: "info",
    },
  ): void {
    logSpurEvent(this.config.dataDir, { event, ...entry });
  }

  private logUserInput(
    sessionId: string,
    projectId: string,
    input: {
      kind: UserInputKind;
      source: string;
      text: string;
      attachments?: StoredImageAttachment[];
    },
  ): void {
    logUserInputEvent(this.config.dataDir, {
      sessionId,
      projectId,
      kind: input.kind,
      source: input.source,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
  }

  private isLiveStateRateLimited(session: Pick<SessionRecord, "id" | "rateLimitedAt">): boolean {
    const liveState = this.stateHistory.get(session.id)?.at(-1)?.state;
    if (liveState !== undefined) {
      return liveState === "rate_limited";
    }
    // No classification has run for this session since the last daemon restart.
    // Fall back to the persisted, restart-safe marker instead of failing open —
    // a brand-new never-classified session naturally has rateLimitedAt unset.
    return session.rateLimitedAt !== undefined;
  }

  private async confirmClaudeUsageLimitMenu(
    session: Pick<SessionRecord, "id" | "project" | "tmuxSession">,
  ): Promise<void> {
    const now = Date.now();
    const lastSentAt = this.usageMenuConfirmedAt.get(session.id) ?? 0;
    if (now - lastSentAt < USAGE_LIMIT_MENU_CONFIRM_COOLDOWN_MS) {
      return;
    }
    this.usageMenuConfirmedAt.set(session.id, now);
    try {
      await sendSubmitKeyToTmux(session.tmuxSession);
      this.logEvent("session.rate_limit.usage_menu_confirmed", {
        level: "info",
        sessionId: session.id,
        projectId: session.project,
        message: `Confirmed the interactive usage-limit menu for ${session.id} (sent Enter for "Stop and wait for limit to reset")`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.usageMenuConfirmedAt.delete(session.id);
      this.logEvent("session.rate_limit.usage_menu_confirm_failed", {
        level: "error",
        sessionId: session.id,
        projectId: session.project,
        message: `Failed to confirm the usage-limit menu for ${session.id}: ${message}`,
      });
    }
  }

  private sessionAgentConfig(
    session: Pick<SessionRecord, "agent" | "id" | "restrictWrites">,
  ): ReturnType<typeof agentSessionConfig> {
    return agentSessionConfig(session.agent, {
      dataDir: this.config.dataDir,
      sessionId: session.id,
      restrictWrites: resolveRestrictWrites(session),
    });
  }

  private resolveClaudeAuthPlanOptions(
    session: Pick<SessionRecord, "agent" | "claudeAccountId" | "id">,
  ): { claudeConfigDir?: string } {
    return resolveClaudeAuthPlanOptions(this.config.dataDir, session);
  }

  private async withSidecarPortLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.sidecarPortLock;
    let release!: () => void;
    this.sidecarPortLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }

  // Keyed chained-promise lock, one entry per tmux pane with a send in
  // flight. Install `current` before the first await so two acquirers in
  // one turn chain instead of racing; delete only under the identity guard
  // so a waiter that already replaced the entry keeps its own (same idiom
  // as triggers.ts enqueue).
  private async withPaneWriteLock<T>(paneKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.paneWriteLocks.get(paneKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.paneWriteLocks.set(paneKey, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.paneWriteLocks.get(paneKey) === current) {
        this.paneWriteLocks.delete(paneKey);
      }
    }
  }

  private scheduleDeliveryRunner(sessionId: string): void {
    this.ensureDeliveryRunner(sessionId);
  }

  private startAttentionMonitor(): void {
    if (this.attentionMonitorTimer) {
      return;
    }
    void this.runAttentionMonitor(true);
    this.attentionMonitorTimer = setInterval(() => {
      void this.runAttentionMonitor(false);
    }, ATTENTION_POLL_INTERVAL_MS);
    this.attentionMonitorTimer.unref();
  }

  private async runAttentionMonitor(baseline: boolean): Promise<void> {
    try {
      await runGhPollCycle({ kind: "attention" }, () => this.pollAttentionStates(baseline));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.attention_monitor.failed", {
        level: "warn",
        message: `Attention monitor failed: ${message}`,
      });
    }
  }

  private async pollAttentionStates(baseline: boolean): Promise<void> {
    if (this.attentionMonitorRunning) {
      return;
    }
    this.attentionMonitorRunning = true;

    try {
      const nextStates = new Map<string, AttentionState>();
      const nextRunStates = new Map<string, SessionState>();
      const sessions = listSessions(this.config.dataDir).filter(
        (session) => !isTerminalSessionStatus(session.status),
      );
      // Run the sweep before the per-session loop, off this same liveIds
      // snapshot, so a session that throws below (see the per-session
      // try/catch) can never skip reclamation for the rest of the daemon's
      // life. Safe to run first: it only deletes/truncates ids ABSENT from
      // liveIds, so nothing the loop is about to populate for a live id is at
      // risk of being evicted on this same pass.
      const liveIds = new Set(sessions.map((session) => session.id));
      this.pruneSessionScopedState(liveIds);
      const claudeAccounts = this.computeClaudeAccountsView();
      this.prCheckGitSpentMs = 0;
      for (const session of sessions) {
        try {
          const view = await this.enrich(session, claudeAccounts);
          await this.checkPrForSession(session, view.state);
          const prevRunState = this.lastObservedRunStates.get(view.id);
          nextRunStates.set(view.id, view.state);
          if (!baseline && prevRunState === "working" && view.state === "waiting") {
            await this.maybeNudgeForgottenReply(view);
          }
          const attention: AttentionState | null =
            view.state === "needs_input"
              ? "needs_input"
              : view.state === "error"
                ? "error"
                : view.state === "rate_limited"
                  ? "rate_limited"
                  : null;
          if (!attention) {
            continue;
          }
          nextStates.set(view.id, attention);
          if (!baseline && this.attentionStates.get(view.id) !== attention) {
            await this.notifyAttention(view, attention);
          }
        } catch (error) {
          // Carry the previous tick's values forward so an aborted tick can
          // neither erase a still-current attention state (spurious
          // re-notify next tick) nor erase a still-current run state (a
          // working->waiting edge landing on the very next tick would
          // otherwise never see its "working" predecessor). Only carry
          // forward what was actually observed before; never invent one.
          const previousAttention = this.attentionStates.get(session.id);
          if (previousAttention !== undefined) {
            nextStates.set(session.id, previousAttention);
          }
          const previousRunState = this.lastObservedRunStates.get(session.id);
          if (previousRunState !== undefined) {
            nextRunStates.set(session.id, previousRunState);
          }
          const message = error instanceof Error ? error.message : String(error);
          this.logEvent("session.attention_monitor.session_failed", {
            level: "warn",
            sessionId: session.id,
            projectId: session.project,
            message: `Attention monitor skipped session ${session.id}: ${message}`,
          });
        }
      }
      // The sweep is the batch window: every PR lookup this sweep queued goes
      // out as one `gh api graphql` per repo instead of one call per branch.
      await flushPrLookups();
      this.attentionStates.clear();
      for (const [sessionId, attention] of nextStates) {
        this.attentionStates.set(sessionId, attention);
      }
      this.lastObservedRunStates.clear();
      for (const [sessionId, runState] of nextRunStates) {
        this.lastObservedRunStates.set(sessionId, runState);
      }
    } finally {
      this.attentionMonitorRunning = false;
    }
  }

  // Single sweep for session-scoped maps whose lifetime ends at terminal
  // status. Runs against the non-terminal id set pollAttentionStates already
  // computes, so its key set is bounded by "currently live sessions" instead
  // of "every session ever classified". Deliberately does not touch
  // dashboardCache, sessionProjectCache, stateHistory, or stateCache. Those
  // four follow the wider dashboard lifetime because completed and
  // killed+retainInList sessions are still enriched by its idle round-robin;
  // runDashboardCacheTick owns their pruning.
  private pruneSessionScopedState(liveIds: ReadonlySet<string>): void {
    for (const sessionId of this.codexMcpDialogOverrides.keys()) {
      if (!liveIds.has(sessionId)) {
        this.codexMcpDialogOverrides.delete(sessionId);
      }
    }
    for (const sessionId of this.claudeCompactingOverrides.keys()) {
      if (!liveIds.has(sessionId)) {
        this.claudeCompactingOverrides.delete(sessionId);
      }
    }
    for (const sessionId of this.lastClassifiedLogStates.keys()) {
      if (!liveIds.has(sessionId)) {
        this.lastClassifiedLogStates.delete(sessionId);
      }
    }
    for (const sessionId of this.claudeJsonlReaders.keys()) {
      if (!liveIds.has(sessionId)) {
        this.claudeJsonlReaders.delete(sessionId);
      }
    }
    for (const sessionId of this.cursorJsonlReaders.keys()) {
      if (!liveIds.has(sessionId)) {
        this.cursorJsonlReaders.delete(sessionId);
      }
    }
    for (const sessionId of this.codexRolloutReaders.keys()) {
      if (!liveIds.has(sessionId)) {
        this.codexRolloutReaders.delete(sessionId);
      }
    }
    for (const sessionId of this.prCheckTrackers.keys()) {
      if (!liveIds.has(sessionId)) {
        this.prCheckTrackers.delete(sessionId);
      }
    }
    for (const sessionId of this.usageMenuConfirmedAt.keys()) {
      if (!liveIds.has(sessionId)) {
        this.usageMenuConfirmedAt.delete(sessionId);
      }
    }
    for (const sessionId of this.claudeRotationEpisode.keys()) {
      if (!liveIds.has(sessionId)) {
        this.claudeRotationEpisode.delete(sessionId);
      }
    }
  }

  private startDashboardCacheLoop(): void {
    if (this.dashboardCacheTimer) {
      return;
    }
    this.dashboardCacheTimer = setInterval(() => {
      void this.runDashboardCacheTick();
    }, DASHBOARD_CACHE_INTERVAL_MS);
    this.dashboardCacheTimer.unref();
  }

  private stopDashboardCacheLoop(): void {
    if (this.dashboardCacheTimer) {
      clearInterval(this.dashboardCacheTimer);
      this.dashboardCacheTimer = null;
    }
  }

  private async runDashboardCacheTick(): Promise<void> {
    if (this.dashboardLoopRunning) {
      return;
    }
    this.dashboardLoopRunning = true;
    try {
      const sessions = listSessions(this.config.dataDir).filter((session) => {
        if (session.status === "completed") {
          return true;
        }
        return session.status !== "killed" || session.retainInList === true;
      });
      const includedIds = new Set(sessions.map((session) => session.id));
      const terminalIds = new Set(
        sessions
          .filter((session) => isTerminalSessionStatus(session.status))
          .map((session) => session.id),
      );

      // These caches serve dashboard enrichment, so their lifetime follows
      // includedIds rather than the attention monitor's non-terminal set.
      // Delete records that left the store/dashboard entirely. For retained
      // terminal records, keep the last history entry: deleting it would make
      // updateStateHistory re-enter its transition branch every tick, while
      // retaining the whole array would keep up to STATE_HISTORY_LIMIT entries.
      for (const [id, history] of this.stateHistory) {
        if (!includedIds.has(id)) {
          this.stateHistory.delete(id);
        } else if (terminalIds.has(id) && history.length > 1) {
          this.stateHistory.set(id, history.slice(-1));
        }
      }
      for (const id of this.stateCache.keys()) {
        if (!includedIds.has(id)) {
          this.stateCache.delete(id);
        }
      }

      // A session is due for enrichment when it can still change on its own
      // (isLiveSessionRecord), when its on-disk record object changed since
      // we last enriched it (recordChanged is exact object-identity
      // inequality, made free by listSessions' stat-gated parse cache — see
      // metadata.ts), or when it has no cached view yet. Everything else is
      // idle: its dashboard view can only drift from filesystem state, not
      // agent activity, so it only needs the bounded round-robin below.
      const due: SessionRecord[] = [];
      const idle: SessionRecord[] = [];
      let nextDashboardIdleCursor = this.dashboardIdleCursor;
      for (const session of sessions) {
        const recordChanged = this.dashboardEnrichedRecords.get(session.id) !== session;
        if (
          this.isLiveSessionRecord(session) ||
          recordChanged ||
          !this.dashboardCache.has(session.id)
        ) {
          due.push(session);
        } else {
          idle.push(session);
        }
      }

      // Bounded round-robin over the idle set: clamp(ceil(idle / SWEEP_TICKS),
      // MIN, MAX) least-recently-visited entries per tick via a rotating
      // cursor (O(1), no sort), so filesystem-only drift still eventually
      // surfaces. The quota scales with the idle set to hold the sweep period
      // near SWEEP_TICKS, and the MAX cap is what keeps the tick's cost
      // bounded by a constant rather than by the idle set's size.
      if (idle.length > 0) {
        const targetQuota = Math.ceil(idle.length / DASHBOARD_IDLE_REFRESH_SWEEP_TICKS);
        const clampedQuota = Math.min(
          DASHBOARD_IDLE_REFRESH_MAX_PER_TICK,
          Math.max(DASHBOARD_IDLE_REFRESH_MIN_PER_TICK, targetQuota),
        );
        const quota = Math.min(clampedQuota, idle.length);
        for (let offset = 0; offset < quota; offset += 1) {
          const roundRobinSession = idle[(this.dashboardIdleCursor + offset) % idle.length];
          if (roundRobinSession) {
            due.push(roundRobinSession);
          }
        }
        nextDashboardIdleCursor = (this.dashboardIdleCursor + quota) % idle.length;
      }

      const enriched = await Promise.all(due.map((session) => this.enrichDashboard(session)));
      for (const view of enriched) {
        this.dashboardCache.set(view.id, view);
      }
      // Store the pre-enrich listSessions reference, NOT the classified
      // session enrichDashboard derived. This map is only ever compared by
      // identity against the next tick's listSessions output, so it has to
      // hold objects from that same parse cache; a classified session is a
      // fresh object and would compare unequal every tick, making every
      // record look changed. Reconcile-driven disk writes are picked up by
      // the parse cache's inode check on the next listSessions, not from
      // anything stored here.
      for (const session of due) {
        this.dashboardEnrichedRecords.set(session.id, session);
      }
      this.dashboardIdleCursor = nextDashboardIdleCursor;

      // Prune off the enumerated+filtered set, never off the enriched
      // subset, so an idle entry that was seeded once and then never due
      // again is not evicted just because this tick skipped it.
      for (const id of this.dashboardCache.keys()) {
        if (!includedIds.has(id)) {
          this.dashboardCache.delete(id);
        }
      }
      // sessionProjectCache's consumer (resolveProjectForSession, via
      // enrich) is called from both ticks, so its retention has to match
      // the WIDER dashboard set, not pollAttentionStates' non-terminal
      // liveIds — a completed or killed+retainInList session still gets
      // enriched here by the idle round-robin long after it leaves the
      // attention monitor's live set. Pruning against liveIds would evict
      // its entry the tick after it goes terminal, forcing a fresh
      // YAML parse (and a re-logged parse failure) on every idle revisit.
      for (const id of this.sessionProjectCache.keys()) {
        if (!includedIds.has(id)) {
          this.sessionProjectCache.delete(id);
        }
      }
      for (const id of this.dashboardEnrichedRecords.keys()) {
        if (!includedIds.has(id)) {
          this.dashboardEnrichedRecords.delete(id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.dashboard_cache.failed", {
        level: "warn",
        message: `Dashboard cache tick failed: ${message}`,
      });
    } finally {
      this.dashboardLoopRunning = false;
    }
  }

  private startReaperLoop(): void {
    if (this.reaperTimer) {
      return;
    }
    this.reaperTimer = setInterval(() => {
      void this.reapOrphanedTmux();
    }, REAP_INTERVAL_MS);
    this.reaperTimer.unref();
  }

  // Safety net: a terminal (killed/completed/stopped) session's tmux is
  // supposed to already be gone, but restarts, crashes mid-teardown, or races
  // can leave it running. This periodically sweeps for that and kills the
  // orphan — but only after two probes, a second apart, both agree no agent
  // process is alive in it. A live agent under a terminal record is left
  // untouched (tmux and its sidecars alike) and flagged instead of killed:
  // killing a live session is the one mistake this loop must never make.
  private async reapOrphanedTmux(): Promise<void> {
    if (this.reaperRunning) {
      return;
    }
    this.reaperRunning = true;
    try {
      const sessions = listSessions(this.config.dataDir).filter(
        (session) =>
          REAPABLE_SESSION_STATUSES.has(session.status) && session.stopReason !== "manual_pause",
      );
      let reaped = 0;
      let liveUnderTerminal = 0;
      for (const session of sessions) {
        let agentAlive = false;
        if (await tmuxSessionExists(session.tmuxSession, { fresh: true })) {
          // A lone "process gone" read is inconclusive, not a verdict: a
          // transient tmux/ps failure reads exactly like an exited agent.
          // confirmAgentExited re-samples with fresh:true after a delay, so only
          // two probes agreeing authorize a kill — the same bar the pipeline
          // poller uses before erroring a session. The fresh existence check
          // above has already refilled the fleet snapshot its first read sees.
          agentAlive = !(await this.confirmAgentExited(session));
          if (agentAlive) {
            liveUnderTerminal += 1;
            this.logEvent("session.reaper.live_under_terminal", {
              level: "warn",
              sessionId: session.id,
              message: `Session ${session.id} has status "${session.status}" but its agent process is still running in tmux "${session.tmuxSession}"; leaving it untouched.`,
              details: { status: session.status },
            });
          } else {
            await killTmuxSession(session.tmuxSession);
            reaped += 1;
          }
        }
        if (agentAlive) {
          // Sidecars serve the agent still running in this tmux. Reaping them
          // under it breaks a live session as surely as killing its tmux would.
          continue;
        }
        // A desk-shared sidecar's pane is named after the desk anchor, so on a
        // terminal anchor this loop would otherwise reap the pane a live
        // sibling is still using. Same rule as teardownSessionSidecars: the
        // last running member releases it.
        const deskSiblingsAlive =
          (session.sidecarNames?.length ?? 0) > 0 && this.hasRunningWorkspaceMembers(session);
        // Resolved unconditionally (not only when deskSiblingsAlive): every
        // sidecar's owner id below needs it, since a desk-shared sidecar's
        // pane is named after the desk anchor/owner, never this session's
        // own id.
        let reapProject: ProjectConfig | undefined;
        try {
          reapProject = this.resolveProjectForSession(session);
        } catch {
          reapProject = undefined;
        }
        for (const sidecarName of session.sidecarNames ?? []) {
          const reapSidecar = reapProject?.sidecars[sidecarName];
          if (deskSiblingsAlive && reapSidecar !== undefined && !reapSidecar.mcp) {
            continue;
          }
          const ownerId = this.sidecarOwnerIdForName(session, reapProject, sidecarName);
          if (await sidecarTmuxAlive(ownerId, sidecarName)) {
            await this.reapSidecarByName(ownerId, sidecarName);
            this.clearSidecarProcEntry(ownerId, sidecarName);
            reaped += 1;
            continue;
          }
          // The owner's pane is already gone (e.g. a desk-shared pane a
          // sibling's own probe id could never see under the old
          // session.id-only probe); fall through to the recorded identity,
          // mirroring killSidecarAndUnlinkSlot.
          const owner = readSession(this.config.dataDir, ownerId);
          const identity = owner?.sidecarProcs?.[sidecarName];
          if (owner && identity) {
            const outcome = await reapRecordedIdentity(identity, owner.worktreePath);
            this.logSidecarReapSurvivors(ownerId, sidecarName, outcome);
            this.clearSidecarProcEntry(ownerId, sidecarName);
            reaped += 1;
          }
        }
      }
      if (reaped > 0 || liveUnderTerminal > 0) {
        this.logEvent("session.reaper.swept", {
          level: reaped > 0 ? "info" : "warn",
          message: `Reaper sweep: reaped ${reaped} orphaned tmux session(s), ${liveUnderTerminal} live-under-terminal anomaly(ies) flagged.`,
          details: { reaped, liveUnderTerminal },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.reaper.failed", {
        level: "warn",
        message: `Reaper sweep failed: ${message}`,
      });
    } finally {
      this.reaperRunning = false;
    }
  }

  private startSessionGcLoop(): void {
    if (this.sessionGcTimer) {
      return;
    }
    this.sessionGcTimer = setInterval(() => {
      void this.runSessionGcSweep();
    }, SESSION_GC_TICK_MS);
    this.sessionGcTimer.unref();
  }

  // Config-gated daemon sweep: off unless sessionGc.enabled is true, and both
  // that flag and intervalMinutes are re-read from this.config on every tick
  // (not cached at construction), so a config reload takes effect on the next
  // tick without a daemon restart. lastSessionGcSweepAt seeds from
  // construction time, so a restart never fires an immediate sweep.
  private async runSessionGcSweep(): Promise<void> {
    if (this.sessionGcRunning) {
      return;
    }
    const gcConfig = this.config.sessionGc;
    if (!gcConfig.enabled) {
      return;
    }
    if (Date.now() - this.lastSessionGcSweepAt < gcConfig.intervalMinutes * 60_000) {
      return;
    }
    this.sessionGcRunning = true;
    this.lastSessionGcSweepAt = Date.now();
    try {
      const sessions = listSessions(this.config.dataDir);
      const plan = planSessionGc({
        sessions,
        protectedSessionIds: new Set(
          sessions
            .filter((session) => this.isLiveSessionRecord(session))
            .map((session) => session.id),
        ),
        worktreeDir: this.config.worktreeDir,
        now: new Date(),
        olderThanDays: gcConfig.olderThanDays,
        statuses: gcConfig.statuses,
        limit: gcConfig.maxGroupsPerSweep,
        pathExists: (path) => workspaceExists(path),
      });
      // sizes: true so the sweep can report freed bytes; the du cost is bounded
      // by maxGroupsPerSweep, and only reclaim groups are measured.
      const report = await executeSessionGc(
        plan,
        createGcDeps(this.config, (session) => this.isLiveSessionRecord(session)),
        {
          dryRun: false,
          sizes: true,
        },
      );
      this.logEvent("session.gc.completed", {
        level: "info",
        message: `Session GC sweep: ${report.totals.worktreesRemoved} worktree(s) removed, ${report.totals.recordsArchived} record(s) archived, ${report.totals.freedBytes ?? 0} byte(s) freed.`,
        details: { totals: report.totals, sessionIds: report.groups.flatMap((g) => g.sessionIds) },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.gc.failed", {
        level: "warn",
        message: `Session GC sweep failed: ${message}`,
      });
    } finally {
      this.sessionGcRunning = false;
    }
  }

  private async refreshDashboardCacheEntry(record: SessionRecord): Promise<void> {
    try {
      const included =
        record.status === "completed"
          ? true
          : record.status !== "killed" || record.retainInList === true;
      if (!included) {
        this.dashboardCache.delete(record.id);
        return;
      }
      this.dashboardCache.set(record.id, await this.enrichDashboard(record));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.dashboard_cache.refresh_failed", {
        level: "warn",
        sessionId: record.id,
        message: `Dashboard cache refresh failed for ${record.id}: ${message}`,
      });
    }
  }

  /**
   * Resolves once this session's lookup is registered with the batch queue (or
   * ruled out), not once it has an answer. The caller awaits this per session
   * and then flushes the queue, so the whole sweep leaves as one query per
   * repo. The answer itself lands through the fire-and-forget run.
   */
  private async checkPrForSession(session: SessionRecord, state: SessionState): Promise<void> {
    // PR binding is workspace-owned: skip once any desk member already has
    // one. resolveWorkspaceState is the dual-read (workspace file, else the
    // legacy owning-record fallback) that replaces a plain anchor-record read.
    if (resolveWorkspaceState(this.config.dataDir, session).pr) {
      return;
    }
    // Skip terminal states
    if (isTerminalSessionStatus(session.status)) {
      return;
    }
    // Skip if no worktree
    if (!session.worktree || !session.worktreePath) {
      return;
    }
    // A removed worktree can never grow a PR. Sync stat, no spawn — mirrors the
    // GitHub review source's session filter. isGitWorktree is deliberately not
    // used here: it spawns git.
    if (!existsSync(session.worktreePath)) {
      return;
    }

    const tracker = this.prCheckTrackers.get(session.id) ?? {
      waitingChecks: 0,
      lastState: null,
      lastCheckAt: 0,
      found: false,
    };
    if (!this.prCheckTrackers.has(session.id)) {
      this.prCheckTrackers.set(session.id, tracker);
    }

    // Already found
    if (tracker.found) {
      return;
    }

    // Reset waitingChecks on state change
    if (tracker.lastState !== null && tracker.lastState !== state) {
      tracker.waitingChecks = 0;
      tracker.lastCheckAt = 0;
    }
    tracker.lastState = state;

    // Back off after limit in waiting with no state change
    if (state === "waiting" && tracker.waitingChecks >= PR_CHECK_WAITING_LIMIT) {
      return;
    }

    // Throttle between lookups. A running session keeps the 30s cadence; every
    // other status drops to the idle cadence, which is what the bulk of the
    // eligible set is.
    const live = session.status === "running";
    if (
      Date.now() - tracker.lastCheckAt <
      (live ? PR_CHECK_THROTTLE_MS : PR_CHECK_IDLE_THROTTLE_MS)
    ) {
      return;
    }
    const capMs = live ? PR_LOOKUP_LIVE_CAP_MS : PR_LOOKUP_IDLE_CAP_MS;

    // Persisted cache before any subprocess: a branch whose lookup is not due
    // must cost nothing at all, or the graphql burst is traded for a git one.
    const memo = tracker.discovery;
    if (
      memo &&
      Date.now() - memo.resolvedAt < PR_DISCOVERY_MEMO_TTL_MS &&
      memo.slug &&
      !isPrLookupDue(readPrLookupEntry(this.config.dataDir, memo.slug, memo.branch), capMs)
    ) {
      tracker.lastCheckAt = Date.now();
      return;
    }

    // Past here the sweep pays for git. Out of budget means "next sweep", with
    // the throttle deliberately left untouched.
    if (this.prCheckGitSpentMs >= PR_CHECK_GIT_BUDGET_MS) {
      return;
    }
    const gitStartedAt = Date.now();
    const discoveryBranch = await resolvePrDiscoveryBranch(session.worktreePath, session.branch);
    // git only, no GitHub budget, and memoized per worktree.
    const slug = await resolvePrLookupRepo(session.worktreePath);
    this.prCheckGitSpentMs += Date.now() - gitStartedAt;
    tracker.discovery = { branch: discoveryBranch, slug, resolvedAt: Date.now() };

    tracker.lastCheckAt = Date.now();
    if (
      slug &&
      !isPrLookupDue(readPrLookupEntry(this.config.dataDir, slug, discoveryBranch), capMs)
    ) {
      return;
    }
    // Counted here, not above: the waiting limit exists to stop repeated
    // lookups, so an attempt that performed none must not burn a slot.
    if (state === "waiting") {
      tracker.waitingChecks += 1;
    }

    // Fire and forget, but tracked so teardown can drain it — an unawaited
    // `gh` call outliving its caller lands on whatever runs next. The queue
    // registration inside is synchronous, so the caller's flush sees it.
    const run = this.runPrCheck(session, discoveryBranch, slug, capMs).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.pr_auto_detect.failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `PR auto-detect failed for ${session.id}: ${message}`,
      });
    });
    this.prCheckRuns.add(run);
    void run.finally(() => this.prCheckRuns.delete(run));
  }

  /**
   * Runs one session's queued lookup and keeps the persisted negative cache in
   * step. A skipped outcome remains distinct from "no PR" so it cannot advance
   * the cache; transport errors also let configured non-GitHub providers run.
   */
  private async resolveQueuedPrLookup(
    slug: PrRepoSlug,
    branch: string,
    worktreePath: string,
    capMs: number,
  ): Promise<PrLookupOutcome> {
    const claim = claimPollPrLookup({
      dataDir: this.config.dataDir,
      slug,
      branch,
      capMs,
    });
    if (claim.status === "cached") return claim.outcome;
    if (claim.status === "joined") return claim.outcome;
    let outcome: PrLookupOutcome = { status: "skipped", reason: "error" };
    try {
      outcome = await enqueuePrLookup({ slug, branch, worktreePath });
    } finally {
      claim.settle(outcome);
    }
    return outcome;
  }

  private async runPrCheck(
    session: SessionRecord,
    discoveryBranch: string,
    slug: PrRepoSlug | null,
    capMs: number,
  ): Promise<void> {
    // No GitHub remote: nothing to look up and nothing to cache, but the
    // non-github review providers still get their turn below.
    const outcome: PrLookupOutcome = slug
      ? await this.resolveQueuedPrLookup(slug, discoveryBranch, session.worktreePath, capMs)
      : { status: "absent" };
    // Budget/cancellation means no provider was attempted. A transport error
    // from a two-segment remote is different: arbitrary GitHub Enterprise
    // hostnames are valid, but the same syntax is also used by Gitea and other
    // forges. Let configured non-GitHub providers inspect that uncertain remote.
    if (outcome.status === "skipped" && outcome.reason !== "error") {
      return;
    }
    const binding = outcome.status === "found" ? prLookupBindingOf(outcome.pr) : null;
    // PR binding write lands on the workspace's own state so every desk
    // member shares it. `workspaceIdOf(session) === session.id` for a
    // non-desk session, so this is the same re-read as before (no extra IO
    // added there).
    const anchorId = workspaceIdOf(session);
    if (binding) {
      const tracker = this.prCheckTrackers.get(session.id);
      if (tracker) {
        tracker.found = true;
      }

      const current = readSession(this.config.dataDir, anchorId);
      if (!current?.worktreePath) {
        return;
      }
      const resolved = resolveWorkspaceState(this.config.dataDir, current);
      if (resolved.pr) {
        return;
      }

      const nextState: WorkspaceState = {
        ...(resolved.slots ? { slots: resolved.slots } : {}),
        pr: binding,
      };
      this.writeWorkspaceStateWithLegacyMirror(current, nextState);
      this.logEvent("session.pr_auto_detect.found", {
        level: "info",
        sessionId: session.id,
        projectId: session.project,
        message: `Auto-detected PR for ${session.id}: ${binding.url}`,
      });
      return;
    }

    const project = this.config.projects[session.project];
    const providerIds = (await orderedReviewProviderIds(session.worktreePath, project)).filter(
      (providerId) => providerId !== "github",
    );
    if (providerIds.length === 0) {
      return;
    }
    let reviewUrl: string | null = null;
    for (const providerId of providerIds) {
      reviewUrl = await reviewProvider(providerId).findReviewUrlByBranch(
        session.worktreePath,
        discoveryBranch,
      );
      if (reviewUrl) {
        break;
      }
    }
    if (!reviewUrl) return;

    const tracker = this.prCheckTrackers.get(session.id);
    if (tracker) {
      tracker.found = true;
    }

    // Re-read session to avoid stale overwrites
    const current = readSession(this.config.dataDir, anchorId);
    if (!current?.worktreePath) {
      return;
    }
    const resolved = resolveWorkspaceState(this.config.dataDir, current);
    if (resolved.pr) {
      return;
    }

    const slots = applySlotsUpdate(resolved.slots, {
      links: [{ label: "pr", url: reviewUrl }],
    });
    // No pr to preserve here: the early return above already covers
    // `resolved.pr` being set.
    const nextState: WorkspaceState = { ...(slots ? { slots } : {}) };
    this.writeWorkspaceStateWithLegacyMirror(current, nextState);
    this.logEvent("session.pr_auto_detect.found", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Auto-detected PR for ${session.id}: ${reviewUrl}`,
    });
  }

  private async notifyAttention(
    session: Pick<
      SessionView,
      "id" | "slots" | "error" | "tmuxSession" | "state" | "agent" | "project"
    >,
    attention: AttentionState,
  ): Promise<void> {
    const summary = session.slots?.title ? `${session.slots.title}\n` : "";
    const title =
      attention === "error"
        ? `Spur error [${session.id}]`
        : attention === "rate_limited"
          ? `Spur rate limited [${session.id}]`
          : `Spur needs input [${session.id}]`;
    const message =
      attention === "error"
        ? `${summary}${session.error ?? "Session errored."}\nRun \`spur list\` for details.`
        : attention === "rate_limited"
          ? `${summary}Agent hit a rate or usage limit.\nRun \`spur list\` for details.`
          : `${summary}Agent is waiting for a reply or approval.\nRun \`spur list\` to respond.`;
    await sendDesktopNotification({
      title,
      message,
      urgent: attention === "error",
    });

    const text =
      attention === "needs_input"
        ? `🔴 ${session.id} needs input${await this.buildPaneTail(session.tmuxSession).catch(() => "")}`
        : attention === "error"
          ? `⚫ ${session.id} error${await this.buildPaneTail(session.tmuxSession).catch(() => "")}`
          : `🟠 ${session.id} rate limited`;
    await this.pushTelegramNotice(session.id, session, text, { updateTopicName: true });
  }

  private resolveTelegramNotice(sessionId: string) {
    const target = readTelegramReplyTarget(this.config.dataDir, sessionId);
    if (!target) return null;
    const source = this.config.projects[target.projectId]?.sources[target.sourceId];
    if (!source || source.type !== "telegram") return null;
    return { target, source };
  }

  private logTelegramNoticeFailure(sessionId: string, context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logEvent("source.telegram.notify_failed", {
      level: "warn",
      sessionId,
      message: `Telegram ${context} failed for ${sessionId}: ${message}`,
    });
  }

  private async pushTelegramNotice(
    sessionId: string,
    topicSession: Pick<SessionView, "id" | "agent" | "state">,
    text: string,
    options: { updateTopicName?: boolean; closeTopic?: boolean } = {},
  ): Promise<void> {
    try {
      const resolved = this.resolveTelegramNotice(sessionId);
      if (!resolved) return;
      const { target, source } = resolved;
      await sendTelegramReply(source, target, text, { topicName: telegramTopicName(topicSession) });
      if (target.messageThreadId !== undefined && target.chatId < 0) {
        if (options.closeTopic) {
          await closeTelegramTopic(source, target.chatId, target.messageThreadId);
        } else if (options.updateTopicName) {
          await editTelegramTopic(
            source,
            target.chatId,
            target.messageThreadId,
            telegramTopicName(topicSession),
          );
        }
      }
    } catch (error) {
      this.logTelegramNoticeFailure(sessionId, "notice", error);
    }
  }

  private async buildPaneTail(tmuxSession: string): Promise<string> {
    const tail = (await captureTmuxPane(tmuxSession, ATTENTION_PANE_TAIL_LINES)).trim();
    return tail ? `\n\`\`\`\n${tail}\n\`\`\`` : "";
  }

  private async maybeNudgeForgottenReply(view: SessionView): Promise<void> {
    try {
      const resolved = this.resolveTelegramNotice(view.id);
      if (!resolved) return;
      const { target } = resolved;
      const alreadyReplied =
        target.lastReplyAt !== undefined &&
        (target.lastInboundAt === undefined || target.lastReplyAt >= target.lastInboundAt);
      if (alreadyReplied) return;
      const paneTail = await this.buildPaneTail(view.tmuxSession).catch(() => "");
      await this.pushTelegramNotice(view.id, view, `🟡 ${view.id} is waiting.${paneTail}`, {
        updateTopicName: true,
      });
      const { updatedAt: _updatedAt, ...rest } = target;
      writeTelegramReplyTarget(this.config.dataDir, {
        ...rest,
        lastReplyAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logTelegramNoticeFailure(view.id, "forgotten-reply nudge", error);
    }
  }

  private getProject(projectId: string): ProjectConfig {
    if (projectId === SHEPHERD_PROJECT_ID) {
      return buildShepherdProject(this.config.dataDir);
    }
    const project = this.config.projects[projectId];
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  private resolveProjectForSession(
    session: Pick<SessionRecord, "id" | "project" | "worktreePath">,
  ): ProjectConfig | undefined {
    if (session.project === SHEPHERD_PROJECT_ID) {
      return buildShepherdProject(this.config.dataDir);
    }
    const daemonProject = this.config.projects[session.project];
    // Only a config that lives in the session's own worktree counts. Walking
    // up the tree escapes a deleted or config-less worktree and lands on an
    // unrelated ancestor spur.yaml (the shared worktree root, say), which then
    // fails project-mode validation on every single call.
    const projectConfigPath = session.worktreePath
      ? findProjectConfigPathInDirectory(session.worktreePath)
      : undefined;
    if (!projectConfigPath) {
      this.sessionProjectCache.delete(session.id);
      return daemonProject;
    }

    // No stamp means the file went unreadable between the lookup and the stat.
    // Parse uncached that once rather than cache a lie; the next call either
    // resolves no path at all or gets a real stamp.
    const stamp = tryConfigStamp(projectConfigPath);
    const cached = this.sessionProjectCache.get(session.id);
    if (
      cached &&
      stamp !== undefined &&
      cached.configPath === projectConfigPath &&
      cached.stamp === stamp
    ) {
      return cached.project ?? daemonProject;
    }

    let localProject: ProjectConfig | undefined;
    try {
      localProject = loadProjectConfig(projectConfigPath, this.config).projects[session.project];
    } catch (error) {
      // Logged only on a cache miss, so a permanently broken config warns once
      // per (session, config stamp) instead of once per tick.
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.project_config.local.failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Failed to load local project config for ${session.id}: ${message}`,
      });
    }
    if (stamp !== undefined) {
      this.sessionProjectCache.set(session.id, {
        configPath: projectConfigPath,
        stamp,
        project: localProject,
      });
    }

    return localProject ?? daemonProject;
  }

  private releaseSidecarPortFromSession(
    sessionId: string,
    sidecarName: string,
    port: number,
  ): void {
    const other = readSession(this.config.dataDir, sessionId);
    const scPorts = other?.sidecarPorts?.[sidecarName];
    if (!other || !scPorts) {
      return;
    }
    const remaining = Object.fromEntries(
      Object.entries(scPorts).filter(([, reserved]) => reserved !== port),
    );
    const { [sidecarName]: _dropped, ...restSidecarPorts } = other.sidecarPorts ?? {};
    const nextSidecarPorts =
      Object.keys(remaining).length === 0
        ? restSidecarPorts
        : { ...restSidecarPorts, [sidecarName]: remaining };
    writeSession(this.config.dataDir, {
      ...other,
      sidecarPorts: nextSidecarPorts,
      updatedAt: nowIso(),
    });
  }

  private async ensureSidecarReservation(
    session: SessionRecord,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
    clearPort?: number,
  ): Promise<SessionRecord> {
    if (!sidecar.ports || Object.keys(sidecar.ports).length === 0) {
      if (clearPort !== undefined) {
        throw new InvalidClearPortError(
          `Port ${clearPort} is not configured for sidecar ${sidecarName}`,
        );
      }
      return session;
    }

    const currentSidecarPorts = session.sidecarPorts?.[sidecarName] ?? {};
    const keepReserved = new Set(Object.values(currentSidecarPorts));
    const unavailable = new Set<number>();

    if (clearPort !== undefined) {
      if (!Number.isInteger(clearPort) || clearPort < 1 || clearPort > 65_535) {
        throw new InvalidClearPortError(`Invalid clearPort: ${clearPort}`);
      }
      const configuredForSidecar = Object.values(sidecar.ports).some(
        (portConfig) => clearPort >= portConfig.start && clearPort <= portConfig.end,
      );
      if (!keepReserved.has(clearPort) && !configuredForSidecar) {
        throw new InvalidClearPortError(
          `Port ${clearPort} is not configured for sidecar ${sidecarName}`,
        );
      }
    }

    // Owner of every port currently held by a Spur service or session, used both
    // to skip selection and to label conflict candidates in the popup.
    const portOwnership = new Map<
      number,
      { owner: string; sessionId?: string; sidecarName?: string }
    >();
    for (const service of listServiceInstances(this.config.dataDir)) {
      if (service.port !== undefined) {
        unavailable.add(service.port);
        portOwnership.set(service.port, { owner: `service:${service.serviceId}` });
      }
    }
    // A terminal anchor still holds its shared sidecar ports while another
    // desk member's agent is still running (single listSessions snapshot,
    // O(N): a second pass would let a fresh session steal a shared port still
    // in use by a live sibling of a completed anchor).
    const allSessions = listSessions(this.config.dataDir);
    const liveDeskAnchors = new Set<string>();
    for (const candidate of allSessions) {
      if (candidate.status === "running" || candidate.status === "spawning") {
        liveDeskAnchors.add(workspaceIdOf(candidate));
      }
    }
    for (const liveSession of allSessions) {
      const holdsSidecarPorts =
        !isTerminalSessionStatus(liveSession.status) ||
        liveDeskAnchors.has(workspaceIdOf(liveSession));
      if (!holdsSidecarPorts) {
        continue;
      }
      for (const [scName, scPorts] of Object.entries(liveSession.sidecarPorts ?? {})) {
        for (const port of Object.values(scPorts)) {
          if (liveSession.id === session.id) {
            const reusable = scName === sidecarName && keepReserved.has(port);
            if (!reusable) {
              unavailable.add(port);
            }
            portOwnership.set(port, {
              owner: "self",
              sessionId: liveSession.id,
              sidecarName: scName,
            });
            continue;
          }
          unavailable.add(port);
          portOwnership.set(port, {
            owner: liveSession.id,
            sessionId: liveSession.id,
            sidecarName: scName,
          });
        }
      }
    }

    const buildRangeCandidates = (
      portId: string,
      portConfig: SidecarPortConfig,
    ): SidecarPortConflictCandidate[] => {
      const candidates: SidecarPortConflictCandidate[] = [];
      for (let port = portConfig.start; port <= portConfig.end; port += 1) {
        candidates.push({
          portId,
          env: portConfig.env,
          port,
          owner: portOwnership.get(port)?.owner ?? "external",
        });
      }
      return candidates;
    };

    // First pass: plan a reservation for every portId without mutating anything.
    // A cross-session teardown or host clear must never happen unless the whole
    // reservation will succeed, so any unsatisfiable portId throws before apply.
    type ReservationPlan =
      | { kind: "reuse" | "free"; env: string; port: number }
      | {
          kind: "clear";
          env: string;
          port: number;
          crossSession?: { sessionId: string; sidecarName: string };
        };
    const plans: ReservationPlan[] = [];
    const claimed = new Set<number>();
    const conflictCandidates: SidecarPortConflictCandidate[] = [];
    for (const [portId, portConfig] of Object.entries(sidecar.ports)) {
      const env = portConfig.env;
      const existingPort = currentSidecarPorts[env];

      // Reuse an existing reservation when the host port is still free.
      if (
        existingPort !== undefined &&
        !claimed.has(existingPort) &&
        (await isHostPortFree(existingPort))
      ) {
        plans.push({ kind: "reuse", env, port: existingPort });
        claimed.add(existingPort);
        continue;
      }

      // The user chose a specific port to clear within this range: assume the
      // clear resolves it (host clear, plus tearing down any owning session).
      if (
        clearPort !== undefined &&
        clearPort >= portConfig.start &&
        clearPort <= portConfig.end &&
        !claimed.has(clearPort)
      ) {
        const ownership = portOwnership.get(clearPort);
        const crossSession =
          ownership?.sessionId &&
          ownership.sessionId !== session.id &&
          ownership.sidecarName !== undefined
            ? { sessionId: ownership.sessionId, sidecarName: ownership.sidecarName }
            : undefined;
        plans.push({
          kind: "clear",
          env,
          port: clearPort,
          ...(crossSession ? { crossSession } : {}),
        });
        claimed.add(clearPort);
        continue;
      }

      // Scan the range for a free, unclaimed port.
      let selectedPort: number | undefined;
      for (let candidate = portConfig.start; candidate <= portConfig.end; candidate += 1) {
        if (claimed.has(candidate) || unavailable.has(candidate)) continue;
        if (!(await isHostPortFree(candidate))) continue;
        selectedPort = candidate;
        break;
      }
      if (selectedPort !== undefined) {
        plans.push({ kind: "free", env, port: selectedPort });
        claimed.add(selectedPort);
        continue;
      }

      // Whole range occupied: offer every occupied port for the user to clear.
      conflictCandidates.push(...buildRangeCandidates(portId, portConfig));
    }

    if (conflictCandidates.length > 0) {
      throw new SidecarPortConflictError(sidecarName, conflictCandidates);
    }

    // Second pass: apply the plan now that the full reservation is known to
    // succeed, so no destructive side effect runs for a doomed reservation.
    const reservedForSidecar: Record<string, number> = {};
    let changed = false;
    for (const plan of plans) {
      if (plan.kind === "clear") {
        if (plan.crossSession) {
          this.abortSidecarUrlProbe(plan.crossSession.sessionId, plan.crossSession.sidecarName);
          await this.reapSidecarByName(plan.crossSession.sessionId, plan.crossSession.sidecarName);
          this.clearSidecarProcEntry(plan.crossSession.sessionId, plan.crossSession.sidecarName);
          this.releaseSidecarPortFromSession(
            plan.crossSession.sessionId,
            plan.crossSession.sidecarName,
            plan.port,
          );
        }
        await clearPortListener(plan.port);
        reservedForSidecar[plan.env] = plan.port;
        changed = true;
        continue;
      }
      reservedForSidecar[plan.env] = plan.port;
      if (plan.kind === "free") {
        changed = true;
      }
    }

    if (!changed) {
      return session;
    }

    const updated: SessionRecord = {
      ...session,
      sidecarPorts: {
        ...(session.sidecarPorts ?? {}),
        [sidecarName]: {
          ...currentSidecarPorts,
          ...reservedForSidecar,
        },
      },
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    return updated;
  }
  private async startSidecarInternal(args: {
    session: SessionRecord;
    project: ProjectConfig;
    sidecarName: string;
    sidecar: ProjectConfig["sidecars"][string];
    sidecarDepth: number;
    clearPort?: number;
  }): Promise<SessionRecord> {
    return this.withSidecarPortLock(async () => {
      const tmuxName = sidecarTmuxSession(args.session.id, args.sidecarName);
      const alive = await sidecarTmuxAlive(args.session.id, args.sidecarName);
      // `remain-on-exit` leaves a `pane_dead=1` pane that still reports
      // "session exists" — that pane's escapee tree can hold a reserved port
      // forever unless treated as not-alive here and reaped before restart.
      const paneDead = alive && (await tmuxPaneDead(tmuxName, { fresh: true }));
      if (alive && !paneDead) {
        if (this.shouldScheduleSidecarUrlProbe(args.session, args.sidecarName, args.sidecar)) {
          this.scheduleSidecarUrlReadyAndPublish(
            args.session.id,
            args.sidecarName,
            args.sidecar,
            args.session,
          );
        }
        return args.session;
      }
      if (paneDead) {
        await this.reapSidecarByName(args.session.id, args.sidecarName);
        this.clearSidecarProcEntry(args.session.id, args.sidecarName);
      } else if (!alive) {
        // tmux session/window is gone entirely (killed externally, crashed)
        // rather than merely pane-dead. Mirrors killSidecarAndUnlinkSlot:
        // fall through to the recorded sidecarProcs identity — the exact
        // leak shape reapRecordedIdentity targets — before reserving the
        // port for a new instance, or a still-live escapee tree from the
        // old instance keeps running under the reused port.
        const owner = readSession(this.config.dataDir, args.session.id);
        const identity = owner?.sidecarProcs?.[args.sidecarName];
        if (owner && identity) {
          const outcome = await reapRecordedIdentity(identity, owner.worktreePath);
          this.logSidecarReapSurvivors(args.session.id, args.sidecarName, outcome);
        }
        this.clearSidecarProcEntry(args.session.id, args.sidecarName);
      }

      // Built-ins may defer command resolution (e.g. a bundle-resolved bin
      // path) to this point instead of config load — see BuiltinSidecarDef.
      const resolvedCommand =
        BUILTIN_SIDECARS[args.sidecarName]?.resolveCommand?.() ?? args.sidecar.command;

      const agentConfig = this.sessionAgentConfig(args.session);
      const reservedSession = await this.ensureSidecarReservation(
        args.session,
        args.sidecarName,
        args.sidecar,
        args.clearPort,
      );

      const existingToolDir = join(this.config.dataDir, "session-tools", reservedSession.id);
      const sessionToolDir = existsSync(existingToolDir)
        ? existingToolDir
        : this.prepareSessionTools(
            reservedSession.id,
            reservedSession.agent,
            reservedSession.project,
          );
      const sessionEnv = buildSessionEnv({
        agent: reservedSession.agent,
        projectId: reservedSession.project,
        sessionId: reservedSession.id,
        artifactsSessionId: workspaceIdOf(reservedSession),
        sessionToolDir,
        dataDir: this.config.dataDir,
        repoPath: args.project.path,
        symlinks: args.project.symlinks,
        ...(agentConfig.env ? { extraEnv: agentConfig.env } : {}),
      });

      try {
        await createTmuxSidecarSession({
          sessionId: reservedSession.id,
          sidecarName: args.sidecarName,
          cwd: reservedSession.worktreePath,
          command: resolvedCommand,
          env: buildSidecarRuntimeEnv(
            sessionEnv,
            reservedSession,
            args.sidecarName,
            args.sidecar.env,
            args.sidecarDepth,
          ),
        });
        await verifySidecarStartup(reservedSession.id, args.sidecarName);

        // Record this instance's identity so a tree that outlives its
        // tmux supervisor is still identifiable and reapable later — see
        // SidecarProcessIdentity. Best-effort: a pid/starttime read failing
        // (race, no procfs) leaves sidecarProcs unset for this name rather
        // than blocking the start.
        const freshPanePid = await getTmuxPanePid(
          sidecarTmuxSession(reservedSession.id, args.sidecarName),
          { fresh: true },
        );
        const starttime = freshPanePid !== null ? await readProcessStarttime(freshPanePid) : null;
        const identity: SidecarProcessIdentity | undefined =
          freshPanePid !== null && starttime !== null
            ? { pid: freshPanePid, pgid: freshPanePid, starttime }
            : undefined;

        const sidecarNames = sessionSidecarNames(reservedSession, args.project);
        // clearSidecarProcEntry above already dropped this name from disk
        // when the pane was dead or the tmux session was gone —
        // reservedSession can still be a stale
        // in-memory copy from before that write (ensureSidecarReservation
        // returns the untouched `session` param when the sidecar has no
        // ports to reserve). Build sidecarProcs explicitly rather than
        // trusting the `...reservedSession` spread, so an unreadable
        // identity persists as cleared instead of resurrecting the stale
        // pgid clearSidecarProcEntry just removed.
        const sidecarProcsWithoutStale = Object.fromEntries(
          Object.entries(reservedSession.sidecarProcs ?? {}).filter(
            ([name]) => name !== args.sidecarName,
          ),
        );
        const nextSidecarProcs = identity
          ? { ...sidecarProcsWithoutStale, [args.sidecarName]: identity }
          : sidecarProcsWithoutStale;
        const updated: SessionRecord = {
          ...reservedSession,
          updatedAt: nowIso(),
          ...(sidecarNames.includes(args.sidecarName)
            ? {}
            : { sidecarNames: [...sidecarNames, args.sidecarName] }),
        };
        if (Object.keys(nextSidecarProcs).length > 0) {
          updated.sidecarProcs = nextSidecarProcs;
        } else {
          delete updated.sidecarProcs;
        }
        writeSession(this.config.dataDir, updated);
        this.scheduleSidecarUrlReadyAndPublish(
          reservedSession.id,
          args.sidecarName,
          args.sidecar,
          updated,
        );
        return readSession(this.config.dataDir, updated.id) ?? updated;
      } catch (error) {
        await this.reapSidecarByName(reservedSession.id, args.sidecarName);
        this.clearSidecarProcEntry(reservedSession.id, args.sidecarName);
        const baseRecord =
          reservedSession !== args.session
            ? args.session
            : (readSession(this.config.dataDir, args.session.id) ?? args.session);
        const resolved = resolveWorkspaceState(this.config.dataDir, baseRecord);
        const nextSlots = this.withUnlinkedSidecarSlot(resolved.slots, args.sidecarName);
        const slotsChanged = nextSlots !== resolved.slots;
        if (reservedSession !== args.session || slotsChanged) {
          // Rolls the reserved-port state back off this session's own record.
          writeSession(this.config.dataDir, { ...baseRecord, updatedAt: nowIso() });
        }
        if (slotsChanged) {
          this.writeWorkspaceStateWithLegacyMirror(
            baseRecord,
            {
              ...(nextSlots ? { slots: nextSlots } : {}),
              ...(resolved.pr ? { pr: resolved.pr } : {}),
            },
            { touchUpdatedAt: true },
          );
        }
        throw error;
      }
    });
  }

  // Pre-launch pass for sidecars that must exist before the agent's launch
  // plan is built (their reserved port feeds launch-time MCP config). Starts
  // every project-configured, agent-eligible, autoStart sidecar carrying
  // `mcp` (reserves a loopback port, launches the tracked tmux sidecar,
  // idempotent), best-effort waits for the built-in's own readiness probe,
  // and returns the SidecarMcpBinding[] to hand to the agent's launch plan.
  // Logs and continues (no binding for that sidecar) on start failure.
  private async startMcpSidecars(
    session: SessionRecord,
    project: ProjectConfig,
  ): Promise<{ session: SessionRecord; mcpBindings: SidecarMcpBinding[] }> {
    const mcpSidecars = Object.fromEntries(
      Object.entries(resolveSessionSidecars(session, project)).filter(
        ([, sidecar]) => sidecar.mcp && sidecar.autoStart,
      ),
    );
    let updated = session;
    for (const [name, sidecar] of Object.entries(mcpSidecars)) {
      try {
        updated = await this.startSidecarInternal({
          session: updated,
          project,
          sidecarName: name,
          sidecar,
          sidecarDepth: ROOT_SIDECAR_DEPTH,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.sidecar.autostart.failed", {
          level: "warn",
          sessionId: session.id,
          projectId: session.project,
          message: `Auto-start sidecar ${name} failed for ${session.id}: ${message}`,
        });
        continue;
      }
      const readiness = BUILTIN_SIDECARS[name]?.readiness;
      const portConfig = sidecar.mcp && sidecar.ports?.[sidecar.mcp.portId];
      const port = portConfig ? updated.sidecarPorts?.[name]?.[portConfig.env] : undefined;
      if (readiness && typeof port === "number") {
        const ready = await readiness(port);
        if (!ready) {
          this.logEvent("session.sidecar.mcp_not_ready", {
            level: "warn",
            sessionId: session.id,
            projectId: session.project,
            message: `MCP sidecar ${name} not ready on port ${port} for ${session.id}; continuing`,
            details: { sidecarName: name, port },
          });
        }
      }
    }
    return { session: updated, mcpBindings: collectMcpBindings(mcpSidecars, updated.sidecarPorts) };
  }

  /**
   * Carry the freshly-reserved sidecar fields (written inline by
   * startSidecarInternal) onto a record that is rebuilt from a pre-sidecar
   * in-memory snapshot, so the later writeSession does not clobber them.
   */
  private applyReservedSidecars(base: SessionRecord, update: SessionRecord): SessionRecord {
    return {
      ...base,
      ...(update.sidecarPorts ? { sidecarPorts: update.sidecarPorts } : {}),
      ...(update.sidecarNames ? { sidecarNames: update.sidecarNames } : {}),
    };
  }

  private scheduleSidecarUrlReadyAndPublish(
    sessionId: string,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
    record: SessionRecord,
  ): void {
    const link = this.resolveSidecarUrlLink(record, sidecarName, sidecar);
    if (!link) return;
    const key = this.sidecarUrlProbeKey(sessionId, sidecarName);
    this.abortSidecarUrlProbe(sessionId, sidecarName);
    const controller = new AbortController();
    this.sidecarUrlProbeControllers.set(key, controller);

    void this.waitForSidecarHttpReady({
      sessionId,
      sidecarName,
      reservedPort: link.reservedPort,
      signal: controller.signal,
    })
      .then(() => this.publishSidecarLink(sessionId, sidecarName, link.reservedPort, link.linkUrl))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const latest = readSession(this.config.dataDir, sessionId);
        if (error instanceof SidecarUrlProbeSidecarExitedError) {
          this.writeSessionWithUnlinkedSidecarSlot(sessionId, sidecarName);
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.sidecar.link_probe.failed", {
          level: "warn",
          sessionId,
          projectId: latest?.project ?? link.projectId,
          message: `Sidecar link probe ${sidecarName} failed for ${sessionId}: ${message}`,
          details: { sidecarName },
        });
      })
      .finally(() => {
        if (this.sidecarUrlProbeControllers.get(key) === controller) {
          this.sidecarUrlProbeControllers.delete(key);
        }
      });
  }

  private sidecarUrlProbeKey(sessionId: string, sidecarName: string): string {
    return `${sessionId}\0${sidecarName}`;
  }

  private abortSidecarUrlProbe(sessionId: string, sidecarName: string): void {
    const key = this.sidecarUrlProbeKey(sessionId, sidecarName);
    const controller = this.sidecarUrlProbeControllers.get(key);
    if (!controller) return;
    controller.abort();
    this.sidecarUrlProbeControllers.delete(key);
  }

  private resolveSidecarUrlLink(
    record: SessionRecord,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
  ): { projectId: string; reservedPort: number; linkUrl: string } | undefined {
    const urlPort = Object.values(sidecar.ports ?? {}).find((port) => port.url !== undefined);
    const url = urlPort?.url;
    if (!urlPort || url === undefined) return undefined;
    const reservedPort = record.sidecarPorts?.[sidecarName]?.[urlPort.env];
    if (typeof reservedPort !== "number") return undefined;
    return {
      projectId: record.project,
      reservedPort,
      linkUrl: buildSidecarLinkUrl(url, reservedPort),
    };
  }

  private shouldScheduleSidecarUrlProbe(
    record: SessionRecord,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
  ): boolean {
    const link = this.resolveSidecarUrlLink(record, sidecarName, sidecar);
    if (!link) return false;
    const resolved = resolveWorkspaceState(this.config.dataDir, record);
    return !resolved.slots?.links.some(
      (slotLink) => slotLink.label === sidecarName && slotLink.url === link.linkUrl,
    );
  }

  // Pure slots transform: drops the named sidecar's link if present. Callers
  // own resolving the current (workspace-file-or-legacy) slots and writing
  // the result back to both the workspace file and the legacy mirror.
  private withUnlinkedSidecarSlot(
    slots: SessionSlots | undefined,
    sidecarName: string,
  ): SessionSlots | undefined {
    if (!slots?.links.some((link) => link.label === sidecarName)) {
      return slots;
    }
    return applySlotsUpdate(slots, { unlinkLabels: [sidecarName] });
  }

  private writeSessionWithUnlinkedSidecarSlot(
    sessionId: string,
    sidecarName: string,
  ): SessionRecord | undefined {
    const latest = readSession(this.config.dataDir, sessionId);
    if (!latest) return undefined;
    // The link belongs to the workspace, not to this session: a member going
    // terminal while its probe was in flight must still drop the dead
    // sidecar's link, or it lingers on every live member's page. Only a
    // workspace with nobody left to see it is left alone.
    const terminal = isTerminalSessionStatus(latest.status);
    if (terminal && !this.hasActiveWorkspaceMembers(latest)) return latest;
    const resolved = resolveWorkspaceState(this.config.dataDir, latest);
    const nextSlots = this.withUnlinkedSidecarSlot(resolved.slots, sidecarName);
    if (nextSlots === resolved.slots) return latest;
    this.writeWorkspaceStateWithLegacyMirror(
      latest,
      {
        ...(nextSlots ? { slots: nextSlots } : {}),
        ...(resolved.pr ? { pr: resolved.pr } : {}),
      },
      // A terminal record keeps its timestamps: bumping them would move it in
      // activity-ordered views for a cleanup it did not do.
      { touchUpdatedAt: !terminal },
    );
    return withSessionSlots(latest, nextSlots);
  }

  // Resolves the record that owns a sidecar's tmux pane and reserved ports:
  // the in-hand record itself for a per-session (mcp) sidecar or a non-desk
  // session (zero extra IO — sidecarOwnerId returns session.id unchanged),
  // else a fresh read of the desk anchor's own record. Session records are
  // never deleted from the store, so a missing anchor is an invariant break,
  // not a fallback case.
  private resolveSidecarOwnerRecord(
    session: SessionRecord,
    sidecar: Pick<SidecarConfig, "mcp">,
  ): SessionRecord {
    const ownerId = sidecarOwnerId(session, sidecar);
    if (ownerId === session.id) {
      return session;
    }
    const anchor = readSession(this.config.dataDir, ownerId);
    if (!anchor) {
      throw new Error(
        `Desk anchor session ${ownerId} not found (owner of sidecar for ${session.id})`,
      );
    }
    return anchor;
  }

  // Owner id for a sidecar known only by name. A name with no config entry
  // (a stale `session.sidecarNames` whose sidecar was dropped from the
  // project since) resolves to the session itself — nothing proves it is
  // desk-shared.
  private sidecarOwnerIdForName(
    session: SessionRecord,
    project: ProjectConfig | undefined,
    sidecarName: string,
  ): string {
    const sidecar = project?.sidecars[sidecarName];
    return sidecar ? sidecarOwnerId(session, sidecar) : session.id;
  }

  private async startSidecarWithDependencies(args: {
    session: SessionRecord;
    project: ProjectConfig;
    sidecarName: string;
    sidecarDepth: number;
    clearPort?: number;
    onStarted: (name: string, sidecar: ProjectConfig["sidecars"][string]) => void;
  }): Promise<SessionRecord> {
    let currentSession = args.session;
    const visited = new Set<string>();

    const start = async (sidecarName: string, clearPort?: number): Promise<void> => {
      if (visited.has(sidecarName)) return;
      visited.add(sidecarName);

      const sidecar = args.project.sidecars[sidecarName];
      if (!sidecar) {
        throw new Error(
          `Project ${args.session.project} has no sidecar "${sidecarName}" configured`,
        );
      }

      for (const dependency of sidecar.dependsOn ?? []) {
        await start(dependency);
      }

      // Non-mcp project sidecars are desk-shared: the owner is the anchor's
      // own record (self for mcp sidecars and non-desk sessions), and
      // startSidecarInternal operates entirely on that owner record. Only
      // when the caller IS the owner does the running chain (and the value
      // this function returns, persisted onto the caller's own record by
      // every call site) get updated — a sibling starting an anchor-owned
      // sidecar must get its own record back unchanged, never the anchor's.
      const owner = this.resolveSidecarOwnerRecord(currentSession, sidecar);
      const wasAlive = await sidecarTmuxAlive(owner.id, sidecarName);
      const updated = await this.startSidecarInternal({
        session: owner,
        project: args.project,
        sidecarName,
        sidecar,
        sidecarDepth: args.sidecarDepth,
        ...(clearPort !== undefined ? { clearPort } : {}),
      });
      if (owner.id === currentSession.id) {
        currentSession = updated;
      }
      if (!wasAlive) {
        args.onStarted(sidecarName, sidecar);
      }
    };

    await start(args.sidecarName, args.clearPort);
    return currentSession;
  }

  private async waitForSidecarHttpReady(args: {
    sessionId: string;
    sidecarName: string;
    reservedPort: number;
    signal: AbortSignal;
  }): Promise<void> {
    const { sessionId, sidecarName, reservedPort, signal } = args;
    const targetUrl = `http://127.0.0.1:${reservedPort}/`;
    for (let i = 0; i < SIDECAR_PROBE_BUDGET_ITERATIONS; i += 1) {
      signal.throwIfAborted();
      try {
        await fetch(targetUrl, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(SIDECAR_PROBE_REQUEST_TIMEOUT_MS)]),
          redirect: "manual",
        });
        return;
      } catch {
        signal.throwIfAborted();
        if (
          i % SIDECAR_PROBE_LIVENESS_CHECK_INTERVAL === 0 &&
          !(await sidecarTmuxAlive(sessionId, sidecarName))
        ) {
          throw new SidecarUrlProbeSidecarExitedError(sidecarName);
        }
        await sleep(SIDECAR_PROBE_INTERVAL_MS, undefined, { signal });
      }
    }
    if (!(await sidecarTmuxAlive(sessionId, sidecarName))) {
      throw new SidecarUrlProbeSidecarExitedError(sidecarName);
    }
    throw new Error(`Sidecar ${sidecarName} did not respond at ${targetUrl} within probe budget`);
  }

  private async publishSidecarLink(
    sessionId: string,
    sidecarName: string,
    reservedPort: number,
    linkUrl: string,
  ): Promise<void> {
    const latest = readSession(this.config.dataDir, sessionId);
    if (!latest) return;
    if (isTerminalSessionStatus(latest.status)) return;
    if (!(await sidecarTmuxAlive(sessionId, sidecarName))) return;
    const resolved = resolveWorkspaceState(this.config.dataDir, latest);
    const slots = applySlotsUpdate(resolved.slots, {
      links: [{ label: sidecarName, url: linkUrl }],
      unlinkLabels: [],
    });
    this.writeWorkspaceStateWithLegacyMirror(latest, {
      ...(slots ? { slots } : {}),
      ...(resolved.pr ? { pr: resolved.pr } : {}),
    });
    this.logEvent("session.sidecar.link.published", {
      level: "info",
      sessionId,
      projectId: latest.project,
      message: `Published sidecar link ${sidecarName} for ${sessionId}`,
      details: { sidecarName, url: linkUrl, reservedPort },
    });
  }

  private async resolveCleanupContext(session: SessionRecord): Promise<SessionCleanupContext> {
    return resolveSessionCleanupContext(this.config.projects, session);
  }

  private requireSessionMemorySession(sessionId: string, key?: string): void {
    assertValidSessionMemoryTarget(sessionId, key);
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private ensureStateSubscriptionIndex(): void {
    if (this.stateSubscriptionIndexReady) {
      return;
    }
    this.stateSubscriptionIndex.clear();
    for (const session of listSessions(this.config.dataDir)) {
      for (const subscription of session.stateSubscriptions ?? []) {
        let subscribers = this.stateSubscriptionIndex.get(subscription.targetSessionId);
        if (!subscribers) {
          subscribers = new Set();
          this.stateSubscriptionIndex.set(subscription.targetSessionId, subscribers);
        }
        subscribers.add(session.id);
      }
    }
    this.stateSubscriptionIndexReady = true;
  }

  private syncStateSubscriptionIndex(
    subscriberId: string,
    oldSubscriptions: SessionStateSubscription[],
    newSubscriptions: SessionStateSubscription[],
  ): void {
    this.ensureStateSubscriptionIndex();
    const oldTargets = new Set(
      oldSubscriptions.map((subscription) => subscription.targetSessionId),
    );
    const newTargets = new Set(
      newSubscriptions.map((subscription) => subscription.targetSessionId),
    );
    for (const targetSessionId of oldTargets) {
      if (!newTargets.has(targetSessionId)) {
        const subscribers = this.stateSubscriptionIndex.get(targetSessionId);
        if (subscribers) {
          subscribers.delete(subscriberId);
          if (subscribers.size === 0) {
            this.stateSubscriptionIndex.delete(targetSessionId);
          }
        }
      }
    }
    for (const targetSessionId of newTargets) {
      let subscribers = this.stateSubscriptionIndex.get(targetSessionId);
      if (!subscribers) {
        subscribers = new Set();
        this.stateSubscriptionIndex.set(targetSessionId, subscribers);
      }
      subscribers.add(subscriberId);
    }
  }

  private writeStateSubscriptions(
    subscriber: SessionRecord,
    stateSubscriptions: SessionStateSubscription[],
    updatedAt = nowIso(),
  ): void {
    this.syncStateSubscriptionIndex(
      subscriber.id,
      subscriber.stateSubscriptions ?? [],
      stateSubscriptions,
    );
    const { stateSubscriptions: _removed, ...base } = subscriber;
    writeSession(this.config.dataDir, {
      ...base,
      ...(stateSubscriptions.length > 0 ? { stateSubscriptions } : {}),
      updatedAt,
    });
  }

  async list(options?: {
    includeCompleted?: boolean;
    view?: "full" | "dashboard";
  }): Promise<SessionListView[]> {
    if (options?.view === "dashboard") {
      if (this.dashboardCacheReady) {
        await this.dashboardCacheReady;
      }
      return Array.from(this.dashboardCache.values()).filter((view) => {
        if (view.status === "completed") {
          return options.includeCompleted === true || view.retainInList === true;
        }
        return view.status !== "killed" || view.retainInList === true;
      });
    }
    const allSessions = listSessions(this.config.dataDir);
    const sessions = allSessions.filter((session) => {
      if (session.status === "completed") {
        return options?.includeCompleted === true || session.retainInList === true;
      }
      return session.status !== "killed" || session.retainInList === true;
    });
    // Compute the claude accounts snapshot once for the whole batch instead of
    // per-session inside enrich (N listAccounts reads + N×M existsSync).
    const claudeAccounts = this.computeClaudeAccountsView();
    const views = await Promise.all(
      sessions.map((session) => this.enrich(session, claudeAccounts, allSessions)),
    );
    return views;
  }

  async get(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    return this.enrich(session);
  }

  listAvailableBacklog(): AvailableBacklogItem[] {
    const items: AvailableBacklogItem[] = [];
    for (const [projectId, project] of Object.entries(this.config.projects)) {
      for (const backlogId of Object.keys(project.backlog)) {
        items.push(...readAvailableBacklogItems(this.config.dataDir, projectId, backlogId));
      }
    }
    return items;
  }

  listStateSubscriptions(subscriberId: string): SessionStateSubscriptionListResponse {
    const subscriber = this.requireSession(subscriberId);
    return { records: subscriber.stateSubscriptions ?? [] };
  }

  // Shared by subscribeToSessionStates (one entry, writes immediately) and
  // applyRequestedStateSubscriptions (N entries, accumulated in memory and
  // written once) so both stay on the same validation/merge rules.
  private buildNextStateSubscriptions(
    subscriberId: string,
    existing: SessionStateSubscription[],
    request: SubscribeSessionStatesRequest,
    now: string,
  ): { record: SessionStateSubscription; nextSubscriptions: SessionStateSubscription[] } {
    const targetSessionId = request.targetSessionId.trim();
    if (!targetSessionId) {
      throw new InvalidSessionSubscriptionInputError("targetSessionId must be a non-empty string");
    }
    this.requireSession(targetSessionId);
    if (subscriberId === targetSessionId) {
      throw new InvalidSessionSubscriptionInputError("session cannot subscribe to itself");
    }
    const states = canonicalSubscriptionStates(request.states);
    const message = request.message?.trim();
    const id = stateSubscriptionId(targetSessionId);
    const previous = existing.find(
      (subscription) => subscription.targetSessionId === targetSessionId,
    );
    const record: SessionStateSubscription = {
      id,
      targetSessionId,
      states,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(message ? { message } : {}),
      ...(previous?.lastDeliveredTransitionId
        ? { lastDeliveredTransitionId: previous.lastDeliveredTransitionId }
        : {}),
      ...(previous?.lastDeliveredAt ? { lastDeliveredAt: previous.lastDeliveredAt } : {}),
    };
    const nextSubscriptions = previous
      ? existing.map((subscription) => (subscription.id === id ? record : subscription))
      : [...existing, record];
    return { record, nextSubscriptions };
  }

  subscribeToSessionStates(
    subscriberId: string,
    request: SubscribeSessionStatesRequest,
  ): SessionStateSubscriptionRecordResponse {
    const subscriber = this.requireSession(subscriberId);
    const now = nowIso();
    const { record, nextSubscriptions } = this.buildNextStateSubscriptions(
      subscriberId,
      subscriber.stateSubscriptions ?? [],
      request,
      now,
    );
    this.writeStateSubscriptions(subscriber, nextSubscriptions, now);
    return { record };
  }

  removeStateSubscription(
    subscriberId: string,
    subscriptionId: string,
  ): SessionStateSubscriptionListResponse {
    const subscriber = this.requireSession(subscriberId);
    const existing = subscriber.stateSubscriptions ?? [];
    const nextSubscriptions = existing.filter((subscription) => subscription.id !== subscriptionId);
    if (nextSubscriptions.length === existing.length) {
      throw new SessionResourceNotFoundError(`Subscription not found: ${subscriptionId}`);
    }
    this.writeStateSubscriptions(subscriber, nextSubscriptions);
    return { records: nextSubscriptions };
  }

  private applyRequestedStateSubscriptions(
    session: SessionRecord,
    requested: SubscribeSessionStatesRequest[] | undefined,
  ): SessionRecord {
    if (!requested || requested.length === 0) {
      return session;
    }
    const now = nowIso();
    let nextSubscriptions = session.stateSubscriptions ?? [];
    let armedAny = false;
    // Accumulate every requested entry in memory and persist once — avoids
    // one readSession/writeSession/syncStateSubscriptionIndex round trip per
    // entry on the spawn hot path.
    for (const entry of requested) {
      try {
        nextSubscriptions = this.buildNextStateSubscriptions(
          session.id,
          nextSubscriptions,
          entry,
          now,
        ).nextSubscriptions;
        armedAny = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.subscription.spawn_failed", {
          level: "warn",
          sessionId: session.id,
          projectId: session.project,
          details: {
            targetSessionId: entry.targetSessionId,
            error: message,
          },
        });
      }
    }
    if (armedAny) {
      try {
        this.writeStateSubscriptions(session, nextSubscriptions, now);
      } catch (error) {
        // A write/index failure here must not fail the spawn — same
        // non-fatal contract as the per-entry validation above.
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.subscription.spawn_failed", {
          level: "warn",
          sessionId: session.id,
          projectId: session.project,
          details: { error: message },
        });
      }
    }
    return readSession(this.config.dataDir, session.id) ?? session;
  }

  listSessionMemory(sessionId: string): SessionMemoryListResponse {
    this.requireSessionMemorySession(sessionId);
    return {
      records: listSessionMemoryRecords(this.config.dataDir, sessionId),
    };
  }

  getSessionMemory(sessionId: string, key: string): SessionMemoryRecordResponse {
    this.requireSessionMemorySession(sessionId, key);
    const record = getSessionMemoryRecord(this.config.dataDir, sessionId, key);
    if (!record) {
      throw new SessionResourceNotFoundError(`Session memory key not found: ${sessionId}/${key}`);
    }
    return { record };
  }

  setSessionMemory(sessionId: string, key: string, request: unknown): SessionMemoryRecordResponse {
    this.requireSessionMemorySession(sessionId, key);
    if (!isRecord(request)) {
      throw new InvalidSessionMemoryInputError("request body must be a JSON object");
    }
    const body = request["body"];
    if (typeof body !== "string") {
      throw new InvalidSessionMemoryInputError("body must be a string");
    }
    const kind = request["kind"];
    if (kind !== undefined && kind !== "note") {
      throw new InvalidSessionMemoryInputError("kind must be note");
    }
    const tags = request["tags"];
    try {
      return {
        record: setSessionMemoryRecord(this.config.dataDir, sessionId, {
          key,
          body,
          ...(kind !== undefined ? { kind } : {}),
          ...(tags !== undefined ? { tags } : {}),
          now: nowIso(),
        }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidSessionMemoryInputError(message);
    }
  }

  resolveSessionMemory(sessionId: string, key: string): SessionMemoryRecordResponse {
    this.requireSessionMemorySession(sessionId, key);
    const record = resolveSessionMemoryRecord(this.config.dataDir, sessionId, key, nowIso());
    if (!record) {
      throw new SessionResourceNotFoundError(`Session memory key not found: ${sessionId}/${key}`);
    }
    return { record };
  }

  listSharedMemory(sessionId: string, scope: string): SharedMemoryListResponse {
    assertValidSharedMemoryRequest(scope);
    const session = this.requireSession(sessionId);
    const storeId = resolveSharedMemoryStoreId(session, scope);
    return { scope, keys: listSharedMemoryKeys(this.config.dataDir, scope, storeId) };
  }

  getSharedMemory(sessionId: string, scope: string, key: string): SharedMemoryEntryResponse {
    assertValidSharedMemoryRequest(scope, key);
    const session = this.requireSession(sessionId);
    const storeId = resolveSharedMemoryStoreId(session, scope);
    const entry = getSharedMemoryEntry(this.config.dataDir, scope, storeId, key);
    if (!entry) {
      throw new SessionResourceNotFoundError(
        `Shared memory key not found: ${scope}/${storeId}/${key}`,
      );
    }
    return { scope, entry };
  }

  setSharedMemory(
    sessionId: string,
    scope: string,
    key: string,
    request: unknown,
  ): SharedMemoryEntryResponse {
    assertValidSharedMemoryRequest(scope, key);
    if (!isRecord(request)) {
      throw new InvalidSessionMemoryInputError("request body must be a JSON object");
    }
    const body = request["body"];
    if (typeof body !== "string") {
      throw new InvalidSessionMemoryInputError("body must be a string");
    }
    const session = this.requireSession(sessionId);
    const storeId = resolveSharedMemoryStoreId(session, scope);
    const entry = setSharedMemoryEntry(this.config.dataDir, scope, storeId, key, body);
    return { scope, entry };
  }

  removeSharedMemory(sessionId: string, scope: string, key: string): SharedMemoryRemoveResponse {
    assertValidSharedMemoryRequest(scope, key);
    const session = this.requireSession(sessionId);
    const storeId = resolveSharedMemoryStoreId(session, scope);
    const removed = removeSharedMemoryEntry(this.config.dataDir, scope, storeId, key);
    if (!removed) {
      throw new SessionResourceNotFoundError(
        `Shared memory key not found: ${scope}/${storeId}/${key}`,
      );
    }
    return { scope, key };
  }

  async markOpened(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }

    // Only lastOpenedAt is stamped: updatedAt is carried through untouched so
    // opening a session never counts as activity or moves it in the dashboard
    // sort. The trailing enrich() classifies (and persists any genuine state
    // change) off the record just read, so no separate pre-enrich pass is
    // needed to avoid a lost update.
    const lastOpenedAt = nowIso();
    const updated: SessionRecord = { ...session, lastOpenedAt };
    writeSession(this.config.dataDir, updated);
    await this.refreshDashboardCacheEntry(updated);
    this.logEvent("session.opened", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Marked ${sessionId} opened`,
      details: { lastOpenedAt },
    });
    return this.enrich(updated);
  }

  getArtifact(sessionId: string, artifactId: string): SessionArtifactFile {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    const artifact = readSessionArtifact(this.config.dataDir, workspaceIdOf(session), artifactId);
    if (!artifact) {
      throw new SessionResourceNotFoundError(`Artifact not found: ${sessionId}/${artifactId}`);
    }
    return artifact;
  }

  async getConversation(sessionId: string): Promise<ConversationResponse> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    const durationMs = Date.now() - new Date(session.createdAt).getTime();
    const fallback: ConversationResponse = {
      messages: [],
      entries: [],
      durationMs,
      state: statusFallbackState(session),
    };

    const entries =
      (await readAgentConversation(session.agent, {
        worktreePath: session.worktreePath,
        ...(session.agent === "codex"
          ? { codexSessionsDir: this.codexSessionsDir(session.id) }
          : {}),
        ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
      })) ?? [];

    if (session.agent === "claude") {
      const result = await readClaudeConversation(session.worktreePath);
      return result
        ? { messages: result.messages, entries, durationMs, state: result.state }
        : { ...fallback, entries };
    }

    const messages: ConversationMessage[] = entries
      .filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message",
      )
      .map((entry) => ({
        role: entry.role,
        text: entry.text,
        timestampMs: entry.timestampMs ?? 0,
      }));
    return { messages, entries, durationMs, state: statusFallbackState(session) };
  }

  async getProjectSuggestions(
    projectId: string,
    requestedAgent?: string,
  ): Promise<AgentSuggestionsResponse> {
    const project = this.getProject(projectId);
    const agent = parseAgentName(
      requestedAgent ?? project.defaultAgent ?? this.config.defaultAgent,
    );
    return loadProjectSuggestions(agent, project.path);
  }

  async branchStatus(projectId: string, name: string): Promise<BranchExistsResponse> {
    const project = this.getProject(projectId);
    const normalized = normalizeBranchName(name);
    if (!normalized) {
      return { exists: false, remote: false, checkedOutAt: null };
    }
    return branchStatus(project.path, normalized);
  }

  async getSessionSuggestions(sessionId: string): Promise<AgentSuggestionsResponse> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return loadSessionSuggestions({
      agent: session.agent,
      worktreePath: session.worktreePath,
      ...(session.agent === "codex"
        ? {
            codexHomePath: codexHookHomePath(
              join(this.config.dataDir, "session-tools", session.id),
            ),
          }
        : {}),
    });
  }

  private async startAutoStartSidecars(
    session: SessionRecord,
    project: ProjectConfig,
  ): Promise<SessionRecord> {
    let updatedRecord = session;
    for (const [name, sidecar] of Object.entries(resolveSessionSidecars(session, project))) {
      if (!sidecar.autoStart) continue;
      const sidecarDepth = ROOT_SIDECAR_DEPTH;
      try {
        updatedRecord = await this.startSidecarWithDependencies({
          session: updatedRecord,
          project,
          sidecarName: name,
          sidecarDepth,
          onStarted: (startedName, startedSidecar) => {
            this.logEvent("session.sidecar.started", {
              level: "info",
              sessionId: session.id,
              projectId: session.project,
              message: `Auto-started sidecar ${startedName} for ${session.id}`,
              details: {
                sidecarName: startedName,
                command: startedSidecar.command,
                manualOnly: false,
                sidecarDepth,
                tmuxSession: sidecarTmuxSession(
                  sidecarOwnerId(session, startedSidecar),
                  startedName,
                ),
              },
            });
          },
        });
      } catch (sidecarError) {
        const sidecarMessage =
          sidecarError instanceof Error ? sidecarError.message : String(sidecarError);
        this.logEvent("session.sidecar.autostart.failed", {
          level: "warn",
          sessionId: session.id,
          projectId: session.project,
          message: `Auto-start sidecar ${name} failed for ${session.id}: ${sidecarMessage}`,
        });
      }
    }
    return updatedRecord;
  }

  async restoreRebootedSessions(drifted: { id: string; project: string }[]): Promise<void> {
    for (const [index, { id, project }] of drifted.entries()) {
      const projectConfig = this.config.projects[project];
      if (projectConfig?.restoreAfterReboot !== true) continue;
      const memory = readHostMemory();
      if (
        this.config.admission.enabled &&
        this.config.admission.memoryGuard.enforceFloors &&
        memory !== null &&
        memory.availableBytes < this.config.admission.memoryGuard.restoreFloorBytes
      ) {
        this.logEvent("session.reboot.restore.aborted", {
          level: "warn",
          message: `Reboot restore stopped before ${id}: available memory is below the restore floor`,
          details: {
            reason: "memory_floor",
            availableBytes: memory.availableBytes,
            floorBytes: this.config.admission.memoryGuard.restoreFloorBytes,
            remaining: drifted.length - index,
          },
        });
        break;
      }
      try {
        await this.restore(id);
        const record = readSession(this.config.dataDir, id);
        if (record) {
          await this.startAutoStartSidecars(record, projectConfig);
        }
        if (memory !== null) {
          await sleep(RESTORE_SETTLE_MS);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.reboot.restore.failed", {
          level: "warn",
          sessionId: id,
          projectId: project,
          message: `Reboot restore failed for ${id}: ${message}`,
        });
      }
    }
  }

  async reconcileStoppedSessions(): Promise<{
    scanned: number;
    alive: number;
    drifted: number;
    driftedSessions: { id: string; project: string }[];
  }> {
    const candidates = listSessions(this.config.dataDir).filter(
      (session) => session.status === "running" || session.status === "spawning",
    );
    let alive = 0;
    let drifted = 0;
    const driftedSessions: { id: string; project: string }[] = [];

    for (const session of candidates) {
      const runtime = await this.readRuntimeSnapshot(session);
      const reconciled = await this.reconcileUnexpectedStop(
        session,
        runtime,
        "boot",
        probeWorkspace(session.worktreePath).missing,
      );
      if (reconciled.session.status === "stopped" || reconciled.session.status === "errored") {
        drifted += 1;
        if (reconciled.session.status === "stopped") {
          driftedSessions.push({ id: session.id, project: session.project });
        }
      } else {
        alive += 1;
      }
    }

    await this.sweepLeakedBuiltinSidecars("boot");
    // Run the same project-sidecar reap pass the 5-minute reaper tick runs,
    // once at boot: a host that stays up for weeks between restarts would
    // otherwise wait a full tick after every restart before an idle leak
    // from before the restart gets swept.
    await this.collectAndExecuteSidecarReapPass(
      listSessions(this.config.dataDir),
      await listTmuxSessionNames(),
    );

    return { scanned: candidates.length, alive, drifted, driftedSessions };
  }

  // Reap orphaned Spur-owned built-in sidecar processes (reparented to init,
  // our bin, port not reserved by any live session). Registry-driven over
  // BUILTIN_SIDECARS; best-effort, logs the killed count per sidecar name.
  private async sweepLeakedBuiltinSidecars(context: "boot" | "reaper"): Promise<void> {
    const ownedPortsByName = new Map<string, Set<number>>();
    for (const session of listSessions(this.config.dataDir)) {
      if (isTerminalSessionStatus(session.status)) continue;
      for (const [name, ports] of Object.entries(session.sidecarPorts ?? {})) {
        if (!(name in BUILTIN_SIDECARS)) continue;
        const set = ownedPortsByName.get(name) ?? new Set<number>();
        for (const port of Object.values(ports)) {
          set.add(port);
        }
        ownedPortsByName.set(name, set);
      }
    }
    for (const [name, builtin] of Object.entries(BUILTIN_SIDECARS)) {
      if (!builtin.sweepLeaked) continue;
      const killed = await builtin.sweepLeaked(ownedPortsByName.get(name) ?? new Set<number>());
      if (killed <= 0) continue;
      if (context === "boot") {
        this.logEvent("daemon.startup.sidecar_sweep", {
          level: "info",
          message: `Reaped ${killed} leaked ${name} sidecar process tree(s) on boot`,
          details: { sidecarName: name, killed },
        });
      } else {
        this.logEvent("session.sidecar_reaper.swept", {
          level: "info",
          message: `Reaped ${killed} leaked ${name} sidecar process tree(s)`,
          details: { sidecarName: name, killed },
        });
      }
    }
  }

  async listServices(sessionId: string): Promise<ServiceInstanceView[]> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const services = listServiceInstancesForSession(this.config.dataDir, sessionId);
    const views: ServiceInstanceView[] = [];
    for (const service of services) {
      views.push(await this.enrichService(service));
    }
    return views;
  }

  async getService(sessionId: string, serviceId: string): Promise<ServiceInstanceView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const service = readServiceInstance(this.config.dataDir, sessionId, serviceId);
    if (!service) {
      throw new Error(`Service not found: ${sessionId}/${serviceId}`);
    }
    return this.enrichService(service);
  }

  async runService(
    sessionId: string,
    serviceId: string,
    request: RunServiceRequest,
  ): Promise<ServiceInstanceView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "running") {
      throw new Error(`Session is not running: ${sessionId}`);
    }
    if (!session.worktreePath || !workspaceExists(session.worktreePath)) {
      throw new Error(`Session workspace is not available: ${sessionId}`);
    }
    const project = this.getProject(session.project);
    if (!projectHasService(project, serviceId)) {
      throw new Error(`Unknown service for ${session.project}: ${serviceId}`);
    }
    if (typeof request.command !== "string" || !request.command.trim()) {
      throw new Error("service command must be a non-empty string");
    }
    if (typeof request.cwd !== "string" || !request.cwd.trim()) {
      throw new Error("service cwd must be a non-empty string");
    }
    if (
      request.port !== undefined &&
      (!Number.isInteger(request.port) || request.port <= 0 || request.port > 65_535)
    ) {
      throw new Error("service port must be an integer between 1 and 65535");
    }
    const serviceCwd = request.cwd.trim();
    if (!existsSync(serviceCwd)) {
      throw new Error(`Service cwd does not exist: ${serviceCwd}`);
    }
    const resolvedWorkspacePath = realpathSync(session.worktreePath);
    const resolvedServiceCwd = realpathSync(serviceCwd);
    if (
      resolvedServiceCwd !== resolvedWorkspacePath &&
      !resolvedServiceCwd.startsWith(`${resolvedWorkspacePath}/`)
    ) {
      throw new Error(`Service cwd must stay inside the session workspace: ${serviceCwd}`);
    }

    const existing = readServiceInstance(this.config.dataDir, sessionId, serviceId);
    if (existing) {
      const existingRuntimeAlive = await tmuxSessionExists(existing.tmuxSession);
      const existingPaneDead = existingRuntimeAlive
        ? await tmuxPaneDead(existing.tmuxSession)
        : true;
      if (existingRuntimeAlive && !existingPaneDead) {
        throw new Error(`Service is already running: ${sessionId}/${serviceId}`);
      }
      await killTmuxSession(existing.tmuxSession);
      deleteServiceInstance(this.config.dataDir, sessionId, serviceId);
    }
    deleteServiceSourceStatesForService(this.config.dataDir, session.project, sessionId, serviceId);

    const tmuxSession = `${sessionId}--svc--${serviceId}`;
    const createdAt = nowIso();
    this.logEvent("service.run.started", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Starting service ${serviceId} for ${sessionId}`,
      details: {
        serviceId,
        cwd: serviceCwd,
      },
    });

    try {
      await createTmuxCommandSession({
        sessionName: tmuxSession,
        cwd: resolvedServiceCwd,
        launchCommand: request.command.trim(),
      });
      const record: ServiceInstanceRecord = {
        sessionId,
        project: session.project,
        serviceId,
        ...(request.port !== undefined ? { port: request.port } : {}),
        command: request.command.trim(),
        cwd: resolvedServiceCwd,
        tmuxSession,
        status: "running",
        createdAt,
        updatedAt: nowIso(),
      };
      writeServiceInstance(this.config.dataDir, record);
      this.logEvent("service.run.completed", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Started service ${serviceId} for ${sessionId}`,
        details: {
          serviceId,
          tmuxSession,
        },
      });
      return await this.enrichService(record);
    } catch (error) {
      await killTmuxSession(tmuxSession);
      const message = error instanceof Error ? error.message : String(error);
      const record: ServiceInstanceRecord = {
        sessionId,
        project: session.project,
        serviceId,
        ...(request.port !== undefined ? { port: request.port } : {}),
        command: request.command.trim(),
        cwd: resolvedServiceCwd,
        tmuxSession,
        status: "errored",
        createdAt,
        updatedAt: nowIso(),
        error: message,
      };
      writeServiceInstance(this.config.dataDir, record);
      this.logEvent("service.run.failed", {
        level: "error",
        sessionId,
        projectId: session.project,
        message: `Failed to start service ${serviceId} for ${sessionId}: ${message}`,
        details: {
          serviceId,
        },
      });
      return this.enrichService(record);
    }
  }

  async preflight(request: PreflightRequest): Promise<PreflightResponse> {
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      throw new Error("prompt must be a non-empty string");
    }
    const project = this.getProject(request.project);
    const agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
    const overrides = parseSpawnOverrides(request.overrides, "overrides");
    const worktree = resolveSpawnWorktree(project, overrides);
    const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
    if (!worktree || !project.preflight) {
      return { branch: null };
    }
    const result = await runSpawnPreflight({
      agent,
      projectId: request.project,
      project,
      baseBranch: defaultBranch,
      worktree,
      prompt: request.prompt,
    });
    return { branch: result.branch ?? null };
  }

  private resolveSpawnTarget(request: SpawnSessionRequest): {
    project: ProjectConfig;
    prompt: string;
    steps?: string[];
    planMode: boolean;
    restrictWrites: boolean;
    allowedTriggers?: string[];
    selfDestruct?: SelfDestructConfig;
  } {
    if (request.project === SHEPHERD_PROJECT_ID) {
      ensureShepherdWorkspace(this.config.dataDir);
      const project = this.getProject(request.project);
      return {
        project,
        ...normalizeSpawnRequest(
          {
            ...request,
            prompt: wrapShepherdSpawnPrompt(request.prompt, {
              ...(request.bareSpawnMessage !== undefined
                ? { bareSpawnMessage: request.bareSpawnMessage }
                : {}),
            }),
            overrides: { ...(request.overrides ?? {}), worktree: false },
          },
          project.spawn?.steps,
        ),
      };
    }
    if (request.bootstrap !== true) {
      const project = this.getProject(request.project);
      return { project, ...normalizeSpawnRequest(request, project.spawn?.steps) };
    }
    const entry = this.listUnconfiguredProjects().find(
      (existing) => existing.id === request.project,
    );
    if (!entry) {
      throw new Error(`Unknown unconfigured project: ${request.project}`);
    }
    const project: ProjectConfig = {
      ...(entry.displayName !== undefined ? { name: entry.displayName } : {}),
      path: entry.path,
      defaultBranch: "main",
      sessionPrefix: entry.prefix,
      worktree: false,
      restoreAfterReboot: false,
      symlinks: [],
      sidecars: {},
      sources: {},
      backlog: {},
      triggers: {},
    };
    const bootstrapPrompt = renderBootstrapPrompt({
      id: entry.id,
      displayName: entry.displayName ?? entry.id,
      prefix: entry.prefix,
      path: entry.path,
      port: this.config.server.port,
    });
    return { project, ...normalizeSpawnRequest({ ...request, prompt: bootstrapPrompt }) };
  }

  async spawn(
    request: SpawnSessionRequest,
    options?: {
      promptKind?: UserInputKind;
      replacingSessionId?: string;
      admissionReservation?: symbol;
    },
  ): Promise<SessionView> {
    request = normalizeShepherdSpawnRequest(request);
    const admissionReservation =
      options?.admissionReservation ??
      this.reserveAdmission(request.project, "spawn", {
        ...(options?.replacingSessionId ? { replacingSessionId: options.replacingSessionId } : {}),
      });
    let admissionReserved = true;
    let stage = "validating";
    let sessionId: string | undefined;
    let project: ProjectConfig | undefined;
    let agent: SessionRecord["agent"] | undefined;
    let worktree = false;
    let workspacePath = "";
    let resolvedBranch: ResolvedSpawnBranch | undefined;
    let createdAt: string | undefined;
    let placeholderWritten = false;
    let resolvedModel: string | undefined;
    let prompt = "";
    let steps: string[] | undefined;
    let planMode: boolean;
    let restrictWrites: boolean;
    let allowedTriggers: string[] | undefined;
    let selfDestruct: SelfDestructConfig | undefined;
    let preflightOutcome: "branch" | "fallback-branch" | "defer" | undefined;
    let preflightBranch: string | undefined;
    let preflightUnvalidatedBranch = false;
    let preflightAttempts: number | undefined;
    let allocatedNewWorktree = false;
    let reuseCtx: {
      workspaceId: string;
      workspacePath: string;
      worktree: boolean;
      resolvedBranch: ResolvedSpawnBranch;
    } | null = null;
    try {
      ({ project, prompt, steps, planMode, restrictWrites, allowedTriggers, selfDestruct } =
        this.resolveSpawnTarget(request));
      if (
        request.branch !== undefined &&
        (typeof request.branch !== "string" || !request.branch.trim())
      ) {
        throw new Error("branch must be a non-empty string when provided");
      }

      const overrides = parseSpawnOverrides(request.overrides, "overrides");
      worktree = resolveSpawnWorktree(project, overrides);
      reuseCtx = this.resolveWorkspaceReuseContext(request, project, worktree);
      const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
      agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
      resolvedModel = await resolveAgentLaunchModel(
        agent,
        resolveSpawnModel({
          requestModel: request.model,
          resolvedAgent: agent,
          project,
        }),
      );
      let effectiveBranch = request.branch;
      let effectiveBranchSource: Extract<BranchSource, "explicit" | "preflight"> | undefined =
        request.branch ? "explicit" : undefined;
      if (!reuseCtx && !effectiveBranch && worktree && project.preflight && prompt) {
        stage = "preflight";
        const preflight = await runSpawnPreflightForSpawn({
          agent,
          projectId: request.project,
          project,
          baseBranch: defaultBranch,
          worktree,
          prompt,
        });
        preflightOutcome = preflight.outcome;
        preflightAttempts = preflight.attempts;
        if (preflight.outcome === "branch") {
          preflightBranch = preflight.branch;
          effectiveBranch = preflight.branch;
          effectiveBranchSource = "preflight";
        } else if (preflight.outcome === "fallback-branch") {
          preflightBranch = preflight.branch;
          effectiveBranch = preflight.branch;
          effectiveBranchSource = "preflight";
          preflightUnvalidatedBranch = true;
          this.logEvent("session.preflight.deferred", {
            level: "warn",
            projectId: request.project,
            message: `Spawn preflight exhausted ${preflight.attempts} attempts; using unvalidated agent-proposed branch ${preflight.branch} as last resort: ${preflight.deferReason}`,
            details: {
              attempts: preflight.attempts,
              reason: preflight.deferReason,
              branch: preflight.branch,
              unvalidated: true,
            },
          });
        } else {
          preflightUnvalidatedBranch = preflight.unvalidated === true;
          this.logEvent("session.preflight.deferred", {
            level: "warn",
            projectId: request.project,
            message: spawnPreflightDeferLogMessage(preflight),
            details: {
              attempts: preflight.attempts,
              branch: null,
              reason: preflight.deferReason ?? null,
            },
          });
        }
      }
      // Preflight phase is done. Reserve/branch resolution below is the same
      // phase the non-preflight path runs under "validating"; reset so a
      // downstream failure here is not mislabeled as a preflight failure.
      // Mirror: background runBackgroundSpawnAttempt() ~4032.
      stage = "validating";
      sessionId = await reserveNextSessionId(
        this.config.dataDir,
        request.project,
        project.sessionPrefix,
      );
      this.spawnsInFlight.add(sessionId);
      if (!reuseCtx && preflightOutcome) {
        this.logEvent("session.preflight.completed", {
          level: "info",
          sessionId,
          projectId: request.project,
          message:
            preflightOutcome !== "defer"
              ? `Spawn preflight selected branch ${preflightBranch} for ${sessionId}`
              : `Spawn preflight deferred branch selection for ${sessionId}`,
          details: {
            outcome: preflightOutcome,
            branch: preflightBranch ?? null,
            baseBranch: defaultBranch,
            attempts: preflightAttempts ?? 1,
          },
        });
      }
      if (!reuseCtx) {
        const skipBranchNamingValidation =
          preflightUnvalidatedBranch || request.allowUnvalidatedFallbackBranch === true;
        resolvedBranch = await resolveSpawnBranch({
          repoPath: project.path,
          requestBranch: effectiveBranch,
          ...(effectiveBranchSource ? { requestBranchSource: effectiveBranchSource } : {}),
          worktree,
          fallbackBranch: sessionId,
          project,
          ...(skipBranchNamingValidation ? { skipBranchNamingValidation: true } : {}),
        });
        if (worktree && resolvedBranch.branch !== sessionId) {
          const branchConflictPath = await findWorktreePathForBranch(
            project.path,
            resolvedBranch.branch,
          );
          if (branchConflictPath) {
            if (resolvedBranch.branchSource === "explicit") {
              throw new Error(
                `branch "${resolvedBranch.branch}" is already checked out in worktree ${branchConflictPath}`,
              );
            }
            this.logEvent("session.spawn.branch_conflict", {
              level: "warn",
              sessionId,
              projectId: request.project,
              message: `Branch ${resolvedBranch.branch} is already checked out; falling back to ${sessionId}`,
              details: {
                occupiedBranch: resolvedBranch.branch,
                conflictingWorktreePath: branchConflictPath,
                fallbackBranch: sessionId,
                branchSource: resolvedBranch.branchSource ?? null,
              },
            });
            resolvedBranch = { branch: sessionId };
          }
        }
      } else {
        resolvedBranch = reuseCtx.resolvedBranch;
      }
      const tmuxSession = sessionId;
      createdAt = nowIso();
      const originalTaskPrompt = resolveOriginalTaskPrompt(request, prompt);

      this.logEvent("session.spawn.started", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawning ${sessionId}`,
        details: {
          agent,
          branch: resolvedBranch.branch,
          worktree,
          defaultBranch,
          branchSource: resolvedBranch.branchSource ?? null,
          ...(reuseCtx ? { reuseWorkspaceSessionId: request.reuseWorkspaceSessionId ?? null } : {}),
        },
      });

      const placeholder: SessionRecord = {
        id: sessionId,
        project: request.project,
        workspaceId: reuseCtx?.workspaceId ?? sessionId,
        agent,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        planMode,
        ...(restrictWrites ? { restrictWrites: true } : {}),
        ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
        prompt,
        branch: resolvedBranch.branch,
        ...(resolvedBranch.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
        worktree,
        worktreePath: reuseCtx ? reuseCtx.workspacePath : worktree ? "" : project.path,
        tmuxSession,
        launchCommand: "",
        status: "spawning",
        createdAt,
        updatedAt: createdAt,
        ...(Object.keys(resolveSessionSidecars({ agent }, project)).length > 0
          ? { sidecarNames: Object.keys(resolveSessionSidecars({ agent }, project)) }
          : {}),
        ...(request.slots?.links?.length
          ? { slots: { links: normalizeSlotLinks(request.slots.links) } }
          : {}),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        originalTaskPrompt,
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;
      this.admissionReservations.delete(admissionReservation);
      admissionReserved = false;
      workspacePath = placeholder.worktreePath;

      stage = "tools.setup";
      const sessionToolDir = this.prepareSessionTools(sessionId, agent, request.project);

      if (worktree) {
        stage = "worktree.create";
        if (reuseCtx) {
          workspacePath = reuseCtx.workspacePath;
          this.logEvent("session.spawn.workspace_reused", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Reused workspace path for ${sessionId}`,
            details: {
              worktreePath: workspacePath,
              sourceSessionId: request.reuseWorkspaceSessionId ?? null,
            },
          });
        } else {
          workspacePath = await createWorktree({
            repoPath: project.path,
            worktreeBaseDir: this.config.worktreeDir,
            projectId: request.project,
            sessionId,
            defaultBranch,
            branch: resolvedBranch.branch,
            symlinks: project.symlinks,
          });
          allocatedNewWorktree = true;
          this.logEvent("session.spawn.worktree_created", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Created worktree for ${sessionId}`,
            details: {
              worktreePath: workspacePath,
              symlinkCount: project.symlinks.length,
            },
          });
        }
      } else {
        this.logEvent("session.spawn.shared_workspace", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Using shared workspace for ${sessionId}`,
          details: {
            workspacePath,
            branch: resolvedBranch.branch,
          },
        });
      }

      const firstStage = steps?.[0];
      const taskPrompt = buildSessionPrompt(prompt, planMode, restrictWrites);
      const initialMessage =
        steps && firstStage
          ? formatPipelineStepMessage(taskPrompt, firstStage, 0, steps.length)
          : taskPrompt;
      const inputKind = options?.promptKind ?? "spawn_prompt";
      const inputSource = inputKind === "respawn_override_prompt" ? "respawn" : "spawn";
      const startupAttachments = this.storeAttachments(
        workspaceIdOf(placeholder),
        request.attachments,
      );
      this.logUserInput(sessionId, request.project, {
        kind: inputKind,
        text: prompt,
        source: inputSource,
        attachments: startupAttachments,
      });
      const { startupImagePaths, startupAttachmentLines } = this.partitionStartupAttachments(
        agent,
        startupAttachments,
      );
      const sidecarNames = manualSidecarNames(resolveSessionSidecars({ agent }, project));
      const composedInitialMessage = [...startupAttachmentLines, initialMessage]
        .filter((line) => line.trim())
        .join("\n");
      const spawnInitialMessage = request.bareSpawnMessage
        ? composedInitialMessage
        : buildInitialMessage(
            composedInitialMessage,
            sidecarNames,
            this.config.tags,
            project.branchNaming?.regex,
            selfDestruct,
          );
      const { session: sessionForMcp, mcpBindings } = await this.startMcpSidecars(
        { ...placeholder, worktreePath: workspacePath },
        project,
      );
      const hookSetup = await setupSessionAgentHooks({
        agent,
        dataDir: this.config.dataDir,
        sessionId,
        worktreePath: workspacePath,
        sessionToolDir,
        restrictWrites,
        modelsCacheHome: this.config.models.codexHome,
        ...(mcpBindings.length > 0 ? { mcpBindings } : {}),
      });
      const sessionAgentConfig = this.sessionAgentConfig({
        agent,
        id: sessionId,
        restrictWrites,
      });
      const planOptions = withAgentModeOptions(
        withProjectAgentOptions(agent, project, {
          ...hookSetup,
          ...(sessionAgentConfig.planOptions ?? {}),
        }),
        { planMode, restrictWrites },
      );
      // Pin a native session id at launch for claude so concurrent sessions
      // sharing one worktree bind to their own transcript instead of guessing
      // by newest mtime.
      const claudeSessionId = agent === "claude" ? randomUUID() : undefined;
      if (request.claudeAccountId) {
        const account = findAccount(this.config.dataDir, request.claudeAccountId);
        if (!account || !isAccountReady(account)) {
          throw new Error(
            `Claude account ${request.claudeAccountId} is not ready (credentials or onboarding incomplete)`,
          );
        }
      }
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...planOptions,
        ...this.resolveClaudeAuthPlanOptions({
          id: sessionId,
          agent,
          ...(request.claudeAccountId ? { claudeAccountId: request.claudeAccountId } : {}),
        }),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(startupImagePaths.length > 0 ? { startupImagePaths } : {}),
        ...(claudeSessionId ? { agentSessionId: claudeSessionId } : {}),
      });
      const promptDeliveredOnLaunch =
        startupImagePaths.length > 0 &&
        !launchPlan.initialMessage.trim() &&
        spawnInitialMessage.trim().length > 0;
      const pipeline = steps
        ? {
            steps,
            nextStepIndex: 1,
            awaitingStepIndex: 0,
            status: "running" as const,
          }
        : undefined;
      const runningRecord: SessionRecord = {
        ...sessionForMcp,
        planMode,
        restrictWrites,
        ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        ...(claudeSessionId ? { agentSessionId: claudeSessionId } : {}),
        ...(request.claudeAccountId ? { claudeAccountId: request.claudeAccountId } : {}),
        status: "running",
        updatedAt: nowIso(),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        ...(startupAttachments.length > 0
          ? {
              startupAttachmentIds: startupAttachments.map((attachment) => attachment.id),
            }
          : {}),
        ...(pipeline ? { pipeline } : {}),
        originalTaskPrompt,
      };

      stage = "tmux.create";
      const sessionEnv = buildSessionEnv({
        agent,
        projectId: request.project,
        sessionId,
        artifactsSessionId: workspaceIdOf(runningRecord),
        sessionToolDir,
        dataDir: this.config.dataDir,
        repoPath: project.path,
        symlinks: project.symlinks,
        ...(sessionAgentConfig.env ? { extraEnv: sessionAgentConfig.env } : {}),
      });
      await createTmuxSession({
        sessionName: tmuxSession,
        cwd: workspacePath,
        launchCommand: launchPlan.launchCommand,
        agent,
        env: sessionEnv,
      });
      this.logEvent("session.spawn.tmux_created", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Created tmux session for ${sessionId}`,
        details: {
          tmuxSession,
        },
      });

      stage = "tmux.ready";
      await waitForTmuxReady(tmuxSession, launchPlan.readyMarkers, undefined, { agent });
      this.logEvent("session.spawn.ready", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Agent prompt is ready for ${sessionId}`,
      });

      if (launchPlan.initialMessage.trim()) {
        stage = "prompt.send";
        await this.sendAgentMessage(runningRecord, launchPlan.initialMessage);
        this.logEvent("session.spawn.initial_prompt_sent", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Sent initial prompt to ${sessionId}`,
          details: {
            messageLength: launchPlan.initialMessage.length,
          },
        });
      } else if (promptDeliveredOnLaunch) {
        this.logEvent("session.spawn.initial_prompt_sent", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Sent initial prompt to ${sessionId}`,
          details: {
            deliveryMode: "launch_command",
            imageCount: startupImagePaths.length,
            messageLength: spawnInitialMessage.length,
          },
        });
      }

      stage = "record.write";
      let updatedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );
      updatedRecord = await this.startAutoStartSidecars(updatedRecord, project);

      writeSession(this.config.dataDir, updatedRecord);
      updatedRecord = this.applyRequestedStateSubscriptions(updatedRecord, request.subscriptions);
      await this.refreshDashboardCacheEntry(updatedRecord);
      this.logEvent("session.spawn.completed", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawned ${sessionId}`,
        details: {
          worktreePath: workspacePath,
          tmuxSession,
          agent,
          agentSessionId: updatedRecord.agentSessionId ?? null,
        },
      });
      if (this.shouldRunDelivery(updatedRecord)) {
        this.scheduleDeliveryRunner(updatedRecord.id);
      }

      return await this.enrich(updatedRecord);
    } catch (error) {
      if (sessionId && project && placeholderWritten) {
        await killTmuxSession(sessionId);
        // Non-mcp project sidecars are desk-shared: a sibling can already be
        // attached to this still-spawning anchor (or, for a failing sibling,
        // the anchor/another sibling can still be live), so this session's
        // own spawn failure must not kill them out from under a live desk
        // member. Own mcp sidecars always die with this session.
        const failedSpawnSession = {
          id: sessionId,
          project: request.project,
          workspaceId: reuseCtx?.workspaceId ?? sessionId,
        };
        // Checked even when this spawn reused no workspace: a child can have
        // attached to this session while it was still spawning, which makes
        // this record the desk anchor whose panes that child is using.
        const failedSpawnDeskAlive = this.hasRunningWorkspaceMembers(failedSpawnSession);
        for (const [scName, sidecar] of Object.entries(project.sidecars)) {
          if (!sidecar.mcp && failedSpawnDeskAlive) {
            continue;
          }
          const failedSpawnOwnerId = sidecarOwnerId(failedSpawnSession, sidecar);
          await this.reapSidecarByName(failedSpawnOwnerId, scName);
          this.clearSidecarProcEntry(failedSpawnOwnerId, scName);
        }
        // Startup attachments are preserved for a respawn, so the ids come
        // from the persisted placeholder — they are out of scope here.
        const persistedStartupIds = readSession(
          this.config.dataDir,
          sessionId,
        )?.startupAttachmentIds;
        this.removeSessionArtifacts(
          {
            id: sessionId,
            project: request.project,
            workspaceId: failedSpawnSession.workspaceId,
            ...(persistedStartupIds ? { startupAttachmentIds: persistedStartupIds } : {}),
          },
          { preserveStartup: true },
        );
        if (allocatedNewWorktree && workspacePath) {
          await removeWorktree(project.path, workspacePath);
        }

        const message = error instanceof Error ? error.message : String(error);
        const erroredRecord: SessionRecord = {
          id: sessionId,
          project: request.project,
          workspaceId: failedSpawnSession.workspaceId,
          agent:
            agent ??
            parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent),
          prompt,
          branch: resolvedBranch?.branch ?? sessionId,
          ...(resolvedBranch?.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
          worktree,
          worktreePath: workspacePath,
          tmuxSession: sessionId,
          launchCommand: "",
          status: "errored",
          createdAt: createdAt ?? nowIso(),
          updatedAt: nowIso(),
          error: message,
        };
        writeSession(this.config.dataDir, erroredRecord);

        this.logEvent("session.spawn.failed", {
          level: "error",
          sessionId,
          projectId: request.project,
          message: `Failed to spawn ${sessionId}: ${message}`,
          details: {
            stage,
            worktree,
            worktreePath: workspacePath || null,
            agent: erroredRecord.agent,
            branch: erroredRecord.branch,
          },
        });

        throw new Error(`Failed to spawn ${sessionId}: ${message}`, { cause: error });
      }

      const message = error instanceof Error ? error.message : String(error);
      if (stage === "preflight") {
        this.logEvent("session.preflight.failed", {
          level: "error",
          projectId: request.project,
          message: `Spawn preflight failed for ${request.project}: ${message}`,
          details: {
            requestedAgent: request.agent ?? null,
          },
        });
      }
      this.logEvent("session.spawn.failed", {
        level: "error",
        projectId: request.project,
        message: `Failed to spawn session: ${message}`,
        details: {
          stage,
          requestedAgent: request.agent ?? null,
        },
      });
      throw error;
    } finally {
      if (admissionReserved) {
        this.admissionReservations.delete(admissionReservation);
      }
      if (sessionId) {
        this.spawnsInFlight.delete(sessionId);
      }
    }
  }

  private resetSpawnAttemptArtifacts(sessionId: string): void {
    deleteAgentHookState(this.config.dataDir, sessionId);
    deleteRuntimeLogCursorsForSession(this.config.dataDir, sessionId);
  }

  private async cleanupBackgroundSpawnAttempt(
    prepared: PreparedSpawn,
    workspacePath: string,
    finalFailure: boolean,
  ): Promise<void> {
    await killTmuxSession(prepared.sessionId);
    // See the same guard in prepareBackgroundSpawn's catch block: non-mcp
    // project sidecars are desk-shared and must not die under a live sibling.
    const deskAlive = this.hasRunningWorkspaceMembers(prepared.placeholder);
    for (const [sidecarName, sidecar] of Object.entries(prepared.project.sidecars)) {
      if (!sidecar.mcp && deskAlive) {
        continue;
      }
      const cleanupOwnerId = sidecarOwnerId(prepared.placeholder, sidecar);
      await this.reapSidecarByName(cleanupOwnerId, sidecarName);
      this.clearSidecarProcEntry(cleanupOwnerId, sidecarName);
    }
    if (finalFailure) {
      this.removeSessionArtifacts(prepared.placeholder);
    } else {
      this.resetSpawnAttemptArtifacts(prepared.sessionId);
    }
    if (prepared.worktree && workspacePath && !prepared.reuseWorkspacePath) {
      await removeWorktree(prepared.project.path, workspacePath);
    }
  }

  private resolveWorkspaceReuseContext(
    request: SpawnSessionRequest,
    project: ProjectConfig,
    worktree: boolean,
  ): {
    workspaceId: string;
    workspacePath: string;
    worktree: boolean;
    resolvedBranch: ResolvedSpawnBranch;
  } | null {
    const raw = request.reuseWorkspaceSessionId?.trim();
    if (!raw) return null;

    const parent = readSession(this.config.dataDir, raw);
    if (!parent) {
      throw new Error(`reuseWorkspaceSessionId: unknown session ${raw}`);
    }
    if (parent.project !== request.project) {
      throw new Error("reuseWorkspaceSessionId: project mismatch");
    }

    if (worktree !== parent.worktree) {
      throw new Error("reuseWorkspaceSessionId: overrides.worktree conflicts with source session");
    }

    const path = parent.worktreePath.trim();
    if (!path) {
      throw new Error("reuseWorkspaceSessionId: empty worktreePath on source");
    }
    if (!workspaceExists(path)) {
      throw new Error(`reuseWorkspaceSessionId: workspace path not present (${path})`);
    }

    const reqBranch = request.branch?.trim();
    if (reqBranch && reqBranch !== parent.branch) {
      throw new Error("reuseWorkspaceSessionId: branch conflicts with shared checkout");
    }

    return {
      workspaceId: workspaceIdOf(parent),
      workspacePath: tryRealpath(path),
      worktree: parent.worktree,
      resolvedBranch: {
        branch: parent.branch,
        ...(parent.branchSource ? { branchSource: parent.branchSource } : {}),
      },
    };
  }

  private listDeskSessions(
    session: SessionRecord,
    sessionBatch = listSessions(this.config.dataDir),
  ): SessionRecord[] {
    const anchor = workspaceIdOf(session);
    return sessionBatch
      .filter(
        (member) =>
          member.project === session.project &&
          workspaceIdOf(member) === anchor &&
          member.status !== "killed",
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async buildDeskGroupMembers(
    session: SessionRecord,
    current: { state: SessionState; runtimeAlive: boolean },
    sessionBatch?: SessionRecord[],
  ): Promise<SessionDeskMember[]> {
    const members: SessionDeskMember[] = [];
    for (const member of this.listDeskSessions(session, sessionBatch)) {
      if (member.id === session.id) {
        members.push({
          id: session.id,
          agent: session.agent,
          status: session.status,
          state: current.state,
          runtimeAlive: current.runtimeAlive,
        });
        continue;
      }
      // Desk siblings reuse the dashboard-cache tick's last-completed
      // classification instead of re-running a full classify per sibling per
      // viewer — that N× re-classify was a major fork-storm contributor.
      // That cached value is usually <=DASHBOARD_CACHE_INTERVAL_MS old, but
      // not guaranteed under tick overlap (a slow tick can leave a slightly
      // older value in place until the next one completes). A sibling
      // missing from the cache (freshly created, or evicted) is rare, so it
      // gets a live classify instead of a stale/derived guess: scanPane:false
      // still skips the capture-pane fork, but jsonl/hook sources already
      // surface needs_input/rate_limited/error, so this stays cheap.
      const cached = this.dashboardCache.get(member.id);
      if (cached) {
        members.push({
          id: member.id,
          agent: member.agent,
          status: member.status,
          state: cached.state,
          runtimeAlive: cached.runtimeAlive,
        });
        continue;
      }
      const classified = await this.classifySessionRecord(member, { scanPane: false });
      members.push({
        id: classified.session.id,
        agent: classified.session.agent,
        status: classified.session.status,
        state: this.stabilizeState(classified.session.id, classified.state),
        runtimeAlive: classified.runtime.runtimeAlive,
      });
    }
    return members;
  }

  private someDeskSibling(
    session: Pick<SessionRecord, "id" | "project" | "workspaceId" | "deskId">,
    match: (sibling: SessionRecord) => boolean,
  ): boolean {
    const anchor = workspaceIdOf(session);
    return listSessions(this.config.dataDir).some(
      (s) =>
        s.id !== session.id &&
        s.project === session.project &&
        workspaceIdOf(s) === anchor &&
        match(s),
    );
  }

  // Another workspace member could still come back and need the workspace's
  // persistent state: its worktree and the shared artifacts dir. A paused or
  // errored member counts — restore brings it back into the same workspace.
  private hasActiveWorkspaceMembers(
    session: Pick<SessionRecord, "id" | "project" | "workspaceId" | "deskId">,
  ): boolean {
    return this.someDeskSibling(session, (s) => !isTerminalSessionStatus(s.status));
  }

  // Another workspace member has an agent running right now, so the
  // workspace's shared sidecars and their reserved ports are actually in
  // use. Deliberately narrower than hasActiveWorkspaceMembers: pausing a
  // session already tears its own sidecars down, and a stopped or errored
  // member holding a shared pane would leak it forever — handoff parks its
  // predecessor as `stopped` and keeps it in the desk, so the workspace
  // would never release the pane or its pool ports. Restore re-runs
  // autostart, so releasing early self-heals.
  private hasRunningWorkspaceMembers(
    session: Pick<SessionRecord, "id" | "project" | "workspaceId" | "deskId">,
  ): boolean {
    return this.someDeskSibling(session, (s) => s.status === "running" || s.status === "spawning");
  }

  // Resolves the record that owns a desk's shared state (slots, PR binding).
  // Zero IO for a non-desk session or the anchor itself — it is already the
  // in-hand record. Only a desk sibling costs an extra read, for the anchor.
  private deskAnchorRecord(session: SessionRecord): SessionRecord {
    const anchorId = workspaceIdOf(session);
    if (anchorId === session.id) {
      return session;
    }
    return readSession(this.config.dataDir, anchorId) ?? session;
  }

  // Persists workspace-owned state plus its transitional legacy mirror.
  //
  // The mirror has to land on the WORKSPACE OWNER's record, which is not
  // always the record in hand: a sidecar callback holds the sidecar owner's
  // record, and for an mcp sidecar that is the session itself rather than
  // the workspace. Mirroring onto the wrong record would leave the legacy
  // fields drifting from the file, which a rollback would then serve. Both
  // fields are always written together for the same reason — mirroring only
  // the half that changed lets the other half go stale.
  // Returns the owner record as written, so a caller that is itself the owner
  // can enrich from it instead of paying for a re-read.
  private writeWorkspaceStateWithLegacyMirror(
    member: SessionRecord,
    state: WorkspaceState,
    options?: { touchUpdatedAt?: boolean },
  ): SessionRecord | null {
    const workspaceId = workspaceIdOf(member);
    writeWorkspaceState(this.config.dataDir, workspaceId, state);
    const owner =
      member.id === workspaceId ? member : readSession(this.config.dataDir, workspaceId);
    if (!owner) {
      return null;
    }
    const mirrored: SessionRecord = {
      ...owner,
      ...(options?.touchUpdatedAt ? { updatedAt: nowIso() } : {}),
    };
    if (state.slots) {
      mirrored.slots = state.slots;
    } else {
      delete mirrored.slots;
    }
    if (state.pr) {
      mirrored.pr = state.pr;
    } else {
      delete mirrored.pr;
    }
    writeSession(this.config.dataDir, mirrored);
    return mirrored;
  }

  private hasActiveWorktreePathPeers(session: SessionRecord): boolean {
    const worktreePath = session.worktreePath.trim();
    if (!worktreePath) {
      return false;
    }
    return listSessions(this.config.dataDir).some(
      (candidate) =>
        candidate.id !== session.id &&
        candidate.worktreePath.trim() === worktreePath &&
        !isTerminalSessionStatus(candidate.status),
    );
  }

  private shouldRemoveWorktreeOnTerminal(session: SessionRecord): boolean {
    return (
      session.worktree &&
      session.worktreePath.trim().length > 0 &&
      workspaceExists(session.worktreePath) &&
      !this.hasActiveWorkspaceMembers(session) &&
      !this.hasActiveWorktreePathPeers(session)
    );
  }

  private async prepareBackgroundSpawn(request: SpawnSessionRequest): Promise<PreparedSpawn> {
    request = normalizeShepherdSpawnRequest(request);
    const admissionReservation = this.reserveAdmission(request.project, "spawn");
    let admissionReserved = true;
    let stage = "validating";
    let sessionId: string | undefined;
    let project: ProjectConfig | undefined;
    let agent: SessionRecord["agent"] | undefined;
    let worktree = false;
    let createdAt: string | undefined;
    let placeholderWritten = false;
    let prompt = "";
    let steps: string[] | undefined;
    let planMode: boolean;
    let restrictWrites: boolean;
    let allowedTriggers: string[] | undefined;
    let selfDestruct: SelfDestructConfig | undefined;
    let resolvedModel: string | undefined;
    let resolvedBranch: ResolvedSpawnBranch | undefined;
    let explicitBranch: string | undefined;
    let reuseCtx: {
      workspaceId: string;
      workspacePath: string;
      resolvedBranch: ResolvedSpawnBranch;
    } | null = null;
    try {
      ({ project, prompt, steps, planMode, restrictWrites, allowedTriggers, selfDestruct } =
        this.resolveSpawnTarget(request));
      if (
        request.branch !== undefined &&
        (typeof request.branch !== "string" || !request.branch.trim())
      ) {
        throw new Error("branch must be a non-empty string when provided");
      }
      explicitBranch = request.branch?.trim() || undefined;

      const overrides = parseSpawnOverrides(request.overrides, "overrides");
      worktree = resolveSpawnWorktree(project, overrides);
      reuseCtx = this.resolveWorkspaceReuseContext(request, project, worktree);
      const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
      agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
      resolvedModel = await resolveAgentLaunchModel(
        agent,
        resolveSpawnModel({
          requestModel: request.model,
          resolvedAgent: agent,
          project,
        }),
      );
      sessionId = await reserveNextSessionId(
        this.config.dataDir,
        request.project,
        project.sessionPrefix,
      );
      if (reuseCtx) {
        resolvedBranch = reuseCtx.resolvedBranch;
      } else if (!worktree) {
        stage = "branch.resolve";
        resolvedBranch = await resolveSpawnBranch({
          repoPath: project.path,
          requestBranch: request.branch,
          ...(request.branch ? { requestBranchSource: "explicit" as const } : {}),
          worktree,
          fallbackBranch: sessionId,
          project,
        });
      }
      createdAt = nowIso();
      const placeholderBranch = resolvedBranch?.branch ?? explicitBranch ?? sessionId;
      const placeholderBranchSource =
        resolvedBranch?.branchSource ?? (worktree && explicitBranch ? "explicit" : undefined);
      const placeholderWorktreePath = reuseCtx
        ? reuseCtx.workspacePath
        : worktree
          ? join(this.config.worktreeDir, request.project, sessionId)
          : project.path;
      const originalTaskPrompt = resolveOriginalTaskPrompt(request, prompt);
      const placeholder: SessionRecord = {
        id: sessionId,
        project: request.project,
        workspaceId: reuseCtx?.workspaceId ?? sessionId,
        agent,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        planMode,
        ...(restrictWrites ? { restrictWrites: true } : {}),
        ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
        prompt,
        branch: placeholderBranch,
        ...(placeholderBranchSource ? { branchSource: placeholderBranchSource } : {}),
        worktree,
        worktreePath: placeholderWorktreePath,
        tmuxSession: sessionId,
        launchCommand: "",
        status: "spawning",
        createdAt,
        updatedAt: createdAt,
        ...(Object.keys(resolveSessionSidecars({ agent }, project)).length > 0
          ? { sidecarNames: Object.keys(resolveSessionSidecars({ agent }, project)) }
          : {}),
        ...(request.slots?.links?.length
          ? { slots: { links: normalizeSlotLinks(request.slots.links) } }
          : {}),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        originalTaskPrompt,
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;
      this.admissionReservations.delete(admissionReservation);
      admissionReserved = false;

      this.logEvent("session.spawn.started", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawning ${sessionId}`,
        details: {
          agent,
          branch: placeholderBranch,
          worktree,
          defaultBranch,
          branchSource: placeholderBranchSource ?? null,
          mode: "background",
          ...(reuseCtx ? { reuseWorkspaceSessionId: request.reuseWorkspaceSessionId ?? null } : {}),
        },
      });

      const startupAttachments = this.storeAttachments(
        workspaceIdOf(placeholder),
        request.attachments,
      );
      this.logUserInput(sessionId, request.project, {
        kind: "spawn_prompt",
        text: prompt,
        source: "spawn_background",
        attachments: startupAttachments,
      });

      return {
        request,
        project,
        agent,
        prompt,
        ...(steps ? { steps } : {}),
        planMode,
        restrictWrites,
        ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        worktree,
        defaultBranch,
        sessionId,
        ...(resolvedBranch ? { resolvedBranch } : {}),
        ...(reuseCtx ? { reuseWorkspacePath: reuseCtx.workspacePath } : {}),
        placeholder,
        sessionToolDir: this.prepareSessionTools(sessionId, agent, request.project),
        startupAttachments,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionId && project && placeholderWritten) {
        const erroredWorkspaceId = reuseCtx?.workspaceId ?? sessionId;
        this.removeSessionArtifacts({
          id: sessionId,
          project: request.project,
          workspaceId: erroredWorkspaceId,
        });
        const erroredBranchSource =
          resolvedBranch?.branchSource ?? (worktree && explicitBranch ? "explicit" : undefined);
        writeSession(this.config.dataDir, {
          id: sessionId,
          project: request.project,
          workspaceId: erroredWorkspaceId,
          agent:
            agent ??
            parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent),
          prompt,
          branch: resolvedBranch?.branch ?? explicitBranch ?? sessionId,
          ...(erroredBranchSource ? { branchSource: erroredBranchSource } : {}),
          worktree,
          worktreePath: reuseCtx
            ? reuseCtx.workspacePath
            : worktree
              ? join(this.config.worktreeDir, request.project, sessionId)
              : project.path,
          tmuxSession: sessionId,
          launchCommand: "",
          status: "errored",
          createdAt: createdAt ?? nowIso(),
          updatedAt: nowIso(),
          error: message,
        });
      }
      this.logEvent("session.spawn.failed", {
        level: "error",
        ...(sessionId ? { sessionId } : {}),
        projectId: request.project,
        message: sessionId
          ? `Failed to spawn ${sessionId}: ${message}`
          : `Failed to spawn session: ${message}`,
        details: {
          stage,
          requestedAgent: request.agent ?? null,
        },
      });
      throw error;
    } finally {
      if (admissionReserved) {
        this.admissionReservations.delete(admissionReservation);
      }
    }
  }

  private async runBackgroundSpawnAttempt(
    prepared: PreparedSpawn,
    attempt: number,
  ): Promise<BackgroundSpawnAttemptResult> {
    const {
      agent,
      planMode,
      project,
      prompt,
      request,
      restrictWrites,
      allowedTriggers,
      selfDestruct,
      sessionId,
    } = prepared;
    let stage = attempt > 1 ? `retry.${attempt}.preflight` : "preflight";
    let workspacePath = prepared.worktree ? "" : project.path;
    let initialPromptSent = false;
    try {
      let resolvedBranch = prepared.resolvedBranch;
      let preflightOutcome: "branch" | "fallback-branch" | "defer" | undefined;
      let preflightBranch: string | undefined;
      let preflightUnvalidatedBranch = false;
      let preflightAttempts: number | undefined;
      if (!resolvedBranch) {
        let effectiveBranch = request.branch;
        let effectiveBranchSource: Extract<BranchSource, "explicit" | "preflight"> | undefined =
          request.branch ? "explicit" : undefined;
        if (!effectiveBranch && prepared.worktree && project.preflight && prompt) {
          const preflight = await runSpawnPreflightForSpawn({
            agent,
            projectId: request.project,
            project,
            baseBranch: prepared.defaultBranch,
            worktree: prepared.worktree,
            prompt,
          });
          preflightOutcome = preflight.outcome;
          preflightAttempts = preflight.attempts;
          if (preflight.outcome === "branch") {
            preflightBranch = preflight.branch;
            effectiveBranch = preflight.branch;
            effectiveBranchSource = "preflight";
          } else if (preflight.outcome === "fallback-branch") {
            preflightBranch = preflight.branch;
            effectiveBranch = preflight.branch;
            effectiveBranchSource = "preflight";
            preflightUnvalidatedBranch = true;
            this.logEvent("session.preflight.deferred", {
              level: "warn",
              sessionId,
              projectId: request.project,
              message: `Spawn preflight exhausted ${preflight.attempts} attempts; using unvalidated agent-proposed branch ${preflight.branch} as last resort: ${preflight.deferReason}`,
              details: {
                attempts: preflight.attempts,
                reason: preflight.deferReason,
                branch: preflight.branch,
                unvalidated: true,
              },
            });
          } else {
            preflightUnvalidatedBranch = preflight.unvalidated === true;
            this.logEvent("session.preflight.deferred", {
              level: "warn",
              sessionId,
              projectId: request.project,
              message: spawnPreflightDeferLogMessage(preflight),
              details: {
                attempts: preflight.attempts,
                branch: null,
                reason: preflight.deferReason ?? null,
              },
            });
          }
        }
        if (preflightOutcome) {
          this.logEvent("session.preflight.completed", {
            level: "info",
            sessionId,
            projectId: request.project,
            message:
              preflightOutcome !== "defer"
                ? `Spawn preflight selected branch ${preflightBranch} for ${sessionId}`
                : `Spawn preflight deferred branch selection for ${sessionId}`,
            details: {
              outcome: preflightOutcome,
              branch: preflightBranch ?? null,
              baseBranch: prepared.defaultBranch,
              attempt,
              preflightAttempts: preflightAttempts ?? 1,
            },
          });
        }
        // Preflight phase is done; branch resolution is its own phase. Reset so a
        // resolveSpawnBranch failure is not mislabeled as a preflight failure.
        // Mirror: foreground spawn() ~3238.
        stage = attempt > 1 ? `retry.${attempt}.branch.resolve` : "branch.resolve";
        const skipBranchNamingValidation =
          preflightUnvalidatedBranch || request.allowUnvalidatedFallbackBranch === true;
        resolvedBranch = await resolveSpawnBranch({
          repoPath: project.path,
          requestBranch: effectiveBranch,
          ...(effectiveBranchSource ? { requestBranchSource: effectiveBranchSource } : {}),
          worktree: prepared.worktree,
          fallbackBranch: sessionId,
          project,
          ...(skipBranchNamingValidation ? { skipBranchNamingValidation: true } : {}),
        });
        if (prepared.worktree && resolvedBranch.branch !== sessionId) {
          const branchConflictPath = await findWorktreePathForBranch(
            project.path,
            resolvedBranch.branch,
          );
          if (branchConflictPath) {
            if (resolvedBranch.branchSource === "explicit") {
              throw new Error(
                `branch "${resolvedBranch.branch}" is already checked out in worktree ${branchConflictPath}`,
              );
            }
            this.logEvent("session.spawn.branch_conflict", {
              level: "warn",
              sessionId,
              projectId: request.project,
              message: `Branch ${resolvedBranch.branch} is already checked out; falling back to ${sessionId}`,
              details: {
                occupiedBranch: resolvedBranch.branch,
                conflictingWorktreePath: branchConflictPath,
                fallbackBranch: sessionId,
                branchSource: resolvedBranch.branchSource ?? null,
                attempt,
              },
            });
            resolvedBranch = { branch: sessionId };
          }
        }
        prepared.resolvedBranch = resolvedBranch;
      }

      const spawnPlaceholder: SessionRecord = {
        ...prepared.placeholder,
        branch: resolvedBranch.branch,
        ...(resolvedBranch.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
        updatedAt: nowIso(),
      };
      writeSession(this.config.dataDir, spawnPlaceholder);
      prepared.placeholder = spawnPlaceholder;

      stage = attempt > 1 ? `retry.${attempt}.worktree.create` : "worktree.create";
      if (prepared.worktree) {
        if (prepared.reuseWorkspacePath) {
          workspacePath = prepared.reuseWorkspacePath;
          this.logEvent("session.spawn.worktree_reused", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Reusing worktree for ${sessionId}`,
            details: {
              worktreePath: workspacePath,
              attempt,
            },
          });
        } else {
          workspacePath = await createWorktree({
            repoPath: project.path,
            worktreeBaseDir: this.config.worktreeDir,
            projectId: request.project,
            sessionId,
            defaultBranch: prepared.defaultBranch,
            branch: resolvedBranch.branch,
            symlinks: project.symlinks,
          });
          this.logEvent("session.spawn.worktree_created", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Created worktree for ${sessionId}`,
            details: {
              worktreePath: workspacePath,
              symlinkCount: project.symlinks.length,
              attempt,
            },
          });
        }
      } else {
        this.logEvent("session.spawn.shared_workspace", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Using shared workspace for ${sessionId}`,
          details: {
            workspacePath,
            branch: resolvedBranch.branch,
            attempt,
          },
        });
      }

      const firstStage = prepared.steps?.[0];
      const taskPrompt = buildSessionPrompt(prompt, planMode, restrictWrites);
      const initialMessage =
        prepared.steps && firstStage
          ? formatPipelineStepMessage(taskPrompt, firstStage, 0, prepared.steps.length)
          : taskPrompt;
      const startupAttachments = prepared.startupAttachments;
      const { startupImagePaths, startupAttachmentLines } = this.partitionStartupAttachments(
        agent,
        startupAttachments,
      );
      const sidecarNames = manualSidecarNames(resolveSessionSidecars({ agent }, project));
      const spawnInitialMessage = buildInitialMessage(
        [...startupAttachmentLines, initialMessage].filter((line) => line.trim()).join("\n"),
        sidecarNames,
        this.config.tags,
        project.branchNaming?.regex,
        selfDestruct,
      );
      const { session: sessionForMcp, mcpBindings } = await this.startMcpSidecars(
        { ...spawnPlaceholder, worktreePath: workspacePath },
        project,
      );
      const hookSetup = await setupSessionAgentHooks({
        agent,
        dataDir: this.config.dataDir,
        sessionId,
        worktreePath: workspacePath,
        sessionToolDir: prepared.sessionToolDir,
        restrictWrites,
        modelsCacheHome: this.config.models.codexHome,
        ...(mcpBindings.length > 0 ? { mcpBindings } : {}),
      });
      // Pin a native session id at launch for claude (fresh per attempt so a
      // retry never reuses a possibly-existing transcript id).
      const claudeSessionId = agent === "claude" ? randomUUID() : undefined;
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...withAgentModeOptions(withProjectAgentOptions(agent, project, hookSetup), {
          planMode,
          restrictWrites,
        }),
        ...(prepared.placeholder.model !== undefined ? { model: prepared.placeholder.model } : {}),
        ...(startupImagePaths.length > 0 ? { startupImagePaths } : {}),
        ...(claudeSessionId ? { agentSessionId: claudeSessionId } : {}),
      });
      const promptDeliveredOnLaunch =
        startupImagePaths.length > 0 &&
        !launchPlan.initialMessage.trim() &&
        spawnInitialMessage.trim().length > 0;
      const pipeline = prepared.steps
        ? {
            steps: prepared.steps,
            nextStepIndex: 1,
            awaitingStepIndex: 0,
            status: "running" as const,
          }
        : undefined;
      const runningRecord: SessionRecord = {
        ...sessionForMcp,
        planMode,
        restrictWrites,
        ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        ...(claudeSessionId ? { agentSessionId: claudeSessionId } : {}),
        status: "running",
        updatedAt: nowIso(),
        ...(startupAttachments.length > 0
          ? {
              startupAttachmentIds: startupAttachments.map((attachment) => attachment.id),
            }
          : {}),
        ...(pipeline ? { pipeline } : {}),
      };

      stage = attempt > 1 ? `retry.${attempt}.tmux.create` : "tmux.create";
      const sessionEnv = buildSessionEnv({
        agent,
        projectId: request.project,
        sessionId,
        artifactsSessionId: workspaceIdOf(runningRecord),
        sessionToolDir: prepared.sessionToolDir,
        dataDir: this.config.dataDir,
        repoPath: project.path,
        symlinks: project.symlinks,
      });
      await createTmuxSession({
        sessionName: sessionId,
        cwd: workspacePath,
        launchCommand: launchPlan.launchCommand,
        agent,
        env: sessionEnv,
      });
      this.logEvent("session.spawn.tmux_created", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Created tmux session for ${sessionId}`,
        details: {
          tmuxSession: sessionId,
          attempt,
        },
      });

      stage = attempt > 1 ? `retry.${attempt}.tmux.ready` : "tmux.ready";
      await waitForTmuxReady(
        sessionId,
        launchPlan.readyMarkers,
        attempt === 1 ? BACKGROUND_SPAWN_READY_TIMEOUT_MS : undefined,
        { agent },
      );
      this.logEvent("session.spawn.ready", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Agent prompt is ready for ${sessionId}`,
        details: { attempt },
      });

      if (launchPlan.initialMessage.trim()) {
        stage = attempt > 1 ? `retry.${attempt}.prompt.send` : "prompt.send";
        await this.sendAgentMessage(runningRecord, launchPlan.initialMessage);
        initialPromptSent = true;
        this.logEvent("session.spawn.initial_prompt_sent", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Sent initial prompt to ${sessionId}`,
          details: {
            messageLength: launchPlan.initialMessage.length,
            attempt,
          },
        });
      } else if (promptDeliveredOnLaunch) {
        initialPromptSent = true;
        this.logEvent("session.spawn.initial_prompt_sent", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Sent initial prompt to ${sessionId}`,
          details: {
            attempt,
            deliveryMode: "launch_command",
            imageCount: startupImagePaths.length,
            messageLength: spawnInitialMessage.length,
          },
        });
      }

      stage = attempt > 1 ? `retry.${attempt}.record.write` : "record.write";
      let updatedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );
      updatedRecord = await this.startAutoStartSidecars(updatedRecord, project);

      writeSession(this.config.dataDir, updatedRecord);
      updatedRecord = this.applyRequestedStateSubscriptions(updatedRecord, request.subscriptions);
      await this.refreshDashboardCacheEntry(updatedRecord);
      this.logEvent("session.spawn.completed", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawned ${sessionId}`,
        details: {
          worktreePath: workspacePath,
          tmuxSession: sessionId,
          agent,
          agentSessionId: updatedRecord.agentSessionId ?? null,
          attempt,
        },
      });
      if (this.shouldRunDelivery(updatedRecord)) {
        this.scheduleDeliveryRunner(updatedRecord.id);
      }
      return "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalFailure = attempt >= SPAWN_RETRY_ATTEMPTS || initialPromptSent;
      await this.cleanupBackgroundSpawnAttempt(prepared, workspacePath, finalFailure);
      if (!finalFailure) {
        writeSession(this.config.dataDir, {
          ...prepared.placeholder,
          launchCommand: "",
          status: "spawning",
          updatedAt: nowIso(),
        });
        this.logEvent("session.spawn.retrying", {
          level: "warn",
          sessionId,
          projectId: request.project,
          message: `Spawn attempt ${attempt} failed for ${sessionId}; retrying`,
          details: {
            stage,
            attempt,
            nextAttempt: attempt + 1,
            error: message,
          },
        });
        return "retry";
      }
      writeSession(this.config.dataDir, {
        ...prepared.placeholder,
        worktreePath: workspacePath || prepared.placeholder.worktreePath,
        launchCommand: "",
        status: "errored",
        updatedAt: nowIso(),
        error: message,
      });
      this.logEvent("session.spawn.failed", {
        level: "error",
        sessionId,
        projectId: request.project,
        message: `Failed to spawn ${sessionId}: ${message}`,
        details: {
          stage,
          attempt,
          worktree: prepared.worktree,
          worktreePath: workspacePath || prepared.placeholder.worktreePath || null,
          agent,
          branch: prepared.placeholder.branch,
        },
      });
      return "completed";
    }
  }

  async spawnInBackground(request: SpawnSessionRequest): Promise<SessionView> {
    const prepared = await this.prepareBackgroundSpawn(request);
    this.spawnsInFlight.add(prepared.placeholder.id);
    const placeholder = await this.enrich(prepared.placeholder);
    const run = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        void (async () => {
          try {
            for (let attempt = 1; attempt <= SPAWN_RETRY_ATTEMPTS; attempt += 1) {
              const result = await this.runBackgroundSpawnAttempt(prepared, attempt);
              if (result === "completed") {
                return;
              }
            }
          } finally {
            this.spawnsInFlight.delete(prepared.placeholder.id);
            resolve();
          }
        })();
      });
    });
    this.backgroundSpawnRuns.add(run);
    void run.finally(() => this.backgroundSpawnRuns.delete(run));
    return placeholder;
  }

  async spawnShepherd(request: { prompt?: string } = {}): Promise<SessionView> {
    const prompt = request.prompt?.trim() ?? "";
    const reusable = listSessions(this.config.dataDir)
      .filter(
        (session) =>
          session.project === SHEPHERD_PROJECT_ID &&
          ["running", "spawning"].includes(session.status),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (reusable) {
      if (prompt && reusable.status !== "spawning") {
        return this.send(reusable.id, { message: prompt });
      }
      return this.enrich(reusable);
    }
    return this.spawnInBackground({
      project: SHEPHERD_PROJECT_ID,
      prompt,
      agent: "claude",
      overrides: { worktree: false },
    });
  }

  async scheduleWake(sessionId: string, request: ScheduleSessionWakeRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const {
      intervalWake: _intervalWake,
      dailyWake: _dailyWake,
      ...sessionWithoutRecurringWakes
    } = session;
    if (request.dailyAt !== undefined) {
      if (
        request.at !== undefined ||
        request.delayMs !== undefined ||
        request.intervalMs !== undefined
      ) {
        throw new Error("dailyAt cannot be combined with at, delayMs, or intervalMs");
      }
      const stopCondition = request.stopCondition?.trim();
      if (!stopCondition) {
        throw new Error("stopCondition is required for daily wakes");
      }
      const dailyAt = normalizeDailyWakeTimes(request.dailyAt);
      const nextDueAt = resolveNextDailyWakeAt(dailyAt);
      const message = request.message?.trim() || DEFAULT_DAILY_WAKE_MESSAGE;
      const updated: SessionRecord = {
        ...sessionWithoutRecurringWakes,
        dailyWake: {
          dailyAt,
          nextDueAt: nextDueAt.toISOString(),
          message,
          stopCondition,
        },
        updatedAt: nowIso(),
      };
      writeSession(this.config.dataDir, updated);
      this.logEvent("session.wake.daily_scheduled", {
        level: "info",
        sessionId,
        projectId: updated.project,
        message: `Scheduled daily wake for ${sessionId}`,
        details: {
          dailyAt,
          nextDueAt: nextDueAt.toISOString(),
        },
      });
      return this.enrich(updated);
    }
    if (request.intervalMs !== undefined) {
      if (!Number.isFinite(request.intervalMs) || Number(request.intervalMs) <= 0) {
        throw new Error("intervalMs must be a positive number");
      }
      const stopCondition = request.stopCondition?.trim();
      if (!stopCondition) {
        throw new Error("stopCondition is required for interval wakes");
      }
      const nextDueAt = this.resolveIntervalWakeDueAt(request);
      const message = request.message?.trim() || DEFAULT_INTERVAL_WAKE_MESSAGE;
      const updated: SessionRecord = {
        ...sessionWithoutRecurringWakes,
        intervalWake: {
          nextDueAt: nextDueAt.toISOString(),
          intervalMs: Number(request.intervalMs),
          message,
          stopCondition,
        },
        updatedAt: nowIso(),
      };
      writeSession(this.config.dataDir, updated);
      this.logEvent("session.wake.interval_scheduled", {
        level: "info",
        sessionId,
        projectId: updated.project,
        message: `Scheduled interval wake for ${sessionId}`,
        details: {
          nextDueAt: nextDueAt.toISOString(),
          intervalMs: Number(request.intervalMs),
        },
      });
      return this.enrich(updated);
    }
    const dueAt = this.resolveWakeDueAt(request);
    const message = request.message?.trim() || DEFAULT_WAKE_MESSAGE;
    const updated: SessionRecord = {
      ...session,
      scheduledWake: {
        dueAt: dueAt.toISOString(),
        message,
      },
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    this.logEvent("session.wake.scheduled", {
      level: "info",
      sessionId,
      projectId: updated.project,
      message: `Scheduled wake for ${sessionId}`,
      details: {
        dueAt: dueAt.toISOString(),
      },
    });
    return this.enrich(updated);
  }

  async cancelWake(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const { intervalWake: _intervalWake, dailyWake: _dailyWake, ...base } = session;
    const updated: SessionRecord = { ...base, updatedAt: nowIso() };
    writeSession(this.config.dataDir, updated);
    const event =
      session.dailyWake && !session.intervalWake
        ? "session.wake.daily_cancelled"
        : "session.wake.interval_cancelled";
    this.logEvent(event, {
      level: "info",
      sessionId,
      projectId: updated.project,
      message: `Cancelled recurring wake for ${sessionId}`,
    });
    return this.enrich(updated);
  }

  async replyToSource(
    sessionId: string,
    request: SourceReplyRequest,
  ): Promise<SourceReplyResponse> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (!message) {
      throw new InvalidSourceReplyInputError("message must be a non-empty string");
    }

    const target = readTelegramReplyTarget(this.config.dataDir, sessionId);
    if (!target) {
      throw new InvalidSourceReplyInputError(`No Telegram reply target for ${sessionId}`);
    }
    const source = this.config.projects[target.projectId]?.sources[target.sourceId];
    if (!source || source.type !== "telegram") {
      throw new InvalidSourceReplyInputError(
        `Telegram source is not configured for ${target.projectId}/${target.sourceId}`,
      );
    }

    const view = await this.enrich(session);
    const result = await sendTelegramReply(source, target, message, {
      topicName: telegramTopicName(view),
    });
    const { statusMessageId: _statusMessageId, ...targetWithoutStatus } = target;
    const replyTarget = {
      ...(result.statusMessageIdConsumed ? targetWithoutStatus : target),
      ...(result.messageThreadId !== undefined ? { messageThreadId: result.messageThreadId } : {}),
      lastReplyAt: new Date().toISOString(),
    };
    writeTelegramReplyTarget(this.config.dataDir, replyTarget);
    if (result.messageThreadId !== undefined && target.messageThreadId !== result.messageThreadId) {
      const bindings = readTelegramBindings(this.config.dataDir, target.projectId, target.sourceId);
      bindings.set(`${target.chatId}:${result.messageThreadId}`, {
        chatId: target.chatId,
        messageThreadId: result.messageThreadId,
        sessionId,
      });
      writeTelegramBindings(
        this.config.dataDir,
        target.projectId,
        target.sourceId,
        bindings.values(),
      );
    }
    this.logEvent("source.reply.sent", {
      level: "info",
      sessionId,
      projectId: replyTarget.projectId,
      sourceId: replyTarget.sourceId,
      message: `Sent telegram reply for ${sessionId}`,
      details: {
        type: "telegram",
        chatId: replyTarget.chatId,
        ...(replyTarget.messageThreadId !== undefined
          ? { messageThreadId: replyTarget.messageThreadId }
          : {}),
      },
    });
    return {
      ok: true,
      source: "telegram",
      sessionId,
      projectId: replyTarget.projectId,
      sourceId: replyTarget.sourceId,
      chatId: replyTarget.chatId,
      ...(replyTarget.messageThreadId !== undefined
        ? { messageThreadId: replyTarget.messageThreadId }
        : {}),
    };
  }

  async send(sessionId: string, request: SendMessageRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!hasMessageContent(request)) {
      throw new Error("message or attachments required");
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }
    const finalMessage = this.prepareSendMessage(session, request);
    if (request.queue === false) {
      return this.deliverPrepared(sessionId, finalMessage, {
        interrupt: request.interrupt === true,
        entryPoint: "send",
        hasAttachments: (request.attachments?.length ?? 0) > 0,
      });
    }

    const readySession = await this.ensureSessionReadyForSend(session);
    const queued = queuedMessages(readySession);
    const sendState = agentBusyQueuedSendAwaitsPrompt(readySession.agent)
      ? await this.classifySessionState(readySession)
      : "waiting";
    let activeRecord: SessionRecord;
    if (queued.includes(finalMessage)) {
      this.logEvent("session.message.duplicate_ignored", {
        level: "info",
        sessionId,
        projectId: readySession.project,
        message: `Ignored duplicate queued message for ${sessionId}`,
        details: {
          queuedCount: queued.length,
          messageLength: finalMessage.length,
        },
      });
      activeRecord = readySession;
    } else {
      activeRecord = withQueuedMessages(
        {
          ...readySession,
          status: "running",
          updatedAt: nowIso(),
        },
        [...queued, finalMessage],
        readySession.queuedMessages?.awaitingPrompt === true || sendState !== "waiting",
      );
      writeSession(this.config.dataDir, activeRecord);
      this.logEvent("session.message.queued", {
        level: "info",
        sessionId,
        projectId: activeRecord.project,
        message: `Queued message for ${sessionId}`,
        details: {
          queuedCount: queuedMessages(activeRecord).length,
          messageLength: finalMessage.length,
        },
      });
    }
    if (activeRecord.queuedMessages?.awaitingPrompt !== true) {
      await this.tryDeliverQueuedMessage(sessionId);
    }
    this.scheduleDeliveryRunner(sessionId);
    return this.enrich(readSession(this.config.dataDir, sessionId) ?? activeRecord);
  }

  async answerQuestion(sessionId: string, optionIndex: number): Promise<void> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.agent !== "claude") {
      throw new Error("Interactive answering is only supported for claude sessions");
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }
    if (!Number.isInteger(optionIndex) || optionIndex < 0) {
      throw new Error("optionIndex must be a non-negative integer");
    }
    await sendMenuSelectionKeys(session.tmuxSession, optionIndex);
  }

  async deliver(
    sessionId: string,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("message must be a non-empty string");
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }

    return this.deliverPrepared(sessionId, message, { ...options, entryPoint: "deliver" });
  }

  private async deliverPrepared(
    sessionId: string,
    message: string,
    options: { interrupt?: boolean; entryPoint: "send" | "deliver"; hasAttachments?: boolean },
  ): Promise<SessionView> {
    const initialSession = readSession(this.config.dataDir, sessionId);
    try {
      if (!initialSession) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (this.isLiveStateRateLimited(initialSession)) {
        this.logEvent("session.message.suppressed_rate_limited", {
          level: "info",
          sessionId,
          projectId: initialSession.project,
          message: `Suppressed message to ${sessionId} while rate limited`,
          details: {
            entryPoint: options.entryPoint,
            messageLength: message.length,
            hasAttachments: options.hasAttachments === true,
            interrupt: options.interrupt === true,
          },
        });
        throw new SessionRateLimitedError(`Session ${sessionId} is rate limited`);
      }
      const readySession = await this.ensureSessionReadyForSend(initialSession);
      let interrupt = options.interrupt === true;
      if (interrupt) {
        const sendState = await this.classifySessionState(readySession);
        interrupt = sendState !== "waiting";
      }
      await this.sendAgentMessage(readySession, message, { interrupt });
      this.stateCache.delete(sessionId);
      const updated: SessionRecord = {
        ...readySession,
        status: "running",
        updatedAt: nowIso(),
      };
      const persisted = await this.captureAgentSessionId(updated, AGENT_SESSION_ID_REFRESH_WAIT_MS);
      writeSession(this.config.dataDir, persisted);
      this.logEvent("session.message.sent", {
        level: "info",
        sessionId,
        projectId: initialSession.project,
        message: `Delivered message to ${sessionId}`,
        details: {
          interrupt,
          messageLength: message.length,
          agentSessionId: persisted.agentSessionId ?? null,
        },
      });
      return await this.enrich(persisted);
    } catch (error) {
      if (error instanceof SessionRateLimitedError) {
        throw error;
      }
      const failure = error instanceof Error ? error.message : String(error);
      this.logEvent("session.message.failed", {
        level: "error",
        sessionId,
        ...(initialSession ? { projectId: initialSession.project } : {}),
        message: `Failed to deliver message to ${sessionId}: ${failure}`,
        details: {
          interrupt: options.interrupt === true,
        },
      });
      throw error;
    }
  }

  private partitionStartupAttachments(
    agent: AgentName,
    startupAttachments: Array<{ id: string; path: string }>,
  ): { startupImagePaths: string[]; startupAttachmentLines: string[] } {
    if (agent !== "codex") {
      return {
        startupImagePaths: [],
        startupAttachmentLines: buildAttachmentReferenceLines(
          startupAttachments.map((attachment) => attachment.id),
        ),
      };
    }
    const imageAttachments = startupAttachments.filter((attachment) =>
      isImageArtifactPath(attachment.path),
    );
    const nonImageAttachments = startupAttachments.filter(
      (attachment) => !isImageArtifactPath(attachment.path),
    );
    return {
      startupImagePaths: imageAttachments.map((attachment) => attachment.path),
      startupAttachmentLines: buildAttachmentReferenceLines(
        nonImageAttachments.map((attachment) => attachment.id),
      ),
    };
  }

  private storeAttachments(
    sessionId: string,
    attachments: SendMessageAttachment[] | undefined,
  ): StoredImageAttachment[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
    }

    const attachDir = ensureSessionArtifactsDir(this.config.dataDir, sessionId);
    const stored: StoredImageAttachment[] = [];
    for (const [index, att] of attachments.entries()) {
      if (typeof att.name !== "string" || !NAME_RE.test(att.name)) {
        throw new Error(`Invalid attachment name: ${String(att.name)}`);
      }
      if (typeof att.data !== "string" || !att.data) {
        throw new Error("Attachment data must be a non-empty base64 string");
      }
      const buf = Buffer.from(att.data, "base64");
      if (buf.length > MAX_DECODED_SIZE) {
        throw new Error(`Attachment ${att.name} exceeds 5MB`);
      }
      let filename = `${Date.now()}-${att.name}`;
      const initialPath = join(attachDir, filename);
      if (existsSync(initialPath)) {
        filename = `${Date.now()}-${index}-${att.name}`;
      }
      const filePath = join(attachDir, filename);
      writeFileSync(filePath, buf, { mode: 0o644 });
      setSessionArtifactOrigin(this.config.dataDir, sessionId, filename, "intentional");
      setSessionArtifactUserAdded(this.config.dataDir, sessionId, filename, true);
      stored.push({ id: filename, path: filePath, name: att.name });
    }
    return stored;
  }

  private cloneStartupAttachments(
    sessionId: string,
    attachmentIds: string[] | undefined,
  ): SendMessageAttachment[] {
    return (attachmentIds ?? []).map((attachmentId) => {
      const artifact = readSessionArtifact(this.config.dataDir, sessionId, attachmentId);
      if (!artifact) {
        throw new Error(`Startup attachment not found: ${attachmentId}`);
      }
      return {
        name: baseAttachmentName(artifact.id),
        data: readFileSync(artifact.path).toString("base64"),
      };
    });
  }

  private async findAgentHistoryFile(
    session: Pick<SessionRecord, "agent" | "id" | "worktreePath">,
  ): Promise<string | null> {
    if (session.agent === "claude") {
      return findLatestClaudeSessionFile(session.worktreePath);
    }
    return findLatestCodexSessionFile({ sessionRootDir: this.codexSessionsDir(session.id) });
  }

  private async captureStateTransitionArtifact(
    session: Pick<
      SessionRecord,
      "agent" | "id" | "status" | "worktreePath" | "workspaceId" | "deskId"
    >,
    transition: {
      at: string;
      fromState: SessionState;
      toState: SessionState;
    },
    historySourcePath?: string | null,
  ): Promise<string | null> {
    if (isTerminalSessionStatus(session.status)) {
      return null;
    }
    const sourcePath = historySourcePath ?? (await this.findAgentHistoryFile(session));
    if (!sourcePath) {
      return null;
    }
    try {
      const artifactId = stateTransitionArtifactId(
        session.id,
        transition.at,
        transition.fromState,
        transition.toState,
      );
      const anchorId = workspaceIdOf(session);
      const artifactDir = ensureSessionArtifactsDir(this.config.dataDir, anchorId);
      copyFileSync(sourcePath, join(artifactDir, artifactId));
      setSessionArtifactOrigin(this.config.dataDir, anchorId, artifactId, "automatic");
      return artifactId;
    } catch {
      return null;
    }
  }

  private async logStateTransition(
    session: Pick<
      SessionRecord,
      "agent" | "id" | "project" | "status" | "worktreePath" | "workspaceId" | "deskId"
    >,
    transition: {
      at: string;
      fromState: SessionState;
      toState: SessionState;
      source: StateSource;
    },
    historySourcePath?: string | null,
  ): Promise<void> {
    const historyArtifactId = await this.captureStateTransitionArtifact(
      session,
      transition,
      historySourcePath,
    );
    this.logEvent("session.state.transition", {
      level: "info",
      timestamp: transition.at,
      sessionId: session.id,
      projectId: session.project,
      message: `Status changed from ${transition.fromState} to ${transition.toState}`,
      details: {
        fromState: transition.fromState,
        toState: transition.toState,
        source: transition.source,
        ...(historyArtifactId ? { historyArtifactId } : {}),
      },
    });
  }

  private prepareSendMessage(
    session: Pick<SessionRecord, "id" | "project" | "workspaceId" | "deskId">,
    request: SendMessageRequest,
  ): string {
    const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (!hasAttachments) {
      this.logUserInput(session.id, session.project, {
        kind: "send_message",
        source: request.queue === false ? "send_direct" : "send",
        text: message,
      });
      return message;
    }

    const stored = this.storeAttachments(workspaceIdOf(session), request.attachments);
    this.logUserInput(session.id, session.project, {
      kind: "send_message",
      source: request.queue === false ? "send_direct" : "send",
      text: message,
      attachments: stored,
    });
    const prefixLines = buildAttachmentReferenceLines(stored.map((attachment) => attachment.id));
    return prefixLines.join("\n") + (message ? `\n${message}` : "");
  }

  async pause(sessionId: string): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "stopped");
  }

  private async sendAgentMessage(
    session: Pick<
      SessionRecord,
      "id" | "tmuxSession" | "agent" | "launchCommand" | "worktreePath" | "agentSessionId"
    >,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<void> {
    return this.withPaneWriteLock(session.tmuxSession, () =>
      this.writeAgentMessage(session, message, options),
    );
  }

  private async writeAgentMessage(
    session: Pick<
      SessionRecord,
      "id" | "tmuxSession" | "agent" | "launchCommand" | "worktreePath" | "agentSessionId"
    >,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<void> {
    const shouldWaitForSubmitAck =
      agentWaitsForSubmitAck(session.agent) && !process.env["SPUR_SKIP_CODEX_SUBMIT_ACK"];
    const sessionToolDir = join(this.config.dataDir, "session-tools", session.id);
    const binding: SubmitAckBinding | null = shouldWaitForSubmitAck
      ? await createAgentSubmitAckBinding(session.agent, {
          worktreePath: session.worktreePath,
          codexSessionsDir: join(codexHookHomePath(sessionToolDir), "sessions"),
          ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
        })
      : null;
    const startedAt = Date.now();
    await sendMessageToTmux(session.tmuxSession, message, {
      agent: session.agent,
      ...(options?.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
    });
    if (!binding) {
      return;
    }
    const ackWindowMs = agentSubmitAckWindowMs(session.agent);
    const maxResends = agentSubmitAckMaxResends(session.agent);
    let lastResult: SubmitAckScanResult = { found: false, lastScannedFile: null };
    for (let attempt = 0; attempt <= maxResends; attempt += 1) {
      lastResult = await this.waitForSubmitAck(binding, message, ackWindowMs);
      if (lastResult.found) {
        return;
      }
      if (attempt < maxResends) {
        await sendSubmitKeyToTmux(session.tmuxSession);
      }
    }
    const processAlive = await isProcessRunningInTmux(
      session.tmuxSession,
      sessionProcessMatchers(session),
    );
    const elapsedMs = Date.now() - startedAt;
    if (session.agent === "cursor" && processAlive) {
      this.logEvent("session.submit.recovered", {
        level: "warn",
        sessionId: session.id,
        message: `Cursor submit ack timed out for ${session.id} but agent process is live; continuing`,
        details: {
          agent: session.agent,
          lastScannedFile: lastResult.lastScannedFile,
          messageLength: message.length,
          elapsedMs,
          processAlive,
        },
      });
      return;
    }
    this.logEvent("session.submit.timeout", {
      level: "warn",
      sessionId: session.id,
      message: `Agent submit ack timed out for ${session.id}`,
      details: {
        agent: session.agent,
        lastScannedFile: lastResult.lastScannedFile,
        messageLength: message.length,
        elapsedMs,
        processAlive,
      },
    });
    throw new SubmitAckTimeoutError({
      sessionId: session.id,
      agent: session.agent,
      lastScannedFile: lastResult.lastScannedFile,
      elapsedMs,
      processAlive,
    });
  }

  private async waitForSubmitAck(
    binding: SubmitAckBinding,
    messageText: string,
    windowMs: number,
  ): Promise<SubmitAckScanResult> {
    const deadline = Date.now() + windowMs;
    let lastResult: SubmitAckScanResult = { found: false, lastScannedFile: null };
    while (Date.now() < deadline) {
      lastResult = await binding.scan(messageText);
      if (lastResult.found) {
        return lastResult;
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }
    return lastResult;
  }

  private async applyOpenPrAction(
    session: SessionRecord,
    action: OpenPrAction | undefined,
  ): Promise<SessionRecord> {
    // "leave_open" never touches GitHub, so skip the gh calls entirely. This keeps
    // session teardown working even when gh is unreachable (auth, rate limit, network).
    if (action === "leave_open") {
      return session;
    }

    if (!session.worktreePath || !(await isGitWorktree(session.worktreePath))) {
      return session;
    }

    try {
      const { binding, updatedSession } = await resolveSessionPrBinding(session);
      const checkedSession = updatedSession ?? session;
      if (!binding) {
        return checkedSession;
      }

      const pr = await viewSessionPrState(session.worktreePath, binding);
      if (pr?.state !== "OPEN") {
        if (updatedSession) {
          writeSession(this.config.dataDir, updatedSession);
        }
        return checkedSession;
      }

      if (action === undefined) {
        if (updatedSession) {
          writeSession(this.config.dataDir, updatedSession);
        }
        throw new OpenPrActionRequiredError(session.id, {
          number: pr.number,
          title: pr.title,
          url: pr.url,
        });
      }

      // action is "close" here (leave_open returned early, undefined threw above).
      // A failed PR close must not strand the session — warn and continue teardown.
      try {
        await closeSessionPr(session.worktreePath, binding);
      } catch (error) {
        this.logEvent("session.pr.close.failed", {
          level: "warn",
          sessionId: session.id,
          projectId: session.project,
          message: `Failed to close pull request #${binding.number} for ${session.id}; continuing teardown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      if (updatedSession) {
        writeSession(this.config.dataDir, updatedSession);
      }
      return checkedSession;
    } catch (error) {
      if (error instanceof OpenPrActionRequiredError) {
        throw error;
      }
      throw new GithubPrCheckUnavailableError(session.id, session.pr ?? null, {
        rateLimited: isGitHubRateLimitError(extractGithubErrorText(error)),
      });
    }
  }

  async complete(
    sessionId: string,
    request: CompleteSessionRequest = {},
    options?: { retainInList?: boolean },
  ): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "completed", request, options);
  }

  async selfDestruct(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    return this.applyManualStatus(sessionId, "completed", { prAction: "leave_open" });
  }

  async completeDesk(
    sessionId: string,
    request: CompleteSessionRequest = {},
  ): Promise<CompleteDeskResponse> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const candidates = this.listDeskSessions(session);

    const completedIds: string[] = [];
    for (const candidate of candidates) {
      if (candidate.status === "completed") {
        continue;
      }
      await this.applyManualStatus(candidate.id, "completed", request);
      completedIds.push(candidate.id);
    }

    return {
      completedIds,
    };
  }

  async updateSlots(sessionId: string, request: UpdateSessionSlotsRequest): Promise<SessionView> {
    const currentSession = readSession(this.config.dataDir, sessionId);
    if (!currentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // Slots (title/links/tags/pr) are workspace-owned: mutations always land
    // on the workspace's own state, so every member sees the same slots.
    const session = this.deskAnchorRecord(currentSession);
    const current = resolveWorkspaceState(this.config.dataDir, session);
    const normalized = normalizeSlotsUpdate(request);
    if (normalized.tags.length > 0) {
      const known = new Set(this.config.tags.map((tag) => tag.name));
      const unknown = normalized.tags.filter((tag) => !known.has(tag));
      if (unknown.length > 0) {
        const available = this.config.tags.map((tag) => tag.name).join(", ") || "(none configured)";
        throw new Error(`Unknown tag(s): ${unknown.join(", ")}. Available tags: ${available}`);
      }
    }
    const hasGenericPrSlot = current.slots?.links.some((link) => link.label === "pr") ?? false;
    const unlinksPr = normalized.unlinkLabels.includes("pr");
    const prLink = normalized.links.filter((link) => link.label === "pr").at(-1);
    const nativePr = prLink ? parseSessionPrBinding(prLink.url) : null;
    const genericLinks = normalized.links.filter(
      (link) => link.label !== "pr" || (prLink?.url === link.url && nativePr === null),
    );
    const genericUnlinks = normalized.unlinkLabels;
    const hasGenericChanges =
      normalized.title !== undefined ||
      normalized.clearTitle ||
      genericLinks.length > 0 ||
      genericUnlinks.length > 0 ||
      normalized.tags.length > 0 ||
      normalized.untags.length > 0;
    const slots = hasGenericChanges
      ? applySlotsUpdate(current.slots, {
          ...(normalized.title !== undefined ? { title: normalized.title } : {}),
          ...(normalized.clearTitle ? { clearTitle: true } : {}),
          ...(genericLinks.length > 0 ? { links: genericLinks } : {}),
          ...(genericUnlinks.length > 0 ? { unlinkLabels: genericUnlinks } : {}),
          ...(normalized.tags.length > 0 ? { tags: normalized.tags } : {}),
          ...(normalized.untags.length > 0 ? { untags: normalized.untags } : {}),
        })
      : current.slots;
    const nextPr = nativePr ? nativePr : unlinksPr && !hasGenericPrSlot ? undefined : current.pr;
    const nextState: WorkspaceState = {
      ...(slots ? { slots } : {}),
      ...(nextPr ? { pr: nextPr } : {}),
    };
    const owner = this.writeWorkspaceStateWithLegacyMirror(session, nextState);
    const displaySlots = deriveSessionSlots(nextState);
    this.logEvent("session.slots.updated", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Updated session slots for ${sessionId}`,
      details: {
        title: displaySlots?.title ?? null,
        linkCount: displaySlots?.links.length ?? 0,
      },
    });
    // The API response is always the CALLER's view, never the workspace
    // owner's. When the caller IS the owner, the record just written is
    // already the caller's; otherwise re-read the caller's own.
    const callerRecord =
      owner?.id === sessionId
        ? owner
        : (readSession(this.config.dataDir, sessionId) ?? currentSession);
    return this.enrich(callerRecord);
  }

  async startSidecar(
    sessionId: string,
    sidecarName: string,
    request: StartSidecarRequest = {},
  ): Promise<SessionView> {
    const caller = sidecarCallerContextFromRequest(request);
    const sidecarDepth = nextSidecarDepth(caller);
    if (caller.name && sidecarDepth > MAX_SIDECAR_DEPTH) {
      const message = formatNestedSidecarStartError(sidecarName, caller.name);
      this.logEvent("session.sidecar.start_rejected", {
        level: "warn",
        sessionId,
        message,
        details: {
          callerSidecarDepth: caller.depth,
          callerSidecarName: caller.name,
          maxSidecarDepth: MAX_SIDECAR_DEPTH,
          reason: "max_depth_exceeded",
          sidecarName,
        },
      });
      throw new Error(message);
    }
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }
    if (!session.worktreePath || !workspaceExists(session.worktreePath)) {
      throw new Error(`Session workspace is not available: ${sessionId}`);
    }
    const project = this.resolveProjectForSession(session);
    if (!project) {
      throw new Error(`Unknown project: ${session.project}`);
    }
    const sidecar = project.sidecars[sidecarName];
    if (!sidecar) {
      throw new Error(`Project ${session.project} has no sidecar "${sidecarName}" configured`);
    }
    if (!resolveSessionSidecars(session, project)[sidecarName]) {
      throw new Error(
        `Sidecar "${sidecarName}" is not available to agent "${session.agent}" for session ${sessionId}`,
      );
    }

    const updated = await this.startSidecarWithDependencies({
      session,
      project,
      sidecarName,
      sidecarDepth,
      ...(request.clearPort !== undefined ? { clearPort: request.clearPort } : {}),
      onStarted: (startedName, startedSidecar) => {
        this.logEvent("session.sidecar.started", {
          level: "info",
          sessionId,
          projectId: session.project,
          message: `Started sidecar ${startedName} for ${sessionId}`,
          details: {
            callerSidecarName: caller.name ?? null,
            sidecarName: startedName,
            sidecarDepth,
            command: startedSidecar.command,
            manualOnly: sidecarDepth > ROOT_SIDECAR_DEPTH,
            tmuxSession: sidecarTmuxSession(sidecarOwnerId(session, startedSidecar), startedName),
          },
        });
      },
    });
    return this.enrich(updated);
  }

  // Reaps a sidecar's whole tmux pane process tree (group-first where
  // proven, per-pid leaves-first otherwise) and waits for confirmation.
  // Never throws — a survivor becomes a `warn` log entry, not a rejected
  // promise (invariant: reap never blocks teardown). This is THE reap path
  // for every single-shot sidecar-kill site; only teardownSessionSidecars
  // bypasses it (signals all its sidecars first, confirms once, batching
  // the grace window instead of paying it once per sidecar here).
  private async reapSidecarByName(ownerId: string, sidecarName: string): Promise<ReapOutcome> {
    const outcome = await reapSidecarPane(sidecarTmuxSession(ownerId, sidecarName));
    this.logSidecarReapSurvivors(ownerId, sidecarName, outcome);
    return outcome;
  }

  private logSidecarReapSurvivors(
    ownerId: string,
    sidecarName: string,
    outcome: ReapOutcome | null,
  ): void {
    if (!outcome || outcome.survivors.length === 0) {
      return;
    }
    this.logEvent("session.sidecar.reap_incomplete", {
      level: "warn",
      sessionId: ownerId,
      message: `Sidecar ${sidecarName} reap on ${ownerId} left ${outcome.survivors.length} process(es) alive after the confirmation window`,
      details: { sidecarName, survivors: outcome.survivors },
    });
  }

  // Drops sidecarProcs[sidecarName] from the owner record once its pane has
  // been reaped, so a stopped sidecar's stale pgid can never be mistaken for
  // a live claim by the sweep predicate. Mirrors the `delete mirrored.slots`
  // pattern in writeWorkspaceStateWithLegacyMirror.
  private clearSidecarProcEntry(ownerId: string, sidecarName: string): void {
    const record = readSession(this.config.dataDir, ownerId);
    if (!record?.sidecarProcs?.[sidecarName]) {
      return;
    }
    const nextProcs = Object.fromEntries(
      Object.entries(record.sidecarProcs).filter(([name]) => name !== sidecarName),
    );
    const updated: SessionRecord = { ...record };
    if (Object.keys(nextProcs).length > 0) {
      updated.sidecarProcs = nextProcs;
    } else {
      delete updated.sidecarProcs;
    }
    writeSession(this.config.dataDir, updated);
  }

  // Kills a sidecar's tmux pane and unlinks its slot on the OWNER id (the
  // anchor's record for a desk-shared project sidecar, else the session's
  // own). Used by stopSidecar before its own event-logged write; the caller
  // re-reads its own record afterward rather than trusting this return.
  // Never gates on sidecarTmuxAlive alone (a dead pane and an absent tmux
  // session are exactly the states a leaked tree lives in): falls through to
  // the recorded `sidecarProcs` identity when the tmux session is gone.
  private async killSidecarAndUnlinkSlot(ownerId: string, sidecarName: string): Promise<void> {
    this.abortSidecarUrlProbe(ownerId, sidecarName);
    if (await sidecarTmuxAlive(ownerId, sidecarName)) {
      await this.reapSidecarByName(ownerId, sidecarName);
    } else {
      const owner = readSession(this.config.dataDir, ownerId);
      const identity = owner?.sidecarProcs?.[sidecarName];
      if (owner && identity) {
        const outcome = await reapRecordedIdentity(identity, owner.worktreePath);
        this.logSidecarReapSurvivors(ownerId, sidecarName, outcome);
      }
    }

    const afterKill = readSession(this.config.dataDir, ownerId);
    if (!afterKill) return;
    const resolved = resolveWorkspaceState(this.config.dataDir, afterKill);
    const nextSlots = applySlotsUpdate(resolved.slots, { unlinkLabels: [sidecarName] });
    if (nextSlots !== resolved.slots) {
      this.writeWorkspaceStateWithLegacyMirror(
        afterKill,
        {
          ...(nextSlots ? { slots: nextSlots } : {}),
          ...(resolved.pr ? { pr: resolved.pr } : {}),
        },
        { touchUpdatedAt: true },
      );
    } else {
      writeSession(this.config.dataDir, { ...afterKill, updatedAt: nowIso() });
    }
    this.clearSidecarProcEntry(ownerId, sidecarName);
  }

  async stopSidecar(sessionId: string, sidecarName: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }
    const project = this.resolveProjectForSession(session);
    const sidecarNames = sessionSidecarNames(session, project);
    if (!sidecarNames.includes(sidecarName)) {
      throw new Error(`Session ${sessionId} has no sidecar "${sidecarName}"`);
    }
    const ownerId = this.sidecarOwnerIdForName(session, project, sidecarName);

    // A dead pane or an absent tmux session with no recorded identity means
    // there is genuinely nothing left to reap.
    const owner = readSession(this.config.dataDir, ownerId);
    const alive = await sidecarTmuxAlive(ownerId, sidecarName);
    if (!alive && !owner?.sidecarProcs?.[sidecarName]) {
      return this.enrich(session);
    }

    await this.killSidecarAndUnlinkSlot(ownerId, sidecarName);
    this.logEvent("session.sidecar.stopped", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Stopped sidecar ${sidecarName} for ${sessionId}`,
      details: {
        sidecarName,
        tmuxSession: sidecarTmuxSession(ownerId, sidecarName),
      },
    });
    return this.enrich(readSession(this.config.dataDir, sessionId) ?? session);
  }

  // Report-first sweep for sidecar process trees no live session claims.
  // Reaping only happens when `reap` is true — callers are `spur sidecar
  // sweep [--reap]`; `spur doctor` calls `findLeakedSidecarTrees` directly
  // and never reaches this method, keeping doctor read-only.
  async sweepSidecarProcesses(reap: boolean): Promise<SidecarSweepResult> {
    const sessions = listSessions(this.config.dataDir);
    const assembled = assembleSidecarSweepClaims(sessions, this.config.worktreeDir);
    if (!assembled) {
      return { supported: false, leaked: [], reaped: [] };
    }
    return sweepSidecars({ ...assembled, reap });
  }

  // Signals every torn-down sidecar's pane first, then confirms the whole
  // batch through ONE shared grace window — not one sleep per sidecar (that
  // would multiply teardown latency by sidecar count).
  private async teardownSessionSidecars(session: SessionRecord): Promise<void> {
    const project = this.resolveProjectForSession(session);
    // Resolved once for the whole teardown: re-reading it per sidecar would
    // both cost a listSessions each time and let a sibling transitioning
    // mid-loop leave the desk's sidecars half torn down.
    const deskSiblingsRunning = this.hasRunningWorkspaceMembers(session);
    const pendingBySidecar: Array<{ ownerId: string; scName: string; pending: PendingReap }> = [];
    for (const scName of sessionSidecarNames(session, project)) {
      const sidecar = project?.sidecars[scName];
      // Non-mcp project sidecars are desk-shared: while another desk member's
      // agent is still running, this session's own teardown (paused, killed,
      // completed, crashed) must not touch the shared pane, slot link, or
      // ports — that member's own teardown handles it. Holds for the anchor's
      // own teardown too, where the owner id is its own id. MCP sidecars are
      // always per-session and tear down unconditionally.
      const isDeskSharedSidecar = sidecar !== undefined && !sidecar.mcp;
      if (isDeskSharedSidecar && deskSiblingsRunning) {
        continue;
      }
      const ownerId = this.sidecarOwnerIdForName(session, project, scName);
      this.abortSidecarUrlProbe(ownerId, scName);
      const record = readSession(this.config.dataDir, ownerId);
      if (record) {
        const resolved = resolveWorkspaceState(this.config.dataDir, record);
        const next = applySlotsUpdate(resolved.slots, { unlinkLabels: [scName] });
        if (next !== resolved.slots) {
          this.writeWorkspaceStateWithLegacyMirror(record, {
            ...(next ? { slots: next } : {}),
            ...(resolved.pr ? { pr: resolved.pr } : {}),
          });
        }
      }
      const pending = await signalSidecarPane(sidecarTmuxSession(ownerId, scName));
      pendingBySidecar.push({ ownerId, scName, pending });
    }
    const outcomes = await confirmReaps(pendingBySidecar.map((entry) => entry.pending));
    for (const [index, entry] of pendingBySidecar.entries()) {
      this.logSidecarReapSurvivors(entry.ownerId, entry.scName, outcomes[index] ?? null);
      this.clearSidecarProcEntry(entry.ownerId, entry.scName);
    }
  }

  // Strips sidecarPorts from a going-terminal record, keeping only the
  // anchor-owned (non-mcp, desk-shared) entries while another desk member's
  // agent is still running and using them. Route every terminal-write site
  // through this instead of a wholesale delete.
  private sessionWithReleasedSidecarPorts(session: SessionRecord): SessionRecord {
    if (!session.sidecarPorts) {
      return session;
    }
    const kept = releasableSidecarPorts(
      session,
      this.resolveProjectForSession(session),
      this.hasRunningWorkspaceMembers(session),
    );
    const { sidecarPorts: _dropped, ...rest } = session;
    return kept ? { ...rest, sidecarPorts: kept } : rest;
  }

  private async cleanupSessionServices(session: SessionRecord): Promise<void> {
    await this.teardownSessionSidecars(session);
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      await killTmuxSession(service.tmuxSession);
    }
    deleteServiceSourceStatesForSession(this.config.dataDir, session.project, session.id);
    deleteServiceInstancesForSession(this.config.dataDir, session.id);
  }

  private prepareSessionTools(sessionId: string, agent: AgentName, projectId?: string): string {
    const project = projectId ? this.config.projects[projectId] : undefined;
    return ensureSessionSlotTool({
      dataDir: this.config.dataDir,
      sessionId,
      configPath: this.config.configPath,
      ...(projectId ? { projectId } : {}),
      ...(project?.branchNaming ? { branchNamingRegex: project.branchNaming.regex } : {}),
      agent,
    });
  }

  private removeSessionArtifacts(
    session: Pick<
      SessionRecord,
      "id" | "project" | "workspaceId" | "deskId" | "startupAttachmentIds"
    >,
    options?: { preserveStartup?: boolean },
  ): void {
    const sessionId = session.id;
    // Per-session cleanup: unconditional, regardless of desk membership.
    deleteAgentHookState(this.config.dataDir, sessionId);
    deleteRuntimeLogCursorsForSession(this.config.dataDir, sessionId);
    deleteSessionUserActions(this.config.dataDir, sessionId);
    const anchorId = workspaceIdOf(session);
    // A desk sibling's own session-tools dir is per-session, so it goes now.
    // The anchor's doubles as the tool dir of the desk's shared sidecars, so
    // it is treated as shared state below.
    if (sessionId !== anchorId) {
      removeSessionSlotTool(this.config.dataDir, sessionId);
    }
    // Shared-desk cleanup: the anchor's artifacts dir and session-tools dir
    // are still in use by any other live desk member (an anchor-owned
    // project sidecar runs with the anchor's SPUR_SESSION_TOOL_DIR), so only
    // the last member's teardown may remove them. One snapshot serves both the
    // guard and the keep-list below.
    const deskMembers = listSessions(this.config.dataDir).filter(
      (s) => s.id !== sessionId && s.project === session.project && workspaceIdOf(s) === anchorId,
    );
    if (deskMembers.some((s) => !isTerminalSessionStatus(s.status))) {
      return;
    }
    // Startup attachments of EVERY member live in this one shared dir, and
    // respawn re-clones them, so a member's keep-list is not enough: deleting
    // another member's ids here would make its respawn fail permanently.
    const preservedStartupIds = new Set(
      deskMembers.flatMap((member) => member.startupAttachmentIds ?? []),
    );
    if (options?.preserveStartup) {
      for (const id of session.startupAttachmentIds ?? []) {
        preservedStartupIds.add(id);
      }
    }
    if (preservedStartupIds.size > 0) {
      deleteSessionArtifactsExcept(this.config.dataDir, anchorId, [...preservedStartupIds]);
    } else {
      deleteSessionArtifactsDir(this.config.dataDir, anchorId);
    }
    removeSessionSlotTool(this.config.dataDir, anchorId);
    // Last member's teardown: the workspace's shared slots/pr state goes
    // with the rest of its shared state.
    deleteWorkspaceState(this.config.dataDir, anchorId);
  }

  private async applyManualStatus(
    sessionId: string,
    targetStatus: ManualSessionStatus,
    request: CompleteSessionRequest,
    options: { retainInList?: boolean; skipEnrichment: true },
  ): Promise<void>;
  private async applyManualStatus(
    sessionId: string,
    targetStatus: ManualSessionStatus,
    request?: CompleteSessionRequest,
    options?: { retainInList?: boolean; skipEnrichment?: false },
  ): Promise<SessionView>;
  private async applyManualStatus(
    sessionId: string,
    targetStatus: ManualSessionStatus,
    request: CompleteSessionRequest = {},
    options?: { retainInList?: boolean; skipEnrichment?: boolean },
  ): Promise<SessionView | void> {
    const currentSession = readSession(this.config.dataDir, sessionId);
    if (!currentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let session = currentSession;
    if (targetStatus === "stopped" && session.status === "paused") {
      const migrated: SessionRecord = {
        ...this.sessionWithReleasedSidecarPorts(session),
        status: "stopped",
        stopReason: "manual_pause",
        updatedAt: nowIso(),
        ...(options?.retainInList ? { retainInList: true } : {}),
      };
      if (!options?.retainInList) {
        delete migrated.retainInList;
      }
      delete migrated.error;
      writeSession(this.config.dataDir, migrated);
      this.stateCache.delete(sessionId);
      if (options?.skipEnrichment) return;
      await this.refreshDashboardCacheEntry(migrated);
      return this.enrich(migrated);
    }
    if (session.status === targetStatus) {
      if (targetStatus === "stopped" && hasSessionErrorEvidence(session)) {
        const record: SessionRecord = {
          ...this.sessionWithReleasedSidecarPorts(session),
          status: "stopped",
          stopReason: "manual_pause",
          updatedAt: nowIso(),
          ...(options?.retainInList ? { retainInList: true } : {}),
        };
        if (!options?.retainInList) {
          delete record.retainInList;
        }
        delete record.error;
        writeSession(this.config.dataDir, record);
        this.stateCache.delete(sessionId);
        if (options?.skipEnrichment) return;
        await this.refreshDashboardCacheEntry(record);
        return this.enrich(record);
      }
      return options?.skipEnrichment ? undefined : this.enrich(session);
    }
    if (isTerminalSessionStatus(session.status)) {
      throw new Error(`Session ${sessionId} is already ${session.status}`);
    }
    const eventAction = targetStatus === "stopped" ? "pause" : "complete";

    try {
      if (targetStatus === "completed" && !request.skipPrCheck) {
        session = await this.applyOpenPrAction(session, request.prAction);
      }
      if (!request.skipRuntimeTeardown) {
        await killTmuxSession(session.tmuxSession);
        await this.cleanupSessionServices(session);
      }
      if (targetStatus === "completed") {
        this.removeSessionArtifacts(session);
        await this.pushTelegramNotice(
          sessionId,
          { id: session.id, agent: session.agent, state: "stopped" },
          `Session ${sessionId} finished (${targetStatus}). This chat is unbound.`,
          { closeTopic: true },
        );
        deleteTelegramSourceStateForSession(this.config.dataDir, session.project, sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent(`session.${eventAction}.failed`, {
        level: "error",
        sessionId,
        projectId: session.project,
        message: `Failed to mark ${sessionId} as ${targetStatus}: ${message}`,
      });
      throw error;
    }

    this.stateCache.delete(sessionId);
    const cleanedSession = readSession(this.config.dataDir, sessionId) ?? session;
    const record: SessionRecord = {
      ...this.sessionWithReleasedSidecarPorts(cleanedSession),
      status: targetStatus,
      ...(targetStatus === "stopped" ? { stopReason: "manual_pause" as const } : {}),
      updatedAt: nowIso(),
      ...(options?.retainInList ? { retainInList: true } : {}),
    };
    if (targetStatus !== "stopped") {
      delete record.stopReason;
    }
    if (!options?.retainInList) {
      delete record.retainInList;
    }
    if (targetStatus === "stopped") {
      delete record.error;
    }
    writeSession(this.config.dataDir, record);
    if (targetStatus === "completed" && this.shouldRemoveWorktreeOnTerminal(record)) {
      const cleanup = await this.resolveCleanupContext(record);
      await removeWorktree(cleanup.repoPath, record.worktreePath);
    }
    if (!options?.skipEnrichment) await this.refreshDashboardCacheEntry(record);
    this.logEvent(`session.${eventAction}.completed`, {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `${targetStatus === "stopped" ? "Stopped" : "Completed"} ${sessionId}`,
      details: {
        worktree: session.worktree,
      },
    });
    return options?.skipEnrichment ? undefined : this.enrich(record);
  }

  private async ensureKillDirtyWorktreeAllowed(
    session: SessionRecord,
    force: boolean,
  ): Promise<void> {
    if (
      !(session.worktree && session.worktreePath && (await isGitWorktree(session.worktreePath)))
    ) {
      return;
    }
    const cleanup = await this.resolveCleanupContext(session);
    const reasons: string[] = [];
    if (await hasUncommittedChanges(session.worktreePath, cleanup.symlinks)) {
      reasons.push("uncommitted changes in its worktree");
    }
    if (await hasUnpushedCommits(session.worktreePath)) {
      reasons.push("unpushed commits");
    }
    if (reasons.length > 0 && !force) {
      throw new Error(buildKillConfirmationRequiredMessage(session.id, reasons));
    }
  }

  async kill(sessionId: string, request: KillSessionRequest = {}): Promise<SessionView> {
    const currentSession = readSession(this.config.dataDir, sessionId);
    if (!currentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let session = currentSession;
    if (session.status === "completed") {
      throw new Error(`Session ${sessionId} is already completed`);
    }

    await this.ensureKillDirtyWorktreeAllowed(session, request.force === true);

    try {
      if (session.status !== "killed" && !request.skipPrCheck) {
        if (session.worktree && session.worktreePath && !workspaceExists(session.worktreePath)) {
          this.logEvent("session.kill.pr_action_skipped_missing_worktree", {
            level: "warn",
            sessionId,
            projectId: session.project,
            message: `Skipped open-PR handling for ${sessionId}: worktree missing at ${session.worktreePath}`,
          });
        } else {
          session = await this.applyOpenPrAction(session, request.prAction);
        }
      }
      await killTmuxSession(session.tmuxSession);
      await this.cleanupSessionServices(session);
      this.removeSessionArtifacts(session, { preserveStartup: true });
      await this.pushTelegramNotice(
        sessionId,
        { id: session.id, agent: session.agent, state: "killed" },
        `Session ${sessionId} finished (killed). This chat is unbound.`,
        { closeTopic: true },
      );
      deleteTelegramSourceStateForSession(this.config.dataDir, session.project, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.kill.failed", {
        level: "error",
        sessionId,
        projectId: session.project,
        message: `Failed to kill ${sessionId}: ${message}`,
      });
      throw error;
    }

    this.stateCache.delete(sessionId);

    if (session.status === "killed") {
      this.logEvent("session.kill.noop", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Session ${sessionId} was already killed`,
      });
      return this.enrich(session);
    }

    const cleanedSession = readSession(this.config.dataDir, sessionId) ?? session;
    const record: SessionRecord = {
      ...this.sessionWithReleasedSidecarPorts(cleanedSession),
      status: "killed",
      updatedAt: nowIso(),
    };
    delete record.retainInList;
    writeSession(this.config.dataDir, record);
    if (this.shouldRemoveWorktreeOnTerminal(record)) {
      const cleanup = await this.resolveCleanupContext(record);
      try {
        await removeWorktree(cleanup.repoPath, record.worktreePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.kill.worktree_remove_failed", {
          level: "warn",
          sessionId,
          projectId: record.project,
          message: `Failed to remove worktree for ${sessionId}: ${message}`,
          details: { repoPath: cleanup.repoPath, worktreePath: record.worktreePath },
        });
      }
    }
    await this.refreshDashboardCacheEntry(record);
    this.logEvent("session.kill.completed", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Killed ${sessionId}`,
      details: {
        worktree: session.worktree,
      },
    });
    return this.enrich(record);
  }

  private async captureAgentSessionId(
    session: SessionRecord,
    timeoutMs: number,
  ): Promise<SessionRecord> {
    if (!session.worktreePath) {
      return session;
    }

    // Claude sessions pin their native session id at launch. Never overwrite a
    // pinned id with a newest-mtime guess (which could bind a sibling session
    // sharing the worktree). Legacy claude sessions with no pinned id and all
    // other agents keep the mtime discovery path below.
    if (session.agent === "claude" && session.agentSessionId) {
      return session;
    }

    const codexSessionRootDir =
      session.agent === "codex"
        ? join(
            codexHookHomePath(join(this.config.dataDir, "session-tools", session.id)),
            "sessions",
          )
        : undefined;
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    const sessionAgentConfig = this.sessionAgentConfig(session);
    while (Date.now() <= deadline) {
      const agentSessionId = await findAgentSessionId(session.agent, session.worktreePath, {
        ...(codexSessionRootDir ? { codexSessionRootDir } : {}),
        ...(sessionAgentConfig.planOptions?.cursorConfigDir
          ? { cursorConfigDir: sessionAgentConfig.planOptions.cursorConfigDir }
          : {}),
      });
      if (agentSessionId) {
        if (agentSessionId === session.agentSessionId) {
          return session;
        }
        this.logEvent("session.agent_session_id.discovered", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `Discovered native agent session id for ${session.id}`,
          details: {
            agent: session.agent,
            previousAgentSessionId: session.agentSessionId ?? null,
            agentSessionId,
          },
        });
        return {
          ...session,
          agentSessionId,
        };
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }

    return session;
  }

  private async ensureSessionReadyForSend(session: SessionRecord): Promise<SessionRecord> {
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    let processAlive = false;
    if (runtimeAlive) {
      processAlive = await isProcessRunningInTmux(
        session.tmuxSession,
        sessionProcessMatchers(session),
      );
      if (processAlive) {
        return this.captureAgentSessionId(session, 0);
      }
    }

    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    this.logEvent("session.recover.check", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Checking whether ${session.id} needs recovery`,
      details: {
        agent: session.agent,
        status: session.status,
        runtimeAlive,
        processAlive,
        workspaceExists: workspacePresent,
        agentSessionId: session.agentSessionId ?? null,
      },
    });

    if (session.status === "killed") {
      throw new Error(`Session ${session.id} was killed and cannot be recovered`);
    }
    if (session.status === "completed") {
      throw new Error(`Session ${session.id} was completed and cannot be recovered`);
    }
    if (!session.worktreePath || !workspacePresent) {
      // Shepherd's workspace is a plain directory (worktree: false), never a
      // git worktree Spur removes on its own — see shouldRemoveWorktreeOnTerminal.
      // If an operator (or a wiped host) deletes it out from under a stopped
      // session, re-materialize the same empty dir spawnShepherd creates on
      // first spawn rather than leaving shepherd permanently unrecoverable.
      if (session.project !== SHEPHERD_PROJECT_ID) {
        throw new Error(
          `Session ${session.id} cannot be recovered because its workspace is missing`,
        );
      }
      ensureShepherdWorkspace(this.config.dataDir);
    }

    const project = this.getProject(session.project);
    // Same restore-warmup protection as restore() above: relaunchSessionInPlace
    // starts the MCP sidecar before this session's status is guaranteed
    // running|spawning on disk, and the reaper's default filter would not
    // otherwise protect that window. Cleared immediately after (not left for
    // the usual RESTORE_WARMUP_MS) — callers of ensureSessionReadyForSend
    // (send, tryDeliverQueuedMessage, switchAuth) classify the session's real
    // state right after this returns and must not have that forced to
    // "working" the way a genuine post-restore warmup intentionally does.
    this.restoreWarmupUntil.set(session.id, Date.now() + RESTORE_WARMUP_MS);
    let recovered: SessionRecord;
    try {
      recovered = await this.relaunchSessionInPlace(session, project);
    } finally {
      this.restoreWarmupUntil.delete(session.id);
    }
    writeSession(this.config.dataDir, recovered);
    await this.refreshDashboardCacheEntry(recovered);
    this.logEvent("session.recover.completed", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Recovered ${session.id}`,
      details: {
        agent: session.agent,
        agentSessionId: recovered.agentSessionId ?? null,
        tmuxSession: session.tmuxSession,
      },
    });
    return recovered;
  }

  // Kills the live tmux pane and relaunches the agent in place, preserving its
  // native transcript id (claude --session-id pin / codex rollout resume).
  // Used by the recover path above (dead process, live session) — the recover
  // guard there will not touch an already-healthy session.
  private async relaunchSessionInPlace(
    session: SessionRecord,
    project: ProjectConfig,
  ): Promise<SessionRecord> {
    await killTmuxSession(session.tmuxSession);
    const sessionWithAgentId = await this.captureAgentSessionId(session, 0);
    let recoveredAgentSessionId = sessionWithAgentId.agentSessionId;
    const sessionToolDir = this.prepareSessionTools(session.id, session.agent, session.project);
    const { session: mcpSidecarUpdate, mcpBindings } = await this.startMcpSidecars(
      session,
      project,
    );
    const hookSetup = await setupSessionAgentHooks({
      agent: session.agent,
      dataDir: this.config.dataDir,
      sessionId: session.id,
      worktreePath: session.worktreePath,
      sessionToolDir,
      restrictWrites: resolveRestrictWrites(session),
      modelsCacheHome: this.config.models.codexHome,
      ...(mcpBindings.length > 0 ? { mcpBindings } : {}),
    });
    const sessionAgentConfig = this.sessionAgentConfig(session);
    const planMode = resolvePlanMode(session);
    const restrictWrites = resolveRestrictWrites(session);
    const resolvedModel = await resolveAgentLaunchModel(session.agent, session.model);
    const planOptions = {
      ...withAgentModeOptions(
        withProjectAgentOptions(session.agent, project, {
          ...hookSetup,
          ...(sessionAgentConfig.planOptions ?? {}),
        }),
        { planMode, restrictWrites },
      ),
      ...this.resolveClaudeAuthPlanOptions(session),
    };
    const baseLaunchPlan = buildAgentLaunchPlan(session.agent, session.prompt, {
      ...planOptions,
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    });
    const baseLaunchCommand = baseLaunchPlan.launchCommand;
    // A pinned claude keeps its native id on a fresh relaunch via --session-id so
    // later state reads stay bound to the same transcript instead of a new one.
    const pinnedClaudeId =
      session.agent === "claude" && sessionWithAgentId.agentSessionId
        ? sessionWithAgentId.agentSessionId
        : undefined;
    let persistedLaunchCommand = baseLaunchCommand;
    const recoveryPlan = sessionWithAgentId.agentSessionId
      ? buildAgentResumePlan(
          sessionWithAgentId.agent,
          sessionWithAgentId.agentSessionId,
          baseLaunchCommand,
          planOptions,
        )
      : null;
    this.logEvent("session.recover.started", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Relaunching ${session.id}`,
      details: {
        agent: session.agent,
        recoveryMode: recoveryPlan ? "native_resume" : "fresh_launch",
        agentSessionId: sessionWithAgentId.agentSessionId ?? null,
      },
    });
    const env = buildSessionEnv({
      agent: session.agent,
      projectId: session.project,
      sessionId: session.id,
      artifactsSessionId: workspaceIdOf(session),
      sessionToolDir,
      dataDir: this.config.dataDir,
      repoPath: this.getProject(session.project).path,
      symlinks: this.getProject(session.project).symlinks,
      ...(sessionAgentConfig.env ? { extraEnv: sessionAgentConfig.env } : {}),
    });

    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: recoveryPlan?.launchCommand ?? baseLaunchCommand,
        agent: session.agent,
        env,
      });
      await waitForTmuxReady(
        session.tmuxSession,
        recoveryPlan?.readyMarkers ?? baseLaunchPlan.readyMarkers,
        undefined,
        { agent: session.agent },
      );
      // fresh:true: this session's tmux pane was just created by
      // createTmuxSession above and may postdate the last fleet-pane
      // snapshot, which would otherwise wrongly see it as absent and abort a
      // genuinely successful recovery.
      if (
        !(await isProcessRunningInTmux(
          session.tmuxSession,
          agentProcessMatchers(session.agent, recoveryPlan?.launchCommand ?? baseLaunchCommand),
          { fresh: true },
        ))
      ) {
        throw new Error(`Agent ${session.agent} exited before recovery became ready`);
      }
    } catch (error) {
      if (!recoveryPlan) {
        throw error;
      }

      const failure = error instanceof Error ? error.message : String(error);
      this.logEvent("session.recover.resume_failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Native resume failed for ${session.id}; falling back to a fresh launch`,
        details: {
          agent: session.agent,
          agentSessionId: sessionWithAgentId.agentSessionId ?? null,
          launchCommand: recoveryPlan.launchCommand,
          failure,
        },
      });
      await killTmuxSession(session.tmuxSession);
      // Reuse the pinned claude id on the fresh relaunch so the session stays
      // bound to its native id; legacy (unpinned) sessions relaunch without one.
      const freshPlan = pinnedClaudeId
        ? buildAgentLaunchPlan(session.agent, session.prompt, {
            ...planOptions,
            ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            agentSessionId: pinnedClaudeId,
          })
        : baseLaunchPlan;
      const freshLaunchCommand = freshPlan.launchCommand;
      recoveredAgentSessionId = pinnedClaudeId;
      persistedLaunchCommand = freshLaunchCommand;
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: freshLaunchCommand,
        agent: session.agent,
        env,
      });
      await waitForTmuxReady(session.tmuxSession, freshPlan.readyMarkers, undefined, {
        agent: session.agent,
      });
      // fresh:true — same rationale as the resume-plan check above: this
      // pane was just (re)created and may postdate the last fleet snapshot.
      if (
        !(await isProcessRunningInTmux(
          session.tmuxSession,
          agentProcessMatchers(session.agent, freshLaunchCommand),
          { fresh: true },
        ))
      ) {
        throw new Error(`Agent ${session.agent} exited before recovery became ready`, {
          cause: error,
        });
      }
    }

    this.stateCache.delete(session.id);
    const { error: _ignoredError, ...recoveredBase } = sessionWithAgentId;
    return this.applyReservedSidecars(
      {
        ...recoveredBase,
        planMode,
        restrictWrites,
        ...(recoveredAgentSessionId ? { agentSessionId: recoveredAgentSessionId } : {}),
        launchCommand: persistedLaunchCommand,
        status: "running",
        updatedAt: nowIso(),
      },
      mcpSidecarUpdate,
    );
  }

  async restore(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // Same shepherd-only re-materialization as ensureSessionReadyForSend: this
    // path reads the session directly rather than through that method, so
    // isRestorableSession's workspaceExists (computed by enrich() below) would
    // otherwise see a wiped shepherd workspace as unrestorable. Gated on
    // !isTerminalSessionStatus (not isRestorableStatus, which excludes
    // "errored") so an errored shepherd still heals here, matching
    // isRestorableSession's own errored+state==="error" branch and the
    // send-path sibling above. A killed/completed shepherd is still rejected
    // below rather than having its workspace re-created as a side effect
    // first.
    if (
      !isTerminalSessionStatus(session.status) &&
      session.project === SHEPHERD_PROJECT_ID &&
      !workspaceExists(session.worktreePath)
    ) {
      ensureShepherdWorkspace(this.config.dataDir);
    }

    const current = await this.enrich(session);
    if (!isRestorableSession(current)) {
      this.logEvent("session.restore.unrestorable", {
        level: "warn",
        sessionId,
        projectId: current.project,
        message: `Session ${sessionId} is not restorable`,
        details: {
          status: current.status,
          state: current.state,
          workspaceExists: current.workspaceExists,
        },
      });
      const availableActions: SessionNotRestorablePayload["availableActions"] = ["force_kill"];
      if (!isTerminalSessionStatus(current.status)) {
        availableActions.push("respawn");
      }
      throw new SessionNotRestorableError(
        sessionId,
        `Session ${sessionId} is not restorable`,
        availableActions,
      );
    }

    this.assertAdmissible(current.project, "restore");

    this.logEvent("session.restore.started", {
      level: "info",
      sessionId,
      projectId: current.project,
      message: `Restoring ${sessionId}`,
      details: {
        agent: current.agent,
        worktreePath: current.worktreePath,
      },
    });
    // Set before startMcpSidecars below: the on-disk status stays
    // stopped/errored until the restore completes (~50 lines down), so the
    // sidecar reaper's normal running|spawning filter would not protect the
    // MCP sidecar tmux pane this starts. The reaper additionally checks this
    // warmup window (see reapDeadSessionSidecars) for exactly this gap.
    this.restoreWarmupUntil.set(sessionId, Date.now() + RESTORE_WARMUP_MS);
    let restoredLaunchCommand = current.launchCommand;
    let mcpSidecarUpdate: SessionRecord = current;

    try {
      const sessionToolDir = this.prepareSessionTools(current.id, current.agent, current.project);
      const restoreProjectConfig = this.getProject(current.project);
      const mcpStart = await this.startMcpSidecars(current, restoreProjectConfig);
      mcpSidecarUpdate = mcpStart.session;
      const mcpBindings = mcpStart.mcpBindings;
      const hookSetup = await setupSessionAgentHooks({
        agent: current.agent,
        dataDir: this.config.dataDir,
        sessionId: current.id,
        worktreePath: current.worktreePath,
        sessionToolDir,
        restrictWrites: resolveRestrictWrites(current),
        modelsCacheHome: this.config.models.codexHome,
        ...(mcpBindings.length > 0 ? { mcpBindings } : {}),
      });
      const sessionAgentConfig = this.sessionAgentConfig(current);
      const planMode = resolvePlanMode(current);
      const restrictWrites = resolveRestrictWrites(current);
      const shouldSendRestoreMessage =
        current.status !== "paused" && current.stopReason !== "manual_pause";
      const restorePrompt = shouldSendRestoreMessage
        ? buildRestorePrompt(current.prompt, planMode, restrictWrites)
        : "";
      const planOptions = {
        ...withAgentModeOptions(
          withProjectAgentOptions(current.agent, restoreProjectConfig, {
            ...hookSetup,
            ...(sessionAgentConfig.planOptions ?? {}),
          }),
          { planMode, restrictWrites },
        ),
        ...this.resolveClaudeAuthPlanOptions(current),
      };
      const resolvedModel = await resolveAgentLaunchModel(current.agent, current.model);
      const launchPlanOptions = {
        ...planOptions,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        // Restore a pinned claude session by resuming its own transcript id;
        // if that transcript is gone the restore plan is null and the fresh
        // launch below reuses the same id via --session-id.
        ...(current.agent === "claude" && current.agentSessionId
          ? { agentSessionId: current.agentSessionId }
          : {}),
      };
      const launchPlan = await waitForRestorePlan(
        current.agent,
        current.worktreePath,
        restorePrompt,
        launchPlanOptions,
      );
      const effectivePlan =
        launchPlan ?? buildAgentLaunchPlan(current.agent, restorePrompt, launchPlanOptions);
      await killTmuxSession(current.tmuxSession);
      let restoreLaunchCommand = effectivePlan.launchCommand;
      let restoreReadyMarkers = effectivePlan.readyMarkers;
      const pinnedClaudeId =
        current.agent === "claude" && current.agentSessionId ? current.agentSessionId : undefined;
      let restoredAgentSessionId =
        current.agent === "cursor" ? current.agentSessionId : pinnedClaudeId;
      if (launchPlan && !pinnedClaudeId) {
        const codexSessionRootDir =
          current.agent === "codex"
            ? join(
                codexHookHomePath(join(this.config.dataDir, "session-tools", current.id)),
                "sessions",
              )
            : undefined;
        const discoveredAgentSessionId = await findAgentSessionId(
          current.agent,
          current.worktreePath,
          {
            ...(codexSessionRootDir ? { codexSessionRootDir } : {}),
            ...(sessionAgentConfig.planOptions?.cursorConfigDir
              ? { cursorConfigDir: sessionAgentConfig.planOptions.cursorConfigDir }
              : {}),
          },
        );
        if (discoveredAgentSessionId) {
          restoredAgentSessionId = discoveredAgentSessionId;
        }
      }
      // Fresh-launch fallback fires when the transcript is gone: either no resume
      // id was discovered, or a pinned claude keeps its `--session-id` launch
      // because its transcript is missing (both skip the resume plan below).
      if (!launchPlan && (!restoredAgentSessionId || pinnedClaudeId)) {
        this.logEvent("session.restore.started", {
          level: "info",
          sessionId,
          projectId: current.project,
          message: `No native resume state for ${sessionId}, falling back to fresh launch`,
          details: { agent: current.agent, worktreePath: current.worktreePath },
        });
      }
      if (restoredAgentSessionId && !(pinnedClaudeId && !launchPlan)) {
        const resumePlan = buildAgentResumePlan(
          current.agent,
          restoredAgentSessionId,
          launchPlan?.launchCommand ?? current.launchCommand,
          planOptions,
        );
        restoreLaunchCommand = resumePlan.launchCommand;
        restoreReadyMarkers = resumePlan.readyMarkers;
      }
      restoredLaunchCommand = restoreLaunchCommand;
      const restoreProject = this.config.projects[current.project];
      const restoreSidecarNames = manualSidecarNames(
        resolveSessionSidecars(current, restoreProject),
      );
      const env = buildSessionEnv({
        agent: current.agent,
        projectId: current.project,
        sessionId: current.id,
        artifactsSessionId: workspaceIdOf(current),
        sessionToolDir,
        dataDir: this.config.dataDir,
        repoPath: this.getProject(current.project).path,
        symlinks: this.getProject(current.project).symlinks,
        ...(sessionAgentConfig.env ? { extraEnv: sessionAgentConfig.env } : {}),
      });

      await createTmuxSession({
        sessionName: current.tmuxSession,
        cwd: current.worktreePath,
        launchCommand: restoreLaunchCommand,
        agent: current.agent,
        env,
      });
      await waitForTmuxReady(current.tmuxSession, restoreReadyMarkers, undefined, {
        agent: current.agent,
      });
      // fresh:true — this pane was just created by createTmuxSession above
      // and may postdate the last fleet-pane snapshot.
      if (
        !(await isProcessRunningInTmux(
          current.tmuxSession,
          agentProcessMatchers(current.agent, restoreLaunchCommand),
          { fresh: true },
        ))
      ) {
        throw new Error(`Agent ${current.agent} exited before restore became ready`);
      }
      if (shouldSendRestoreMessage && effectivePlan.initialMessage.trim()) {
        const restoreInitialMessage = buildInitialMessage(
          effectivePlan.initialMessage,
          restoreSidecarNames,
          this.config.tags,
          restoreProject?.branchNaming?.regex,
          current.selfDestruct,
        );
        if (current.agent === "codex") {
          await sendMessageToTmux(current.tmuxSession, restoreInitialMessage, {
            agent: current.agent,
          });
        } else {
          await this.sendAgentMessage(current, restoreInitialMessage);
        }
      }
    } catch (error) {
      // Drop the warmup set before startMcpSidecars: every exit from here
      // either killed the pane below or returns an already-live session, so
      // leaving it would make classifySessionRecord report "working" with
      // fabricated liveness for the rest of RESTORE_WARMUP_MS. The success
      // path after this block intentionally keeps its own warmup.
      this.restoreWarmupUntil.delete(sessionId);
      if (error instanceof SubmitAckTimeoutError && error.processAlive) {
        const { error: _ignoredError, ...recoveredBase } = current;
        const recovered: SessionRecord = this.applyReservedSidecars(
          {
            ...recoveredBase,
            planMode: resolvePlanMode(current),
            restrictWrites: resolveRestrictWrites(current),
            launchCommand: restoredLaunchCommand,
            status: "running",
            updatedAt: nowIso(),
          },
          mcpSidecarUpdate,
        );
        delete recovered.stopReason;
        const persistedRecovered = await this.captureAgentSessionId(
          recovered,
          AGENT_SESSION_ID_REFRESH_WAIT_MS,
        );
        writeSession(this.config.dataDir, persistedRecovered);
        await this.refreshDashboardCacheEntry(persistedRecovered);
        requestGitHubMergeConflictRestoreReplays(
          this.config,
          persistedRecovered.project,
          persistedRecovered.id,
        );
        this.logEvent("session.restore.recovered", {
          level: "warn",
          sessionId,
          projectId: current.project,
          message: `Recovered ${sessionId} after submit ack timeout with live agent process`,
          details: {
            agent: error.agent,
            lastScannedFile: error.lastScannedFile,
            elapsedMs: error.elapsedMs,
            processAlive: error.processAlive,
          },
        });
        this.stateCache.delete(sessionId);
        if (this.shouldRunDelivery(persistedRecovered)) {
          this.scheduleDeliveryRunner(persistedRecovered.id);
        }
        return this.enrich(persistedRecovered);
      }
      await killTmuxSession(current.tmuxSession);
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.restore.failed", {
        level: "error",
        sessionId,
        projectId: current.project,
        message: `Failed to restore ${sessionId}: ${message}`,
      });
      throw new Error(`Failed to restore ${sessionId}: ${message}`, { cause: error });
    }

    const { error: _ignoredError, ...restoredBase } = current;
    const restored: SessionRecord = this.applyReservedSidecars(
      {
        ...restoredBase,
        planMode: resolvePlanMode(current),
        restrictWrites: resolveRestrictWrites(current),
        launchCommand: restoredLaunchCommand,
        status: "running",
        updatedAt: nowIso(),
      },
      mcpSidecarUpdate,
    );
    delete restored.stopReason;
    const persistedRestored = await this.captureAgentSessionId(
      restored,
      AGENT_SESSION_ID_REFRESH_WAIT_MS,
    );
    writeSession(this.config.dataDir, persistedRestored);
    await this.refreshDashboardCacheEntry(persistedRestored);
    requestGitHubMergeConflictRestoreReplays(
      this.config,
      persistedRestored.project,
      persistedRestored.id,
    );
    this.logEvent("session.restore.completed", {
      level: "info",
      sessionId,
      projectId: current.project,
      message: `Restored ${sessionId}`,
      details: {
        agent: current.agent,
        agentSessionId: persistedRestored.agentSessionId ?? null,
      },
    });
    this.stateCache.delete(sessionId);
    this.restoreWarmupUntil.set(sessionId, Date.now() + RESTORE_WARMUP_MS);
    if (this.shouldRunDelivery(persistedRestored)) {
      this.scheduleDeliveryRunner(persistedRestored.id);
    }
    return this.enrich(persistedRestored);
  }

  // Brings a `completed` session back to life on the same id: rebuild the
  // worktree if it was reclaimed, flip the record to a restorable
  // stopped/manual_pause state (so restore() below resumes the agent's own
  // conversation without resending the original prompt), then delegate the
  // whole launch transaction to restore(). Nothing completion destroyed
  // (Telegram binding, sidecarPorts, artifacts, work item) is recreated.
  async reopen(sessionId: string): Promise<SessionView> {
    // Refuse a second concurrent reopen outright instead of narrowing the
    // read-check-then-write window: two overlapping calls that both pass the
    // `status !== "completed"` guard would otherwise race into restore() for
    // the same tmux session and worktree.
    if (this.reopensInFlight.has(sessionId)) {
      throw new SessionNotReopenableError(`Session ${sessionId} is already being reopened`);
    }
    this.reopensInFlight.add(sessionId);
    try {
      return await this.reopenLocked(sessionId);
    } finally {
      this.reopensInFlight.delete(sessionId);
    }
  }

  private async reopenLocked(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }
    if (session.status !== "completed") {
      throw new SessionNotReopenableError(
        `Session ${sessionId} is ${session.status}, not completed — use restore or respawn`,
      );
    }

    const needsWorktree = session.worktree && !workspaceExists(session.worktreePath);
    if (needsWorktree) {
      const project = this.getProject(session.project);
      // createWorktree always rebuilds at
      // worktreePathFor(worktreeDir, projectId, sessionId). A desk member's
      // record can carry the anchor's worktreePath instead (deskId set), so
      // check the two paths BEFORE touching git — otherwise a mismatch would
      // leave a stray worktree registered in git that blocks every later
      // reopen/respawn on the branch.
      const expectedWorktreePath = worktreePathFor(
        this.config.worktreeDir,
        session.project,
        session.id,
      );
      if (expectedWorktreePath !== session.worktreePath) {
        const deskNote =
          workspaceIdOf(session) !== session.id ? " it belonged to a shared workspace;" : "";
        throw new SessionNotReopenableError(
          `Session ${sessionId} cannot be reopened: its worktree at ${session.worktreePath} is gone and cannot be rebuilt at that path;${deskNote} use respawn`,
        );
      }
      const refs = await branchRefsExist(project.path, session.branch);
      if (!refs.exists && !refs.remote) {
        throw new SessionNotReopenableError(
          `Session ${sessionId} cannot be reopened: branch ${session.branch} no longer exists locally or on origin — use respawn`,
        );
      }
      let created: string;
      try {
        created = await createWorktree({
          repoPath: project.path,
          worktreeBaseDir: this.config.worktreeDir,
          projectId: session.project,
          sessionId: session.id,
          defaultBranch: project.defaultBranch,
          branch: session.branch,
          symlinks: project.symlinks,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SessionNotReopenableError(
          `Session ${sessionId} cannot be reopened: failed to rebuild its worktree (${message}) — use respawn`,
        );
      }
      this.logEvent("session.reopen.worktree_rebuilt", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Rebuilt worktree for ${sessionId}`,
        details: {
          worktreePath: created,
          branch: session.branch,
          localRef: refs.exists,
          remoteRef: refs.remote,
        },
      });
    }

    const record: SessionRecord = {
      ...this.sessionWithReleasedSidecarPorts(session),
      status: "stopped",
      stopReason: "manual_pause",
      updatedAt: nowIso(),
    };
    delete record.error;
    // A completed record can still carry a queued message or a running
    // pipeline step from before completion (applyManualStatus's completed
    // branch does not clear either). Once restore() below flips status to
    // "running", shouldRunDelivery would otherwise replay them — resending
    // exactly the text this feature promises not to resend. The pipeline's
    // `steps` still feed a later "Edit & Respawn" (resolveRespawnRequest),
    // so stop the replay by flipping its status instead of deleting it.
    delete record.queuedMessages;
    if (record.pipeline) {
      record.pipeline = { ...record.pipeline, status: "completed" };
    }
    writeSession(this.config.dataDir, record);
    this.stateCache.delete(sessionId);
    await this.refreshDashboardCacheEntry(record);

    try {
      return await this.restore(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The completed record's Telegram binding, artifacts, and work-item
      // completion are already destroyed, so leaving the flipped
      // stopped/manual_pause record in place would make send/kill/sidecars
      // legal on a gutted session. Roll back to completed instead — but
      // read fresh, not from the pre-flip `session` snapshot: the record on
      // disk is restorable (status stopped/manual_pause) the moment we wrote
      // it above, so a concurrent send()/deliver() can legally queue a
      // message, or restore() itself can persist status:"running" and then
      // still throw from its own uncaught tail (most likely
      // `await this.enrich(persistedRestored)`, its very last statement, but
      // also captureAgentSessionId/writeSession/refreshDashboardCacheEntry
      // just before it). Rolling back from the stale snapshot would discard
      // whatever happened in that window instead of what's actually on disk.
      const latest = readSession(this.config.dataDir, sessionId) ?? session;
      if (latest.status === "running") {
        // restore() got far enough to persist a genuinely live, running
        // agent (writeSession succeeded) before failing afterward. That
        // agent is real and working — killing its pane and stamping
        // "completed" here would destroy a session that isn't actually
        // broken just because the reopen call that revived it failed a step
        // after the revival already landed. Leave it running.
        this.logEvent("session.reopen.failed", {
          level: "error",
          sessionId,
          projectId: session.project,
          message: `Reopen of ${sessionId} errored after restore already brought it back to running: ${message}`,
        });
        throw error;
      }
      // restore() itself kills the tmux pane it created before rethrowing
      // for every failure inside its own try/catch (including the fresh
      // pane created by createTmuxSession). Tear down defensively here too —
      // killTmuxSession/cleanupSessionServices are best-effort and safe to
      // call on an already-dead pane — to cover a pane restore() created but
      // didn't get to kill before this catch ran.
      await killTmuxSession(latest.tmuxSession);
      await this.cleanupSessionServices(latest);
      const rolledBack: SessionRecord = {
        ...this.sessionWithReleasedSidecarPorts(latest),
        status: "completed",
        updatedAt: nowIso(),
      };
      delete rolledBack.stopReason; // latest may still carry manual_pause
      writeSession(this.config.dataDir, rolledBack);
      this.stateCache.delete(sessionId);
      await this.refreshDashboardCacheEntry(rolledBack);
      this.logEvent("session.reopen.failed", {
        level: "error",
        sessionId,
        projectId: session.project,
        message: `Failed to reopen ${sessionId}: ${message}`,
      });
      throw error;
    }
  }

  async switchAuth(
    sessionId: string,
    accountId: string,
    opts: { reason: "manual" | "auto_rate_limit"; force?: boolean },
  ): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.agent !== "claude") {
      throw new Error(
        `switch-auth is only supported for claude sessions (session ${sessionId} runs ${session.agent})`,
      );
    }
    const account = findAccount(this.config.dataDir, accountId);
    if (!account) {
      throw new Error(`Unknown claude account: ${accountId}`);
    }
    if (!isAccountReady(account)) {
      throw new Error(
        `Claude account ${accountId} is not ready (credentials or onboarding incomplete)`,
      );
    }

    const force = opts.force === true;
    if (!force) {
      const state = await this.classifySessionState(session);
      if (state === "working") {
        throw new Error(
          `Session ${sessionId} is working; retry when idle or pass force to switch auth`,
        );
      }
    }
    const sessionToolDir = join(this.config.dataDir, "session-tools", sessionId);
    const sessionHome = sessionClaudeHome(sessionToolDir);
    const usesSessionHome = session.launchCommand.startsWith(
      `CLAUDE_CONFIG_DIR=${shellEscape(sessionHome)} `,
    );

    const updated: SessionRecord = {
      ...session,
      claudeAccountId: accountId,
      updatedAt: nowIso(),
    };

    if (usesSessionHome) {
      // Session launched against its session home: atomically swap credentials in place.
      // The live Claude process rereads credentials on its next request,
      // so no kill/relaunch is needed.
      swapSessionCredentials(sessionHome, account);
      writeSession(this.config.dataDir, updated);
      touchAccountUsed(this.config.dataDir, accountId);
      this.logEvent("session.auth.switched", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Switched claude account for ${sessionId} to ${accountId}`,
        details: { accountId, reason: opts.reason, forced: force, method: "in_place" },
      });
      return this.enrich(updated);
    }

    await this.ensureKillDirtyWorktreeAllowed(session, force);
    // Install target credentials before persisting the record or killing the pane.
    // If the swap throws, the persisted account and running pane remain old.
    mkdirSync(sessionHome, { recursive: true });
    swapSessionCredentials(sessionHome, account);
    writeSession(this.config.dataDir, updated);
    touchAccountUsed(this.config.dataDir, accountId);
    // Session was launched against an account dir directly.
    // Relaunch once to migrate onto the new account's session home.
    await killTmuxSession(updated.tmuxSession);
    const relaunched = await this.ensureSessionReadyForSend(updated);
    this.logEvent("session.auth.switched", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Switched claude account for ${sessionId} to ${accountId}`,
      details: { accountId, reason: opts.reason, forced: force, method: "relaunch" },
    });
    return this.enrich(relaunched);
  }

  // Rotate a rate-limited claude session onto the next ready account.
  // Returns true when a rotation happened; false when disabled, capped, or no
  // fresh candidate exists (caller then falls through to the reactivation nudge).
  private async tryAutoRotateClaudeAccount(session: SessionRecord): Promise<boolean> {
    if (!this.config.authRotation.autoRotateOnRateLimit || session.agent !== "claude") {
      return false;
    }
    const now = Date.now();
    const cooldownMs = this.config.authRotation.cooldownMinutes * 60_000;
    // Mark the current account rate-limited so later rotations skip it until it
    // is likely reset. The usage-limit menu does not expose a reset time, so use
    // the configured cooldown.
    if (session.claudeAccountId) {
      this.claudeAccountRateLimit.set(session.claudeAccountId, now + cooldownMs);
    }
    const episode = String(session.rateLimitedAt);
    const tracker = this.claudeRotationEpisode.get(session.id);
    const count = tracker?.episode === episode ? tracker.count : 0;
    if (count >= this.config.authRotation.maxRotationsPerEpisode) {
      return false;
    }
    const next = listAccounts(this.config.dataDir).find((account) => {
      if (account.id === session.claudeAccountId) return false;
      if (!isAccountReady(account)) return false;
      const limitedUntil = this.claudeAccountRateLimit.get(account.id);
      return limitedUntil === undefined || limitedUntil <= now;
    });
    if (!next) {
      return false;
    }
    await this.switchAuth(session.id, next.id, { reason: "auto_rate_limit" });
    this.claudeRotationEpisode.set(session.id, { episode, count: count + 1 });
    this.logEvent("session.auth.auto_rotated", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Auto-rotated ${session.id} to claude account ${next.id} after rate limit`,
      details: {
        ...(session.claudeAccountId ? { fromAccountId: session.claudeAccountId } : {}),
        toAccountId: next.id,
        episode,
      },
    });
    return true;
  }

  listClaudeAccounts(): {
    id: string;
    label?: string;
    authenticated: boolean;
    lastUsedAt?: string;
  }[] {
    ensureDefaultAccount(this.config.dataDir);
    return listAccounts(this.config.dataDir).map((account) => ({
      id: account.id,
      ...(account.label ? { label: account.label } : {}),
      authenticated: isAccountAuthenticated(account),
      ...(account.lastUsedAt ? { lastUsedAt: account.lastUsedAt } : {}),
    }));
  }

  addClaudeAccount(opts: { label?: string }): ClaudeAccount {
    return addAccount(this.config.dataDir, opts);
  }

  removeClaudeAccount(accountId: string): void {
    // removeAccount rmSync's the account's CLAUDE_CONFIG_DIR. Guard against
    // deleting creds out from under a live claude process bound to it: a
    // non-terminal session still has its claude process alive in tmux.
    const bound = listSessions(this.config.dataDir).filter(
      (session) => session.claudeAccountId === accountId,
    );
    const live = bound.filter((session) => !isTerminalSessionStatus(session.status));
    if (live.length > 0) {
      throw new Error(
        `Cannot remove account ${accountId}: in use by ${live.length} running session(s)`,
      );
    }
    // Terminal sessions keep no live process, but leaving the ref dangling would
    // point at a deleted account; clear it before removing the store entry.
    for (const session of bound) {
      const { claudeAccountId: _claudeAccountId, ...base } = session;
      writeSession(this.config.dataDir, { ...base, updatedAt: nowIso() });
    }
    removeAccount(this.config.dataDir, accountId);
  }

  // Host an interactive OAuth login pane for an account in an isolated
  // CLAUDE_CONFIG_DIR. The UI attaches to the returned tmux session and the
  // operator completes the browser sign-in there; finishAccountLogin tears it
  // down once .credentials.json lands.
  async startAccountLogin(accountId: string): Promise<{ loginTmuxSession: string }> {
    const account = findAccount(this.config.dataDir, accountId);
    if (!account) {
      throw new Error(`Unknown claude account: ${accountId}`);
    }
    const loginTmuxSession = `claude-login-${accountId}`;
    await killTmuxSession(loginTmuxSession);
    await createTmuxCommandSession({
      sessionName: loginTmuxSession,
      cwd: userInfo().homedir,
      launchCommand: claudeCommand(),
      env: { CLAUDE_CONFIG_DIR: account.configDir },
    });
    return { loginTmuxSession };
  }

  async finishAccountLogin(accountId: string): Promise<{ authenticated: boolean }> {
    const account = findAccount(this.config.dataDir, accountId);
    if (!account) {
      throw new Error(`Unknown claude account: ${accountId}`);
    }
    const authenticated = isAccountAuthenticated(account);
    await killTmuxSession(`claude-login-${accountId}`);
    return { authenticated };
  }

  async getAccountLoginStatus(
    accountId: string,
  ): Promise<{ authenticated: boolean; loginActive: boolean }> {
    const account = findAccount(this.config.dataDir, accountId);
    if (!account) {
      throw new Error(`Unknown claude account: ${accountId}`);
    }
    const loginActive = await tmuxSessionExists(`claude-login-${accountId}`);
    return { authenticated: isAccountAuthenticated(account), loginActive };
  }

  async respawn(sessionId: string, request: RespawnSessionRequest = {}): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (
      session.status !== "completed" &&
      session.status !== "killed" &&
      session.status !== "errored"
    ) {
      throw new Error(
        `Session ${sessionId} is not in a terminal state (status: ${session.status})`,
      );
    }

    const forceKillSource = request.forceKillSource === true;
    if (session.status !== "completed") {
      await this.ensureKillDirtyWorktreeAllowed(session, forceKillSource);
    }

    this.logEvent("session.respawn.started", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Respawning ${sessionId}`,
      details: { agent: session.agent },
    });
    const requestedStartupAttachmentIds =
      request.startupAttachmentIds ?? session.startupAttachmentIds ?? [];
    const allowedStartupIds = new Set(session.startupAttachmentIds ?? []);
    for (const attachmentId of requestedStartupAttachmentIds) {
      if (!allowedStartupIds.has(attachmentId)) {
        throw new Error(`Unknown startup attachment id: ${attachmentId}`);
      }
    }
    const clonedAttachments = this.cloneStartupAttachments(
      workspaceIdOf(session),
      requestedStartupAttachmentIds,
    );
    const mergedAttachments = [...clonedAttachments, ...(request.attachments ?? [])];
    const bootstrap = this.isUnconfiguredProjectId(session.project);
    // Unlike handoff, respawn needs no replacingSessionId exclusion: the
    // status guard above requires completed/killed/errored, none of which
    // countLiveSessions treats as live, and the kill() below (source cleanup
    // for a status other than "completed") only runs after this spawn
    // already succeeded — so admission never counts the source twice.
    const spawned = await this.spawn(
      resolveRespawnRequest(session, {
        ...(bootstrap ? { bootstrap: true } : {}),
        ...(!bootstrap && request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
        ...(request.agent ? { agent: parseAgentName(request.agent) } : {}),
        ...(request.model !== undefined ? { model: request.model } : {}),
      }),
      request.prompt !== undefined ? { promptKind: "respawn_override_prompt" } : undefined,
    );
    if (session.status !== "completed") {
      await this.kill(session.id, { force: forceKillSource, prAction: "leave_open" });
    }
    return spawned;
  }

  async handoff(sessionId: string, request: HandoffSessionRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (
      session.status !== "running" &&
      session.status !== "spawning" &&
      session.status !== "paused" &&
      session.status !== "stopped"
    ) {
      throw new Error(
        `Session ${sessionId} is not eligible for handoff (status: ${session.status})`,
      );
    }
    if (!session.worktreePath.trim() || !workspaceExists(session.worktreePath)) {
      throw new Error(`Session ${sessionId} has no reusable workspace for handoff`);
    }
    // Gate before any teardown below. The source session is still on-disk as
    // running/spawning here, so a denial leaves it fully untouched — no kill,
    // no status flip. The successor replaces the source rather than adding to
    // the fleet, so exclude it from the live count: a handoff at exactly the
    // cap is net-neutral (stop one, start one) and must be allowed.
    const admissionReservation = this.reserveAdmission(session.project, "spawn", {
      replacingSessionId: session.id,
    });

    try {
      const agent = parseAgentName(request.agent);
      const notes = request.notes?.trim();
      const originalTask = extractBareUserTask(session.originalTaskPrompt ?? session.prompt);
      const clonedAttachments = this.cloneStartupAttachments(
        workspaceIdOf(session),
        session.startupAttachmentIds ?? [],
      );
      const handoffScreenshot = await buildHandoffScreenshotAttachment(session.tmuxSession);
      const mergedAttachments = [
        ...clonedAttachments,
        ...(handoffScreenshot ? [handoffScreenshot] : []),
      ];
      let remainingPipelineSteps: string[] | undefined;
      if (session.pipeline?.status === "running") {
        const steps = session.pipeline.steps.slice(session.pipeline.nextStepIndex);
        if (steps.length > 0) {
          remainingPipelineSteps = steps;
        }
      }
      const model = resolveCarriedSpawnModel(session, agent, request.model);

      let sourceForSpawn = session;
      if (session.status === "running" || session.status === "spawning") {
        const stopped: SessionRecord = {
          ...this.sessionWithReleasedSidecarPorts(session),
          status: "stopped",
          stopReason: "manual_pause",
          updatedAt: nowIso(),
          retainInList: true,
        };
        writeSession(this.config.dataDir, stopped);
        this.stateCache.delete(sessionId);
        await killTmuxSession(session.tmuxSession);
        await this.cleanupSessionServices(stopped);
        sourceForSpawn = readSession(this.config.dataDir, sessionId) ?? stopped;
      }

      const prompt = renderHandoffPrompt({
        sourceSessionId: session.id,
        sourceAgent: session.agent,
        branch: session.branch,
        worktreePath: session.worktreePath,
        originalPrompt: originalTask,
        ...(session.slots?.title ? { title: session.slots.title } : {}),
        links: sourceForSpawn.slots?.links ?? [],
        ...(session.slots?.tags?.length ? { tags: session.slots.tags } : {}),
        ...(session.pr ? { pr: session.pr } : {}),
        ...(remainingPipelineSteps?.length ? { remainingPipelineSteps } : {}),
        ...(notes ? { notes } : {}),
        ...(handoffScreenshot ? { terminalScreenshot: true } : {}),
      });

      this.logEvent("session.handoff.started", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Handing off ${sessionId} to ${agent}`,
        details: {
          sourceAgent: session.agent,
          targetAgent: agent,
          ...(handoffScreenshot ? { terminalScreenshot: true } : {}),
        },
      });

      let spawned = await this.spawn(
        resolveHandoffSpawnRequest(sourceForSpawn, {
          prompt,
          agent,
          ...(model !== undefined ? { model } : {}),
          originalTaskPrompt: originalTask,
          ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
          ...(remainingPipelineSteps ? { pipelineSteps: remainingPipelineSteps } : {}),
        }),
        { replacingSessionId: session.id, admissionReservation },
      );

      const spawnedRecord = readSession(this.config.dataDir, spawned.id);
      if (spawnedRecord) {
        writeSession(this.config.dataDir, {
          ...spawnedRecord,
          ...(session.pr ? { pr: session.pr } : {}),
          originalTaskPrompt: originalTask,
          updatedAt: nowIso(),
        });
      }

      if (session.slots?.title || session.slots?.tags?.length) {
        const knownTags = new Set(this.config.tags.map((tag) => tag.name));
        const carryTags = session.slots.tags?.filter((tag) => knownTags.has(tag)) ?? [];
        if (session.slots.title || carryTags.length > 0) {
          try {
            spawned = await this.updateSlots(spawned.id, {
              ...(session.slots.title ? { title: session.slots.title } : {}),
              ...(carryTags.length > 0 ? { tags: carryTags } : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logEvent("session.handoff.carry_slots_failed", {
              level: "warn",
              sessionId,
              projectId: session.project,
              message: `Handoff spawned ${spawned.id} but failed to carry slots from ${sessionId}: ${message}`,
            });
          }
        }
      }

      try {
        await this.complete(
          session.id,
          { prAction: "leave_open", skipPrCheck: true, skipRuntimeTeardown: true },
          { retainInList: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.handoff.source_complete_failed", {
          level: "warn",
          sessionId,
          projectId: session.project,
          message: `Handoff spawned ${spawned.id} but failed to complete ${sessionId}: ${message}`,
        });
      }

      return spawned;
    } finally {
      this.admissionReservations.delete(admissionReservation);
    }
  }

  private resumeSessionDelivery(): void {
    for (const session of listSessions(this.config.dataDir)) {
      this.ensureDeliveryRunner(session.id);
    }
  }

  private shouldRunDelivery(session: SessionRecord | null): session is SessionRecord {
    if (!session || session.status !== "running") {
      return false;
    }
    return (
      hasQueuedMessages(session) ||
      session.queuedMessages?.awaitingPrompt === true ||
      session.pipeline?.status === "running"
    );
  }

  private ensureDeliveryRunner(sessionId: string): void {
    if (this.deliveryRuns.has(sessionId)) {
      return;
    }

    const session = readSession(this.config.dataDir, sessionId);
    if (!this.shouldRunDelivery(session)) {
      return;
    }

    const run = this.runDeliveryLoop(sessionId).finally(() => {
      this.deliveryRuns.delete(sessionId);
    });
    this.deliveryRuns.set(sessionId, run);
  }

  private async tryDeliverQueuedMessage(sessionId: string): Promise<boolean> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!this.shouldRunDelivery(session) || !hasQueuedMessages(session)) {
      return false;
    }

    const readySession = await this.ensureSessionReadyForSend(session);
    const classified = await this.classifySessionRecord(readySession);
    // A live claude server-error wedge behaves like "waiting" for delivery
    // purposes: typing the queued message is exactly what un-wedges Claude
    // (the same mechanism as the reactivation nudge in processScheduledWakes),
    // so an ordinary queued send must not sit for up to 30 minutes waiting
    // for that nudge to fire on its own.
    if (classified.state !== "waiting" && !classified.serverError) {
      return false;
    }
    // Gate on the agent's own structured artifact, not raw tmux activity. Raw
    // tmux activity is the session-wide max across every window, so a user's
    // split running a dev server would stall delivery indefinitely, and merely
    // attaching the web terminal (which makes the TUI repaint) would delay it
    // by another full window. The agent's transcript is inherently scoped to
    // the agent and is untouched by both.
    if (!isIdleEnoughToReceive(resolveAgentActivityAt(classified), getIdleWaitBeforeFlushMs())) {
      return false;
    }

    const latest = readSession(this.config.dataDir, sessionId);
    if (!this.shouldRunDelivery(latest) || !hasQueuedMessages(latest)) {
      return false;
    }

    const nextMessage = queuedMessages(latest)[0];
    if (!nextMessage) {
      return false;
    }

    await this.deliverQueuedMessage(latest, nextMessage, queuedMessages(latest).slice(1));
    return true;
  }

  private async deliverQueuedMessage(
    session: SessionRecord,
    message: string,
    remainingMessages: string[],
  ): Promise<SessionRecord> {
    await this.sendAgentMessage(session, message, { interrupt: false });
    const sessionId = session.id;
    this.stateCache.delete(sessionId);
    const updated = withQueuedMessages(
      {
        ...session,
        status: "running",
        updatedAt: nowIso(),
      },
      remainingMessages,
      true,
    );
    const persisted = await this.captureAgentSessionId(updated, AGENT_SESSION_ID_REFRESH_WAIT_MS);
    writeSession(this.config.dataDir, persisted);
    this.logEvent("session.message.sent", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Delivered message to ${sessionId}`,
      details: {
        interrupt: false,
        messageLength: message.length,
        agentSessionId: persisted.agentSessionId ?? null,
      },
    });
    return persisted;
  }

  private async runDeliveryLoop(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const session = readSession(this.config.dataDir, sessionId);
        if (!this.shouldRunDelivery(session)) {
          return;
        }

        if (session.queuedMessages?.awaitingPrompt) {
          const waitOutcome = await this.waitForQueuedMessage(sessionId);
          if (waitOutcome === "ready") {
            const latest = readSession(this.config.dataDir, sessionId);
            if (!latest?.queuedMessages?.awaitingPrompt) {
              continue;
            }
            writeSession(
              this.config.dataDir,
              withQueuedMessages(
                {
                  ...latest,
                  updatedAt: nowIso(),
                },
                queuedMessages(latest),
                false,
              ),
            );
            continue;
          }

          if (waitOutcome === "stopped") {
            return;
          }

          const latest = readSession(this.config.dataDir, sessionId);
          if (latest?.queuedMessages?.awaitingPrompt) {
            writeSession(
              this.config.dataDir,
              withQueuedMessages(
                {
                  ...latest,
                  updatedAt: nowIso(),
                },
                queuedMessages(latest),
                false,
              ),
            );
          }
          continue;
        }

        if (session.pipeline?.awaitingStepIndex !== undefined) {
          const waitOutcome = await this.waitForPipelineStep(sessionId);
          if (waitOutcome === "stopped") {
            return;
          }
          if (waitOutcome === "ready") {
            const latest = readSession(this.config.dataDir, sessionId);
            if (
              !latest?.pipeline ||
              latest.status !== "running" ||
              latest.pipeline.status !== "running"
            ) {
              return;
            }

            if (latest.pipeline.awaitingStepIndex === undefined) {
              continue;
            }

            const {
              awaitingStepIndex: _awaitingStepIndex,
              nextStepNotBefore: _nextStepNotBefore,
              error: _pipelineError,
              ...pipelineBase
            } = latest.pipeline;
            const completedPipeline =
              latest.pipeline.nextStepIndex >= latest.pipeline.steps.length
                ? {
                    ...pipelineBase,
                    status: "completed" as const,
                  }
                : {
                    ...pipelineBase,
                    nextStepNotBefore: new Date(Date.now() + PIPELINE_STEP_DELAY_MS).toISOString(),
                  };
            writeSession(this.config.dataDir, {
              ...latest,
              updatedAt: nowIso(),
              pipeline: completedPipeline,
            });
            if (completedPipeline.status === "completed") {
              this.logEvent("session.pipeline.completed", {
                level: "info",
                sessionId,
                projectId: latest.project,
                message: `Pipeline completed for ${sessionId}`,
              });
              return;
            }
            continue;
          }

          const failedStepIndex = session.pipeline.awaitingStepIndex;
          const message =
            waitOutcome === "timeout"
              ? `Pipeline step ${failedStepIndex + 1}/${session.pipeline.steps.length} timed out waiting for the agent prompt`
              : `Pipeline step ${failedStepIndex + 1}/${session.pipeline.steps.length} ended before the agent returned to a prompt`;
          this.markPipelineErrored(sessionId, message);
          return;
        }

        if (hasQueuedMessages(session)) {
          if (await this.tryDeliverQueuedMessage(sessionId)) {
            await sleep(PIPELINE_POLL_INTERVAL_MS);
            continue;
          }
          await sleep(PIPELINE_POLL_INTERVAL_MS);
          continue;
        }

        if (!session.pipeline || session.pipeline.status !== "running") {
          return;
        }

        if (session.pipeline.nextStepIndex >= session.pipeline.steps.length) {
          const latest = readSession(this.config.dataDir, sessionId);
          if (
            !latest?.pipeline ||
            latest.status !== "running" ||
            latest.pipeline.status !== "running"
          ) {
            return;
          }
          const {
            awaitingStepIndex: _awaitingStepIndex,
            error: _pipelineError,
            ...pipelineBase
          } = latest.pipeline;
          writeSession(this.config.dataDir, {
            ...latest,
            updatedAt: nowIso(),
            pipeline: {
              ...pipelineBase,
              status: "completed",
            },
          });
          this.logEvent("session.pipeline.completed", {
            level: "info",
            sessionId,
            projectId: latest.project,
            message: `Pipeline completed for ${sessionId}`,
          });
          return;
        }

        const delayRemainingMs = pipelineDelayRemainingMs(session.pipeline.nextStepNotBefore);
        if (delayRemainingMs > 0) {
          await sleep(Math.min(delayRemainingMs, PIPELINE_POLL_INTERVAL_MS));
          continue;
        }
        if (session.pipeline.nextStepNotBefore !== undefined) {
          const latest = readSession(this.config.dataDir, sessionId);
          if (
            !latest?.pipeline ||
            latest.status !== "running" ||
            latest.pipeline.status !== "running"
          ) {
            return;
          }
          const { nextStepNotBefore: _nextStepNotBefore, ...pipelineBase } = latest.pipeline;
          writeSession(this.config.dataDir, {
            ...latest,
            updatedAt: nowIso(),
            pipeline: pipelineBase,
          });
          continue;
        }

        const stepIndex = session.pipeline.nextStepIndex;
        const step = session.pipeline.steps[stepIndex];
        if (step === undefined) {
          throw new Error(
            `Pipeline state is invalid for ${sessionId}: missing step ${stepIndex + 1}`,
          );
        }
        await this.sendAgentMessage(
          session,
          formatPipelineStepMessage(session.prompt, step, stepIndex, session.pipeline.steps.length),
        );

        const latest = readSession(this.config.dataDir, sessionId);
        if (
          !latest?.pipeline ||
          latest.status !== "running" ||
          latest.pipeline.status !== "running"
        ) {
          return;
        }

        const {
          error: _pipelineError,
          nextStepNotBefore: _nextStepNotBefore,
          ...pipelineBase
        } = latest.pipeline;
        writeSession(this.config.dataDir, {
          ...latest,
          updatedAt: nowIso(),
          pipeline: {
            ...pipelineBase,
            nextStepIndex: Math.max(latest.pipeline.nextStepIndex, stepIndex + 1),
            awaitingStepIndex: stepIndex,
          },
        });
        this.logEvent("session.pipeline.step_sent", {
          level: "info",
          sessionId,
          projectId: session.project,
          message: `Sent pipeline step ${stepIndex + 1}/${session.pipeline.steps.length} to ${sessionId}`,
          details: {
            stepIndex: stepIndex + 1,
            totalSteps: session.pipeline.steps.length,
          },
        });
        await sleep(PIPELINE_POLL_INTERVAL_MS);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markPipelineErrored(sessionId, message);
    }
  }

  private async waitForPipelineStep(sessionId: string): Promise<PipelineWaitOutcome> {
    const deadline = Date.now() + PIPELINE_STEP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const session = readSession(this.config.dataDir, sessionId);
      if (
        !session?.pipeline ||
        session.status !== "running" ||
        session.pipeline.status !== "running"
      ) {
        return "stopped";
      }
      if (session.pipeline.awaitingStepIndex === undefined) {
        return "ready";
      }

      if (await this.confirmAgentExited(session)) {
        return "exited";
      }

      const stepUpdatedAt = new Date(session.updatedAt);

      const agentState = await this.classifySessionState(session);
      if (agentState === "working") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "needs_input") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "waiting" && !isFresh(stepUpdatedAt, MESSAGE_READY_GRACE_MS)) {
        return "ready";
      }

      await sleep(PIPELINE_POLL_INTERVAL_MS);
    }

    return "timeout";
  }

  private async waitForQueuedMessage(sessionId: string): Promise<PipelineWaitOutcome> {
    for (;;) {
      const session = readSession(this.config.dataDir, sessionId);
      if (!session || session.status !== "running") {
        return "stopped";
      }
      if (!session.queuedMessages?.awaitingPrompt) {
        return "ready";
      }

      if (await this.confirmAgentExited(session)) {
        return "exited";
      }

      const messageUpdatedAt = new Date(session.updatedAt);
      const promptGraceMs = agentQueuedSendPromptGraceMs(session.agent);

      const agentState = await this.classifySessionState(session);
      if (agentState === "working") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "needs_input") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "waiting" && !isFresh(messageUpdatedAt, promptGraceMs)) {
        return "ready";
      }

      await sleep(PIPELINE_POLL_INTERVAL_MS);
    }
  }

  private async confirmAgentExited(
    session: Pick<SessionRecord, "tmuxSession" | "agent" | "launchCommand">,
  ): Promise<boolean> {
    if (await tmuxSessionExists(session.tmuxSession)) {
      if (await isProcessRunningInTmux(session.tmuxSession, sessionProcessMatchers(session))) {
        return false;
      }
    }
    // Retry once after a short delay to guard against transient tmux/ps failures.
    // fresh:true forces an independent re-sample here — otherwise this retry
    // would just re-read the same ~2s-TTL cached result as the first check
    // above, making a single transient glitch look like two agreeing reads
    // and erroring a still-live pipeline.
    await sleep(PIPELINE_POLL_INTERVAL_MS);
    if (await tmuxSessionExists(session.tmuxSession, { fresh: true })) {
      return !(await isProcessRunningInTmux(session.tmuxSession, sessionProcessMatchers(session), {
        fresh: true,
      }));
    }
    return true;
  }

  private markPipelineErrored(sessionId: string, message: string): void {
    const session = readSession(this.config.dataDir, sessionId);
    if (
      !session?.pipeline ||
      session.status !== "running" ||
      session.pipeline.status !== "running"
    ) {
      return;
    }

    writeSession(this.config.dataDir, {
      ...session,
      updatedAt: nowIso(),
      pipeline: {
        ...session.pipeline,
        status: "errored",
        error: message,
      },
    });
    this.logEvent("session.pipeline.errored", {
      level: "error",
      sessionId,
      projectId: session.project,
      message: `Pipeline errored for ${sessionId}: ${message}`,
      details: {
        nextStepIndex: session.pipeline.nextStepIndex,
        awaitingStepIndex: session.pipeline.awaitingStepIndex ?? null,
      },
    });
  }

  private async enrichService(service: ServiceInstanceRecord): Promise<ServiceInstanceView> {
    const runtimeAlive = await tmuxSessionExists(service.tmuxSession);
    const paneDead = runtimeAlive ? await tmuxPaneDead(service.tmuxSession) : true;
    const tmuxActivityAt = runtimeAlive ? await getTmuxSessionActivity(service.tmuxSession) : null;
    const updatedAt = new Date(service.updatedAt);
    const lastActivityAt = (latestActivityAt(updatedAt, tmuxActivityAt) ?? updatedAt).toISOString();
    const problemRuleIds = listActiveServiceProblems(
      this.config.dataDir,
      service.project,
      service.sessionId,
      service.serviceId,
    );

    let state: ServiceInstanceView["state"];
    if (service.status === "errored") {
      state = "error";
    } else if (problemRuleIds.length > 0) {
      state = "problem";
    } else if (runtimeAlive && !paneDead) {
      state = "running";
    } else {
      state = "stopped";
    }

    return {
      ...service,
      runtimeAlive,
      state,
      lastActivityAt,
      problemRuleIds,
    };
  }

  private codexSessionsDir(sessionId: string): string {
    return join(
      codexHookHomePath(join(this.config.dataDir, "session-tools", sessionId)),
      "sessions",
    );
  }

  private async classifyCodexState(sessionId: string): Promise<{
    state: SessionState;
    source: StateSource;
    hookState: ReturnType<typeof readAgentHookState>;
    rolloutState: CodexRolloutStateRecord | null;
    rateLimit: RateLimitDetection | null;
    activityMs: number;
    model?: string;
  }> {
    const hookState = readAgentHookState(this.config.dataDir, sessionId);
    const rolloutReader = this.codexRolloutReaders.get(sessionId) ?? { files: new Map() };
    this.codexRolloutReaders.set(sessionId, rolloutReader);
    const rolloutRead = await readCodexRolloutState(
      this.codexSessionsDir(sessionId),
      rolloutReader,
    );
    const rolloutState = rolloutRead.rollout;
    let state: SessionState = hookState?.state ?? "waiting";
    let source: StateSource = hookState ? "hook" : "status";

    if (rolloutState && shouldUseCodexRolloutState(hookState, rolloutState)) {
      state = rolloutState.state;
      source = "jsonl";
    }

    // When codex last did something, from its own structured sources: the
    // in-content rollout timestamp (rollout mtime is unusable — `codex resume`'s
    // poison-id heal rewrites every file at once) and the hook state. 0 means
    // neither source exists yet. The single derivation for both the hung-turn
    // check below and the caller's activity/idle-gate signal.
    const activityMs = Math.max(
      rolloutState?.timestampMs ?? 0,
      hookState ? new Date(hookState.updatedAt).getTime() : 0,
    );

    if (state === "working" && rolloutState && !codexToolExecuting(hookState)) {
      if (Date.now() - activityMs >= CODEX_HUNG_AFTER_TOOLS_MS) {
        state = "waiting";
        source = "codex_stale";
      }
    }

    return {
      state,
      source,
      hookState,
      rolloutState,
      rateLimit: rolloutRead.rateLimit,
      activityMs,
      ...(rolloutRead.model ? { model: rolloutRead.model } : {}),
    };
  }

  // `fresh` busts the fleet caches before each read so the whole snapshot is
  // a genuinely independent re-sample, not a replay of whatever the last
  // ~2s tick saw. Needed by reconcileUnexpectedStop's confirmation re-read —
  // without it, a transient tmux blip cached on the first check would just
  // be read again 1s later, agreeing with itself and marking a live session
  // stopped.
  private async readRuntimeSnapshot(
    session: Pick<SessionRecord, "tmuxSession" | "agent" | "launchCommand">,
    options?: { fresh?: boolean },
  ): Promise<SessionRuntimeSnapshot> {
    const fresh = options?.fresh ?? false;
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession, { fresh });
    const paneUsable = runtimeAlive ? !(await tmuxPaneDead(session.tmuxSession, { fresh })) : false;
    const tmuxActivityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
    const processAlive =
      runtimeAlive && paneUsable
        ? await isProcessRunningInTmux(session.tmuxSession, sessionProcessMatchers(session), {
            fresh,
          })
        : false;
    return {
      runtimeAlive,
      paneUsable,
      processAlive,
      tmuxActivityAt,
    };
  }

  private isInRestoreWarmup(sessionId: string): boolean {
    const until = this.restoreWarmupUntil.get(sessionId);
    if (until !== undefined && Date.now() < until) return true;
    this.restoreWarmupUntil.delete(sessionId);
    return false;
  }

  // Same "can this session's dashboard view still change from agent
  // activity" predicate as reapDeadSessionSidecars' inline filter. The
  // short-circuit order matters: isInRestoreWarmup mutates (it clears an
  // expired warmup entry), so running/spawning sessions must never reach it,
  // exactly as the sidecar reaper already relies on.
  private isLiveSessionRecord(session: Pick<SessionRecord, "id" | "status">): boolean {
    return (
      session.status === "running" ||
      session.status === "spawning" ||
      this.isInRestoreWarmup(session.id)
    );
  }

  // Single source of truth for "is this session live" across the two
  // admission gates, /headroom, and the daemon-startup log. Never calls
  // enrich() — running|spawning is the on-disk status predicate
  // reconcileStoppedSessions already uses, unioned with sessions mid-restore
  // (on-disk status still stopped/errored, see restore()'s comment above
  // restoreWarmupUntil.set) so a restore in flight is counted exactly once.
  // `excludeSessionId` drops one session from the live count before admission
  // math runs. Used to make a "replace this session" admission decision
  // (handoff) net-neutral: the source is still on-disk as running/spawning
  // when the check runs (it must be, so a denial leaves it untouched), but
  // it is about to be torn down and replaced, so it should not count against
  // the very spawn that replaces it.
  private countLiveSessions(excludeSessionId?: string): {
    total: number;
    byProject: Map<string, number>;
    records: SessionRecord[];
  } {
    const live = listSessions(this.config.dataDir).filter(
      (session) => session.id !== excludeSessionId && this.isLiveSessionRecord(session),
    );
    const byProject = new Map<string, number>();
    for (const session of live) {
      byProject.set(session.project, (byProject.get(session.project) ?? 0) + 1);
    }
    return { total: live.length, byProject, records: live };
  }

  private admissionDenialAction(records: SessionRecord[]): string {
    const candidates = [...records]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, 3)
      .map((session) => `${session.id} (${session.project})`)
      .join(", ");
    return candidates
      ? `Stop one of: ${candidates}.`
      : "Wait for an in-flight spawn to finish, then stop a live session or retry.";
  }

  private admissionOccupancy(live: number, reserved: number): string {
    const claimed = live + reserved;
    return `${claimed} ${claimed === 1 ? "slot" : "slots"} claimed: ${live} live, ${reserved} reserved`;
  }

  // Runs at both admission gates (resolveSpawnTarget, restore). Never
  // mutates state, never kills, never acts retroactively on sessions already
  // above the cap — a denial only refuses the *new* spawn/restore in front
  // of it. `admission.enabled: false` is a full escape hatch: neither the
  // cap nor the memory guard can deny, though the guard still logs a
  // report-only warning when crossed so the condition stays visible.
  private assertAdmissible(
    projectId: string,
    context: "spawn" | "restore",
    opts?: { replacingSessionId?: string; admissionReservation?: symbol },
  ): void {
    const admission = this.config.admission;
    const memory = readHostMemory();
    let legacyGuardDetail: string | undefined;
    let floorGuardDetail: string | undefined;
    if (memory) {
      const availableMiB = (memory.availableBytes / (1024 * 1024)).toFixed(0);
      const floorMiB = (admission.memoryGuard.minAvailableBytes / (1024 * 1024)).toFixed(0);
      const swapMiB = (memory.swapFreeBytes / (1024 * 1024)).toFixed(0);
      const swapFloorMiB = (admission.memoryGuard.minFreeSwapBytes / (1024 * 1024)).toFixed(0);
      if (memory.availableBytes < admission.memoryGuard.minAvailableBytes) {
        legacyGuardDetail = `available memory ${availableMiB}MB is below the ${floorMiB}MB floor`;
      } else if (memory.swapFreeBytes < admission.memoryGuard.minFreeSwapBytes) {
        legacyGuardDetail = `free swap ${swapMiB}MB is below the ${swapFloorMiB}MB floor`;
      }

      const contextFloor =
        context === "restore"
          ? admission.memoryGuard.restoreFloorBytes
          : admission.memoryGuard.admissionFloorBytes;
      if (memory.availableBytes < contextFloor) {
        floorGuardDetail = `available memory ${availableMiB}MB is below the ${(
          contextFloor /
          (1024 * 1024)
        ).toFixed(0)}MB ${context} floor`;
      } else {
        const pressure = readCgroupPressure();
        if (
          pressure !== null &&
          pressure.someAvg10 > admission.memoryGuard.pressureSomeAvg10Refuse
        ) {
          floorGuardDetail = `memory PSI some avg10 ${pressure.someAvg10.toFixed(2)} exceeds ${admission.memoryGuard.pressureSomeAvg10Refuse.toFixed(2)}`;
        }
      }
    }
    if (legacyGuardDetail) {
      this.logEvent("session.admission.memory_guard", {
        level: "warn",
        projectId,
        message: `Memory guard crossed for ${context} in project "${projectId}": ${legacyGuardDetail}`,
      });
    }
    if (!admission.enabled) {
      return;
    }
    const denialDetail =
      (legacyGuardDetail && admission.memoryGuard.enforce ? legacyGuardDetail : undefined) ??
      (floorGuardDetail && admission.memoryGuard.enforceFloors ? floorGuardDetail : undefined);
    if (denialDetail) {
      const denial = new SessionAdmissionDeniedError(
        `Cannot ${context} session for project "${projectId}": memory guard crossed — ${denialDetail}`,
      );
      this.logEvent("session.admission.denied", {
        level: "warn",
        projectId,
        message: denial.message,
      });
      throw denial;
    }
    const live = this.countLiveSessions(opts?.replacingSessionId);
    let reservedTotal = 0;
    let projectReserved = 0;
    for (const [reservation, reservedProjectId] of this.admissionReservations) {
      if (reservation === opts?.admissionReservation) continue;
      reservedTotal += 1;
      if (reservedProjectId === projectId) projectReserved += 1;
    }
    const projectCap = this.config.projects[projectId]?.maxLiveSessions;
    const projectLive = live.byProject.get(projectId) ?? 0;
    const projectClaimed = projectLive + projectReserved;
    if (projectCap !== undefined && projectClaimed >= projectCap) {
      const projectCandidates = live.records.filter((session) => session.project === projectId);
      const denial = new SessionAdmissionDeniedError(
        `Cannot ${context} session for project "${projectId}": at its per-project cap of ${projectCap} live sessions (${this.admissionOccupancy(projectLive, projectReserved)}). ${this.admissionDenialAction(projectCandidates)}`,
      );
      this.logEvent("session.admission.denied", {
        level: "warn",
        projectId,
        message: denial.message,
      });
      throw denial;
    }
    const totalLive = live.total + reservedTotal;
    if (totalLive >= admission.maxLiveSessions) {
      const denial = new SessionAdmissionDeniedError(
        `Cannot ${context} session for project "${projectId}": at the global cap of ${admission.maxLiveSessions} live sessions (${this.admissionOccupancy(live.total, reservedTotal)}). ${this.admissionDenialAction(live.records)}`,
      );
      this.logEvent("session.admission.denied", {
        level: "warn",
        projectId,
        message: denial.message,
      });
      throw denial;
    }
  }

  private reserveAdmission(
    projectId: string,
    context: "spawn" | "restore",
    opts?: { replacingSessionId?: string },
  ): symbol {
    this.assertAdmissible(projectId, context, opts);
    const reservation = Symbol(projectId);
    this.admissionReservations.set(reservation, projectId);
    return reservation;
  }

  // Cheap admission snapshot for the daemon-startup log: cap and live count
  // only. getHeadroom() also awaits getFleetSessionRssBytes() (a `ps` fork
  // plus `tmux list-panes -a`) for its per-session RSS breakdown, which the
  // boot log throws away — too costly to run inside the pre-`ready` window.
  getAdmissionStartupSummary(): {
    enabled: boolean;
    cap: { global: number; source: AdmissionCapSource };
    liveCount: number;
  } {
    const admission = this.config.admission;
    const live = this.countLiveSessions();
    return {
      enabled: admission.enabled,
      cap: { global: admission.maxLiveSessions, source: admission.maxLiveSessionsSource },
      liveCount: live.total,
    };
  }

  getMemoryCeilingWarning(): {
    cgroupPath: string;
    memoryMaxUnlimited: true;
    memoryHighUnlimited: boolean;
    oomdPresent: false;
  } | null {
    const limits = readCgroupMemorySnapshot();
    const oomdPresent = isSystemdOomdPresent();
    if (limits?.maxBytes !== null || oomdPresent) return null;
    return {
      cgroupPath: limits.path,
      memoryMaxUnlimited: true,
      memoryHighUnlimited: limits.highBytes === null,
      oomdPresent: false,
    };
  }

  async getHeadroom(): Promise<HeadroomReport> {
    const admission = this.config.admission;
    const live = this.countLiveSessions();
    const liveSessionByWorkspaceId = new Map<string, string>();
    for (const session of live.records) {
      const workspaceId = workspaceIdOf(session);
      const currentOwner = liveSessionByWorkspaceId.get(workspaceId);
      if (!currentOwner || session.id === workspaceId) {
        liveSessionByWorkspaceId.set(workspaceId, session.id);
      }
    }
    const rssBySessionId = await getFleetSessionRssBytes(liveSessionByWorkspaceId);
    const projectCaps: Record<string, number> = {};
    for (const [projectId, project] of Object.entries(this.config.projects)) {
      if (project.maxLiveSessions !== undefined) {
        projectCaps[projectId] = project.maxLiveSessions;
      }
    }
    const byProject: Record<string, number> = {};
    for (const [projectId, count] of live.byProject) {
      byProject[projectId] = count;
    }
    const memory = readHostMemory();
    const guardCrossed =
      memory !== null &&
      (memory.availableBytes < admission.memoryGuard.minAvailableBytes ||
        memory.swapFreeBytes < admission.memoryGuard.minFreeSwapBytes ||
        memory.availableBytes < admission.memoryGuard.admissionFloorBytes);
    return {
      cap: {
        global: admission.maxLiveSessions,
        source: admission.maxLiveSessionsSource,
        perSessionBytes: admission.perSessionBytes,
        reserveFraction: admission.reserveFraction,
      },
      projectCaps,
      live: { count: live.total, byProject },
      projectedRoom: Math.max(0, admission.maxLiveSessions - live.total),
      sessions: [...live.records]
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((session) => ({
          id: session.id,
          project: session.project,
          status: session.status,
          rssBytes: rssBySessionId.get(session.id) ?? 0,
        })),
      memory,
      guard: {
        enforce: admission.memoryGuard.enforce,
        enforceFloors: admission.memoryGuard.enforceFloors,
        minAvailableBytes: admission.memoryGuard.minAvailableBytes,
        minFreeSwapBytes: admission.memoryGuard.minFreeSwapBytes,
        admissionFloorBytes: admission.memoryGuard.admissionFloorBytes,
        shedCriticalFloorBytes: admission.memoryGuard.shedCriticalFloorBytes,
        restoreFloorBytes: admission.memoryGuard.restoreFloorBytes,
        pressureSomeAvg10Refuse: admission.memoryGuard.pressureSomeAvg10Refuse,
        crossed: guardCrossed,
      },
    };
  }

  private stabilizeState(sessionId: string, nextState: SessionState): SessionState {
    const cached = this.stateCache.get(sessionId);
    const now = Date.now();
    if (cached && nextState !== cached.state && now - cached.classifiedAt < STATE_HOLD_MS) {
      if (
        nextState !== "needs_input" &&
        nextState !== "rate_limited" &&
        nextState !== "stopped" &&
        nextState !== "killed" &&
        nextState !== "error"
      ) {
        return cached.state;
      }
    }
    this.stateCache.set(sessionId, { state: nextState, classifiedAt: now });
    return nextState;
  }

  private scheduleStateSubscriptionDispatch(
    targetSession: Pick<SessionRecord, "id" | "project">,
    transition: {
      at: string;
      fromState: SessionState;
      toState: SessionState;
      source: StateSource;
    },
  ): void {
    if (this.stateSubscriptionDispatchDepth > 0) {
      return;
    }
    void this.dispatchStateSubscriptions(targetSession, transition).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.subscription.dispatch_failed", {
        level: "warn",
        sessionId: targetSession.id,
        projectId: targetSession.project,
        message: `Failed to dispatch state subscriptions: ${message}`,
        details: {
          targetSessionId: targetSession.id,
          targetProjectId: targetSession.project,
        },
      });
    });
  }

  private async dispatchStateSubscriptions(
    targetSession: Pick<SessionRecord, "id" | "project">,
    transition: {
      at: string;
      fromState: SessionState;
      toState: SessionState;
      source: StateSource;
    },
  ): Promise<void> {
    this.stateSubscriptionDispatchDepth += 1;
    try {
      this.ensureStateSubscriptionIndex();
      const transitionId = stateTransitionId(targetSession.id, transition);
      const subscriberIds = this.stateSubscriptionIndex.get(targetSession.id);
      if (!subscriberIds || subscriberIds.size === 0) {
        return;
      }
      for (const subscriberId of subscriberIds) {
        const currentSubscriber = readSession(this.config.dataDir, subscriberId);
        if (!currentSubscriber) {
          continue;
        }
        const currentSubscriptions = currentSubscriber.stateSubscriptions ?? [];
        const deliverable = currentSubscriptions.filter(
          (subscription) =>
            subscription.targetSessionId === targetSession.id &&
            subscription.states.includes(transition.toState) &&
            subscription.lastDeliveredTransitionId !== transitionId,
        );
        for (const subscription of deliverable) {
          try {
            await this.send(currentSubscriber.id, {
              message: formatStateSubscriptionMessage({
                targetSessionId: targetSession.id,
                transition,
                ...(subscription.message ? { customMessage: subscription.message } : {}),
              }),
            });
            const deliveredAt = nowIso();
            const freshSubscriber = readSession(this.config.dataDir, subscriberId);
            if (!freshSubscriber) {
              continue;
            }
            const freshSubscriptions = freshSubscriber.stateSubscriptions ?? [];
            const claimedSubscriptions = freshSubscriptions.map((entry) =>
              entry.id === subscription.id
                ? {
                    ...entry,
                    lastDeliveredTransitionId: transitionId,
                    lastDeliveredAt: deliveredAt,
                  }
                : entry,
            );
            this.writeStateSubscriptions(freshSubscriber, claimedSubscriptions, deliveredAt);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logEvent("session.subscription.delivery_failed", {
              level: "warn",
              sessionId: currentSubscriber.id,
              projectId: currentSubscriber.project,
              message: `Failed to deliver state subscription ${subscription.id}: ${message}`,
              details: {
                targetSessionId: targetSession.id,
                targetProjectId: targetSession.project,
                transitionId,
                subscriptionId: subscription.id,
              },
            });
          }
        }
      }
    } finally {
      this.stateSubscriptionDispatchDepth -= 1;
    }
  }

  private async updateStateHistory(
    session: SessionRecord,
    state: SessionState,
    stateSource: StateSource,
    historySourcePath: string | null,
    serverError: boolean,
  ): Promise<SessionStateTransition[]> {
    // The state can stay "error" across many ticks while the marker must
    // still be armed/cleared, so this runs outside the transition branch
    // below. Gated on the in-hand session record (no extra readSession) so
    // the steady state (serverError already agrees with session.serverErrorAt)
    // costs nothing.
    if (serverError && !session.serverErrorAt) {
      this.writeServerErrorMarker(session.id, nowIso());
    } else if (!serverError && session.serverErrorAt) {
      this.writeServerErrorMarker(session.id, null);
    }

    const history = this.stateHistory.get(session.id) ?? [];
    const lastEntry = history[history.length - 1];
    if (history.length === 0 || lastEntry?.state !== state) {
      const transitionAt = new Date().toISOString();
      history.push({ state, at: transitionAt, source: stateSource });
      if (history.length > STATE_HISTORY_LIMIT) {
        history.splice(0, history.length - STATE_HISTORY_LIMIT);
      }
      this.stateHistory.set(session.id, history);
      const current = readSession(this.config.dataDir, session.id);
      if (current) {
        if (state === "rate_limited") {
          if (!current.rateLimitedAt) {
            writeSession(this.config.dataDir, {
              ...current,
              rateLimitedAt: transitionAt,
              updatedAt: nowIso(),
            });
          }
        } else if (current.rateLimitedAt) {
          const { rateLimitedAt: _rateLimitedAt, ...base } = current;
          writeSession(this.config.dataDir, { ...base, updatedAt: nowIso() });
        }
      }
      if (lastEntry) {
        await this.logStateTransition(
          session,
          {
            at: transitionAt,
            fromState: lastEntry.state,
            toState: state,
            source: stateSource,
          },
          historySourcePath,
        );
        this.scheduleStateSubscriptionDispatch(session, {
          at: transitionAt,
          fromState: lastEntry.state,
          toState: state,
          source: stateSource,
        });
      }
    }
    return history;
  }

  // Sole writer/clearer of serverErrorAt outside the wake-loop CAS re-arm.
  // Re-reads before writing since this runs off the in-hand session record.
  private writeServerErrorMarker(sessionId: string, serverErrorAt: string | null): void {
    const current = readSession(this.config.dataDir, sessionId);
    if (!current) return;
    if (serverErrorAt) {
      // Guard against an overlapping tick's stale in-hand session (the caller
      // only checked !session.serverErrorAt before calling this): re-reading
      // here can find the marker already armed by another tick, and writing
      // again would restart the 30-minute window for no reason.
      if (current.serverErrorAt) return;
      writeSession(this.config.dataDir, { ...current, serverErrorAt, updatedAt: nowIso() });
    } else {
      if (!current.serverErrorAt) return;
      const { serverErrorAt: _serverErrorAt, ...base } = current;
      writeSession(this.config.dataDir, { ...base, updatedAt: nowIso() });
    }
  }

  private async hasServiceIssues(session: Pick<SessionRecord, "id" | "project">): Promise<boolean> {
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      if (service.status !== "running") {
        return true;
      }
      if (!(await tmuxSessionExists(service.tmuxSession))) {
        return true;
      }
      if (
        listActiveServiceProblems(
          this.config.dataDir,
          session.project,
          session.id,
          service.serviceId,
        ).length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  private async reconcileUnexpectedStop(
    session: SessionRecord,
    runtime: SessionRuntimeSnapshot,
    reason: "boot" | "runtime_check",
    workspaceMissing: boolean,
  ): Promise<{ session: SessionRecord; runtime: SessionRuntimeSnapshot }> {
    if (session.status !== "running" && session.status !== "spawning") {
      return { session, runtime };
    }
    if (session.status === "spawning") {
      // At boot we cannot tell an in-progress spawn from a stuck one and tmux
      // may not exist yet, so never reconcile a spawning session on boot.
      // During live runtime checks, a spawn still running in this process has no
      // stable runtime yet — skip it regardless of how long setup takes. Only a
      // spawning session with no active pipeline (finished, failed, or lost to a
      // daemon restart) and a dead runtime is reconciled like a dropped running
      // one — otherwise it hangs on "working" forever with no terminal state.
      if (reason === "boot" || this.spawnsInFlight.has(session.id)) {
        return { session, runtime };
      }
    }
    const workspaceGone = workspaceMissing;
    let confirmedRuntime = runtime;
    if (!workspaceGone) {
      if (runtime.runtimeAlive && runtime.paneUsable && runtime.processAlive) {
        return { session, runtime };
      }
      await sleep(PIPELINE_POLL_INTERVAL_MS);
      // fresh:true — an independent re-sample, not a replay of the same
      // ~2s-TTL cached snapshot the first check above just read. Otherwise a
      // single transient tmux/list-windows blip would agree with itself on
      // both reads and mark a genuinely live session stopped.
      confirmedRuntime = await this.readRuntimeSnapshot(session, { fresh: true });
      if (
        confirmedRuntime.runtimeAlive &&
        confirmedRuntime.paneUsable &&
        confirmedRuntime.processAlive
      ) {
        return { session, runtime: confirmedRuntime };
      }
    }

    const latest = readSession(this.config.dataDir, session.id);
    if (!latest) {
      return { session, runtime };
    }
    if (latest.status !== session.status) {
      return { session: latest, runtime };
    }

    const terminalUnavailable =
      !workspaceGone && (!confirmedRuntime.runtimeAlive || !confirmedRuntime.paneUsable);
    const updatedAt = nowIso();
    // Neither "stopped" nor "errored" is a terminal status (isTerminalSessionStatus
    // is completed|killed only), so any sidecarPorts left on the record would be
    // treated as still owned by a live session forever — release them here the
    // same way pause/kill already do, or the leak sweep can never reclaim the
    // port and the pool eventually exhausts. Desk-shared entries are kept while
    // another member is non-terminal: those ports really are still in use.
    const latestNoPorts = this.sessionWithReleasedSidecarPorts(latest);
    let updated: SessionRecord;
    if (terminalUnavailable) {
      const {
        error: _ignoredError,
        stopReason: _ignoredStopReason,
        ...stoppedBase
      } = latestNoPorts;
      updated = {
        ...stoppedBase,
        status: "stopped",
        updatedAt,
      };
    } else {
      updated = {
        ...latestNoPorts,
        status: "errored",
        error: workspaceGone ? "Agent worktree is missing." : "Agent runtime exited unexpectedly.",
        updatedAt,
      };
    }
    writeSession(this.config.dataDir, updated);
    this.stateCache.delete(session.id);
    await this.teardownSessionSidecars(updated).catch(() => {});
    this.logEvent(
      reason === "boot" ? "session.reconcile.drift" : `session.runtime.${updated.status}`,
      {
        level: reason === "boot" || terminalUnavailable ? "warn" : "error",
        sessionId: session.id,
        projectId: session.project,
        message:
          reason === "boot"
            ? `Drift: ${session.id} status=${session.status} but ${workspaceGone ? "its worktree is missing" : "runtime is no longer alive"}`
            : workspaceGone
              ? `Marked ${session.id} errored after worktree went missing`
              : terminalUnavailable
                ? `Marked ${session.id} stopped after runtime became unavailable`
                : `Marked ${session.id} errored after runtime exit`,
        details: {
          previousStatus: session.status,
          tmuxSession: session.tmuxSession,
          agent: session.agent,
          runtimeAlive: confirmedRuntime.runtimeAlive,
          paneUsable: confirmedRuntime.paneUsable,
          processAlive: confirmedRuntime.processAlive,
          workspaceMissing: workspaceGone,
          reason,
        },
      },
    );
    return {
      session: updated,
      runtime: confirmedRuntime,
    };
  }

  private reconcileStaleStoppedSession(
    session: SessionRecord,
    runtime: SessionRuntimeSnapshot,
    workspaceMissing: boolean,
  ): SessionRecord {
    if (
      session.status !== "stopped" ||
      session.project === SHEPHERD_PROJECT_ID ||
      session.stopReason === "manual_pause" ||
      hasSessionErrorEvidence(session) ||
      workspaceMissing ||
      !runtime.runtimeAlive ||
      !runtime.paneUsable ||
      !runtime.processAlive
    ) {
      return session;
    }

    const latest = readSession(this.config.dataDir, session.id);
    if (!latest) {
      return session;
    }
    if (
      latest.status !== "stopped" ||
      latest.stopReason === "manual_pause" ||
      hasSessionErrorEvidence(latest)
    ) {
      return latest;
    }

    const { error: _ignoredError, ...runningBase } = latest;
    const updated: SessionRecord = {
      ...runningBase,
      status: "running",
      updatedAt: nowIso(),
    };
    delete updated.stopReason;
    writeSession(this.config.dataDir, updated);
    this.stateCache.delete(session.id);
    this.logEvent("session.reconcile.running", {
      level: "warn",
      sessionId: session.id,
      projectId: session.project,
      message: `Reconciled ${session.id} from stopped to running because tmux and agent process are live`,
      details: {
        previousStatus: session.status,
        tmuxSession: session.tmuxSession,
        agent: session.agent,
        runtimeAlive: runtime.runtimeAlive,
        paneUsable: runtime.paneUsable,
        processAlive: runtime.processAlive,
      },
    });
    return updated;
  }

  private reconcileStaleErroredSession(
    session: SessionRecord,
    runtime: SessionRuntimeSnapshot,
    workspaceMissing: boolean,
  ): SessionRecord {
    if (
      session.status !== "errored" ||
      session.project === SHEPHERD_PROJECT_ID ||
      workspaceMissing ||
      !runtime.runtimeAlive ||
      !runtime.paneUsable ||
      !runtime.processAlive
    ) {
      return session;
    }

    const latest = readSession(this.config.dataDir, session.id);
    if (!latest || latest.status !== "errored") {
      return latest ?? session;
    }

    const { error: _ignoredError, ...runningBase } = latest;
    const updated: SessionRecord = {
      ...runningBase,
      status: "running",
      updatedAt: nowIso(),
    };
    delete updated.stopReason;
    writeSession(this.config.dataDir, updated);
    this.stateCache.delete(session.id);
    this.logEvent("session.reconcile.running", {
      level: "warn",
      sessionId: session.id,
      projectId: session.project,
      message: `Reconciled ${session.id} from errored to running because tmux and agent process are live`,
      details: {
        previousStatus: session.status,
        tmuxSession: session.tmuxSession,
        agent: session.agent,
        runtimeAlive: runtime.runtimeAlive,
        paneUsable: runtime.paneUsable,
        processAlive: runtime.processAlive,
      },
    });
    return updated;
  }

  private async classifySessionRecord(
    session: SessionRecord,
    options?: { scanPane?: boolean },
  ): Promise<SessionStateResult> {
    const scanPane = options?.scanPane ?? true;
    if (
      (session.status === "running" || session.status === "spawning") &&
      this.isInRestoreWarmup(session.id)
    ) {
      return {
        session,
        runtime: { runtimeAlive: true, paneUsable: true, processAlive: true, tmuxActivityAt: null },
        state: "working",
        source: "status",
        historySourcePath: null,
        workspacePresent: probeWorkspace(session.worktreePath).exists,
        serverError: false,
        agentActivityAt: null,
      };
    }
    let runtime: SessionRuntimeSnapshot = isTerminalSessionStatus(session.status)
      ? {
          runtimeAlive: false,
          paneUsable: false,
          processAlive: false,
          tmuxActivityAt: null,
        }
      : await this.readRuntimeSnapshot(session);
    const workspace = probeWorkspace(session.worktreePath);
    let effectiveSession = session;
    let state: SessionState;
    // Holds the message for the single deduped session.state.classified emit
    // at the end of this function; undefined means never log (unchanged from
    // today for non-running/dead-pane sessions). A later branch's assignment
    // overrides an earlier one exactly as it overrides `state`.
    let classifiedDetail: string | undefined;
    let stateSource: StateSource = "status";
    let historySourcePath: string | null = null;
    let liveModel: string | undefined;
    if (effectiveSession.status === "running" || effectiveSession.status === "spawning") {
      const reconciled = await this.reconcileUnexpectedStop(
        effectiveSession,
        runtime,
        "runtime_check",
        workspace.missing,
      );
      effectiveSession = reconciled.session;
      runtime = reconciled.runtime;
    }
    effectiveSession = this.reconcileStaleStoppedSession(
      effectiveSession,
      runtime,
      workspace.missing,
    );
    effectiveSession = this.reconcileStaleErroredSession(
      effectiveSession,
      runtime,
      workspace.missing,
    );

    let rateLimit: RateLimitDetection | null = null;
    let hasServerErrorRecord = false;
    let serverErrorJsonlPath: string | null = null;
    // Set from whichever structured artifact the branches below already read.
    let agentActivityAt: Date | null = null;
    if (effectiveSession.status !== "running") {
      state = statusFallbackState(effectiveSession);
    } else if (!runtime.paneUsable || !runtime.processAlive) {
      state = "stopped";
    } else {
      const strategy = agentStateStrategy(session.agent);
      if (strategy === "claude_jsonl") {
        // Independent I/O (tmux exec vs. file read): fetch the pane pid
        // concurrently with the jsonl read so it stays off the critical path.
        const panePidPromise = getTmuxPanePid(session.tmuxSession);
        const jsonlResult = await readClaudeJsonlState(
          session.worktreePath,
          this.claudeJsonlReaders.get(session.id),
          session.agentSessionId,
        );
        if (jsonlResult) {
          this.claudeJsonlReaders.set(session.id, jsonlResult.reader);
          rateLimit = jsonlResult.rateLimit;
          hasServerErrorRecord = jsonlResult.serverError;
          serverErrorJsonlPath = jsonlResult.reader.filePath;
          // The reader already stat()ed the pinned transcript; reuse its mtime.
          agentActivityAt = activityAtFromMs(jsonlResult.reader.lastMtimeMs);
          liveModel = jsonlResult.liveModel;
        }
        const panePid = await panePidPromise;
        const statusResult = await readClaudeSessionStatus(
          session.worktreePath,
          session.agentSessionId,
          undefined,
          panePid !== null ? { panePid } : {},
        );
        if (statusResult) {
          state = statusResult.state;
          stateSource = "claude_status";
          historySourcePath = statusResult.filePath;
          classifiedDetail = `State: ${state} (claude status=${statusResult.status})`;
        } else if (jsonlResult) {
          state = jsonlResult.state;
          stateSource = "jsonl";
          historySourcePath = jsonlResult.reader.filePath;
          classifiedDetail = `State: ${state} (jsonl, records=${jsonlResult.reader.tailRecords.length})`;
        } else {
          state = "working";
          classifiedDetail = `State: ${state} (no claude status/jsonl)`;
        }
      } else if (strategy === "hook") {
        const codexState = await this.classifyCodexState(session.id);
        state = codexState.state;
        stateSource = codexState.source;
        rateLimit = codexState.rateLimit;
        agentActivityAt = activityAtFromMs(codexState.activityMs);
        liveModel = codexState.model;
        if (stateSource === "codex_stale" && codexState.rolloutState) {
          historySourcePath = codexState.rolloutState.filePath;
          classifiedDetail = `State: ${state} (codex stale, idle=${Date.now() - codexState.activityMs}ms)`;
        } else if (stateSource === "jsonl" && codexState.rolloutState) {
          historySourcePath = codexState.rolloutState.filePath;
          classifiedDetail = `State: ${state} (codex jsonl=${codexState.rolloutState.reason})`;
        } else if (codexState.hookState) {
          const hookState = codexState.hookState;
          classifiedDetail = `State: ${state} (hook=${hookState.state}, event=${hookState.hookEvent ?? "?"}, hookAge=${Math.round((Date.now() - new Date(hookState.updatedAt).getTime()) / 1000)}s)`;
        } else {
          classifiedDetail = `State: ${state} (no hook/jsonl)`;
        }
      } else {
        const jsonlResult = await readCursorJsonlState(
          session.worktreePath,
          this.cursorJsonlReaders.get(session.id),
          session.agentSessionId,
        );
        if (jsonlResult) {
          this.cursorJsonlReaders.set(session.id, jsonlResult.reader);
          rateLimit = jsonlResult.rateLimit;
          state = jsonlResult.state;
          stateSource = "jsonl";
          historySourcePath = jsonlResult.reader.filePath;
          agentActivityAt = activityAtFromMs(jsonlResult.reader.lastMtimeMs);
          classifiedDetail = `State: ${state} (cursor jsonl, records=${jsonlResult.reader.tailRecords.length})`;
        } else {
          state = "working";
          classifiedDetail = `State: ${state} (no cursor jsonl)`;
        }
      }

      // Structured sources first; the generic tmux-banner scan only runs when they
      // didn't confirm a limit. For Claude, the interactive-menu check always runs
      // regardless, since the menu can show up even after jsonl already confirmed
      // the limit — that's the common case the Enter-confirm needs to catch.
      // The 2s dashboard-cache tick opts out (scanPane:false): capture-pane is the
      // last per-session fork left in this path, and jsonl/hook sources already
      // cover rate-limit detection for the dashboard. The 5s attention monitor and
      // on-demand enrich of the viewed session keep scanning (through the cached
      // captureTmuxPane, so it's still O(1) forks per session per TTL window).
      if (scanPane && strategy === "claude_jsonl") {
        const paneText = await captureTmuxPane(session.tmuxSession);
        const menuHit = detectClaudeUsageLimitMenu(paneText);
        if (!rateLimit?.limited) {
          const tmuxHit = scanTmuxRateLimit(paneText) ?? menuHit;
          if (tmuxHit?.limited) {
            rateLimit = tmuxHit;
          }
        }
        if (menuHit?.limited && claudeUsageMenuOptionOneSelected(paneText)) {
          await this.confirmClaudeUsageLimitMenu(session);
        }
        // Compaction never reaches Claude's persisted status file (it stays
        // "idle" throughout, which jsonl/hook maps to waiting) and the
        // transcript only gets a compact record after completion — so the
        // live pane spinner is the only signal while it's in progress. The
        // rate-limit override below still wins if a banner is also present —
        // skip recording the override in that case so the scanPane:false
        // dashboard tick doesn't strand a stale "working" once the rate
        // limit expires (mirrors codexMcpDialogOverrides' hard-limit delete
        // above). Recorded into claudeCompactingOverrides (TTL) so the
        // scanPane:false dashboard tick's own idle re-read doesn't keep
        // refreshing stabilizeState's hold window against this working
        // transition.
        if (detectClaudeCompacting(paneText) && !rateLimit?.limited) {
          state = "working";
          this.claudeCompactingOverrides.set(
            session.id,
            Date.now() + CLAUDE_COMPACTING_OVERRIDE_TTL_MS,
          );
          classifiedDetail = "State: working (claude compacting)";
        } else {
          this.claudeCompactingOverrides.delete(session.id);
        }
      } else if (!scanPane && strategy === "claude_jsonl") {
        // The scanPane:false dashboard tick can't afford its own capture-pane
        // fork, but it can still reuse the last live pane-scan's compaction
        // confirmation while it's fresh, so the dashboard doesn't keep
        // showing waiting for a session the 5s attention monitor (or
        // on-demand enrich of the viewed session) already knows is
        // mid-compaction.
        const expiresAt = this.claudeCompactingOverrides.get(session.id);
        if (expiresAt !== undefined && expiresAt > Date.now()) {
          state = "working";
          classifiedDetail = "State: working (claude compacting)";
        }
      } else if (scanPane && strategy === "hook") {
        // Codex-specific: a hard rate-limit banner always wins. Otherwise,
        // whenever the pane shows a live MCP tool-permission dialog (whether or
        // not a soft rate-limit signal is also present) the session is
        // promoted to needs_input.
        const paneText = await captureTmuxPane(session.tmuxSession);
        const hardHit = scanTmuxRateLimit(paneText);
        if (hardHit?.limited) {
          rateLimit = hardHit;
          this.codexMcpDialogOverrides.delete(session.id);
        } else if (detectCodexMcpPermissionDialog(paneText)) {
          state = "needs_input";
          rateLimit = null;
          this.codexMcpDialogOverrides.set(
            session.id,
            Date.now() + CODEX_MCP_DIALOG_OVERRIDE_TTL_MS,
          );
          classifiedDetail = "State: needs_input (codex MCP permission dialog)";
        } else {
          this.codexMcpDialogOverrides.delete(session.id);
        }
      } else if (!scanPane && strategy === "hook") {
        // The scanPane:false dashboard tick can't afford its own capture-pane
        // fork (see enrichDashboard), but it can still reuse the last live
        // pane-scan's dialog confirmation while it's fresh, so the dashboard
        // doesn't keep showing rate_limited (or working) for a session the 5s
        // attention monitor already knows is parked on a live MCP permission
        // dialog. The override can be live with no rate-limit signal at all
        // (the pane-scan branch above sets it independent of rateLimit), so
        // this reuse branch must not require rateLimit?.limited either, or it
        // misses that case on 2s ticks. The override-presence + expiry check
        // below is the real gate; this branch is just a cheap Map.get when
        // there's nothing to reuse.
        const expiresAt = this.codexMcpDialogOverrides.get(session.id);
        if (expiresAt !== undefined && expiresAt > Date.now()) {
          state = "needs_input";
          rateLimit = null;
          classifiedDetail = "State: needs_input (codex MCP permission dialog)";
        }
      } else if (scanPane && !rateLimit?.limited) {
        const paneText = await captureTmuxPane(session.tmuxSession);
        const tmuxHit = scanTmuxRateLimit(paneText);
        if (tmuxHit?.limited) {
          rateLimit = tmuxHit;
        }
      }
      if (rateLimit?.limited) {
        state = "rate_limited";
        classifiedDetail = `State: rate_limited (${rateLimit.reason})`;
      } else if (hasServerErrorRecord) {
        state = "error";
        stateSource = "jsonl";
        historySourcePath = serverErrorJsonlPath;
        classifiedDetail = "State: error (claude server error)";
      }
    }

    if (classifiedDetail === undefined) {
      this.lastClassifiedLogStates.delete(session.id);
    } else {
      if (this.lastClassifiedLogStates.get(session.id) !== state) {
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: classifiedDetail,
        });
      }
      this.lastClassifiedLogStates.set(session.id, state);
    }

    return {
      session: effectiveSession,
      runtime,
      state,
      source: stateSource,
      historySourcePath,
      // Only true when the override above actually applied: a rate_limit
      // record always wins state, so when that happens this reports false
      // and updateStateHistory's clear branch drops any stale serverErrorAt
      // instead of arming it — the two markers stay independently owned.
      serverError: state === "error" && hasServerErrorRecord,
      workspacePresent: workspace.exists,
      agentActivityAt,
      ...(liveModel ? { liveModel } : {}),
    };
  }

  private async enrichDashboard(session: SessionRecord): Promise<DashboardSessionView> {
    // The 2s dashboard-cache tick skips the per-session capture-pane scan (the
    // last un-batched fork): jsonl/hook-sourced rate limits still show up
    // immediately, and the 5s attention monitor (full enrich) plus on-demand
    // viewed-session enrich still run the tmux-banner/usage-menu scan.
    const classified = await this.classifySessionRecord(session, { scanPane: false });
    session = classified.session;
    const {
      queuedMessages: _queuedMessages,
      pipeline: _pipeline,
      sidecarNames: _sidecarNames,
      sidecarPorts: _sidecarPorts,
      ...dashboardSession
    } = session;
    const workspacePresent = classified.workspacePresent;
    const lastActivityAt = buildLastActivityAt(session, classified);
    const state = this.stabilizeState(session.id, classified.state);
    await this.updateStateHistory(
      session,
      state,
      classified.source,
      classified.historySourcePath ?? null,
      classified.serverError,
    );
    const displaySlots = deriveSessionSlots(resolveWorkspaceState(this.config.dataDir, session));
    // Same owner resolution as enrich's sidecars loop: without it, every
    // desk sibling would render the anchor-owned shared sidecar as offline
    // (it probes its own tmux id, which never has the pane). Still gated on
    // being a desk member with sidecars — a non-desk session always owns its
    // own panes, so this 2s-tick path skips even the cached lookup.
    const sidecarNames = session.sidecarNames ?? [];
    const deskProject =
      workspaceIdOf(session) !== session.id && sidecarNames.length > 0
        ? this.resolveProjectForSession(session)
        : undefined;
    const runningSidecarNames = (
      await Promise.all(
        sidecarNames.map(async (name) => {
          const ownerId = this.sidecarOwnerIdForName(session, deskProject, name);
          return (await sidecarTmuxAlive(ownerId, name)) ? name : null;
        }),
      )
    ).filter((name): name is string => name !== null);

    return {
      ...dashboardSession,
      // Always resolved for consumers, whatever shape the stored record is in.
      // `deskId` rides along as a compat alias so a browser tab still running
      // the previous bundle keeps grouping desks; drop it a release from now.
      workspaceId: workspaceIdOf(dashboardSession),
      deskId: workspaceIdOf(dashboardSession),
      planMode: resolvePlanMode(dashboardSession),
      restrictWrites: resolveRestrictWrites(dashboardSession),
      ...(displaySlots ? { slots: displaySlots } : {}),
      runtimeAlive: classified.runtime.runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      hasUnseenAttention: hasUnseenAttention(session, state, lastActivityAt),
      lastActivityAt,
      ...((await this.hasServiceIssues(session)) ? { hasServiceIssues: true } : {}),
      ...(runningSidecarNames.length > 0 ? { runningSidecarNames } : {}),
      ...(classified.liveModel ? { model: classified.liveModel } : {}),
    };
  }

  // Snapshot of authenticated claude accounts for SessionView.claudeAccounts.
  // Computed once per listSessions() batch and threaded into every enrich so a
  // batch of N claude sessions does one listAccounts read instead of N.
  private computeClaudeAccountsView(): { id: string; label?: string; authenticated: boolean }[] {
    return listAccounts(this.config.dataDir).map((account) => ({
      id: account.id,
      ...(account.label ? { label: account.label } : {}),
      authenticated: isAccountAuthenticated(account),
    }));
  }

  private async enrich(
    session: SessionRecord,
    claudeAccounts?: { id: string; label?: string; authenticated: boolean }[],
    sessionBatch?: SessionRecord[],
  ): Promise<SessionView> {
    const classified = await this.classifySessionRecord(session);
    session = classified.session;
    const workspacePresent = classified.workspacePresent;
    const lastActivityAt = buildLastActivityAt(session, classified);
    const state = this.stabilizeState(session.id, classified.state);
    const history = await this.updateStateHistory(
      session,
      state,
      classified.source,
      classified.historySourcePath ?? null,
      classified.serverError,
    );

    const services: ServiceInstanceView[] = [];
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      services.push(await this.enrichService(service));
    }

    const project = this.resolveProjectForSession(session);
    // Fetched at most once per enrich (zero extra IO for a non-desk session,
    // where deskAnchorRecord returns `session` itself unchanged): reused for
    // the sidecars' owner state (ports, still per-record) below. Passed into
    // resolveWorkspaceState for the shared slots/pr too, so a sibling doesn't
    // pay for a second read of the same anchor record when there's no
    // workspace file yet.
    const anchorRecord = this.deskAnchorRecord(session);
    const sidecarNamesForView = sessionSidecarNames(session, project);
    // One snapshot for the whole enrich pass, not one per sidecar — and only
    // taken at all when there is a sidecar to report an age for, so a
    // sidecar-less session's enrich never pays for a `ps` fork.
    const sidecarAgeSnapshot =
      sidecarNamesForView.length > 0 ? await snapshotProcesses() : null;
    const sidecars: SessionSidecarView[] = [];
    for (const name of sidecarNamesForView) {
      const sidecar = project?.sidecars[name];
      const ownerId = this.sidecarOwnerIdForName(session, project, name);
      const ownerRecord = ownerId === session.id ? session : anchorRecord;
      const identity = ownerRecord.sidecarProcs?.[name];
      const ageSeconds = identity
        ? sidecarAgeSnapshot?.byPid.get(identity.pid)?.etimes
        : undefined;
      sidecars.push({
        name,
        alive: await sidecarTmuxAlive(ownerId, name),
        ports: sidecarViewPorts(ownerRecord, name, sidecar),
        tmuxSession: sidecarTmuxSession(ownerId, name),
        ...(ageSeconds !== undefined ? { ageSeconds } : {}),
      });
    }
    const queuedMessagesView = displayQueuedMessages(session);
    const workspaceAccess = buildWorkspaceAccess(session, project, workspacePresent);
    const displaySlots = deriveSessionSlots(
      resolveWorkspaceState(this.config.dataDir, anchorRecord),
    );
    const deskGroupMembers = await this.buildDeskGroupMembers(
      session,
      {
        state,
        runtimeAlive: classified.runtime.runtimeAlive,
      },
      sessionBatch,
    );
    const resolvedClaudeAccounts =
      session.agent === "claude" ? (claudeAccounts ?? this.computeClaudeAccountsView()) : [];

    return {
      ...session,
      // See enrichDashboard: always resolved, with `deskId` as a compat alias
      // for a browser tab still running the previous bundle.
      workspaceId: workspaceIdOf(session),
      deskId: workspaceIdOf(session),
      planMode: resolvePlanMode(session),
      restrictWrites: resolveRestrictWrites(session),
      ...(displaySlots ? { slots: displaySlots } : {}),
      runtimeAlive: classified.runtime.runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      ...(history.length > 0 ? { stateHistory: history } : {}),
      hasUnseenAttention: hasUnseenAttention(session, state, lastActivityAt),
      lastActivityAt,
      artifacts: listSessionArtifacts(this.config.dataDir, workspaceIdOf(session)),
      services,
      sidecars,
      ...(workspaceAccess ? { workspaceAccess } : {}),
      ...(queuedMessagesView ? { queuedMessages: queuedMessagesView } : {}),
      ...(deskGroupMembers.length > 1 ? { deskGroupMembers } : {}),
      ...(resolvedClaudeAccounts.length > 0 ? { claudeAccounts: resolvedClaudeAccounts } : {}),
      ...(session.claudeAccountId ? { activeClaudeAccountId: session.claudeAccountId } : {}),
      ...(classified.liveModel ? { model: classified.liveModel } : {}),
    };
  }

  private async classifySessionState(session: SessionRecord): Promise<SessionState> {
    return (await this.classifySessionRecord(session)).state;
  }
}

function hasMessageContent(request: SendMessageRequest): boolean {
  return (
    (typeof request.message === "string" && request.message.trim().length > 0) ||
    (Array.isArray(request.attachments) && request.attachments.length > 0)
  );
}
