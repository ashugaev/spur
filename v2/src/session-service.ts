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
  setupAgentHooks,
  type SubmitAckBinding,
  type SubmitAckScanResult,
} from "./agents/index.js";
import { shellEscape } from "./agents/shell-escape.js";
import {
  PLAYWRIGHT_SIDECAR_NAME,
  SPUR_RESERVED_PORT_PLAYWRIGHT,
  buildPlaywrightSidecarConfig,
  sweepLeakedPlaywright,
  waitForPlaywrightReady,
} from "./agents/playwright-mcp.js";
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
} from "./agents/claude.js";
import { extractGithubErrorText, isGitHubRateLimitError } from "./gh.js";
import {
  codexHookHomePath,
  findLatestCodexSessionFile,
  readCodexRolloutState,
  type CodexRolloutStateRecord,
} from "./agents/codex.js";
import { DEFAULT_CURSOR_MODEL, cursorConfigDirForSession } from "./agents/cursor.js";
import { resolveCursorLaunchModel } from "./agents/models.js";
import {
  claudeUsageMenuOptionOneSelected,
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
  findAccount,
  isAccountAuthenticated,
  listAccounts,
  removeAccount,
  touchAccountUsed,
  type ClaudeAccount,
} from "./claude-accounts.js";
import {
  buildSidecarLinkUrl,
  deriveProjectIdFromDisplayName,
  expandHome,
  findProjectConfigPath,
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
import { renderSpawnPrompt } from "./prompt-template.js";
import {
  logSpurEvent,
  logUserInputEvent,
  type SpurLogEntry,
  type UserInputKind,
} from "./event-log.js";
import { deleteSessionUserActions } from "./user-action-log.js";
import { reserveNextSessionId } from "./ids.js";
import { clearPortListener, isHostPortFree } from "./port-probe.js";
import { sendDesktopNotification } from "./desktop-notify.js";
import {
  closeTelegramTopic,
  editTelegramTopic,
  sendTelegramReply,
} from "./telegram-source-state.js";
import {
  claimAvailableBacklogItem,
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
  getTmuxSessionActivity,
  getTmuxPanePid,
  isProcessRunningInTmux,
  killSidecarTmux,
  killTmuxSession,
  listTmuxSessionNames,
  sendSubmitKeyToTmux,
  setTmuxSocketName,
  sendMessageToTmux,
  tmuxPaneDead,
  tmuxSessionExists,
  waitForTmuxReady,
} from "./runtime-tmux.js";
import {
  AGENT_STATE_TOOL_NAME,
  SLOT_TOOL_NAME,
  applySlotsUpdate,
  ensureSessionSlotTool,
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
  closeSessionPr,
  deriveSessionSlots,
  discoverSessionPrBinding,
  parseSessionPrBinding,
  resolvePrDiscoveryBranch,
  resolveSessionPrBinding,
  viewSessionPrState,
} from "./session-pr.js";
import {
  addUnconfiguredProject,
  buildMergedConfig,
  mutateConfigRegistry,
  readConfigRegistryFile,
  removeUnconfiguredProject,
  upsertConfigRegistryPath,
  type UnconfiguredProjectEntry,
} from "./registry.js";
import { normalizeDailyWakeTimes, resolveNextDailyWakeAt } from "./wake-schedule.js";
import {
  SPUR_DAEMON_API_VERSION,
  SESSION_STATES,
  type AgentName,
  type AgentSuggestionsResponse,
  type AppConfig,
  type AvailableBacklogItem,
  type BranchExistsResponse,
  type BranchSource,
  type CompleteDeskResponse,
  type CompleteSessionRequest,
  type ConversationResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DashboardSessionView,
  type DeleteProjectResponse,
  type KillSessionRequest,
  type GithubPrCheckUnavailablePayload,
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
  type SidecarPortConfig,
  type SidecarPortConflictCandidate,
  type SidecarPortConflictPayload,
  type SourceReplyRequest,
  type SourceReplyResponse,
  type SidecarPortView,
  type SessionMemoryListResponse,
  type SessionMemoryRecordResponse,
  type StartSidecarRequest,
  type SessionRecord,
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
  type TakeBacklogItemRequest,
  type TakeBacklogItemResponse,
  type TagDefinition,
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
  branchStatus,
  createWorktree,
  findWorktreePathForBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  isGitWorktree,
  readCurrentBranch,
  removeWorktree,
  resolveRepoPathFromWorktree,
  workspaceExists,
  probeWorkspace,
} from "./workspace.js";
import { orderedReviewProviderIds, reviewProvider } from "./review-providers/index.js";
import { version } from "./version.js";

const KILL_CONFIRMATION_REQUIRED_PREFIX = "Kill confirmation required";
const RATE_LIMIT_REACTIVATION_PROMPT =
  "You were rate limited earlier and should be able to continue now. Please resume the task you were working on and pick up from where you left off.";
const PIPELINE_POLL_INTERVAL_MS = 1_000;
const SCHEDULED_WAKE_POLL_INTERVAL_MS = 1_000;
const SIDECAR_REAPER_INTERVAL_MS = 60_000;
const PIPELINE_STEP_DELAY_MS = 30_000;
const MESSAGE_READY_GRACE_MS = 15_000;
const STATE_HOLD_MS = 4_000;
// Codex turns that hang after their tool calls complete (model inference dies between/after tools)
// pin state to "working" forever. The rollout JSONL emits no deterministic mid-inference liveness
// signal: token_count event_msg lines fire only at response-step (tool-batch) boundaries, never
// incrementally within a single response, so a hung inference produces no new records at all. tmux
// activity is rejected as a corroborating signal because codex's TUI repaints a per-second
// "Working (… • esc to interrupt)" timer, advancing #{session_activity} every second even while the
// turn is genuinely hung — it would mask exactly this bug. Pending tool calls are excluded (a long
// exec_command is legitimately silent), so this threshold only needs to exceed the longest plausible
// single model inference between tool batches (large context + high reasoning, observed ~tens of
// seconds). A false flip is low-cost but not free: the working->waiting edge lets a queued
// interrupt:false message be typed in after a further idle gate, so we set the threshold well above
// any realistic single inference. 300s makes a false flip on a live inference highly unlikely while
// still clearing an indefinite-"working" hang.
const CODEX_HUNG_AFTER_TOOLS_MS = 300_000;
const RESTORE_WARMUP_MS = 30_000;
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
const ATTENTION_POLL_INTERVAL_MS = 5_000;
const DASHBOARD_CACHE_INTERVAL_MS = 2_000;
// Must outlast the gap between attention-monitor sweeps (ATTENTION_POLL_INTERVAL_MS)
// with buffer for scheduling jitter, so the scanPane:false dashboard tick keeps
// showing the corrected needs_input state between live pane scans instead of
// reverting to rate_limited every cycle.
const CODEX_MCP_DIALOG_OVERRIDE_TTL_MS = 15_000;
const PR_CHECK_THROTTLE_MS = 30_000;
const WORKTREE_PATH_TOKEN = "$" + "{worktreePath}";
const WORKTREE_PATH_SHELL_TOKEN = "$" + "{worktreePathShell}";
const WORKTREE_PATH_URL_TOKEN = "$" + "{worktreePathUrl}";
const PR_CHECK_WAITING_LIMIT = 5;
const DEFAULT_WAKE_MESSAGE = "Scheduled wake-up. Review current state and continue orchestration.";
const DEFAULT_INTERVAL_WAKE_MESSAGE = "Scheduled interval wake-up. Review current state.";
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
}

export class SessionResourceNotFoundError extends Error {
  readonly statusCode = 404;
}

export class BacklogItemUnavailableError extends Error {
  readonly statusCode = 409;
}

const DEFAULT_BACKLOG_PROMPT = "Work on {{key}}: {{title}}\n\n{{url}}";

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
interface SessionCleanupContext {
  repoPath: string;
  symlinks: string[];
}
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
}

