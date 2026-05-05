import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentBusyQueuedSendAwaitsPrompt,
  agentProcessMatchers,
  agentQueuedSendPromptGraceMs,
  agentSessionConfig,
  agentStateStrategy,
  agentWaitsForSubmitAck,
  buildAgentLaunchPlan,
  buildAgentRestorePlan,
  buildAgentResumePlan,
  findAgentSessionId,
  parseAgentName,
  setupAgentHooks,
} from "./agents/index.js";
import { shellEscape } from "./agents/shell-escape.js";
import { deleteAgentHookState, readAgentHookState } from "./agent-hook-state.js";
import { findLatestSessionFile as findLatestClaudeSessionFile } from "./agents/claude.js";
import {
  codexHookHomePath,
  captureCodexRolloutBaseline,
  findLatestCodexSessionFile,
  readCodexRolloutState,
  scanCodexRolloutForMessage,
  type CodexRolloutStateRecord,
  type RolloutBaseline,
} from "./agents/codex.js";
import { loadProjectSuggestions, loadSessionSuggestions } from "./agent-suggestions.js";
import {
  readClaudeConversation,
  readClaudeJsonlState,
  type ClaudeJsonlReaderState,
} from "./claude-jsonl-state.js";
import { findProjectConfigPath, loadProjectConfig } from "./config.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { reserveNextSessionId } from "./ids.js";
import { isHostPortFree } from "./port-probe.js";
import { sendDesktopNotification } from "./desktop-notify.js";
import {
  requestGitHubMergeConflictRestoreReplay,
  deleteRuntimeLogCursorsForSession,
  deleteServiceInstance,
  deleteServiceInstancesForSession,
  deleteServiceSourceStatesForService,
  deleteServiceSourceStatesForSession,
  listActiveServiceProblems,
  listServiceInstances,
  listServiceInstancesForSession,
  listSessions,
  readServiceInstance,
  readSession,
  writeServiceInstance,
  writeSession,
} from "./metadata.js";
import { runSpawnPreflight } from "./preflight.js";
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
  isProcessRunningInTmux,
  killSidecarTmux,
  killTmuxSession,
  sendSubmitKeyToTmux,
  setTmuxSocketName,
  sendMessageToTmux,
  syncTmuxStatus,
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
  listSessionArtifacts,
  readSessionArtifact,
  setSessionArtifactOrigin,
  setSessionArtifactUserAdded,
  type SessionArtifactFile,
  withSessionArtifactInstructions,
} from "./session-artifacts.js";
import {
  deriveSessionSlots,
  discoverSessionPrBinding,
  parseSessionPrBinding,
  resolvePrDiscoveryBranch,
} from "./session-pr.js";
import { buildMergedConfig, upsertConfigRegistryPath, writeConfigRegistry } from "./registry.js";
import {
  SPUR_DAEMON_API_VERSION,
  type AgentName,
  type AgentSuggestionsResponse,
  type AppConfig,
  type BranchSource,
  type ConversationResponse,
  type KillSessionRequest,
  type ProjectListEntry,
  type PreflightRequest,
  type PreflightResponse,
  type ProjectConfig,
  type RunServiceRequest,
  type RuntimeInfo,
  type ServiceInstanceRecord,
  type ServiceInstanceView,
  type SendMessageAttachment,
  type SendMessageRequest,
  type StartSidecarRequest,
  type SessionRecord,
  type SessionStatus,
  type SessionQueuedMessagesState,
  type SessionState,
  type SessionView,
  type SessionStateTransition,
  type SessionWorkspaceAccess,
  type SpawnOverrides,
  type SpawnSessionRequest,
  type StateSource,
  type UpdateSessionSlotsRequest,
} from "./types.js";
import { classifyCursorPaneState } from "./cursor-state.js";
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
  createWorktree,
  findWorktreePathForBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  readCurrentBranch,
  removeWorktree,
  resolveRepoPathFromWorktree,
  workspaceExists,
} from "./workspace.js";
import { orderedReviewProviderIds, reviewProvider } from "./review-providers/index.js";

const KILL_CONFIRMATION_REQUIRED_PREFIX = "Kill confirmation required";
const PIPELINE_POLL_INTERVAL_MS = 1_000;
const PIPELINE_STEP_DELAY_MS = 30_000;
const MESSAGE_READY_GRACE_MS = 15_000;
const STATE_HOLD_MS = 4_000;

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
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
const CODEX_SUBMIT_ACK_TIMEOUT_MS = 60_000;
const CODEX_SUBMIT_RETRY_LIMIT = 1;
const ATTENTION_POLL_INTERVAL_MS = 5_000;
const PR_CHECK_THROTTLE_MS = 30_000;
const WORKTREE_PATH_TOKEN = "$" + "{worktreePath}";
const WORKTREE_PATH_SHELL_TOKEN = "$" + "{worktreePathShell}";
const WORKTREE_PATH_URL_TOKEN = "$" + "{worktreePathUrl}";
const PR_CHECK_WAITING_LIMIT = 5;

interface PrCheckTracker {
  waitingChecks: number;
  lastState: SessionState | null;
  lastCheckAt: number;
  found: boolean;
}

export class SessionResourceNotFoundError extends Error {
  readonly statusCode = 404;
}

const RESTORE_PROMPT_PREFIX =
  "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:";
const PLAN_MODE_PROMPT_SUFFIX =
  "Plan mode: do not write or modify code. Only plan the task and describe the intended implementation.";