function cleanupIgnoredPaths(session: Pick<SessionRecord, "agent">, symlinks: string[]): string[] {
  if (session.agent !== "cursor") {
    return symlinks;
  }
  return [...symlinks, ".cursor/.workspace-trusted"];
}

function isTerminalSessionStatus(status: SessionStatus): status is "completed" | "killed" {
  return status === "completed" || status === "killed";
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

function stateTransitionArtifactId(
  at: string,
  fromState: SessionState,
  toState: SessionState,
): string {
  const safeTimestamp = at.replaceAll(":", "-").replaceAll(".", "-");
  return `agent-history-${safeTimestamp}-${fromState}-to-${toState}.jsonl`;
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
  playwrightPort?: number;
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
    ...(args.playwrightPort !== undefined ? { playwrightPort: args.playwrightPort } : {}),
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
  },
  modes: { planMode: boolean; restrictWrites: boolean },
): {
  claudeSettingsPath?: string;
  codexHomePath?: string;
  cursorConfigDir?: string;
  codexArgs?: string[];
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
  project: Pick<ProjectConfig, "codexArgs">,
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
} {
  return project.codexArgs ? { ...options, codexArgs: project.codexArgs } : options;
}

function createRuntimeInfo(config: AppConfig, startedAt: string): RuntimeInfo {
  return {
    ok: true,
    apiVersion: SPUR_DAEMON_API_VERSION,
    version,
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
    withSessionArtifactInstructions(withSessionSlotInstructions(initialMessage, tags)),
    selfDestruct,
  );
  if (branchNamingRegex) {
    base = `${base}\n\nBranch naming:\n- Current project requires branch names to match \`${branchNamingRegex}\`.\n- Use \`spur-branch create <name>\` or \`spur-branch rename <name>\`; it rejects invalid names. \`git push\` is blocked when the current branch does not match.`;
  }
  if (sidecarNames.length === 0) return base;
  const names = sidecarNames.map((n) => `\`${n}\``).join(", ");
  return `${base}\n\nSidecars: use Sidecar for testing by default. Run \`"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>\` to start one, or \`"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>\` to stop one. Do not start app, dev server, or test helper processes directly with \`pnpm\`, \`next\`, or similar commands unless the user explicitly tells you to bypass Sidecar. Auto-start applies only when the main session spawns. From inside a sidecar, nested sidecars are manual-only and stop after one more level. See \`v2/README.md\` for sidecar usage. Available: ${names}.`;
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
// store. Back-compat: when the session has no bound account (or it was removed),
// returns {} so claude launches byte-identical to today. Non-claude agents
// always return {}.
export function resolveClaudeAuthPlanOptions(
  dataDir: string,
  session: Pick<SessionRecord, "agent" | "claudeAccountId">,
): { claudeConfigDir?: string } {
  if (session.agent !== "claude" || !session.claudeAccountId) {
    return {};
  }
  const account = findAccount(dataDir, session.claudeAccountId);
  if (!account) {
    return {};
  }
  return { claudeConfigDir: account.configDir };
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
    SPUR_SESSION_ARTIFACTS_DIR: ensureSessionArtifactsDir(args.dataDir, args.sessionId),
    SPUR_SLOT_COMMAND: join(args.sessionToolDir, SLOT_TOOL_NAME),
    SPUR_AGENT_STATE_COMMAND: join(args.sessionToolDir, AGENT_STATE_TOOL_NAME),
    SPUR_AGENT_STATE_FILE: join(args.dataDir, "session-agent-state", `${args.sessionId}.json`),
    // Real HOME from /etc/passwd, unaffected by sandboxes that remap $HOME to a scratch dir.
    // Sidecars that need `~/.nvm`, `~/.bashrc`, etc. should source "$SPUR_REAL_HOME/..." instead of "$HOME/...".
    SPUR_REAL_HOME: userInfo().homedir,
    PATH: `${args.sessionToolDir}:${process.env["PATH"] ?? ""}`,
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

function agentUsesPlaywrightSidecar(agent: AgentName): boolean {
  return agent === "claude" || agent === "codex";
}

// Built-in implicit playwright sidecar config for claude/codex sessions. Built
// per session so the marker env carries the concrete session id. Cursor is out
// of scope.
function sessionPlaywrightSidecar(
  session: Pick<SessionRecord, "agent" | "id">,
): SidecarConfig | undefined {
  if (!agentUsesPlaywrightSidecar(session.agent)) {
    return undefined;
  }
  return buildPlaywrightSidecarConfig(session.id);
}

function sessionSidecarNames(
  session: Pick<SessionRecord, "sidecarNames" | "agent">,
  project?: Pick<ProjectConfig, "sidecars">,
): string[] {
  const names = session.sidecarNames ?? Object.keys(project?.sidecars ?? {});
  // Belt-and-suspenders: ensure teardown enumerates "playwright" for claude/codex
  // even if a persisted record predates startSidecarInternal persisting it.
  if (agentUsesPlaywrightSidecar(session.agent) && !names.includes(PLAYWRIGHT_SIDECAR_NAME)) {
    return [...names, PLAYWRIGHT_SIDECAR_NAME];
  }
  return names;
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

function buildLastActivityAt(
  session: Pick<SessionRecord, "updatedAt">,
  runtime: Pick<SessionRuntimeSnapshot, "tmuxActivityAt">,
): string {
  const updatedAt = new Date(session.updatedAt);
  return (latestActivityAt(updatedAt, runtime.tmuxActivityAt) ?? updatedAt).toISOString();
}

function copySessionWithoutSidecarPorts(session: SessionRecord): SessionRecord {
  const updated: SessionRecord = { ...session };
  delete updated.sidecarPorts;
  return updated;
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

// A model only ever applies to the agent it belongs to. An explicit request
// model wins; otherwise the project defaultModels entry for the resolved agent
// applies. The map is keyed by agent, so it never bleeds onto another agent.
export function resolveSpawnModel(args: {
  requestModel: string | undefined;
  resolvedAgent: AgentName;
  project: ProjectConfig;
}): string | undefined {
  return (
    args.requestModel ??
    args.project.defaultModels?.[args.resolvedAgent] ??
    (args.resolvedAgent === "cursor" ? DEFAULT_CURSOR_MODEL : undefined)
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
  private readonly deliveryRuns = new Map<string, Promise<void>>();
  private readonly attentionStates = new Map<string, AttentionState>();
  private readonly lastObservedRunStates = new Map<string, SessionState>();
  // Last live (scanPane:true) pane-scan confirmation of an active codex MCP
  // permission dialog, keyed by session id, value = expiry epoch ms. Lets the
  // scanPane:false dashboard tick apply the same needs_input demotion without
  // forking a capture-pane (the tick's whole reason for existing).
  private readonly codexMcpDialogOverrides = new Map<string, number>();
  private attentionMonitorTimer: NodeJS.Timeout | null = null;
  private attentionMonitorRunning = false;
  private dashboardCache: Map<string, DashboardSessionView> = new Map();
  private dashboardCacheTimer: NodeJS.Timeout | null = null;
  private dashboardLoopRunning: boolean = false;
  private dashboardCacheReady: Promise<void> | null = null;
  private scheduledWakeTimer: NodeJS.Timeout | null = null;
  private scheduledWakeMonitorRunning = false;
  private sidecarReaperTimer: NodeJS.Timeout | null = null;
  private sidecarReaperRunning = false;
  private readonly stateCache = new Map<string, { state: SessionState; classifiedAt: number }>();
  private readonly restoreWarmupUntil = new Map<string, number>();
  // Session ids this process is actively spawning. A spawning session tracked
  // here still has its spawn pipeline running (worktree/tools/tmux setup), so
  // its dead runtime is expected and must not be reconciled to stopped.
  private readonly spawnsInFlight = new Set<string>();
  private readonly backgroundSpawnRuns = new Set<Promise<void>>();
  private readonly claudeJsonlReaders = new Map<string, ClaudeJsonlReaderState>();
  private readonly usageMenuConfirmedAt = new Map<string, number>();
  private readonly cursorJsonlReaders = new Map<string, CursorJsonlReaderState>();
  private readonly stateHistory = new Map<string, SessionStateTransition[]>();
  private readonly stateSubscriptionIndex = new Map<string, Set<string>>();
  private stateSubscriptionIndexReady = false;
  private stateSubscriptionDispatchDepth = 0;
  private readonly prCheckTrackers = new Map<string, PrCheckTracker>();
  // Auto-rotation bookkeeping: accountId -> epoch ms until which the account is
  // considered rate-limited; sessionId -> per-episode rotation count.
  private readonly claudeAccountRateLimit = new Map<string, number>();
  private readonly claudeRotationEpisode = new Map<string, { episode: string; count: number }>();
  private sidecarPortLock: Promise<void> = Promise.resolve();
  private readonly sidecarUrlProbeControllers = new Map<string, AbortController>();

  constructor(configPath?: string, startedAt = nowIso()) {
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
    const merged = buildMergedConfig(this.bootstrapConfigPath, this.registryPaths, {
      skipInvalid: true,
      warn: (message) => {
        logSpurEvent(bootstrap.config.dataDir, {
          event: "daemon.registry.warning",
          level: "warn",
          message,
        });
      },
    });
    this.config = bootstrap.config;
    this.applyConfig(merged.config, merged.configPaths);
    this.startAttentionMonitor();
    this.startScheduledWakeMonitor();
    this.startSidecarReaper();
    this.dashboardCacheReady = this.runDashboardCacheTick();
    this.startDashboardCacheLoop();
  }

  /** Resolves once every in-flight background spawn has settled. Lets teardown drain async spawn work. */
  async settleBackgroundSpawns(): Promise<void> {
    await Promise.allSettled([...this.backgroundSpawnRuns]);
  }

  dispose(): void {
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

  // Periodic sweep for playwright sidecar tmux sessions whose owning session
  // record is gone or terminal. Keyed on tmux ownership (not process ppid)
  // so a transient empty listSessions read can never reap a live sidecar.
  // Guarded against re-entrancy: a slow pass (large tmux fleet) must not
  // overlap the next interval tick.
  private async reapDeadSessionSidecars(): Promise<void> {
    if (this.sidecarReaperRunning) {
      return;
    }
    this.sidecarReaperRunning = true;
    try {
      const suffix = `--${PLAYWRIGHT_SIDECAR_NAME}`;
      const liveSessions = listSessions(this.config.dataDir).filter(
        (session) => session.status === "running" || session.status === "spawning",
      );
      // Protect every sidecar tmux name a live session is entitled to (agent
      // playwright sidecar plus any project-declared user sidecar), and also
      // the raw `${id}--` prefix as a belt-and-suspenders guard against
      // config drift where a live session's sidecar name isn't enumerated by
      // sessionSidecarNames.
      const protectedTmux = new Set<string>();
      const liveIdPrefixes = new Set<string>();
      for (const session of liveSessions) {
        liveIdPrefixes.add(`${session.id}--`);
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

      const names = await listTmuxSessionNames();
      for (const name of names) {
        if (!name.endsWith(suffix)) {
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
        const sessionId = name.slice(0, -suffix.length);
        await killSidecarTmux(sessionId, PLAYWRIGHT_SIDECAR_NAME).catch(() => {});
      }
      await this.sweepLeakedPlaywrightProcesses("reaper");
    } finally {
      this.sidecarReaperRunning = false;
    }
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
          try {
            await this.send(session.id, { message: scheduledWake.message });
            const current = readSession(this.config.dataDir, session.id) ?? session;
            if (
              current.scheduledWake?.dueAt === scheduledWake.dueAt &&
              current.scheduledWake.message === scheduledWake.message
            ) {
              const { scheduledWake: _scheduledWake, ...base } = current;
              const cleared: SessionRecord = { ...base, updatedAt: nowIso() };
              writeSession(this.config.dataDir, cleared);
            }
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
        // relaunches the session and suppresses the afterHours nudge below.
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

        const dailyWake = session.dailyWake;
        if (!dailyWake || Date.parse(dailyWake.nextDueAt) > now) {
          continue;
        }
        try {
          await this.send(session.id, {
            message: this.formatDailyWakeMessage(
              session.id,
              dailyWake.message,
              dailyWake.stopCondition,
            ),
          });
          const current = readSession(this.config.dataDir, session.id) ?? session;
          if (
            current.dailyWake?.nextDueAt === dailyWake.nextDueAt &&
            current.dailyWake.dailyAt.join(",") === dailyWake.dailyAt.join(",") &&
            current.dailyWake.message === dailyWake.message &&
            current.dailyWake.stopCondition === dailyWake.stopCondition
          ) {
            const nextDueAt = resolveNextDailyWakeAt(dailyWake.dailyAt, new Date(now));
            const updated: SessionRecord = {
              ...current,
              dailyWake: {
                ...dailyWake,
                nextDueAt: nextDueAt.toISOString(),
              },
              updatedAt: nowIso(),
            };
            writeSession(this.config.dataDir, updated);
          }
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
    } finally {
      this.scheduledWakeMonitorRunning = false;
    }
  }

  previewConfigConnect(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
    unconfiguredToRemove: string[];
  } {
    return this.previewRegistryPaths(
      this.registryPaths.includes(configPath)
        ? this.registryPaths
        : [...this.registryPaths, configPath],
    );
  }

  previewConfigDisconnect(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
    unconfiguredToRemove: string[];
  } {
    return this.previewRegistryPaths(this.registryPaths.filter((path) => path !== configPath));
  }

  private previewRegistryPaths(nextRegistryPaths: string[]): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
    unconfiguredToRemove: string[];
  } {
    const warnings: string[] = [];
    const merged = buildMergedConfig(this.bootstrapConfigPath, nextRegistryPaths, {
      skipInvalid: true,
      warn: (message) => warnings.push(message),
    });
    const currentSignature = JSON.stringify(this.config.projects);
    const nextSignature = JSON.stringify(merged.config.projects);
    const unconfiguredIds = new Set(this.listUnconfiguredProjects().map((entry) => entry.id));
    const unconfiguredToRemove = Object.keys(merged.config.projects).filter((id) =>
      unconfiguredIds.has(id),
    );
    return {
      config: merged.config,
      registryPaths: merged.configPaths,
      warnings,
      changed:
        currentSignature !== nextSignature ||
        merged.configPaths.length !== this.registryPaths.length ||
        merged.configPaths.some((path, index) => path !== this.registryPaths[index]) ||
        unconfiguredToRemove.length > 0,
      unconfiguredToRemove,
    };
  }

  applyConfig(
    config: AppConfig,
    registryPaths: string[],
    options: { unconfiguredToRemove?: string[] } = {},
  ): void {
    this.config = config;
    this.registryPaths = [...new Set(registryPaths)];
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

  // Resolve the CLAUDE_CONFIG_DIR for a claude session from the account store.
  // Back-compat: when the session has no bound account, returns {} so claude
  // launches byte-identical to today. Non-claude agents always return {}.
  private resolveClaudeAuthPlanOptions(session: Pick<SessionRecord, "agent" | "claudeAccountId">): {
    claudeConfigDir?: string;
  } {
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
      await this.pollAttentionStates(baseline);
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
      const claudeAccounts = this.computeClaudeAccountsView();
      for (const session of sessions) {
        const view = await this.enrich(session, claudeAccounts);
        this.checkPrForSession(session, view.state);
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
      }
      this.attentionStates.clear();
      for (const [sessionId, attention] of nextStates) {
        this.attentionStates.set(sessionId, attention);
      }
      this.lastObservedRunStates.clear();
      for (const [sessionId, runState] of nextRunStates) {
        this.lastObservedRunStates.set(sessionId, runState);
      }
      const liveIds = new Set(sessions.map((session) => session.id));
      for (const sessionId of this.codexMcpDialogOverrides.keys()) {
        if (!liveIds.has(sessionId)) {
          this.codexMcpDialogOverrides.delete(sessionId);
        }
      }
    } finally {
      this.attentionMonitorRunning = false;
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
      const liveIds = new Set(sessions.map((session) => session.id));
      const enriched = await Promise.all(sessions.map((session) => this.enrichDashboard(session)));
      for (const view of enriched) {
        this.dashboardCache.set(view.id, view);
      }
      for (const id of this.dashboardCache.keys()) {
        if (!liveIds.has(id)) {
          this.dashboardCache.delete(id);
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

  private checkPrForSession(session: SessionRecord, state: SessionState): void {
    if (session.pr) {
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

    // Throttle between gh calls
    if (Date.now() - tracker.lastCheckAt < PR_CHECK_THROTTLE_MS) {
      return;
    }

    tracker.lastCheckAt = Date.now();
    if (state === "waiting") {
      tracker.waitingChecks += 1;
    }

    // Fire and forget
    void this.runPrCheck(session).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.pr_auto_detect.failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `PR auto-detect failed for ${session.id}: ${message}`,
      });
    });
  }

  private async runPrCheck(session: SessionRecord): Promise<void> {
    const binding = await discoverSessionPrBinding(session.worktreePath, session.branch);
    if (binding) {
      const tracker = this.prCheckTrackers.get(session.id);
      if (tracker) {
        tracker.found = true;
      }

      const current = readSession(this.config.dataDir, session.id);
      if (!current?.worktreePath || current.pr) {
        return;
      }

      const updated: SessionRecord = {
        ...current,
        pr: binding,
      };
      writeSession(this.config.dataDir, updated);
      this.logEvent("session.pr_auto_detect.found", {
        level: "info",
        sessionId: session.id,
        projectId: session.project,
        message: `Auto-detected PR for ${session.id}: ${binding.url}`,
      });
      return;
    }

    const project = this.config.projects[session.project];
    const discoveryBranch = await resolvePrDiscoveryBranch(session.worktreePath, session.branch);
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
    const current = readSession(this.config.dataDir, session.id);
    if (!current?.worktreePath || current.pr) {
      return;
    }

    const slots = applySlotsUpdate(current.slots, {
      links: [{ label: "pr", url: reviewUrl }],
    });
    const updated: SessionRecord = { ...current, ...(slots ? { slots } : {}) };
    writeSession(this.config.dataDir, updated);
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
    const projectConfigPath = session.worktreePath
      ? findProjectConfigPath(session.worktreePath)
      : undefined;
    if (!projectConfigPath) {
      return daemonProject;
    }

    try {
      const localProject = loadProjectConfig(projectConfigPath, this.config).projects[
        session.project
      ];
      if (localProject) {
        return localProject;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.project_config.local.failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Failed to load local project config for ${session.id}: ${message}`,
      });
    }

    return daemonProject;
  }

  private findProjectByRepoPath(repoPath: string): ProjectConfig | undefined {
    const resolvedRepoPath = tryRealpath(repoPath);
    return Object.values(this.config.projects).find(
      (project) => tryRealpath(project.path) === resolvedRepoPath,
    );
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
    for (const liveSession of listSessions(this.config.dataDir)) {
      if (isTerminalSessionStatus(liveSession.status)) {
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
          await killTmuxSession(
            sidecarTmuxSession(plan.crossSession.sessionId, plan.crossSession.sidecarName),
          );
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
      if (await sidecarTmuxAlive(args.session.id, args.sidecarName)) {
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
          command: args.sidecar.command,
          env: buildSidecarRuntimeEnv(
            sessionEnv,
            reservedSession,
            args.sidecarName,
            args.sidecar.env,
            args.sidecarDepth,
          ),
        });
        await verifySidecarStartup(reservedSession.id, args.sidecarName);

        const sidecarNames = sessionSidecarNames(reservedSession, args.project);
        const updated: SessionRecord = {
          ...reservedSession,
          updatedAt: nowIso(),
          ...(sidecarNames.includes(args.sidecarName)
            ? {}
            : { sidecarNames: [...sidecarNames, args.sidecarName] }),
        };
        writeSession(this.config.dataDir, updated);
        this.scheduleSidecarUrlReadyAndPublish(
          reservedSession.id,
          args.sidecarName,
          args.sidecar,
          updated,
        );
        return readSession(this.config.dataDir, updated.id) ?? updated;
      } catch (error) {
        await killSidecarTmux(reservedSession.id, args.sidecarName).catch(() => {});
        const baseRecord =
          reservedSession !== args.session
            ? args.session
            : (readSession(this.config.dataDir, args.session.id) ?? args.session);
        const nextRecord = this.withUnlinkedSidecarSlot(baseRecord, args.sidecarName);
        if (reservedSession !== args.session || nextRecord !== baseRecord) {
          writeSession(this.config.dataDir, {
            ...nextRecord,
            updatedAt: nowIso(),
          });
        }
        throw error;
      }
    });
  }

  // Start the Spur-owned playwright MCP sidecar (claude/codex only). Reserves a
  // loopback port, launches the tracked tmux sidecar (idempotent), best-effort
  // waits for readiness, and returns the reserved port for agent config plus the
  // session record carrying the reserved sidecar fields. Logs and returns the
  // input session with no port on failure so spawn continues without it.
  private async startPlaywrightSidecar(
    session: SessionRecord,
    project: ProjectConfig,
  ): Promise<{ session: SessionRecord; port?: number }> {
    const sidecar = sessionPlaywrightSidecar(session);
    if (!sidecar) {
      return { session };
    }
    let updated: SessionRecord;
    try {
      updated = await this.startSidecarInternal({
        session,
        project,
        sidecarName: PLAYWRIGHT_SIDECAR_NAME,
        sidecar,
        sidecarDepth: ROOT_SIDECAR_DEPTH,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.sidecar.autostart.failed", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Auto-start sidecar ${PLAYWRIGHT_SIDECAR_NAME} failed for ${session.id}: ${message}`,
      });
      return { session };
    }
    const port = updated.sidecarPorts?.[PLAYWRIGHT_SIDECAR_NAME]?.[SPUR_RESERVED_PORT_PLAYWRIGHT];
    if (typeof port !== "number") {
      return { session: updated };
    }
    const ready = await waitForPlaywrightReady(port);
    if (!ready) {
      this.logEvent("session.sidecar.playwright_not_ready", {
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Playwright MCP not ready on port ${port} for ${session.id}; continuing`,
        details: { port },
      });
    }
    return { session: updated, port };
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
    return !record.slots?.links.some(
      (slotLink) => slotLink.label === sidecarName && slotLink.url === link.linkUrl,
    );
  }

  private withUnlinkedSidecarSlot(record: SessionRecord, sidecarName: string): SessionRecord {
    if (!record.slots?.links.some((link) => link.label === sidecarName)) {
      return record;
    }
    const nextSlots = applySlotsUpdate(record.slots, { unlinkLabels: [sidecarName] });
    return nextSlots !== record.slots ? withSessionSlots(record, nextSlots) : record;
  }

  private writeSessionWithUnlinkedSidecarSlot(
    sessionId: string,
    sidecarName: string,
  ): SessionRecord | undefined {
    const latest = readSession(this.config.dataDir, sessionId);
    if (!latest) return undefined;
    if (isTerminalSessionStatus(latest.status)) return latest;
    const nextRecord = this.withUnlinkedSidecarSlot(latest, sidecarName);
    if (nextRecord !== latest) {
      writeSession(this.config.dataDir, { ...nextRecord, updatedAt: nowIso() });
    }
    return nextRecord;
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

      const wasAlive = await sidecarTmuxAlive(currentSession.id, sidecarName);
      const updated = await this.startSidecarInternal({
        session: currentSession,
        project: args.project,
        sidecarName,
        sidecar,
        sidecarDepth: args.sidecarDepth,
        ...(clearPort !== undefined ? { clearPort } : {}),
      });
      currentSession = updated;
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
    const slots = applySlotsUpdate(latest.slots, {
      links: [{ label: sidecarName, url: linkUrl }],
      unlinkLabels: [],
    });
    const updated = withSessionSlots(latest, slots);
    writeSession(this.config.dataDir, updated);
    this.logEvent("session.sidecar.link.published", {
      level: "info",
      sessionId,
      projectId: latest.project,
      message: `Published sidecar link ${sidecarName} for ${sessionId}`,
      details: { sidecarName, url: linkUrl, reservedPort },
    });
  }

  private async resolveCleanupContext(session: SessionRecord): Promise<SessionCleanupContext> {
    const currentProject = this.config.projects[session.project];
    if (currentProject) {
      return {
        repoPath: currentProject.path,
        symlinks: cleanupIgnoredPaths(session, currentProject.symlinks),
      };
    }
    if (!session.worktree || !session.worktreePath) {
      throw new Error(`Unknown project: ${session.project}`);
    }
    const repoPath = await resolveRepoPathFromWorktree(session.worktreePath);
    if (!repoPath) {
      throw new Error(
        `Cannot resolve repository root for ${session.id} after project rename: ${session.worktreePath}`,
      );
    }
    return {
      repoPath,
      symlinks: cleanupIgnoredPaths(session, this.findProjectByRepoPath(repoPath)?.symlinks ?? []),
    };
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
    const sessions = listSessions(this.config.dataDir).filter((session) => {
      if (session.status === "completed") {
        return options?.includeCompleted === true || session.retainInList === true;
      }
      return session.status !== "killed" || session.retainInList === true;
    });
    // Compute the claude accounts snapshot once for the whole batch instead of
    // per-session inside enrich (N listAccounts reads + N×M existsSync).
    const claudeAccounts = this.computeClaudeAccountsView();
    const views = await Promise.all(
      sessions.map((session) => this.enrich(session, claudeAccounts)),
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

  async takeAvailableBacklog(request: TakeBacklogItemRequest): Promise<TakeBacklogItemResponse> {
    const project = this.config.projects[request.projectId];
    const binding = project?.backlog[request.backlogId];
    if (!project || !binding) {
      throw new BacklogItemUnavailableError("Backlog item is unavailable");
    }

    const item = claimAvailableBacklogItem(
      this.config.dataDir,
      request.projectId,
      request.backlogId,
      request.externalId,
    );
    if (!item) {
      throw new BacklogItemUnavailableError("Backlog item is unavailable");
    }

    const prompt = renderSpawnPrompt(binding.spawn?.prompt ?? DEFAULT_BACKLOG_PROMPT, {
      key: item.key,
      title: item.title,
      url: item.url,
      provider: item.provider,
      backlogId: request.backlogId,
    });
    const session = await this.spawnInBackground({
      project: request.projectId,
      prompt,
      ...(binding.spawn?.agent ? { agent: binding.spawn.agent } : {}),
      slots: {
        links: [{ label: "tracker", url: item.url }],
      },
    });
    return { item, session };
  }

  listStateSubscriptions(subscriberId: string): SessionStateSubscriptionListResponse {
    const subscriber = this.requireSession(subscriberId);
    return { records: subscriber.stateSubscriptions ?? [] };
  }

  subscribeToSessionStates(
    subscriberId: string,
    request: SubscribeSessionStatesRequest,
  ): SessionStateSubscriptionRecordResponse {
    const subscriber = this.requireSession(subscriberId);
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
    const now = nowIso();
    const id = stateSubscriptionId(targetSessionId);
    const existing = subscriber.stateSubscriptions ?? [];
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

  async markOpened(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new SessionResourceNotFoundError(`Session not found: ${sessionId}`);
    }

    await this.enrich(session);
    const latest = readSession(this.config.dataDir, sessionId) ?? session;
    const lastOpenedAt = nowIso();
    const updated: SessionRecord = { ...latest, lastOpenedAt };
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
    const artifact = readSessionArtifact(this.config.dataDir, sessionId, artifactId);
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
      durationMs,
      state: statusFallbackState(session),
    };
    if (session.agent !== "claude") return fallback;
    const result = await readClaudeConversation(session.worktreePath);
    return result ? { ...result, durationMs } : fallback;
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
    for (const [name, sidecar] of Object.entries(project.sidecars)) {
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
                tmuxSession: sidecarTmuxSession(session.id, startedName),
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
    for (const { id, project } of drifted) {
      const projectConfig = this.config.projects[project];
      if (projectConfig?.restoreAfterReboot !== true) continue;
      try {
        await this.restore(id);
        const record = readSession(this.config.dataDir, id);
        if (record) {
          await this.startAutoStartSidecars(record, projectConfig);
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

    await this.sweepLeakedPlaywrightProcesses("boot");

    return { scanned: candidates.length, alive, drifted, driftedSessions };
  }

  // Reap orphaned Spur-owned playwright MCP servers (reparented to init, our bin,
  // port not reserved by any live session). Best-effort; logs the killed count.
  private async sweepLeakedPlaywrightProcesses(context: "boot" | "reaper"): Promise<void> {
    const ownedPorts = new Set<number>();
    for (const session of listSessions(this.config.dataDir)) {
      if (isTerminalSessionStatus(session.status)) continue;
      const port = session.sidecarPorts?.[PLAYWRIGHT_SIDECAR_NAME]?.[SPUR_RESERVED_PORT_PLAYWRIGHT];
      if (typeof port === "number") {
        ownedPorts.add(port);
      }
    }
    const killed = await sweepLeakedPlaywright(ownedPorts);
    if (killed <= 0) {
      return;
    }
    if (context === "boot") {
      this.logEvent("daemon.startup.playwright_sweep", {
        level: "info",
        message: `Reaped ${killed} leaked playwright MCP process tree(s) on boot`,
        details: { killed },
      });
    } else {
      this.logEvent("session.sidecar_reaper.swept", {
        level: "info",
        message: `Reaped ${killed} leaked playwright MCP process tree(s)`,
        details: { killed },
      });
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
    options?: { promptKind?: UserInputKind },
  ): Promise<SessionView> {
    request = normalizeShepherdSpawnRequest(request);
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
      const reuseCtx = this.resolveWorkspaceReuseContext(request, project, worktree);
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
        ...(reuseCtx ? { deskId: reuseCtx.deskId } : {}),
        ...(Object.keys(project.sidecars).length > 0
          ? { sidecarNames: Object.keys(project.sidecars) }
          : {}),
        ...(request.slots?.links?.length ? { slots: { links: request.slots.links } } : {}),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        originalTaskPrompt,
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;
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
      const startupAttachments = this.storeAttachments(sessionId, request.attachments);
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
      const sidecarNames = Object.keys(project.sidecars);
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
      const { session: sessionForPlaywright, port: playwrightPort } =
        await this.startPlaywrightSidecar({ ...placeholder, worktreePath: workspacePath }, project);
      const hookSetup = await setupSessionAgentHooks({
        agent,
        dataDir: this.config.dataDir,
        sessionId,
        worktreePath: workspacePath,
        sessionToolDir,
        restrictWrites,
        ...(playwrightPort !== undefined ? { playwrightPort } : {}),
      });
      const sessionAgentConfig = this.sessionAgentConfig({
        agent,
        id: sessionId,
        restrictWrites,
      });
      const planOptions = withAgentModeOptions(
        withProjectAgentOptions(project, {
          ...hookSetup,
          ...(sessionAgentConfig.planOptions ?? {}),
        }),
        { planMode, restrictWrites },
      );
      // Pin a native session id at launch for claude so concurrent sessions
      // sharing one worktree bind to their own transcript instead of guessing
      // by newest mtime.
      const claudeSessionId = agent === "claude" ? randomUUID() : undefined;
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...planOptions,
        ...this.resolveClaudeAuthPlanOptions({
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
        ...sessionForPlaywright,
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
        for (const scName of Object.keys(project.sidecars)) {
          await killSidecarTmux(sessionId, scName).catch(() => {});
        }
        this.removeSessionArtifacts(sessionId, { preserveStartup: true });
        if (allocatedNewWorktree && workspacePath) {
          await removeWorktree(project.path, workspacePath);
        }

        const message = error instanceof Error ? error.message : String(error);
        const erroredRecord: SessionRecord = {
          id: sessionId,
          project: request.project,
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
    for (const sidecarName of Object.keys(prepared.project.sidecars)) {
      await killSidecarTmux(prepared.sessionId, sidecarName).catch(() => {});
    }
    if (finalFailure) {
      this.removeSessionArtifacts(prepared.sessionId);
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
    deskId: string;
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
      deskId: parent.deskId ?? parent.id,
      workspacePath: tryRealpath(path),
      worktree: parent.worktree,
      resolvedBranch: {
        branch: parent.branch,
        ...(parent.branchSource ? { branchSource: parent.branchSource } : {}),
      },
    };
  }

  private listDeskSessions(session: SessionRecord): SessionRecord[] {
    const anchor = session.deskId ?? session.id;
    return listSessions(this.config.dataDir)
      .filter(
        (member) =>
          member.project === session.project &&
          (member.deskId ?? member.id) === anchor &&
          member.status !== "killed",
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async buildDeskGroupMembers(
    session: SessionRecord,
    current: { state: SessionState; runtimeAlive: boolean },
  ): Promise<SessionDeskMember[]> {
    const members: SessionDeskMember[] = [];
    for (const member of this.listDeskSessions(session)) {
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

  private hasActiveWorktreeSiblings(session: SessionRecord): boolean {
    const anchor = session.deskId ?? session.id;
    return listSessions(this.config.dataDir).some(
      (s) =>
        s.id !== session.id &&
        s.project === session.project &&
        (s.deskId ?? s.id) === anchor &&
        !isTerminalSessionStatus(s.status),
    );
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
      !this.hasActiveWorktreeSiblings(session) &&
      !this.hasActiveWorktreePathPeers(session)
    );
  }

  private async prepareBackgroundSpawn(request: SpawnSessionRequest): Promise<PreparedSpawn> {
    request = normalizeShepherdSpawnRequest(request);
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
      deskId: string;
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
        ...(reuseCtx ? { deskId: reuseCtx.deskId } : {}),
        ...(Object.keys(project.sidecars).length > 0
          ? { sidecarNames: Object.keys(project.sidecars) }
          : {}),
        ...(request.slots?.links?.length ? { slots: { links: request.slots.links } } : {}),
        ...(selfDestruct !== undefined ? { selfDestruct } : {}),
        originalTaskPrompt,
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;

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

      const startupAttachments = this.storeAttachments(sessionId, request.attachments);
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
        this.removeSessionArtifacts(sessionId);
        const erroredBranchSource =
          resolvedBranch?.branchSource ?? (worktree && explicitBranch ? "explicit" : undefined);
        writeSession(this.config.dataDir, {
          id: sessionId,
          project: request.project,
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
      const sidecarNames = Object.keys(project.sidecars);
      const spawnInitialMessage = buildInitialMessage(
        [...startupAttachmentLines, initialMessage].filter((line) => line.trim()).join("\n"),
        sidecarNames,
        this.config.tags,
        project.branchNaming?.regex,
        selfDestruct,
      );
      const { session: sessionForPlaywright, port: playwrightPort } =
        await this.startPlaywrightSidecar(
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
        ...(playwrightPort !== undefined ? { playwrightPort } : {}),
      });
      // Pin a native session id at launch for claude (fresh per attempt so a
      // retry never reuses a possibly-existing transcript id).
      const claudeSessionId = agent === "claude" ? randomUUID() : undefined;
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...withAgentModeOptions(withProjectAgentOptions(project, hookSetup), {
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
        ...sessionForPlaywright,
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
      await waitForTmuxReady(sessionId, launchPlan.readyMarkers, undefined, { agent });
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
    session: Pick<SessionRecord, "agent" | "id" | "status" | "worktreePath">,
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
        transition.at,
        transition.fromState,
        transition.toState,
      );
      const artifactDir = ensureSessionArtifactsDir(this.config.dataDir, session.id);
      copyFileSync(sourcePath, join(artifactDir, artifactId));
      setSessionArtifactOrigin(this.config.dataDir, session.id, artifactId, "automatic");
      return artifactId;
    } catch {
      return null;
    }
  }

  private async logStateTransition(
    session: Pick<SessionRecord, "agent" | "id" | "project" | "status" | "worktreePath">,
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
    session: Pick<SessionRecord, "id" | "project">,
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

    const stored = this.storeAttachments(session.id, request.attachments);
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
    const anchor = session.deskId ?? session.id;
    const candidates = listSessions(this.config.dataDir)
      .filter(
        (member) =>
          member.project === session.project &&
          (member.deskId ?? member.id) === anchor &&
          member.status !== "killed",
      )
      .sort((a, b) => a.id.localeCompare(b.id));

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
    const session = currentSession;
    const normalized = normalizeSlotsUpdate(request);
    if (normalized.tags.length > 0) {
      const known = new Set(this.config.tags.map((tag) => tag.name));
      const unknown = normalized.tags.filter((tag) => !known.has(tag));
      if (unknown.length > 0) {
        const available = this.config.tags.map((tag) => tag.name).join(", ") || "(none configured)";
        throw new Error(`Unknown tag(s): ${unknown.join(", ")}. Available tags: ${available}`);
      }
    }
    const hasGenericPrSlot = session.slots?.links.some((link) => link.label === "pr") ?? false;
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
      ? applySlotsUpdate(session.slots, {
          ...(normalized.title !== undefined ? { title: normalized.title } : {}),
          ...(normalized.clearTitle ? { clearTitle: true } : {}),
          ...(genericLinks.length > 0 ? { links: genericLinks } : {}),
          ...(genericUnlinks.length > 0 ? { unlinkLabels: genericUnlinks } : {}),
          ...(normalized.tags.length > 0 ? { tags: normalized.tags } : {}),
          ...(normalized.untags.length > 0 ? { untags: normalized.untags } : {}),
        })
      : session.slots;
    const updated: SessionRecord = {
      ...session,
      ...(slots ? { slots } : {}),
      ...(nativePr
        ? { pr: nativePr }
        : unlinksPr && !hasGenericPrSlot
          ? {}
          : session.pr
            ? { pr: session.pr }
            : {}),
    };
    if (!slots) {
      delete updated.slots;
    }
    if (prLink === undefined && unlinksPr && !hasGenericPrSlot) {
      delete updated.pr;
    }
    writeSession(this.config.dataDir, updated);
    const displaySlots = deriveSessionSlots(updated);
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
    return this.enrich(updated);
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
            tmuxSession: sidecarTmuxSession(sessionId, startedName),
          },
        });
      },
    });
    return this.enrich(updated);
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

    if (!(await sidecarTmuxAlive(sessionId, sidecarName))) {
      return this.enrich(session);
    }

    this.abortSidecarUrlProbe(sessionId, sidecarName);
    await killSidecarTmux(sessionId, sidecarName);

    const afterKill = readSession(this.config.dataDir, sessionId) ?? session;
    const nextSlots = applySlotsUpdate(afterKill.slots, { unlinkLabels: [sidecarName] });
    const baseRecord: SessionRecord =
      nextSlots !== afterKill.slots ? withSessionSlots(afterKill, nextSlots) : afterKill;
    const updated: SessionRecord = {
      ...baseRecord,
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    this.logEvent("session.sidecar.stopped", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Stopped sidecar ${sidecarName} for ${sessionId}`,
      details: {
        sidecarName,
        tmuxSession: sidecarTmuxSession(sessionId, sidecarName),
      },
    });
    return this.enrich(updated);
  }

  private async teardownSessionSidecars(session: SessionRecord): Promise<void> {
    const project = this.resolveProjectForSession(session);
    for (const scName of sessionSidecarNames(session, project)) {
      this.abortSidecarUrlProbe(session.id, scName);
      const record = readSession(this.config.dataDir, session.id);
      if (record) {
        const next = applySlotsUpdate(record.slots, { unlinkLabels: [scName] });
        if (next !== record.slots) {
          const updated = withSessionSlots(record, next);
          writeSession(this.config.dataDir, updated);
        }
      }
      await killSidecarTmux(session.id, scName).catch(() => {});
    }
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

  private removeSessionArtifacts(sessionId: string, options?: { preserveStartup?: boolean }): void {
    const session = options?.preserveStartup ? readSession(this.config.dataDir, sessionId) : null;
    deleteAgentHookState(this.config.dataDir, sessionId);
    deleteRuntimeLogCursorsForSession(this.config.dataDir, sessionId);
    deleteSessionUserActions(this.config.dataDir, sessionId);
    if (options?.preserveStartup && session?.startupAttachmentIds?.length) {
      deleteSessionArtifactsExcept(this.config.dataDir, sessionId, session.startupAttachmentIds);
    } else {
      deleteSessionArtifactsDir(this.config.dataDir, sessionId);
    }
    removeSessionSlotTool(this.config.dataDir, sessionId);
  }

  private async applyManualStatus(
    sessionId: string,
    targetStatus: ManualSessionStatus,
    request: CompleteSessionRequest = {},
    options?: { retainInList?: boolean },
  ): Promise<SessionView> {
    const currentSession = readSession(this.config.dataDir, sessionId);
    if (!currentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let session = currentSession;
    if (targetStatus === "stopped" && session.status === "paused") {
      const migrated: SessionRecord = {
        ...copySessionWithoutSidecarPorts(session),
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
      await this.refreshDashboardCacheEntry(migrated);
      return this.enrich(migrated);
    }
    if (session.status === targetStatus) {
      if (targetStatus === "stopped" && hasSessionErrorEvidence(session)) {
        const record: SessionRecord = {
          ...copySessionWithoutSidecarPorts(session),
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
        await this.refreshDashboardCacheEntry(record);
        return this.enrich(record);
      }
      return this.enrich(session);
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
        this.removeSessionArtifacts(sessionId);
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
      ...copySessionWithoutSidecarPorts(cleanedSession),
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
    delete record.sidecarPorts;
    writeSession(this.config.dataDir, record);
    if (targetStatus === "completed" && this.shouldRemoveWorktreeOnTerminal(record)) {
      const cleanup = await this.resolveCleanupContext(record);
      await removeWorktree(cleanup.repoPath, record.worktreePath);
    }
    await this.refreshDashboardCacheEntry(record);
    this.logEvent(`session.${eventAction}.completed`, {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `${targetStatus === "stopped" ? "Stopped" : "Completed"} ${sessionId}`,
      details: {
        worktree: session.worktree,
      },
    });
    return this.enrich(record);
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
      this.removeSessionArtifacts(sessionId, { preserveStartup: true });
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
      ...copySessionWithoutSidecarPorts(cleanedSession),
      status: "killed",
      updatedAt: nowIso(),
    };
    delete record.retainInList;
    delete record.sidecarPorts;
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

    const workspacePresent =
      session.worktree && session.worktreePath ? workspaceExists(session.worktreePath) : false;
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
    if (!session.worktree || !session.worktreePath || !workspacePresent) {
      throw new Error(`Session ${session.id} cannot be recovered because its worktree is missing`);
    }

    await killTmuxSession(session.tmuxSession);
    const sessionWithAgentId = await this.captureAgentSessionId(session, 0);
    let recoveredAgentSessionId = sessionWithAgentId.agentSessionId;
    const sessionToolDir = this.prepareSessionTools(session.id, session.agent, session.project);
    const project = this.getProject(session.project);
    const { session: playwrightSidecarUpdate, port: playwrightPort } =
      await this.startPlaywrightSidecar(session, project);
    const hookSetup = await setupSessionAgentHooks({
      agent: session.agent,
      dataDir: this.config.dataDir,
      sessionId: session.id,
      worktreePath: session.worktreePath,
      sessionToolDir,
      restrictWrites: resolveRestrictWrites(session),
      ...(playwrightPort !== undefined ? { playwrightPort } : {}),
    });
    const sessionAgentConfig = this.sessionAgentConfig(session);
    const planMode = resolvePlanMode(session);
    const restrictWrites = resolveRestrictWrites(session);
    const resolvedModel = await resolveAgentLaunchModel(session.agent, session.model);
    const planOptions = {
      ...withAgentModeOptions(
        withProjectAgentOptions(project, {
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
      message: `Recovering ${session.id}`,
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
    const recovered: SessionRecord = this.applyReservedSidecars(
      {
        ...recoveredBase,
        planMode,
        restrictWrites,
        ...(recoveredAgentSessionId ? { agentSessionId: recoveredAgentSessionId } : {}),
        launchCommand: persistedLaunchCommand,
        status: "running",
        updatedAt: nowIso(),
      },
      playwrightSidecarUpdate,
    );
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

  async restore(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
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
    let restoredLaunchCommand = current.launchCommand;
    let playwrightSidecarUpdate: SessionRecord = current;

    try {
      const sessionToolDir = this.prepareSessionTools(current.id, current.agent, current.project);
      const restoreProjectConfig = this.getProject(current.project);
      const playwrightStart = await this.startPlaywrightSidecar(current, restoreProjectConfig);
      playwrightSidecarUpdate = playwrightStart.session;
      const playwrightPort = playwrightStart.port;
      const hookSetup = await setupSessionAgentHooks({
        agent: current.agent,
        dataDir: this.config.dataDir,
        sessionId: current.id,
        worktreePath: current.worktreePath,
        sessionToolDir,
        restrictWrites: resolveRestrictWrites(current),
        ...(playwrightPort !== undefined ? { playwrightPort } : {}),
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
          withProjectAgentOptions(restoreProjectConfig, {
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
      const restoreSidecarNames = Object.keys(restoreProject?.sidecars ?? {});
      const env = buildSessionEnv({
        agent: current.agent,
        projectId: current.project,
        sessionId: current.id,
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
          playwrightSidecarUpdate,
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
      playwrightSidecarUpdate,
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
    if (!isAccountAuthenticated(account)) {
      throw new Error(`Claude account ${accountId} is not logged in`);
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
    await this.ensureKillDirtyWorktreeAllowed(session, force);

    const updated: SessionRecord = {
      ...session,
      claudeAccountId: accountId,
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    touchAccountUsed(this.config.dataDir, accountId);

    await killTmuxSession(updated.tmuxSession);
    const relaunched = await this.ensureSessionReadyForSend(updated);

    this.logEvent("session.auth.switched", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Switched claude account for ${sessionId} to ${accountId}`,
      details: { accountId, reason: opts.reason, forced: force },
    });
    return this.enrich(relaunched);
  }

  // Rotate a rate-limited claude session onto the next authenticated account.
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
      if (!isAccountAuthenticated(account)) return false;
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
      launchCommand: `CLAUDE_CONFIG_DIR=${shellEscape(account.configDir)} ${claudeCommand()}`,
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
      session.id,
      requestedStartupAttachmentIds,
    );
    const mergedAttachments = [...clonedAttachments, ...(request.attachments ?? [])];
    const bootstrap = this.isUnconfiguredProjectId(session.project);
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

    const agent = parseAgentName(request.agent);
    const notes = request.notes?.trim();
    const originalTask = extractBareUserTask(session.originalTaskPrompt ?? session.prompt);
    const clonedAttachments = this.cloneStartupAttachments(
      session.id,
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
        ...copySessionWithoutSidecarPorts(session),
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
    if (classified.state !== "waiting") {
      return false;
    }
    if (!isIdleEnoughToReceive(classified.runtime.tmuxActivityAt, getIdleWaitBeforeFlushMs())) {
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
  }> {
    const hookState = readAgentHookState(this.config.dataDir, sessionId);
    const rolloutRead = await readCodexRolloutState(this.codexSessionsDir(sessionId));
    const rolloutState = rolloutRead.rollout;
    let state: SessionState = hookState?.state ?? "waiting";
    let source: StateSource = hookState ? "hook" : "status";

    if (rolloutState && shouldUseCodexRolloutState(hookState, rolloutState)) {
      state = rolloutState.state;
      source = "jsonl";
    }

    if (state === "working" && rolloutState && !codexToolExecuting(hookState)) {
      const lastActivityMs = Math.max(
        rolloutState.timestampMs,
        hookState ? new Date(hookState.updatedAt).getTime() : 0,
      );
      if (Date.now() - lastActivityMs >= CODEX_HUNG_AFTER_TOOLS_MS) {
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
  ): Promise<SessionStateTransition[]> {
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
      // single transient tmux/list-sessions blip would agree with itself on
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
    let updated: SessionRecord;
    if (terminalUnavailable) {
      const { error: _ignoredError, stopReason: _ignoredStopReason, ...stoppedBase } = latest;
      updated = {
        ...stoppedBase,
        status: "stopped",
        updatedAt,
      };
    } else {
      updated = {
        ...latest,
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
    let stateSource: StateSource = "status";
    let historySourcePath: string | null = null;
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
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (claude status=${statusResult.status})`,
          });
        } else if (jsonlResult) {
          state = jsonlResult.state;
          stateSource = "jsonl";
          historySourcePath = jsonlResult.reader.filePath;
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (jsonl, records=${jsonlResult.reader.tailRecords.length})`,
          });
        } else {
          state = "working";
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (no claude status/jsonl)`,
          });
        }
      } else if (strategy === "hook") {
        const codexState = await this.classifyCodexState(session.id);
        state = codexState.state;
        stateSource = codexState.source;
        rateLimit = codexState.rateLimit;
        if (stateSource === "codex_stale" && codexState.rolloutState) {
          historySourcePath = codexState.rolloutState.filePath;
          const lastActivityMs = Math.max(
            codexState.rolloutState.timestampMs,
            codexState.hookState ? new Date(codexState.hookState.updatedAt).getTime() : 0,
          );
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (codex stale, idle=${Date.now() - lastActivityMs}ms)`,
          });
        } else if (stateSource === "jsonl" && codexState.rolloutState) {
          historySourcePath = codexState.rolloutState.filePath;
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (codex jsonl=${codexState.rolloutState.reason})`,
          });
        } else if (codexState.hookState) {
          const hookState = codexState.hookState;
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (hook=${hookState.state}, event=${hookState.hookEvent ?? "?"}, hookAge=${Math.round((Date.now() - new Date(hookState.updatedAt).getTime()) / 1000)}s)`,
          });
        } else {
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (no hook/jsonl)`,
          });
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
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (cursor jsonl, records=${jsonlResult.reader.tailRecords.length})`,
          });
        } else {
          state = "working";
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: `State: ${state} (no cursor jsonl)`,
          });
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
      } else if (scanPane && strategy === "hook") {
        // Codex-specific: a hard rate-limit banner always wins. Otherwise, a
        // soft has_credits:false rollout signal can be a false positive when
        // the session is actually parked on a live MCP tool-permission dialog
        // (hook-independent — this can show up under any hookEvent, including
        // PostToolUse) rather than genuinely rate limited.
        const paneText = await captureTmuxPane(session.tmuxSession);
        const hardHit = scanTmuxRateLimit(paneText);
        if (hardHit?.limited) {
          rateLimit = hardHit;
          this.codexMcpDialogOverrides.delete(session.id);
        } else if (rateLimit?.limited && detectCodexMcpPermissionDialog(paneText)) {
          state = "needs_input";
          rateLimit = null;
          this.codexMcpDialogOverrides.set(
            session.id,
            Date.now() + CODEX_MCP_DIALOG_OVERRIDE_TTL_MS,
          );
          this.logEvent("session.state.classified", {
            level: "info",
            sessionId: session.id,
            projectId: session.project,
            message: "State: needs_input (codex MCP permission dialog, overrides soft rate limit)",
          });
        } else {
          this.codexMcpDialogOverrides.delete(session.id);
        }
      } else if (!scanPane && strategy === "hook" && rateLimit?.limited) {
        // The scanPane:false dashboard tick can't afford its own capture-pane
        // fork (see enrichDashboard), but it can still reuse the last live
        // pane-scan's dialog confirmation while it's fresh, so the dashboard
        // doesn't keep showing rate_limited for a session the 5s attention
        // monitor already knows is parked on a live MCP permission dialog.
        const expiresAt = this.codexMcpDialogOverrides.get(session.id);
        if (expiresAt !== undefined && expiresAt > Date.now()) {
          state = "needs_input";
          rateLimit = null;
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
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: rate_limited (${rateLimit.reason})`,
        });
      }
    }

    return {
      session: effectiveSession,
      runtime,
      state,
      source: stateSource,
      historySourcePath,
      workspacePresent: workspace.exists,
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
    const lastActivityAt = buildLastActivityAt(session, classified.runtime);
    const state = this.stabilizeState(session.id, classified.state);
    await this.updateStateHistory(
      session,
      state,
      classified.source,
      classified.historySourcePath ?? null,
    );
    const displaySlots = deriveSessionSlots(session);
    const runningSidecarNames = (
      await Promise.all(
        (session.sidecarNames ?? []).map(async (name) =>
          (await sidecarTmuxAlive(session.id, name)) ? name : null,
        ),
      )
    ).filter((name): name is string => name !== null);

    return {
      ...dashboardSession,
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
  ): Promise<SessionView> {
    const classified = await this.classifySessionRecord(session);
    session = classified.session;
    const workspacePresent = classified.workspacePresent;
    const lastActivityAt = buildLastActivityAt(session, classified.runtime);
    const state = this.stabilizeState(session.id, classified.state);
    const history = await this.updateStateHistory(
      session,
      state,
      classified.source,
      classified.historySourcePath ?? null,
    );

    const services: ServiceInstanceView[] = [];
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      services.push(await this.enrichService(service));
    }

    const project = this.resolveProjectForSession(session);
    const sidecars: { name: string; alive: boolean; ports: SidecarPortView[] }[] = [];
    for (const name of sessionSidecarNames(session, project)) {
      sidecars.push({
        name,
        alive: await sidecarTmuxAlive(session.id, name),
        ports: sidecarViewPorts(session, name, project?.sidecars[name]),
      });
    }
    const queuedMessagesView = displayQueuedMessages(session);
    const workspaceAccess = buildWorkspaceAccess(session, project, workspacePresent);
    const displaySlots = deriveSessionSlots(session);
    const deskGroupMembers = await this.buildDeskGroupMembers(session, {
      state,
      runtimeAlive: classified.runtime.runtimeAlive,
    });
    const resolvedClaudeAccounts =
      session.agent === "claude" ? (claudeAccounts ?? this.computeClaudeAccountsView()) : [];

    return {
      ...session,
      planMode: resolvePlanMode(session),
      restrictWrites: resolveRestrictWrites(session),
      ...(displaySlots ? { slots: displaySlots } : {}),
      runtimeAlive: classified.runtime.runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      ...(history.length > 0 ? { stateHistory: history } : {}),
      hasUnseenAttention: hasUnseenAttention(session, state, lastActivityAt),
      lastActivityAt,
      artifacts: listSessionArtifacts(this.config.dataDir, session.id),
      services,
      sidecars,
      ...(workspaceAccess ? { workspaceAccess } : {}),
      ...(queuedMessagesView ? { queuedMessages: queuedMessagesView } : {}),
      ...(deskGroupMembers.length > 1 ? { deskGroupMembers } : {}),
      ...(resolvedClaudeAccounts.length > 0 ? { claudeAccounts: resolvedClaudeAccounts } : {}),
      ...(session.claudeAccountId ? { activeClaudeAccountId: session.claudeAccountId } : {}),
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