type ManualSessionStatus = "stopped" | "completed";
type AttentionState = "needs_input" | "error";
type BackgroundSpawnAttemptResult = "completed" | "retry";
interface SessionCleanupContext {
  repoPath: string;
  symlinks: string[];
}
interface SessionRuntimeSnapshot {
  runtimeAlive: boolean;
  processAlive: boolean;
  tmuxActivityAt: Date | null;
}
interface SessionStateResult {
  session: SessionRecord;
  runtime: SessionRuntimeSnapshot;
  state: SessionState;
  source: StateSource;
  historySourcePath?: string | null;
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

function sidecarProbeKey(sessionId: string, sidecarName: string): string {
  return `${sessionId}::${sidecarName}`;
}

function isRestorableStatus(status: SessionStatus): boolean {
  return status === "running" || status === "stopped" || status === "paused";
}

function statusFallbackState(status: SessionStatus): SessionState {
  if (status === "killed") return "killed";
  if (status === "errored") return "error";
  if (status === "stopped" || status === "paused" || status === "completed") return "stopped";
  return "working"; // running, spawning
}

type PipelineWaitOutcome = "ready" | "stopped" | "exited" | "timeout";

function nowIso(): string {
  return new Date().toISOString();
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
} {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  const steps = (prompt ? (request.steps ?? defaultSteps) : undefined)?.map((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`steps[${index}] must be a non-empty string`);
    }
    return step.trim();
  });
  const normalized = {
    prompt,
    planMode: request.planMode === true,
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

function buildPlanModePrompt(prompt: string): string {
  return `${prompt}\n\n${PLAN_MODE_PROMPT_SUFFIX}`;
}

function buildSessionPrompt(prompt: string, planMode: boolean): string {
  if (!planMode || !prompt.trim()) {
    return prompt;
  }
  return buildPlanModePrompt(prompt);
}

function withPlanMode(
  options: {
    claudeSettingsPath?: string;
    codexHomePath?: string;
    cursorConfigDir?: string;
    codexArgs?: string[];
  },
  planMode: boolean,
): {
  claudeSettingsPath?: string;
  codexHomePath?: string;
  cursorConfigDir?: string;
  codexArgs?: string[];
  planMode?: boolean;
} {
  return planMode ? { ...options, planMode: true } : options;
}

function sessionProcessMatchers(session: Pick<SessionRecord, "agent" | "launchCommand">): string[] {
  return agentProcessMatchers(session.agent, session.launchCommand);
}

function withProjectAgentOptions(
  project: Pick<ProjectConfig, "codexArgs">,
  options: {
    claudeSettingsPath?: string;
    codexHomePath?: string;
    cursorConfigDir?: string;
  },
): {
  claudeSettingsPath?: string;
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
    pid: process.pid,
    host: config.server.host,
    port: config.server.port,
    dataDir: config.dataDir,
    worktreeDir: config.worktreeDir,
    configPath: config.configPath,
    tmuxSocketName: config.tmux.socketName,
    uiPort: config.ui.port,
    startedAt,
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
  if (rolloutState.state === "needs_input") {
    return sameTurn || rolloutNewerThanHook;
  }
  return !hookState || sameTurn || hookState.state === "needs_input";
}

function isFresh(timestamp: Date, thresholdMs: number): boolean {
  return Date.now() - timestamp.getTime() <= thresholdMs;
}

function buildInitialMessage(initialMessage: string, sidecarNames: string[]): string {
  if (!initialMessage.trim()) return "";
  const base = withSessionArtifactInstructions(withSessionSlotInstructions(initialMessage));
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

export function isRestorableSession(
  session: Pick<SessionView, "status" | "state" | "workspaceExists">,
): boolean {
  return (
    isRestorableStatus(session.status) && session.state === "stopped" && session.workspaceExists
  );
}

export function buildRestorePrompt(prompt: string, planMode = false): string {
  return `${RESTORE_PROMPT_PREFIX}\n\n${buildSessionPrompt(prompt, planMode)}`;
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

function collectReservedSidecarPorts(
  session: Pick<SessionRecord, "status" | "sidecarPorts">,
): number[] {
  if (isTerminalSessionStatus(session.status)) {
    return [];
  }
  return Object.values(session.sidecarPorts ?? {}).flatMap((sidecarPorts) =>
    Object.values(sidecarPorts),
  );
}

function sidecarPortEnv(
  session: Pick<SessionRecord, "sidecarPorts">,
  sidecarName: string,
): Record<string, string> {
  const entries = Object.entries(session.sidecarPorts?.[sidecarName] ?? {});
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

function requestGitHubMergeConflictRestoreReplays(
  config: AppConfig,
  projectId: string,
  sessionId: string,
): void {
  const project = config.projects[projectId];
  if (!project) return;
  for (const [sourceId, source] of Object.entries(project.sources)) {
    if (source.type !== "github") continue;
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

async function verifySidecarStartup(sessionId: string, sidecarName: string): Promise<void> {
  const tmuxSession = sidecarTmuxSession(sessionId, sidecarName);
  await sleep(SIDECAR_STARTUP_VERIFY_MS);
  if (!(await tmuxPaneDead(tmuxSession))) return;
  const output = (await captureTmuxPane(tmuxSession, SIDECAR_STARTUP_TAIL_LINES)).trim();
  await killTmuxSession(tmuxSession);
  const detail = output ? `\nLast output:\n${output}` : "";
  throw new Error(`Sidecar "${sidecarName}" exited immediately after launch.${detail}`);
}

function sessionSidecarNames(
  session: Pick<SessionRecord, "sidecarNames">,
  project?: Pick<ProjectConfig, "sidecars">,
): string[] {
  return session.sidecarNames ?? Object.keys(project?.sidecars ?? {});
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

interface ResolvedSpawnBranch {
  branch: string;
  branchSource?: BranchSource;
}

interface PreparedSpawn {
  request: SpawnSessionRequest;
  project: ProjectConfig;
  agent: SessionRecord["agent"];
  prompt: string;
  steps?: string[];
  planMode: boolean;
  worktree: boolean;
  defaultBranch: string;
  sessionId: string;
  resolvedBranch?: ResolvedSpawnBranch;
  placeholder: SessionRecord;
  sessionToolDir: string;
}

function resolveRespawnRequest(
  session: SessionRecord,
  options?: { prompt?: string; attachments?: SendMessageAttachment[] },
): SpawnSessionRequest {
  return {
    project: session.project,
    prompt: options?.prompt ?? session.prompt,
    ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
    agent: session.agent,
    ...(session.planMode !== undefined && { planMode: session.planMode }),
    ...(session.pipeline?.steps && { steps: session.pipeline.steps }),
    overrides: { worktree: session.worktree },
    ...(session.worktree &&
    session.branchSource === "explicit" &&
    isTerminalSessionStatus(session.status)
      ? { branch: session.branch }
      : {}),
  };
}

async function resolveSpawnBranch(args: {
  repoPath: string;
  requestBranch: string | undefined;
  requestBranchSource?: Extract<BranchSource, "explicit" | "preflight">;
  worktree: boolean;
  fallbackBranch: string;
}): Promise<ResolvedSpawnBranch> {
  if (args.worktree) {
    const requestedBranch = args.requestBranch?.trim();
    if (requestedBranch) {
      return args.requestBranchSource
        ? { branch: requestedBranch, branchSource: args.requestBranchSource }
        : { branch: requestedBranch };
    }
    return { branch: args.fallbackBranch };
  }

  const currentBranch = await readCurrentBranch(args.repoPath);
  const requestedBranch = args.requestBranch?.trim();
  if (requestedBranch && requestedBranch !== currentBranch) {
    throw new Error(
      `branch override requires worktree=true; shared workspace is on branch ${currentBranch}`,
    );
  }
  return { branch: currentBranch, branchSource: "shared_workspace" };
}

function projectHasService(project: ProjectConfig, serviceId: string): boolean {
  return Object.values(project.sources).some(
    (source) => source.type === "service" && source.service === serviceId,
  );
}

export class SessionService {
  readonly bootstrapConfigPath: string;
  readonly startedAt: string;
  config: AppConfig;
  private registryPaths: string[];
  private readonly deliveryRuns = new Map<string, Promise<void>>();
  private readonly attentionStates = new Map<string, AttentionState>();
  private attentionMonitorTimer: NodeJS.Timeout | null = null;
  private attentionMonitorRunning = false;
  private readonly stateCache = new Map<string, { state: SessionState; classifiedAt: number }>();
  private readonly claudeJsonlReaders = new Map<string, ClaudeJsonlReaderState>();
  private readonly stateHistory = new Map<string, SessionStateTransition[]>();
  private readonly prCheckTrackers = new Map<string, PrCheckTracker>();
  private sidecarPortLock: Promise<void> = Promise.resolve();
  private readonly sidecarProbes = new Map<string, AbortController>();

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
  }

  dispose(): void {
    if (this.attentionMonitorTimer) {
      clearInterval(this.attentionMonitorTimer);
      this.attentionMonitorTimer = null;
    }
  }

  previewConfigConnect(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
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
  } {
    return this.previewRegistryPaths(this.registryPaths.filter((path) => path !== configPath));
  }

  private previewRegistryPaths(nextRegistryPaths: string[]): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    const merged = buildMergedConfig(this.bootstrapConfigPath, nextRegistryPaths, {
      skipInvalid: true,
      warn: (message) => warnings.push(message),
    });
    const currentSignature = JSON.stringify(this.config.projects);
    const nextSignature = JSON.stringify(merged.config.projects);
    return {
      config: merged.config,
      registryPaths: merged.configPaths,
      warnings,
      changed:
        currentSignature !== nextSignature ||
        merged.configPaths.length !== this.registryPaths.length ||
        merged.configPaths.some((path, index) => path !== this.registryPaths[index]),
    };
  }

  applyConfig(config: AppConfig, registryPaths: string[]): void {
    this.config = config;
    this.registryPaths = [...new Set(registryPaths)];
    setTmuxSocketName(this.config.tmux.socketName);
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
    writeConfigRegistry(this.config.dataDir, this.registryPaths);
    this.resumeSessionDelivery();
  }

  getRegistryPaths(): string[] {
    return [...this.registryPaths];
  }

  listProjects(): ProjectListEntry[] {
    return Object.entries(this.config.projects)
      .map(([id, project]) => ({
        id,
        name: project.name?.trim() || id,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
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

  private sessionAgentConfig(
    session: Pick<SessionRecord, "agent" | "id">,
  ): ReturnType<typeof agentSessionConfig> {
    return agentSessionConfig(session.agent, {
      dataDir: this.config.dataDir,
      sessionId: session.id,
    });
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
      const sessions = listSessions(this.config.dataDir).filter(
        (session) => !isTerminalSessionStatus(session.status),
      );
      for (const session of sessions) {
        const view = await this.enrich(session);
        this.checkPrForSession(session, view.state);
        const attention =
          view.state === "needs_input" ? "needs_input" : view.state === "error" ? "error" : null;
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
    } finally {
      this.attentionMonitorRunning = false;
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
      await syncTmuxStatus(updated.tmuxSession, deriveSessionSlots(updated));
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
    await syncTmuxStatus(updated.tmuxSession, deriveSessionSlots(updated));
    this.logEvent("session.pr_auto_detect.found", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Auto-detected PR for ${session.id}: ${reviewUrl}`,
    });
  }

  private async notifyAttention(
    session: Pick<SessionView, "id" | "slots" | "error">,
    attention: AttentionState,
  ): Promise<void> {
    const summary = session.slots?.title ? `${session.slots.title}\n` : "";
    const title =
      attention === "error" ? `Spur error [${session.id}]` : `Spur needs input [${session.id}]`;
    const message =
      attention === "error"
        ? `${summary}${session.error ?? "Session errored."}\nRun \`spur list\` for details.`
        : `${summary}Agent is waiting for a reply or approval.\nRun \`spur list\` to respond.`;
    await sendDesktopNotification({
      title,
      message,
      urgent: attention === "error",
    });
  }

  private getProject(projectId: string): ProjectConfig {
    const project = this.config.projects[projectId];
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  private resolveProjectForSession(
    session: Pick<SessionRecord, "id" | "project" | "worktreePath">,
  ): ProjectConfig | undefined {
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

  private async ensureSidecarReservation(
    session: SessionRecord,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
  ): Promise<SessionRecord> {
    if (!sidecar.ports || Object.keys(sidecar.ports).length === 0) {
      return session;
    }

    const currentSidecarPorts = session.sidecarPorts?.[sidecarName] ?? {};
    const keepReserved = new Set(Object.values(currentSidecarPorts));
    const unavailable = new Set<number>();

    for (const service of listServiceInstances(this.config.dataDir)) {
      if (service.port !== undefined) {
        unavailable.add(service.port);
      }
    }
    for (const liveSession of listSessions(this.config.dataDir)) {
      for (const port of collectReservedSidecarPorts(liveSession)) {
        if (liveSession.id === session.id && keepReserved.has(port)) {
          continue;
        }
        unavailable.add(port);
      }
    }

    const reservedForSidecar: Record<string, number> = {};
    let changed = false;
    for (const [portId, portConfig] of Object.entries(sidecar.ports)) {
      const existingPort = currentSidecarPorts[portConfig.env];
      if (existingPort !== undefined) {
        reservedForSidecar[portConfig.env] = existingPort;
        unavailable.add(existingPort);
        continue;
      }

      let selectedPort: number | undefined;
      const hostBusy: number[] = [];
      for (let candidate = portConfig.start; candidate <= portConfig.end; candidate += 1) {
        if (unavailable.has(candidate)) continue;
        if (!(await isHostPortFree(candidate))) {
          unavailable.add(candidate);
          hostBusy.push(candidate);
          continue;
        }
        selectedPort = candidate;
        unavailable.add(candidate);
        break;
      }
      if (selectedPort === undefined) {
        const busyDetail = hostBusy.length > 0 ? ` Host-bound: ${hostBusy.join(", ")}.` : "";
        throw new Error(
          `No free reserved port for sidecar ${sidecarName}.${portId} in range ${portConfig.start}-${portConfig.end}.${busyDetail}`,
        );
      }
      reservedForSidecar[portConfig.env] = selectedPort;
      changed = true;
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
  }): Promise<SessionRecord> {
    return this.withSidecarPortLock(async () => {
      if (await sidecarTmuxAlive(args.session.id, args.sidecarName)) {
        return args.session;
      }

      const agentConfig = this.sessionAgentConfig(args.session);
      const reservedSession = await this.ensureSidecarReservation(
        args.session,
        args.sidecarName,
        args.sidecar,
      );

      const sessionToolDir = this.prepareSessionTools(reservedSession.id, reservedSession.agent);
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
      } catch (error) {
        if (reservedSession !== args.session) {
          writeSession(this.config.dataDir, {
            ...args.session,
            updatedAt: nowIso(),
          });
        }
        throw error;
      }

      const sidecarNames = sessionSidecarNames(reservedSession, args.project);
      const updated: SessionRecord = {
        ...reservedSession,
        updatedAt: nowIso(),
        ...(sidecarNames.includes(args.sidecarName)
          ? {}
          : { sidecarNames: [...sidecarNames, args.sidecarName] }),
      };
      writeSession(this.config.dataDir, updated);
      return updated;
    });
  }

  private maybeStartSidecarUrlProbe(
    sessionId: string,
    sidecarName: string,
    sidecar: ProjectConfig["sidecars"][string],
    record: SessionRecord,
  ): void {
    const urlPort = Object.values(sidecar.ports ?? {}).find((p) => p.url !== undefined);
    if (!urlPort || urlPort.url === undefined) return;
    const reservedPort = record.sidecarPorts?.[sidecarName]?.[urlPort.env];
    if (typeof reservedPort !== "number") return;
    this.startSidecarProbe(sessionId, sidecarName, reservedPort, urlPort.url);
  }

  private startSidecarProbe(
    sessionId: string,
    sidecarName: string,
    reservedPort: number,
    url: string,
  ): void {
    const key = sidecarProbeKey(sessionId, sidecarName);
    this.sidecarProbes.get(key)?.abort();
    const controller = new AbortController();
    this.sidecarProbes.set(key, controller);
    void this.publishSidecarLinkWhenReady({
      sessionId,
      sidecarName,
      reservedPort,
      url,
      signal: controller.signal,
    }).finally(() => {
      if (this.sidecarProbes.get(key) === controller) {
        this.sidecarProbes.delete(key);
      }
    });
  }

  private stopSidecarProbe(sessionId: string, sidecarName: string): void {
    const key = sidecarProbeKey(sessionId, sidecarName);
    const controller = this.sidecarProbes.get(key);
    if (!controller) return;
    controller.abort();
    this.sidecarProbes.delete(key);
  }

  private async publishSidecarLinkWhenReady(args: {
    sessionId: string;
    sidecarName: string;
    reservedPort: number;
    url: string;
    signal: AbortSignal;
  }): Promise<void> {
    const { sessionId, sidecarName, reservedPort, url, signal } = args;
    const targetUrl = `http://127.0.0.1:${reservedPort}/`;
    const linkUrl = `${url}:${reservedPort}`;
    for (let i = 0; i < SIDECAR_PROBE_BUDGET_ITERATIONS; i += 1) {
      if (signal.aborted) return;
      const perRequest = AbortSignal.any([
        signal,
        AbortSignal.timeout(SIDECAR_PROBE_REQUEST_TIMEOUT_MS),
      ]);
      let responded: boolean;
      try {
        await fetch(targetUrl, { signal: perRequest, redirect: "manual" });
        responded = true;
      } catch {
        responded = false;
      }
      if (responded) {
        const latest = readSession(this.config.dataDir, sessionId);
        if (!latest) return;
        if (isTerminalSessionStatus(latest.status)) return;
        if (!(await sidecarTmuxAlive(sessionId, sidecarName))) return;
        const slots = applySlotsUpdate(latest.slots, {
          links: [{ label: sidecarName, url: linkUrl }],
          unlinkLabels: [],
        });
        const updated: SessionRecord = slots
          ? { ...latest, slots }
          : (() => {
              const { slots: _drop, ...rest } = latest;
              return rest;
            })();
        writeSession(this.config.dataDir, updated);
        await syncTmuxStatus(updated.tmuxSession, updated.slots);
        this.logEvent("session.sidecar.link.published", {
          level: "info",
          sessionId,
          projectId: latest.project,
          message: `Published sidecar link ${sidecarName} for ${sessionId}`,
          details: { sidecarName, url: linkUrl },
        });
        return;
      }
      await sleep(SIDECAR_PROBE_INTERVAL_MS);
    }
    this.logEvent("session.sidecar.link.timeout", {
      level: "warn",
      sessionId,
      message: `Sidecar ${sidecarName} did not respond at ${targetUrl} within probe budget`,
      details: { sidecarName, reservedPort },
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

  async list(options?: { includeCompleted?: boolean }): Promise<SessionView[]> {
    const sessions = listSessions(this.config.dataDir).filter((session) => {
      if (session.status === "completed") {
        return options?.includeCompleted === true || session.retainInList === true;
      }
      return session.status !== "killed" || session.retainInList === true;
    });
    const views: SessionView[] = [];
    for (const session of sessions) {
      views.push(await this.enrich(session));
    }
    return views;
  }

  async get(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.enrich(session);
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
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const durationMs = Date.now() - new Date(session.createdAt).getTime();
    const fallback: ConversationResponse = {
      messages: [],
      durationMs,
      state: statusFallbackState(session.status),
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

  async reconcileStoppedSessions(): Promise<{ scanned: number; alive: number; drifted: number }> {
    const candidates = listSessions(this.config.dataDir).filter(
      (session) => session.status === "running" || session.status === "spawning",
    );
    let alive = 0;
    let drifted = 0;

    for (const session of candidates) {
      const runtime = await this.readRuntimeSnapshot(session);
      const reconciled = await this.reconcileUnexpectedStop(session, runtime, "boot");
      if (reconciled.session.status === "stopped") {
        drifted += 1;
      } else {
        alive += 1;
      }
    }

    return { scanned: candidates.length, alive, drifted };
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

  async spawn(request: SpawnSessionRequest): Promise<SessionView> {
    let stage = "validating";
    let sessionId: string | undefined;
    let project: ProjectConfig | undefined;
    let agent: SessionRecord["agent"] | undefined;
    let worktree = false;
    let workspacePath = "";
    let resolvedBranch: ResolvedSpawnBranch | undefined;
    let createdAt: string | undefined;
    let placeholderWritten = false;
    let prompt = "";
    let steps: string[] | undefined;
    let planMode: boolean;
    let preflightOutcome: "branch" | "defer" | undefined;
    let preflightBranch: string | undefined;
    try {
      project = this.getProject(request.project);
      ({ prompt, steps, planMode } = normalizeSpawnRequest(request, project.spawn?.steps));
      if (
        request.branch !== undefined &&
        (typeof request.branch !== "string" || !request.branch.trim())
      ) {
        throw new Error("branch must be a non-empty string when provided");
      }

      const overrides = parseSpawnOverrides(request.overrides, "overrides");
      worktree = resolveSpawnWorktree(project, overrides);
      const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
      agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
      let effectiveBranch = request.branch;
      let effectiveBranchSource: Extract<BranchSource, "explicit" | "preflight"> | undefined =
        request.branch ? "explicit" : undefined;
      if (!effectiveBranch && worktree && project.preflight && prompt) {
        stage = "preflight";
        const preflight = await runSpawnPreflight({
          agent,
          projectId: request.project,
          project,
          baseBranch: defaultBranch,
          worktree,
          prompt,
        });
        if (preflight.branch) {
          preflightOutcome = "branch";
          preflightBranch = preflight.branch;
          effectiveBranch = preflight.branch;
          effectiveBranchSource = "preflight";
        } else {
          preflightOutcome = "defer";
        }
      }
      sessionId = await reserveNextSessionId(
        this.config.dataDir,
        request.project,
        project.sessionPrefix,
      );
      if (preflightOutcome) {
        this.logEvent("session.preflight.completed", {
          level: "info",
          sessionId,
          projectId: request.project,
          message:
            preflightOutcome === "branch"
              ? `Spawn preflight selected branch ${preflightBranch} for ${sessionId}`
              : `Spawn preflight deferred branch selection for ${sessionId}`,
          details: {
            outcome: preflightOutcome,
            branch: preflightBranch ?? null,
            baseBranch: defaultBranch,
          },
        });
      }
      resolvedBranch = await resolveSpawnBranch({
        repoPath: project.path,
        requestBranch: effectiveBranch,
        ...(effectiveBranchSource ? { requestBranchSource: effectiveBranchSource } : {}),
        worktree,
        fallbackBranch: sessionId,
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
      const tmuxSession = sessionId;
      createdAt = nowIso();

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
        },
      });

      const placeholder: SessionRecord = {
        id: sessionId,
        project: request.project,
        agent,
        planMode,
        prompt,
        branch: resolvedBranch.branch,
        ...(resolvedBranch.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
        worktree,
        worktreePath: worktree ? "" : project.path,
        tmuxSession,
        launchCommand: "",
        status: "spawning",
        createdAt,
        updatedAt: createdAt,
        ...(Object.keys(project.sidecars).length > 0
          ? { sidecarNames: Object.keys(project.sidecars) }
          : {}),
        ...(request.slots?.links?.length ? { slots: { links: request.slots.links } } : {}),
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;
      workspacePath = placeholder.worktreePath;

      stage = "tools.setup";
      const sessionToolDir = this.prepareSessionTools(sessionId, agent);

      if (worktree) {
        stage = "worktree.create";
        workspacePath = await createWorktree({
          repoPath: project.path,
          worktreeBaseDir: this.config.worktreeDir,
          projectId: request.project,
          sessionId,
          defaultBranch,
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
          },
        });
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
      const initialMessage =
        steps && firstStage
          ? formatPipelineStepMessage(prompt, firstStage, 0, steps.length)
          : buildSessionPrompt(prompt, planMode);
      const startupAttachments = this.storeImageAttachments(sessionId, request.attachments);
      const startupAttachmentLines =
        agent === "codex"
          ? []
          : buildAttachmentReferenceLines(startupAttachments.map((attachment) => attachment.id));
      const sidecarNames = Object.keys(project.sidecars);
      const spawnInitialMessage = buildInitialMessage(
        [...startupAttachmentLines, initialMessage].filter((line) => line.trim()).join("\n"),
        sidecarNames,
      );
      const hookSetup = await setupAgentHooks({
        agent,
        worktreePath: workspacePath,
        sessionToolDir,
      });
      const sessionAgentConfig = this.sessionAgentConfig({
        agent,
        id: sessionId,
      });
      const planOptions = withPlanMode(
        withProjectAgentOptions(project, {
          ...hookSetup,
          ...(sessionAgentConfig.planOptions ?? {}),
        }),
        planMode,
      );
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...planOptions,
        ...(agent === "codex" && startupAttachments.length > 0
          ? {
              startupImagePaths: startupAttachments.map((attachment) => attachment.path),
            }
          : {}),
      });
      const promptDeliveredOnLaunch =
        agent === "codex" &&
        startupAttachments.length > 0 &&
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
        ...placeholder,
        planMode,
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        status: "running",
        updatedAt: nowIso(),
        ...(startupAttachments.length > 0
          ? {
              startupAttachmentIds: startupAttachments.map((attachment) => attachment.id),
            }
          : {}),
        ...(pipeline ? { pipeline } : {}),
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

      stage = "tmux.status";
      await syncTmuxStatus(tmuxSession, deriveSessionSlots(runningRecord));
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
            imageCount: startupAttachments.length,
            messageLength: spawnInitialMessage.length,
          },
        });
      }

      stage = "record.write";
      let updatedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );
      const projectSidecars = project.sidecars;
      for (const [name, sidecar] of Object.entries(projectSidecars)) {
        if (!sidecar.autoStart) continue;
        const sidecarDepth = ROOT_SIDECAR_DEPTH;
        try {
          updatedRecord = await this.startSidecarInternal({
            session: updatedRecord,
            project,
            sidecarName: name,
            sidecar,
            sidecarDepth,
          });
          this.logEvent("session.sidecar.started", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Auto-started sidecar ${name} for ${sessionId}`,
            details: {
              sidecarName: name,
              command: sidecar.command,
              manualOnly: false,
              sidecarDepth,
              tmuxSession: sidecarTmuxSession(sessionId, name),
            },
          });
          this.maybeStartSidecarUrlProbe(sessionId, name, sidecar, updatedRecord);
        } catch (sidecarError) {
          const sidecarMessage =
            sidecarError instanceof Error ? sidecarError.message : String(sidecarError);
          this.logEvent("session.sidecar.autostart.failed", {
            level: "warn",
            sessionId,
            projectId: request.project,
            message: `Auto-start sidecar ${name} failed for ${sessionId}: ${sidecarMessage}`,
          });
        }
      }

      writeSession(this.config.dataDir, updatedRecord);
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
        if (worktree && workspacePath) {
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
    if (prepared.worktree && workspacePath) {
      await removeWorktree(prepared.project.path, workspacePath);
    }
  }

  private async prepareBackgroundSpawn(request: SpawnSessionRequest): Promise<PreparedSpawn> {
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
    let resolvedBranch: ResolvedSpawnBranch | undefined;
    let explicitBranch: string | undefined;
    try {
      project = this.getProject(request.project);
      ({ prompt, steps, planMode } = normalizeSpawnRequest(request, project.spawn?.steps));
      if (
        request.branch !== undefined &&
        (typeof request.branch !== "string" || !request.branch.trim())
      ) {
        throw new Error("branch must be a non-empty string when provided");
      }
      explicitBranch = request.branch?.trim() || undefined;

      const overrides = parseSpawnOverrides(request.overrides, "overrides");
      worktree = resolveSpawnWorktree(project, overrides);
      const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
      agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
      sessionId = await reserveNextSessionId(
        this.config.dataDir,
        request.project,
        project.sessionPrefix,
      );
      if (!worktree) {
        stage = "branch.resolve";
        resolvedBranch = await resolveSpawnBranch({
          repoPath: project.path,
          requestBranch: request.branch,
          ...(request.branch ? { requestBranchSource: "explicit" as const } : {}),
          worktree,
          fallbackBranch: sessionId,
        });
      }
      createdAt = nowIso();
      const placeholderBranch = resolvedBranch?.branch ?? explicitBranch ?? sessionId;
      const placeholderBranchSource =
        resolvedBranch?.branchSource ?? (worktree && explicitBranch ? "explicit" : undefined);
      const placeholderWorktreePath = worktree
        ? join(this.config.worktreeDir, request.project, sessionId)
        : project.path;
      const placeholder: SessionRecord = {
        id: sessionId,
        project: request.project,
        agent,
        planMode,
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
        ...(Object.keys(project.sidecars).length > 0
          ? { sidecarNames: Object.keys(project.sidecars) }
          : {}),
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
        },
      });

      return {
        request,
        project,
        agent,
        prompt,
        ...(steps ? { steps } : {}),
        planMode,
        worktree,
        defaultBranch,
        sessionId,
        ...(resolvedBranch ? { resolvedBranch } : {}),
        placeholder,
        sessionToolDir: this.prepareSessionTools(sessionId, agent),
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
          worktreePath: worktree
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
    const { agent, planMode, project, prompt, request, sessionId } = prepared;
    let stage = attempt > 1 ? `retry.${attempt}.preflight` : "preflight";
    let workspacePath = prepared.worktree ? "" : project.path;
    let initialPromptSent = false;
    try {
      let resolvedBranch = prepared.resolvedBranch;
      let preflightOutcome: "branch" | "defer" | undefined;
      let preflightBranch: string | undefined;
      if (!resolvedBranch) {
        let effectiveBranch = request.branch;
        let effectiveBranchSource: Extract<BranchSource, "explicit" | "preflight"> | undefined =
          request.branch ? "explicit" : undefined;
        if (!effectiveBranch && prepared.worktree && project.preflight && prompt) {
          const preflight = await runSpawnPreflight({
            agent,
            projectId: request.project,
            project,
            baseBranch: prepared.defaultBranch,
            worktree: prepared.worktree,
            prompt,
          });
          if (preflight.branch) {
            preflightOutcome = "branch";
            preflightBranch = preflight.branch;
            effectiveBranch = preflight.branch;
            effectiveBranchSource = "preflight";
          } else {
            preflightOutcome = "defer";
          }
        }
        if (preflightOutcome) {
          this.logEvent("session.preflight.completed", {
            level: "info",
            sessionId,
            projectId: request.project,
            message:
              preflightOutcome === "branch"
                ? `Spawn preflight selected branch ${preflightBranch} for ${sessionId}`
                : `Spawn preflight deferred branch selection for ${sessionId}`,
            details: {
              outcome: preflightOutcome,
              branch: preflightBranch ?? null,
              baseBranch: prepared.defaultBranch,
              attempt,
            },
          });
        }
        resolvedBranch = await resolveSpawnBranch({
          repoPath: project.path,
          requestBranch: effectiveBranch,
          ...(effectiveBranchSource ? { requestBranchSource: effectiveBranchSource } : {}),
          worktree: prepared.worktree,
          fallbackBranch: sessionId,
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
      const initialMessage =
        prepared.steps && firstStage
          ? formatPipelineStepMessage(prompt, firstStage, 0, prepared.steps.length)
          : buildSessionPrompt(prompt, planMode);
      const startupAttachments = this.storeImageAttachments(sessionId, request.attachments);
      const startupAttachmentLines =
        agent === "codex"
          ? []
          : buildAttachmentReferenceLines(startupAttachments.map((attachment) => attachment.id));
      const sidecarNames = Object.keys(project.sidecars);
      const spawnInitialMessage = buildInitialMessage(
        [...startupAttachmentLines, initialMessage].filter((line) => line.trim()).join("\n"),
        sidecarNames,
      );
      const hookSetup = await setupAgentHooks({
        agent,
        worktreePath: workspacePath,
        sessionToolDir: prepared.sessionToolDir,
      });
      const launchPlan = buildAgentLaunchPlan(agent, spawnInitialMessage, {
        ...withPlanMode(withProjectAgentOptions(project, hookSetup), planMode),
        ...(agent === "codex" && startupAttachments.length > 0
          ? {
              startupImagePaths: startupAttachments.map((attachment) => attachment.path),
            }
          : {}),
      });
      const promptDeliveredOnLaunch =
        agent === "codex" &&
        startupAttachments.length > 0 &&
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
        ...spawnPlaceholder,
        planMode,
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
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

      stage = attempt > 1 ? `retry.${attempt}.tmux.status` : "tmux.status";
      await syncTmuxStatus(sessionId, deriveSessionSlots(runningRecord));
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
            imageCount: startupAttachments.length,
            messageLength: spawnInitialMessage.length,
          },
        });
      }

      stage = attempt > 1 ? `retry.${attempt}.record.write` : "record.write";
      const persistedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );

      for (const [name, sidecar] of Object.entries(project.sidecars)) {
        if (!sidecar.autoStart) continue;
        try {
          await createTmuxSidecarSession({
            sessionId,
            sidecarName: name,
            cwd: workspacePath,
            command: sidecar.command,
            env: {
              ...sessionEnv,
              SPUR_SIDECAR_NAME: name,
              ...(sidecar.env ?? {}),
              ...sidecarPortEnv(runningRecord, name),
            },
          });
          await verifySidecarStartup(sessionId, name);
          this.logEvent("session.sidecar.started", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Auto-started sidecar ${name} for ${sessionId}`,
            details: {
              sidecarName: name,
              command: sidecar.command,
              tmuxSession: sidecarTmuxSession(sessionId, name),
              attempt,
            },
          });
        } catch (sidecarError) {
          const sidecarMessage =
            sidecarError instanceof Error ? sidecarError.message : String(sidecarError);
          this.logEvent("session.sidecar.autostart.failed", {
            level: "warn",
            sessionId,
            projectId: request.project,
            message: `Auto-start sidecar ${name} failed for ${sessionId}: ${sidecarMessage}`,
          });
        }
      }

      writeSession(this.config.dataDir, persistedRecord);
      this.logEvent("session.spawn.completed", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawned ${sessionId}`,
        details: {
          worktreePath: workspacePath,
          tmuxSession: sessionId,
          agent,
          agentSessionId: persistedRecord.agentSessionId ?? null,
          attempt,
        },
      });
      if (this.shouldRunDelivery(persistedRecord)) {
        this.scheduleDeliveryRunner(persistedRecord.id);
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
    const placeholder = await this.enrich(prepared.placeholder);
    queueMicrotask(() => {
      void (async () => {
        for (let attempt = 1; attempt <= SPAWN_RETRY_ATTEMPTS; attempt += 1) {
          const result = await this.runBackgroundSpawnAttempt(prepared, attempt);
          if (result === "completed") {
            return;
          }
        }
      })();
    });
    return placeholder;
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
      });
    }

    const readySession = await this.ensureSessionReadyForSend(session);
    const sendState = agentBusyQueuedSendAwaitsPrompt(readySession.agent)
      ? await this.classifySessionState(readySession)
      : "waiting";
    const updated = withQueuedMessages(
      {
        ...readySession,
        status: "running",
        updatedAt: nowIso(),
      },
      [...queuedMessages(readySession), finalMessage],
      readySession.queuedMessages?.awaitingPrompt === true || sendState !== "waiting",
    );
    writeSession(this.config.dataDir, updated);
    this.logEvent("session.message.queued", {
      level: "info",
      sessionId,
      projectId: updated.project,
      message: `Queued message for ${sessionId}`,
      details: {
        queuedCount: queuedMessages(updated).length,
        messageLength: finalMessage.length,
      },
    });
    if (updated.queuedMessages?.awaitingPrompt !== true) {
      await this.tryDeliverQueuedMessage(sessionId);
    }
    this.scheduleDeliveryRunner(sessionId);
    return this.enrich(readSession(this.config.dataDir, sessionId) ?? updated);
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

    return this.deliverPrepared(sessionId, message, options);
  }

  private async deliverPrepared(
    sessionId: string,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<SessionView> {
    const initialSession = readSession(this.config.dataDir, sessionId);
    try {
      if (!initialSession) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const readySession = await this.ensureSessionReadyForSend(initialSession);
      let interrupt = options?.interrupt === true;
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
      const failure = error instanceof Error ? error.message : String(error);
      this.logEvent("session.message.failed", {
        level: "error",
        sessionId,
        ...(initialSession ? { projectId: initialSession.project } : {}),
        message: `Failed to deliver message to ${sessionId}: ${failure}`,
        details: {
          interrupt: options?.interrupt === true,
        },
      });
      throw error;
    }
  }

  private storeImageAttachments(
    sessionId: string,
    attachments: SendMessageAttachment[] | undefined,
  ): Array<{ id: string; path: string }> {
    if (!attachments || attachments.length === 0) {
      return [];
    }
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
    }

    const attachDir = ensureSessionArtifactsDir(this.config.dataDir, sessionId);
    const stored: Array<{ id: string; path: string }> = [];
    for (const [index, att] of attachments.entries()) {
      if (typeof att.name !== "string" || !NAME_RE.test(att.name)) {
        throw new Error(`Invalid attachment name: ${String(att.name)}`);
      }
      const ext = extname(att.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        throw new Error(`Unsupported attachment extension: ${ext}`);
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
      stored.push({ id: filename, path: filePath });
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
    session: Pick<SessionRecord, "id">,
    request: SendMessageRequest,
  ): string {
    const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (!hasAttachments) {
      return message;
    }

    const stored = this.storeImageAttachments(session.id, request.attachments);
    const prefixLines = buildAttachmentReferenceLines(stored.map((attachment) => attachment.id));
    return prefixLines.join("\n") + (message ? `\n${message}` : "");
  }

  async pause(sessionId: string): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "stopped");
  }

  private async sendAgentMessage(
    session: Pick<SessionRecord, "id" | "tmuxSession" | "agent" | "launchCommand">,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<void> {
    const sessionToolDir = join(this.config.dataDir, "session-tools", session.id);
    const codexSessionsDir = agentWaitsForSubmitAck(session.agent)
      ? join(codexHookHomePath(sessionToolDir), "sessions")
      : null;
    const baseline: RolloutBaseline | null = codexSessionsDir
      ? await captureCodexRolloutBaseline(codexSessionsDir)
      : null;
    const startedAt = Date.now();
    await sendMessageToTmux(session.tmuxSession, message, {
      agent: session.agent,
      ...(options?.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
    });
    if (!agentWaitsForSubmitAck(session.agent) || !codexSessionsDir || !baseline) {
      return;
    }
    let lastResult: { found: boolean; lastScannedFile: string | null } = {
      found: false,
      lastScannedFile: null,
    };
    for (let attempt = 0; attempt <= CODEX_SUBMIT_RETRY_LIMIT; attempt += 1) {
      lastResult = await this.waitForCodexRolloutAck(codexSessionsDir, message, baseline);
      if (lastResult.found) {
        return;
      }
      if (attempt < CODEX_SUBMIT_RETRY_LIMIT) {
        await sendSubmitKeyToTmux(session.tmuxSession);
      }
    }
    const processAlive = await isProcessRunningInTmux(
      session.tmuxSession,
      sessionProcessMatchers(session),
    );
    this.logEvent("session.codex.submit.timeout", {
      level: "warn",
      sessionId: session.id,
      message: `Codex submit ack timed out for ${session.id}`,
      details: {
        lastScannedFile: lastResult.lastScannedFile,
        messageLength: message.length,
        elapsedMs: Date.now() - startedAt,
        processAlive,
      },
    });
    throw new Error(`Timed out waiting for Codex submit acknowledgment for ${session.id}`);
  }

  private async waitForCodexRolloutAck(
    sessionsDir: string,
    messageText: string,
    baseline: RolloutBaseline,
  ): Promise<{ found: boolean; lastScannedFile: string | null }> {
    const deadline = Date.now() + CODEX_SUBMIT_ACK_TIMEOUT_MS;
    let lastResult: { found: boolean; lastScannedFile: string | null } = {
      found: false,
      lastScannedFile: null,
    };
    while (Date.now() < deadline) {
      lastResult = await scanCodexRolloutForMessage(sessionsDir, messageText, baseline);
      if (lastResult.found) {
        return lastResult;
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }
    return lastResult;
  }

  async complete(sessionId: string, options?: { retainInList?: boolean }): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "completed", options);
  }

  async updateSlots(sessionId: string, request: UpdateSessionSlotsRequest): Promise<SessionView> {
    const currentSession = readSession(this.config.dataDir, sessionId);
    if (!currentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const session = currentSession;
    const normalized = normalizeSlotsUpdate(request);
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
      genericUnlinks.length > 0;
    const slots = hasGenericChanges
      ? applySlotsUpdate(session.slots, {
          ...(normalized.title !== undefined ? { title: normalized.title } : {}),
          ...(normalized.clearTitle ? { clearTitle: true } : {}),
          ...(genericLinks.length > 0 ? { links: genericLinks } : {}),
          ...(genericUnlinks.length > 0 ? { unlinkLabels: genericUnlinks } : {}),
        })
      : session.slots;
    const updated: SessionRecord = {
      ...session,
      ...(slots ? { slots } : {}),
      ...(nativePr
        ? { pr: nativePr }
        : normalized.unlinkLabels.includes("pr")
          ? {}
          : session.pr
            ? { pr: session.pr }
            : {}),
    };
    if (!slots) {
      delete updated.slots;
    }
    if (prLink === undefined && normalized.unlinkLabels.includes("pr")) {
      delete updated.pr;
    }
    writeSession(this.config.dataDir, updated);
    const displaySlots = deriveSessionSlots(updated);
    await syncTmuxStatus(updated.tmuxSession, displaySlots);
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

    if (await sidecarTmuxAlive(sessionId, sidecarName)) {
      return this.enrich(session);
    }

    const updated = await this.startSidecarInternal({
      session,
      project,
      sidecarName,
      sidecar,
      sidecarDepth,
    });
    this.logEvent("session.sidecar.started", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Started sidecar ${sidecarName} for ${sessionId}`,
      details: {
        callerSidecarName: caller.name ?? null,
        sidecarName,
        sidecarDepth,
        command: sidecar.command,
        manualOnly: sidecarDepth > ROOT_SIDECAR_DEPTH,
        tmuxSession: sidecarTmuxSession(sessionId, sidecarName),
      },
    });
    this.maybeStartSidecarUrlProbe(sessionId, sidecarName, sidecar, updated);
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

    this.stopSidecarProbe(sessionId, sidecarName);
    await killSidecarTmux(sessionId, sidecarName);

    const afterKill = readSession(this.config.dataDir, sessionId) ?? session;
    const nextSlots = applySlotsUpdate(afterKill.slots, { unlinkLabels: [sidecarName] });
    const baseRecord: SessionRecord =
      nextSlots !== afterKill.slots
        ? nextSlots
          ? { ...afterKill, slots: nextSlots }
          : (() => {
              const { slots: _drop, ...rest } = afterKill;
              return rest;
            })()
        : afterKill;
    const updated: SessionRecord = {
      ...baseRecord,
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    if (nextSlots !== afterKill.slots) {
      await syncTmuxStatus(updated.tmuxSession, updated.slots);
    }
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

  private async cleanupSessionServices(session: SessionRecord): Promise<void> {
    const project = this.resolveProjectForSession(session);
    for (const scName of sessionSidecarNames(session, project)) {
      this.stopSidecarProbe(session.id, scName);
      const record = readSession(this.config.dataDir, session.id);
      if (record) {
        const next = applySlotsUpdate(record.slots, { unlinkLabels: [scName] });
        if (next !== record.slots) {
          const updated: SessionRecord = next
            ? { ...record, slots: next }
            : (() => {
                const { slots: _drop, ...rest } = record;
                return rest;
              })();
          writeSession(this.config.dataDir, updated);
          await syncTmuxStatus(updated.tmuxSession, updated.slots);
        }
      }
      await killSidecarTmux(session.id, scName).catch(() => {});
    }
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      await killTmuxSession(service.tmuxSession);
    }
    deleteServiceSourceStatesForSession(this.config.dataDir, session.project, session.id);
    deleteServiceInstancesForSession(this.config.dataDir, session.id);
  }

  private prepareSessionTools(sessionId: string, agent: AgentName): string {
    return ensureSessionSlotTool({
      dataDir: this.config.dataDir,
      sessionId,
      configPath: this.config.configPath,
      agent,
    });
  }

  private removeSessionArtifacts(sessionId: string, options?: { preserveStartup?: boolean }): void {
    const session = options?.preserveStartup ? readSession(this.config.dataDir, sessionId) : null;
    deleteAgentHookState(this.config.dataDir, sessionId);
    deleteRuntimeLogCursorsForSession(this.config.dataDir, sessionId);
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
    options?: { retainInList?: boolean },
  ): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
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
      writeSession(this.config.dataDir, migrated);
      this.stateCache.delete(sessionId);
      return this.enrich(migrated);
    }
    if (session.status === targetStatus) {
      return this.enrich(session);
    }
    if (isTerminalSessionStatus(session.status)) {
      throw new Error(`Session ${sessionId} is already ${session.status}`);
    }
    const eventAction = targetStatus === "stopped" ? "pause" : "complete";

    try {
      await killTmuxSession(session.tmuxSession);
      await this.cleanupSessionServices(session);
      if (targetStatus === "completed") {
        if (session.worktree && session.worktreePath && workspaceExists(session.worktreePath)) {
          const cleanup = await this.resolveCleanupContext(session);
          await removeWorktree(cleanup.repoPath, session.worktreePath);
        }
        this.removeSessionArtifacts(sessionId);
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
    const record: SessionRecord = {
      ...copySessionWithoutSidecarPorts(session),
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
    delete record.sidecarPorts;
    writeSession(this.config.dataDir, record);
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

  async kill(sessionId: string, request: KillSessionRequest = {}): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status === "completed") {
      throw new Error(`Session ${sessionId} is already completed`);
    }

    if (session.worktree && session.worktreePath && workspaceExists(session.worktreePath)) {
      const cleanup = await this.resolveCleanupContext(session);
      const reasons: string[] = [];
      if (await hasUncommittedChanges(session.worktreePath, cleanup.symlinks)) {
        reasons.push("uncommitted changes in its worktree");
      }
      if (await hasUnpushedCommits(session.worktreePath)) {
        reasons.push("unpushed commits");
      }
      if (reasons.length > 0 && request.force !== true) {
        throw new Error(buildKillConfirmationRequiredMessage(sessionId, reasons));
      }
    }

    try {
      await killTmuxSession(session.tmuxSession);
      await this.cleanupSessionServices(session);
      if (session.worktree && session.worktreePath && workspaceExists(session.worktreePath)) {
        const cleanup = await this.resolveCleanupContext(session);
        await removeWorktree(cleanup.repoPath, session.worktreePath);
      }
      this.removeSessionArtifacts(sessionId, { preserveStartup: true });
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

    const record: SessionRecord = {
      ...copySessionWithoutSidecarPorts(session),
      status: "killed",
      updatedAt: nowIso(),
    };
    delete record.retainInList;
    delete record.sidecarPorts;
    writeSession(this.config.dataDir, record);
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
    const sessionToolDir = this.prepareSessionTools(session.id, session.agent);
    const hookSetup = await setupAgentHooks({
      agent: session.agent,
      worktreePath: session.worktreePath,
      sessionToolDir,
    });
    const sessionAgentConfig = this.sessionAgentConfig(session);
    const planMode = resolvePlanMode(session);
    const project = this.getProject(session.project);
    const planOptions = withPlanMode(
      withProjectAgentOptions(project, {
        ...hookSetup,
        ...(sessionAgentConfig.planOptions ?? {}),
      }),
      planMode,
    );
    const baseLaunchPlan = buildAgentLaunchPlan(session.agent, session.prompt, planOptions);
    const baseLaunchCommand = baseLaunchPlan.launchCommand;
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
      await syncTmuxStatus(session.tmuxSession, deriveSessionSlots(session));
      await waitForTmuxReady(
        session.tmuxSession,
        recoveryPlan?.readyMarkers ?? baseLaunchPlan.readyMarkers,
        undefined,
        { agent: session.agent },
      );
      if (
        !(await isProcessRunningInTmux(
          session.tmuxSession,
          agentProcessMatchers(session.agent, recoveryPlan?.launchCommand ?? baseLaunchCommand),
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
      recoveredAgentSessionId = undefined;
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: baseLaunchCommand,
        agent: session.agent,
        env,
      });
      await syncTmuxStatus(session.tmuxSession, deriveSessionSlots(session));
      await waitForTmuxReady(session.tmuxSession, baseLaunchPlan.readyMarkers, undefined, {
        agent: session.agent,
      });
      if (
        !(await isProcessRunningInTmux(
          session.tmuxSession,
          agentProcessMatchers(session.agent, baseLaunchCommand),
        ))
      ) {
        throw new Error(`Agent ${session.agent} exited before recovery became ready`, {
          cause: error,
        });
      }
    }

    this.stateCache.delete(session.id);
    const { error: _ignoredError, ...recoveredBase } = sessionWithAgentId;
    const recovered: SessionRecord = {
      ...recoveredBase,
      planMode,
      ...(recoveredAgentSessionId ? { agentSessionId: recoveredAgentSessionId } : {}),
      launchCommand: baseLaunchCommand,
      status: "running",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, recovered);
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
      throw new Error(`Session is not restorable: ${sessionId}`);
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
    let restoredLaunchCommand: string;

    try {
      const sessionToolDir = this.prepareSessionTools(current.id, current.agent);
      const hookSetup = await setupAgentHooks({
        agent: current.agent,
        worktreePath: current.worktreePath,
        sessionToolDir,
      });
      const sessionAgentConfig = this.sessionAgentConfig(current);
      const planMode = resolvePlanMode(current);
      const shouldSendRestoreMessage =
        current.status !== "paused" && current.stopReason !== "manual_pause";
      const restorePrompt = shouldSendRestoreMessage
        ? buildRestorePrompt(current.prompt, planMode)
        : "";
      const restoreProjectConfig = this.getProject(current.project);
      const planOptions = withPlanMode(
        withProjectAgentOptions(restoreProjectConfig, {
          ...hookSetup,
          ...(sessionAgentConfig.planOptions ?? {}),
        }),
        planMode,
      );
      const launchPlan = await waitForRestorePlan(
        current.agent,
        current.worktreePath,
        restorePrompt,
        planOptions,
      );
      const effectivePlan =
        launchPlan ?? buildAgentLaunchPlan(current.agent, restorePrompt, planOptions);
      await killTmuxSession(current.tmuxSession);
      let restoreLaunchCommand = effectivePlan.launchCommand;
      let restoreReadyMarkers = effectivePlan.readyMarkers;
      let restoredAgentSessionId = current.agent === "cursor" ? current.agentSessionId : undefined;
      if (launchPlan) {
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
      if (!launchPlan && !restoredAgentSessionId) {
        this.logEvent("session.restore.started", {
          level: "info",
          sessionId,
          projectId: current.project,
          message: `No native resume state for ${sessionId}, falling back to fresh launch`,
          details: { agent: current.agent, worktreePath: current.worktreePath },
        });
      }
      if (restoredAgentSessionId) {
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
      await syncTmuxStatus(current.tmuxSession, deriveSessionSlots(current));
      await waitForTmuxReady(current.tmuxSession, restoreReadyMarkers, undefined, {
        agent: current.agent,
      });
      if (
        !(await isProcessRunningInTmux(
          current.tmuxSession,
          agentProcessMatchers(current.agent, restoreLaunchCommand),
        ))
      ) {
        throw new Error(`Agent ${current.agent} exited before restore became ready`);
      }
      if (shouldSendRestoreMessage && effectivePlan.initialMessage.trim()) {
        const restoreInitialMessage = buildInitialMessage(
          effectivePlan.initialMessage,
          restoreSidecarNames,
        );
        await this.sendAgentMessage(current, restoreInitialMessage);
      }
    } catch (error) {
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
    const restored: SessionRecord = {
      ...restoredBase,
      planMode: resolvePlanMode(current),
      launchCommand: restoredLaunchCommand,
      status: "running",
      updatedAt: nowIso(),
    };
    delete restored.stopReason;
    const persistedRestored = await this.captureAgentSessionId(
      restored,
      AGENT_SESSION_ID_REFRESH_WAIT_MS,
    );
    writeSession(this.config.dataDir, persistedRestored);
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
    if (this.shouldRunDelivery(persistedRestored)) {
      this.scheduleDeliveryRunner(persistedRestored.id);
    }
    return this.enrich(persistedRestored);
  }

  async respawn(
    sessionId: string,
    request: {
      prompt?: string;
      attachments?: SendMessageAttachment[];
      startupAttachmentIds?: string[];
    } = {},
  ): Promise<SessionView> {
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
    return this.spawn(
      resolveRespawnRequest(session, {
        ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
        ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
      }),
    );
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
    const agentState = await this.classifySessionState(readySession);
    if (agentState !== "waiting") {
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

    await this.sendAgentMessage(latest, nextMessage, { interrupt: false });
    this.stateCache.delete(sessionId);
    const updated = withQueuedMessages(
      {
        ...latest,
        status: "running",
        updatedAt: nowIso(),
      },
      queuedMessages(latest).slice(1),
      true,
    );
    const persisted = await this.captureAgentSessionId(updated, AGENT_SESSION_ID_REFRESH_WAIT_MS);
    writeSession(this.config.dataDir, persisted);
    this.logEvent("session.message.sent", {
      level: "info",
      sessionId,
      projectId: latest.project,
      message: `Delivered message to ${sessionId}`,
      details: {
        interrupt: false,
        messageLength: nextMessage.length,
        agentSessionId: persisted.agentSessionId ?? null,
      },
    });
    return true;
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
    await sleep(PIPELINE_POLL_INTERVAL_MS);
    if (await tmuxSessionExists(session.tmuxSession)) {
      return !(await isProcessRunningInTmux(session.tmuxSession, sessionProcessMatchers(session)));
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
  }> {
    const hookState = readAgentHookState(this.config.dataDir, sessionId);
    const rolloutState = await readCodexRolloutState(this.codexSessionsDir(sessionId));
    let state: SessionState = hookState?.state ?? "waiting";
    let source: StateSource = hookState ? "hook" : "status";

    if (rolloutState && shouldUseCodexRolloutState(hookState, rolloutState)) {
      state = rolloutState.state;
      source = "jsonl";
    }

    return {
      state,
      source,
      hookState,
      rolloutState,
    };
  }

  private async readRuntimeSnapshot(
    session: Pick<SessionRecord, "tmuxSession" | "agent" | "launchCommand">,
  ): Promise<SessionRuntimeSnapshot> {
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    const tmuxActivityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
    const processAlive = runtimeAlive
      ? await isProcessRunningInTmux(session.tmuxSession, sessionProcessMatchers(session))
      : false;
    return {
      runtimeAlive,
      processAlive,
      tmuxActivityAt,
    };
  }

  private async reconcileUnexpectedStop(
    session: SessionRecord,
    runtime: SessionRuntimeSnapshot,
    reason: "boot" | "runtime_check",
  ): Promise<{ session: SessionRecord; runtime: SessionRuntimeSnapshot }> {
    if (session.status !== "running" && session.status !== "spawning") {
      return { session, runtime };
    }
    if (reason === "runtime_check" && session.status === "spawning") {
      return { session, runtime };
    }
    if (runtime.runtimeAlive && runtime.processAlive) {
      return { session, runtime };
    }
    if (!(await this.confirmAgentExited(session))) {
      return {
        session,
        runtime: await this.readRuntimeSnapshot(session),
      };
    }

    const latest = readSession(this.config.dataDir, session.id);
    if (!latest) {
      return { session, runtime };
    }
    if (latest.status !== session.status) {
      return { session: latest, runtime };
    }

    const updated: SessionRecord = {
      ...latest,
      status: "stopped",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    this.stateCache.delete(session.id);
    this.logEvent(reason === "boot" ? "session.reconcile.drift" : "session.runtime.stopped", {
      level: reason === "boot" ? "warn" : "info",
      sessionId: session.id,
      projectId: session.project,
      message:
        reason === "boot"
          ? `Drift: ${session.id} status=${session.status} but runtime is no longer alive`
          : `Marked ${session.id} stopped after runtime exit`,
      details: {
        previousStatus: session.status,
        tmuxSession: session.tmuxSession,
        agent: session.agent,
        runtimeAlive: runtime.runtimeAlive,
        processAlive: runtime.processAlive,
        reason,
      },
    });
    return {
      session: updated,
      runtime,
    };
  }

  private async classifySessionRecord(session: SessionRecord): Promise<SessionStateResult> {
    let runtime = await this.readRuntimeSnapshot(session);
    let effectiveSession = session;
    let state: SessionState;
    let stateSource: StateSource = "status";
    let historySourcePath: string | null = null;
    if (effectiveSession.status === "running" || effectiveSession.status === "spawning") {
      const reconciled = await this.reconcileUnexpectedStop(
        effectiveSession,
        runtime,
        "runtime_check",
      );
      effectiveSession = reconciled.session;
      runtime = reconciled.runtime;
    }

    if (effectiveSession.status === "killed") {
      state = "killed";
    } else if (
      effectiveSession.status === "stopped" ||
      effectiveSession.status === "paused" ||
      effectiveSession.status === "completed"
    ) {
      state = "stopped";
    } else if (effectiveSession.status === "errored") {
      state = "error";
    } else if (effectiveSession.status === "spawning") {
      state = "working";
    } else if (!runtime.runtimeAlive || !runtime.processAlive) {
      state = "stopped";
    } else {
      const strategy = agentStateStrategy(session.agent);
      if (strategy === "claude_jsonl") {
        const jsonlResult = await readClaudeJsonlState(
          session.worktreePath,
          this.claudeJsonlReaders.get(session.id),
        );
        if (jsonlResult) {
          this.claudeJsonlReaders.set(session.id, jsonlResult.reader);
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
            message: `State: ${state} (no jsonl)`,
          });
        }
      } else if (strategy === "hook") {
        const codexState = await this.classifyCodexState(session.id);
        state = codexState.state;
        stateSource = codexState.source;
        if (stateSource === "jsonl" && codexState.rolloutState) {
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
        stateSource = "pane";
        const pane = await captureTmuxPane(session.tmuxSession);
        const classified = classifyCursorPaneState({
          pane,
          activityAt: runtime.tmuxActivityAt,
        });
        state = classified.state;
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: ${state} (cursor pane: ${classified.reason})`,
        });
      }
    }

    return {
      session: effectiveSession,
      runtime,
      state,
      source: stateSource,
      historySourcePath,
    };
  }

  private async enrich(session: SessionRecord): Promise<SessionView> {
    const classified = await this.classifySessionRecord(session);
    session = classified.session;
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    const updatedAt = new Date(session.updatedAt);
    const tmuxActivityAt = classified.runtime.tmuxActivityAt;
    const lastActivityAt = (latestActivityAt(updatedAt, tmuxActivityAt) ?? updatedAt).toISOString();
    let state = classified.state;
    const stateSource = classified.source;
    const historySourcePath = classified.historySourcePath ?? null;

    // State debounce: suppress single-poll flicker for running sessions.
    const cached = this.stateCache.get(session.id);
    const now = Date.now();
    let classifiedAt = now;
    if (cached && state !== cached.state && now - cached.classifiedAt < STATE_HOLD_MS) {
      if (
        state !== "needs_input" &&
        state !== "stopped" &&
        state !== "killed" &&
        state !== "error"
      ) {
        state = cached.state;
        classifiedAt = cached.classifiedAt;
      }
    }
    this.stateCache.set(session.id, { state, classifiedAt });

    // State history: ring buffer of transitions.
    const history = this.stateHistory.get(session.id) ?? [];
    const lastEntry = history[history.length - 1];
    if (history.length === 0 || lastEntry?.state !== state) {
      const transitionAt = new Date(now).toISOString();
      history.push({ state, at: transitionAt, source: stateSource });
      if (history.length > STATE_HISTORY_LIMIT) {
        history.splice(0, history.length - STATE_HISTORY_LIMIT);
      }
      this.stateHistory.set(session.id, history);
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
      }
    }

    const services: ServiceInstanceView[] = [];
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      services.push(await this.enrichService(service));
    }

    const project = this.resolveProjectForSession(session);
    const sidecars: { name: string; alive: boolean }[] = [];
    for (const name of sessionSidecarNames(session, project)) {
      sidecars.push({ name, alive: await sidecarTmuxAlive(session.id, name) });
    }
    const queuedMessagesView = displayQueuedMessages(session);
    const workspaceAccess = buildWorkspaceAccess(session, project, workspacePresent);
    const displaySlots = deriveSessionSlots(session);

    return {
      ...session,
      planMode: resolvePlanMode(session),
      ...(displaySlots ? { slots: displaySlots } : {}),
      runtimeAlive: classified.runtime.runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      ...(history.length > 0 ? { stateHistory: history } : {}),
      lastActivityAt,
      artifacts: listSessionArtifacts(this.config.dataDir, session.id),
      services,
      sidecars,
      ...(workspaceAccess ? { workspaceAccess } : {}),
      ...(queuedMessagesView ? { queuedMessages: queuedMessagesView } : {}),
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
