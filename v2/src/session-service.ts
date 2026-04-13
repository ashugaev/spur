import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAgentLaunchPlan,
  buildAgentRestorePlan,
  buildAgentResumePlan,
  findAgentSessionId,
  parseAgentName,
  setupAgentHooks,
} from "./agents/index.js";
import { deleteAgentHookState, readAgentHookState } from "./agent-hook-state.js";
import {
  readClaudeConversation,
  readClaudeJsonlState,
  type ClaudeJsonlReaderState,
} from "./claude-jsonl-state.js";
import { findProjectConfigPath, loadProjectConfig } from "./config.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { reserveNextSessionId } from "./ids.js";
import { sendDesktopNotification } from "./desktop-notify.js";
import {
  deleteSessionGroup,
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
  writeSessionGroup,
  writeSession,
} from "./metadata.js";
import { runSpawnPreflight } from "./preflight.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";
import { PIPELINE_STEP_TIMEOUT_MS, formatPipelineStepMessage } from "./pipeline.js";
import {
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
  removeSessionSlotTool,
  withSessionSlotInstructions,
} from "./session-slots.js";
import { buildMergedConfig, upsertConfigRegistryPath, writeConfigRegistry } from "./registry.js";
import {
  SPUR_DAEMON_API_VERSION,
  type AgentName,
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
  type SendMessageRequest,
  type SessionGroupRecord,
  type SessionRecord,
  type SessionStatus,
  type SessionState,
  type SessionView,
  type SessionStateTransition,
  type SpawnResult,
  type SpawnOverrides,
  type SpawnSessionMemberRequest,
  type SpawnSessionRequest,
  type StateSource,
  type UpdateSessionSlotsRequest,
} from "./types.js";
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
import { gh } from "./gh.js";

const KILL_CONFIRMATION_REQUIRED_PREFIX = "Kill confirmation required";
const PIPELINE_POLL_INTERVAL_MS = 1_000;
const PIPELINE_STEP_DELAY_MS = 30_000;
const PIPELINE_READY_GRACE_MS = 2_000;
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
const CODEX_SUBMIT_ACK_TIMEOUT_MS = 5_000;
const CODEX_SUBMIT_RETRY_LIMIT = 1;
const ATTENTION_POLL_INTERVAL_MS = 5_000;
const PR_CHECK_THROTTLE_MS = 30_000;
const PR_CHECK_WAITING_LIMIT = 5;

interface PrCheckTracker {
  waitingChecks: number;
  lastState: SessionState | null;
  lastCheckAt: number;
  found: boolean;
}

const RESTORE_PROMPT_PREFIX =
  "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:";
type ManualSessionStatus = "paused" | "completed";
type AttentionState = "needs_input" | "error";
interface SessionCleanupContext {
  repoPath: string;
  symlinks: string[];
}

function isTerminalSessionStatus(status: SessionStatus): status is "completed" | "killed" {
  return status === "completed" || status === "killed";
}

function isRestorableStatus(status: SessionStatus): boolean {
  return status === "running" || status === "paused";
}

type PipelineWaitOutcome = "ready" | "stopped" | "exited" | "timeout";

function nowIso(): string {
  return new Date().toISOString();
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
  members?: SpawnSessionMemberRequest[];
} {
  const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
  if (request.agent !== undefined && request.members !== undefined) {
    throw new Error("agent and members cannot be combined");
  }
  const steps = (prompt ? (request.steps ?? defaultSteps) : undefined)?.map((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`steps[${index}] must be a non-empty string`);
    }
    return step.trim();
  });
  const members = request.members?.map((member, index) => {
    if (!member || typeof member !== "object") {
      throw new Error(`members[${index}] must be an object`);
    }
    const parsedAgent = parseAgentName(member.agent);
    if (
      member.branch !== undefined &&
      (typeof member.branch !== "string" || !member.branch.trim())
    ) {
      throw new Error(`members[${index}].branch must be a non-empty string when provided`);
    }
    if (member.name !== undefined && (typeof member.name !== "string" || !member.name.trim())) {
      throw new Error(`members[${index}].name must be a non-empty string when provided`);
    }
    return {
      agent: parsedAgent,
      ...(member.branch?.trim() ? { branch: member.branch.trim() } : {}),
      ...(member.name?.trim() ? { name: member.name.trim() } : {}),
    };
  });
  if (members !== undefined && members.length === 0) {
    throw new Error("members must contain at least one entry");
  }
  const normalized = {
    prompt,
    planMode: request.planMode === true,
    ...(members ? { members } : {}),
  };
  if (!prompt) {
    return normalized;
  }
  if (!steps || steps.length === 0) {
    return normalized;
  }
  return { ...normalized, steps };
}

function resolvePlanMode(session: Pick<SessionRecord, "planMode">): boolean {
  return session.planMode === true;
}

function withPlanMode(
  options: { claudeSettingsPath?: string; codexHomePath?: string },
  planMode: boolean,
): { claudeSettingsPath?: string; codexHomePath?: string; planMode?: boolean } {
  return planMode ? { ...options, planMode: true } : options;
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

function isFresh(timestamp: Date, thresholdMs: number): boolean {
  return Date.now() - timestamp.getTime() <= thresholdMs;
}

function hookStateTimestampMs(updatedAt: string | undefined): number | null {
  if (!updatedAt) {
    return null;
  }
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function hookStateFileAdvanced(
  baseline: ReturnType<typeof readAgentHookState>,
  current: ReturnType<typeof readAgentHookState>,
): boolean {
  if (!baseline || !current) {
    return false;
  }
  return (
    typeof baseline.fileMtimeMs === "number" &&
    typeof current.fileMtimeMs === "number" &&
    current.fileMtimeMs > baseline.fileMtimeMs
  );
}

function isCodexSubmitAcknowledged(
  baseline: ReturnType<typeof readAgentHookState>,
  current: ReturnType<typeof readAgentHookState>,
): boolean {
  if (!current) {
    return false;
  }
  if (!baseline) {
    return current.hookEvent === "UserPromptSubmit";
  }
  if (current.turnId && baseline.turnId && current.turnId !== baseline.turnId) {
    return true;
  }
  if (hookStateFileAdvanced(baseline, current)) {
    return true;
  }
  const baselineMs = hookStateTimestampMs(baseline.updatedAt);
  const currentMs = hookStateTimestampMs(current.updatedAt);
  const advanced =
    baselineMs === null || currentMs === null
      ? current.updatedAt !== baseline.updatedAt
      : currentMs > baselineMs;
  if (!advanced) {
    return false;
  }
  // Codex can emit UserPromptSubmit and then quickly overwrite the hook state with
  // a follow-up event (for example Stop) before the daemon polls. Any newer hook
  // record after the pre-send baseline means Codex observed and processed the submit.
  return true;
}

function buildInitialMessage(initialMessage: string, sidecarNames: string[]): string {
  const base = withSessionSlotInstructions(initialMessage);
  if (sidecarNames.length === 0) return base;
  const names = sidecarNames.map((n) => `\`${n}\``).join(", ");
  return `${base}\n\nSidecars: use Sidecar for testing by default. Run \`"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>\` to start one. Do not start app, dev server, or test helper processes directly with \`pnpm\`, \`next\`, or similar commands unless the user explicitly tells you to bypass Sidecar. See \`v2/README.md\` for sidecar usage. Available: ${names}.`;
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

export function buildRestorePrompt(prompt: string): string {
  return `${RESTORE_PROMPT_PREFIX}\n\n${prompt}`;
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
}): Record<string, string> {
  const env: Record<string, string> = {
    SPUR_SESSION: args.sessionId,
    SPUR_PROJECT: args.projectId,
    SPUR_AGENT: args.agent,
    SPUR_SESSION_TOOL_DIR: args.sessionToolDir,
    SPUR_SLOT_COMMAND: join(args.sessionToolDir, SLOT_TOOL_NAME),
    SPUR_AGENT_STATE_COMMAND: join(args.sessionToolDir, AGENT_STATE_TOOL_NAME),
    SPUR_AGENT_STATE_FILE: join(args.dataDir, "session-agent-state", `${args.sessionId}.json`),
    PATH: `${args.sessionToolDir}:${process.env["PATH"] ?? ""}`,
  };
  if (
    args.symlinks.includes("node_modules") &&
    (existsSync(join(args.repoPath, "pnpm-lock.yaml")) ||
      existsSync(join(args.repoPath, "pnpm-workspace.yaml")))
  ) {
    env["npm_config_virtual_store_dir"] = join(args.repoPath, "node_modules/.pnpm");
  }
  return env;
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

function reserveSidecarPorts(
  dataDir: string,
  sidecars: ProjectConfig["sidecars"],
): SessionRecord["sidecarPorts"] | undefined {
  const unavailable = new Set<number>();
  for (const service of listServiceInstances(dataDir)) {
    if (service.port !== undefined) {
      unavailable.add(service.port);
    }
  }
  for (const session of listSessions(dataDir)) {
    for (const port of collectReservedSidecarPorts(session)) {
      unavailable.add(port);
    }
  }

  const reserved: NonNullable<SessionRecord["sidecarPorts"]> = {};
  for (const [sidecarName, sidecar] of Object.entries(sidecars)) {
    if (!sidecar.ports) continue;
    const reservedEnvPorts: Record<string, number> = {};
    for (const [portId, portConfig] of Object.entries(sidecar.ports)) {
      let selectedPort: number | undefined;
      for (let candidate = portConfig.start; candidate <= portConfig.end; candidate += 1) {
        if (unavailable.has(candidate)) continue;
        selectedPort = candidate;
        unavailable.add(candidate);
        break;
      }
      if (selectedPort === undefined) {
        throw new Error(
          `No free reserved port for sidecar ${sidecarName}.${portId} in range ${portConfig.start}-${portConfig.end}`,
        );
      }
      reservedEnvPorts[portConfig.env] = selectedPort;
    }
    if (Object.keys(reservedEnvPorts).length > 0) {
      reserved[sidecarName] = reservedEnvPorts;
    }
  }

  return Object.keys(reserved).length > 0 ? reserved : undefined;
}

function sidecarPortEnv(
  session: Pick<SessionRecord, "sidecarPorts">,
  sidecarName: string,
): Record<string, string> {
  const entries = Object.entries(session.sidecarPorts?.[sidecarName] ?? {});
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

async function waitForRestorePlan(
  agent: SessionRecord["agent"],
  worktreePath: string,
  restoreMessage: string,
  options?: { claudeSettingsPath?: string; codexHomePath?: string; planMode?: boolean },
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

function resolveRespawnRequest(session: SessionRecord): SpawnSessionRequest {
  return {
    project: session.project,
    prompt: session.prompt,
    agent: session.agent,
    ...(session.planMode !== undefined && { planMode: session.planMode }),
    ...(session.pipeline?.steps && { steps: session.pipeline.steps }),
    overrides: { worktree: session.worktree },
    ...(session.worktree && session.branchSource === "explicit" ? { branch: session.branch } : {}),
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
    entry: Omit<SpurLogEntry, "timestamp" | "event"> = { level: "info" },
  ): void {
    logSpurEvent(this.config.dataDir, { event, ...entry });
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
    // Skip if PR slot already exists
    if (session.slots?.links.some((link) => link.label === "pr")) {
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
    const raw = await gh(
      session.worktreePath,
      "pr",
      "list",
      "--head",
      session.branch,
      "--json",
      "url",
      "--limit",
      "1",
    );
    const prs: Array<{ url: string }> = JSON.parse(raw);
    const pr = prs[0];
    if (!pr?.url) {
      return;
    }

    const tracker = this.prCheckTrackers.get(session.id);
    if (tracker) {
      tracker.found = true;
    }

    // Re-read session to avoid stale overwrites
    const current = readSession(this.config.dataDir, session.id);
    if (!current || current.slots?.links.some((link) => link.label === "pr")) {
      return;
    }

    const slots = applySlotsUpdate(current.slots, {
      links: [{ label: "pr", url: pr.url }],
    });
    const updated: SessionRecord = { ...current, ...(slots ? { slots } : {}) };
    writeSession(this.config.dataDir, updated);
    await syncTmuxStatus(updated.tmuxSession, updated.slots);
    this.logEvent("session.pr_auto_detect.found", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Auto-detected PR for ${session.id}: ${pr.url}`,
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

  private async resolveCleanupContext(session: SessionRecord): Promise<SessionCleanupContext> {
    const currentProject = this.config.projects[session.project];
    if (currentProject) {
      return {
        repoPath: currentProject.path,
        symlinks: currentProject.symlinks,
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
      symlinks: this.findProjectByRepoPath(repoPath)?.symlinks ?? [],
    };
  }

  async list(): Promise<SessionView[]> {
    const sessions = listSessions(this.config.dataDir).filter(
      (session) => !isTerminalSessionStatus(session.status) || session.retainInList === true,
    );
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

  async getConversation(sessionId: string): Promise<ConversationResponse> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const durationMs = Date.now() - new Date(session.createdAt).getTime();
    const fallback: ConversationResponse = { messages: [], durationMs, state: "working" };
    if (session.agent !== "claude") return fallback;
    const result = await readClaudeConversation(session.worktreePath);
    return result ? { ...result, durationMs } : fallback;
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

  async spawn(request: SpawnSessionRequest): Promise<SpawnResult> {
    try {
      const project = this.getProject(request.project);
      const { prompt, steps, planMode, members } = normalizeSpawnRequest(
        request,
        project.spawn?.steps,
      );
      const overrides = parseSpawnOverrides(request.overrides, "overrides");
      const worktree = resolveSpawnWorktree(project, overrides);
      if (members && request.branch !== undefined) {
        throw new Error("branch cannot be combined with members");
      }
      if (members && members.length > 1 && !worktree) {
        throw new Error("multi-agent spawn requires worktree mode");
      }

      const spawnMembers = members ?? [
        {
          agent: parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent),
          ...(request.branch?.trim() ? { branch: request.branch.trim() } : {}),
        },
      ];

      if (spawnMembers.length === 1) {
        const session = await this.spawnSingleSession({
          project: request.project,
          prompt,
          ...(steps ? { steps } : {}),
          agent: spawnMembers[0]!.agent,
          ...(spawnMembers[0]!.branch ? { branch: spawnMembers[0]!.branch } : {}),
          ...(planMode ? { planMode } : {}),
          ...(overrides ? { overrides } : {}),
        });
        return {
          ...session,
          sessions: [session],
        };
      }

      const spawned: SessionView[] = [];
      let groupId: string | undefined;
      try {
        this.logEvent("session.group.spawn.started", {
          level: "info",
          projectId: request.project,
          message: `Spawning ${spawnMembers.length} grouped sessions for ${request.project}`,
          details: {
            agents: spawnMembers.map((member) => member.agent),
          },
        });
        for (const member of spawnMembers) {
          spawned.push(
            await this.spawnSingleSession({
              project: request.project,
              prompt,
              ...(steps ? { steps } : {}),
              agent: member.agent,
              ...(member.branch ? { branch: member.branch } : {}),
              ...(planMode ? { planMode } : {}),
              ...(overrides ? { overrides } : {}),
            }),
          );
        }

        groupId = `${spawned[0]!.id}-group`;
        const updatedSessions: SessionView[] = [];
        for (const [index, spawnedSession] of spawned.entries()) {
          const current = readSession(this.config.dataDir, spawnedSession.id);
          if (!current) {
            throw new Error(`Session not found after grouped spawn: ${spawnedSession.id}`);
          }
          writeSession(this.config.dataDir, {
            ...current,
            group: {
              id: groupId,
              index,
              total: spawned.length,
              ...(spawnMembers[index]?.name ? { name: spawnMembers[index]!.name } : {}),
            },
            updatedAt: nowIso(),
          });
          updatedSessions.push(await this.get(spawnedSession.id));
        }

        const groupRecord: SessionGroupRecord = {
          id: groupId,
          project: request.project,
          prompt,
          ...(steps ? { steps } : {}),
          planMode,
          members: updatedSessions.map((session, index) => ({
            sessionId: session.id,
            agent: session.agent,
            branch: session.branch,
            ...(spawnMembers[index]?.name ? { name: spawnMembers[index]!.name } : {}),
          })),
          createdAt: updatedSessions[0]!.createdAt,
          updatedAt: nowIso(),
        };
        writeSessionGroup(this.config.dataDir, groupRecord);
        this.logEvent("session.group.spawn.completed", {
          level: "info",
          projectId: request.project,
          message: `Spawned group ${groupId}`,
          details: {
            groupId,
            sessionIds: updatedSessions.map((session) => session.id),
          },
        });
        return {
          ...updatedSessions[0]!,
          sessions: updatedSessions,
          groupId,
        };
      } catch (error) {
        if (groupId) {
          deleteSessionGroup(this.config.dataDir, groupId);
        }
        for (const session of spawned) {
          try {
            await this.kill(session.id, { force: true });
          } catch {
            // Best effort rollback only.
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logEvent("session.group.spawn.failed", {
          level: "error",
          projectId: request.project,
          message: `Failed grouped spawn for ${request.project}: ${message}`,
          details: {
            groupId: groupId ?? null,
            rolledBackSessionIds: spawned.map((session) => session.id),
          },
        });
        throw error;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Failed to spawn ")) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logEvent("session.spawn.failed", {
        level: "error",
        projectId: request.project,
        message: `Failed to spawn session: ${message}`,
        details: {
          requestedAgent: request.agent ?? request.members?.[0]?.agent ?? null,
        },
      });
      throw error;
    }
  }

  private async spawnSingleSession(request: SpawnSessionRequest): Promise<SessionView> {
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
      const sidecarPorts = reserveSidecarPorts(this.config.dataDir, project.sidecars);
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
        ...(sidecarPorts ? { sidecarPorts } : {}),
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
          : prompt;
      const hookSetup = await setupAgentHooks({
        agent,
        worktreePath: workspacePath,
        sessionToolDir,
      });
      const launchPlan = buildAgentLaunchPlan(
        agent,
        initialMessage,
        withPlanMode(hookSetup, planMode),
      );
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
      await syncTmuxStatus(tmuxSession, runningRecord.slots);
      stage = "tmux.ready";
      await waitForTmuxReady(tmuxSession, launchPlan.readyMarkers);
      this.logEvent("session.spawn.ready", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Agent prompt is ready for ${sessionId}`,
      });

      if (launchPlan.initialMessage.trim()) {
        stage = "prompt.send";
        const sidecarNames = Object.keys(project.sidecars);
        const spawnInitialMessage = buildInitialMessage(launchPlan.initialMessage, sidecarNames);
        await this.sendAgentMessage(runningRecord, spawnInitialMessage);
        this.logEvent("session.spawn.initial_prompt_sent", {
          level: "info",
          sessionId,
          projectId: request.project,
          message: `Sent initial prompt to ${sessionId}`,
          details: {
            messageLength: launchPlan.initialMessage.length,
          },
        });
      }

      stage = "record.write";
      const persistedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );

      const projectSidecars = project.sidecars;
      for (const [name, sidecar] of Object.entries(projectSidecars)) {
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
          this.logEvent("session.sidecar.started", {
            level: "info",
            sessionId,
            projectId: request.project,
            message: `Auto-started sidecar ${name} for ${sessionId}`,
            details: {
              sidecarName: name,
              command: sidecar.command,
              tmuxSession: sidecarTmuxSession(sessionId, name),
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
          tmuxSession,
          agent,
          agentSessionId: persistedRecord.agentSessionId ?? null,
        },
      });
      if (this.shouldRunDelivery(persistedRecord)) {
        this.scheduleDeliveryRunner(persistedRecord.id);
      }

      return await this.enrich(persistedRecord);
    } catch (error) {
      if (sessionId && project && placeholderWritten) {
        await killTmuxSession(sessionId);
        for (const scName of Object.keys(project.sidecars)) {
          await killSidecarTmux(sessionId, scName).catch(() => {});
        }
        this.removeSessionArtifacts(sessionId);
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
      throw error;
    }
  }

  async send(sessionId: string, request: SendMessageRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
    const message = typeof request.message === "string" ? request.message.trim() : "";
    if (!message && !hasAttachments) {
      throw new Error("message or attachments required");
    }
    if (!isRestorableStatus(session.status)) {
      throw new Error(`Session is not running: ${sessionId}`);
    }

    let finalMessage = message;
    if (hasAttachments) {
      const attachments = request.attachments ?? [];
      if (attachments.length > MAX_ATTACHMENTS) {
        throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS})`);
      }
      const attachDir = join(session.worktreePath, ".spur", "attachments");
      mkdirSync(attachDir, { recursive: true });
      const prefixLines: string[] = [];
      for (const att of attachments) {
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
        const filename = `${Date.now()}-${att.name}`;
        const filePath = join(attachDir, filename);
        writeFileSync(filePath, buf, { mode: 0o644 });
        prefixLines.push(`[Attached file: ${filePath}]`);
      }
      finalMessage = prefixLines.join("\n") + (message ? `\n${message}` : "");
    }

    const readySession = await this.ensureSessionReadyForSend(session);
    const updated = withQueuedMessages(
      {
        ...readySession,
        status: "running",
        updatedAt: nowIso(),
      },
      [...queuedMessages(readySession), finalMessage],
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
    await this.tryDeliverQueuedMessage(sessionId);
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

    try {
      const readySession = await this.ensureSessionReadyForSend(session);
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
        projectId: session.project,
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
        projectId: session.project,
        message: `Failed to deliver message to ${sessionId}: ${failure}`,
        details: {
          interrupt: options?.interrupt === true,
        },
      });
      throw error;
    }
  }

  async pause(sessionId: string): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "paused");
  }

  private async sendAgentMessage(
    session: Pick<SessionRecord, "id" | "tmuxSession" | "agent">,
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<void> {
    const codexBaseline =
      session.agent === "codex"
        ? (readAgentHookState(this.config.dataDir, session.id) ??
          (await this.waitForCodexHookBaseline(session.id)) ??
          null)
        : null;
    await sendMessageToTmux(session.tmuxSession, message, {
      agent: session.agent,
      ...(options?.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
    });
    if (session.agent !== "codex") {
      return;
    }
    for (let attempt = 0; attempt <= CODEX_SUBMIT_RETRY_LIMIT; attempt += 1) {
      if (await this.waitForCodexSubmitAck(session.id, codexBaseline)) {
        return;
      }
      if (attempt < CODEX_SUBMIT_RETRY_LIMIT) {
        await sendSubmitKeyToTmux(session.tmuxSession);
      }
    }
    const processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
    const currentHook = readAgentHookState(this.config.dataDir, session.id);
    this.logEvent("session.codex.submit.timeout", {
      level: "warn",
      sessionId: session.id,
      message: `Codex submit ack timed out for ${session.id}`,
      details: {
        baseline: codexBaseline
          ? {
              turnId: codexBaseline.turnId ?? null,
              updatedAt: codexBaseline.updatedAt,
              hookEvent: codexBaseline.hookEvent ?? null,
            }
          : null,
        current: currentHook
          ? {
              turnId: currentHook.turnId ?? null,
              updatedAt: currentHook.updatedAt,
              hookEvent: currentHook.hookEvent ?? null,
            }
          : null,
        processAlive,
      },
    });
    throw new Error(`Timed out waiting for Codex submit acknowledgment for ${session.id}`);
  }

  private async waitForCodexSubmitAck(
    sessionId: string,
    baseline: ReturnType<typeof readAgentHookState>,
  ): Promise<boolean> {
    const deadline = Date.now() + CODEX_SUBMIT_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = readAgentHookState(this.config.dataDir, sessionId);
      if (isCodexSubmitAcknowledged(baseline, current)) {
        return true;
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }
    return false;
  }

  private async waitForCodexHookBaseline(
    sessionId: string,
  ): Promise<ReturnType<typeof readAgentHookState>> {
    const deadline = Date.now() + CODEX_SUBMIT_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = readAgentHookState(this.config.dataDir, sessionId);
      if (current) {
        return current;
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }
    return null;
  }

  async complete(sessionId: string, options?: { retainInList?: boolean }): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "completed", options);
  }

  async updateSlots(sessionId: string, request: UpdateSessionSlotsRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const slots = applySlotsUpdate(session.slots, request);
    const updated: SessionRecord = {
      ...session,
      ...(slots ? { slots } : {}),
    };
    if (!slots) {
      delete updated.slots;
    }
    writeSession(this.config.dataDir, updated);
    await syncTmuxStatus(updated.tmuxSession, updated.slots);
    this.logEvent("session.slots.updated", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Updated session slots for ${sessionId}`,
      details: {
        title: updated.slots?.title ?? null,
        linkCount: updated.slots?.links.length ?? 0,
      },
    });
    return this.enrich(updated);
  }

  async startSidecar(sessionId: string, sidecarName: string): Promise<SessionView> {
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

    const sessionToolDir = this.prepareSessionTools(session.id, session.agent);
    const sessionEnv = buildSessionEnv({
      agent: session.agent,
      projectId: session.project,
      sessionId: session.id,
      sessionToolDir,
      dataDir: this.config.dataDir,
      repoPath: project.path,
      symlinks: project.symlinks,
    });

    await createTmuxSidecarSession({
      sessionId,
      sidecarName,
      cwd: session.worktreePath,
      command: sidecar.command,
      env: {
        ...sessionEnv,
        SPUR_SIDECAR_NAME: sidecarName,
        ...(sidecar.env ?? {}),
        ...sidecarPortEnv(session, sidecarName),
      },
    });

    const updated: SessionRecord = { ...session, updatedAt: nowIso() };
    writeSession(this.config.dataDir, updated);
    this.logEvent("session.sidecar.started", {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `Started sidecar ${sidecarName} for ${sessionId}`,
      details: {
        sidecarName,
        command: sidecar.command,
        tmuxSession: sidecarTmuxSession(sessionId, sidecarName),
      },
    });
    return this.enrich(updated);
  }

  private async cleanupSessionServices(session: SessionRecord): Promise<void> {
    const project = this.config.projects[session.project];
    for (const scName of Object.keys(project?.sidecars ?? {})) {
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

  private removeSessionArtifacts(sessionId: string): void {
    deleteAgentHookState(this.config.dataDir, sessionId);
    deleteRuntimeLogCursorsForSession(this.config.dataDir, sessionId);
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
    if (session.status === targetStatus) {
      return this.enrich(session);
    }
    if (isTerminalSessionStatus(session.status)) {
      throw new Error(`Session ${sessionId} is already ${session.status}`);
    }
    const eventAction = targetStatus === "paused" ? "pause" : "complete";

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
      ...session,
      status: targetStatus,
      updatedAt: nowIso(),
      ...(options?.retainInList ? { retainInList: true } : {}),
    };
    if (!options?.retainInList) {
      delete record.retainInList;
    }
    writeSession(this.config.dataDir, record);
    this.logEvent(`session.${eventAction}.completed`, {
      level: "info",
      sessionId,
      projectId: session.project,
      message: `${targetStatus === "paused" ? "Paused" : "Completed"} ${sessionId}`,
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
      this.removeSessionArtifacts(sessionId);
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
      ...session,
      status: "killed",
      updatedAt: nowIso(),
    };
    delete record.retainInList;
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

    const deadline = Date.now() + Math.max(timeoutMs, 0);
    while (Date.now() <= deadline) {
      const agentSessionId = await findAgentSessionId(session.agent, session.worktreePath);
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
      processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
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
    const planMode = resolvePlanMode(session);
    const baseLaunchPlan = buildAgentLaunchPlan(
      session.agent,
      session.prompt,
      withPlanMode(hookSetup, planMode),
    );
    const baseLaunchCommand = baseLaunchPlan.launchCommand;
    const recoveryPlan = sessionWithAgentId.agentSessionId
      ? buildAgentResumePlan(
          sessionWithAgentId.agent,
          sessionWithAgentId.agentSessionId,
          baseLaunchCommand,
          withPlanMode(hookSetup, planMode),
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
    });

    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: recoveryPlan?.launchCommand ?? baseLaunchCommand,
        agent: session.agent,
        env,
      });
      await syncTmuxStatus(session.tmuxSession, session.slots);
      await waitForTmuxReady(
        session.tmuxSession,
        recoveryPlan?.readyMarkers ?? baseLaunchPlan.readyMarkers,
      );
      if (!(await isProcessRunningInTmux(session.tmuxSession, session.agent))) {
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
      await syncTmuxStatus(session.tmuxSession, session.slots);
      await waitForTmuxReady(session.tmuxSession, baseLaunchPlan.readyMarkers);
      if (!(await isProcessRunningInTmux(session.tmuxSession, session.agent))) {
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
      const planMode = resolvePlanMode(current);
      const restorePrompt = buildRestorePrompt(current.prompt);
      const launchPlan = await waitForRestorePlan(
        current.agent,
        current.worktreePath,
        restorePrompt,
        withPlanMode(hookSetup, planMode),
      );
      const effectivePlan =
        launchPlan ??
        buildAgentLaunchPlan(current.agent, restorePrompt, withPlanMode(hookSetup, planMode));
      if (!launchPlan) {
        this.logEvent("session.restore.started", {
          level: "info",
          sessionId,
          projectId: current.project,
          message: `No native resume state for ${sessionId}, falling back to fresh launch`,
          details: { agent: current.agent, worktreePath: current.worktreePath },
        });
      }
      await killTmuxSession(current.tmuxSession);
      let restoreLaunchCommand = effectivePlan.launchCommand;
      let restoreReadyMarkers = effectivePlan.readyMarkers;
      if (current.agent === "claude") {
        const restoredAgentSessionId = await findAgentSessionId(
          current.agent,
          current.worktreePath,
        );
        if (restoredAgentSessionId) {
          const resumePlan = buildAgentResumePlan(
            current.agent,
            restoredAgentSessionId,
            effectivePlan.launchCommand,
            withPlanMode(hookSetup, planMode),
          );
          restoreLaunchCommand = resumePlan.launchCommand;
          restoreReadyMarkers = resumePlan.readyMarkers;
        }
      }
      restoredLaunchCommand = restoreLaunchCommand;
      await createTmuxSession({
        sessionName: current.tmuxSession,
        cwd: current.worktreePath,
        launchCommand: restoreLaunchCommand,
        agent: current.agent,
        env: buildSessionEnv({
          agent: current.agent,
          projectId: current.project,
          sessionId: current.id,
          sessionToolDir,
          dataDir: this.config.dataDir,
          repoPath: this.getProject(current.project).path,
          symlinks: this.getProject(current.project).symlinks,
        }),
      });
      await syncTmuxStatus(current.tmuxSession, current.slots);
      await waitForTmuxReady(current.tmuxSession, restoreReadyMarkers);
      if (!(await isProcessRunningInTmux(current.tmuxSession, current.agent))) {
        throw new Error(`Agent ${current.agent} exited before restore became ready`);
      }
      const restoreProject = this.config.projects[current.project];
      const restoreSidecarNames = Object.keys(restoreProject?.sidecars ?? {});
      const restoreInitialMessage = buildInitialMessage(
        effectivePlan.initialMessage,
        restoreSidecarNames,
      );
      await this.sendAgentMessage(current, restoreInitialMessage);
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
    const persistedRestored = await this.captureAgentSessionId(
      restored,
      AGENT_SESSION_ID_REFRESH_WAIT_MS,
    );
    writeSession(this.config.dataDir, persistedRestored);
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

  async respawn(sessionId: string): Promise<SessionView> {
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

    return this.spawn(resolveRespawnRequest(session));
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
          const {
            awaitingStepIndex: _awaitingStepIndex,
            error: _pipelineError,
            ...pipelineBase
          } = session.pipeline;
          writeSession(this.config.dataDir, {
            ...session,
            updatedAt: nowIso(),
            pipeline: {
              ...pipelineBase,
              status: "completed",
            },
          });
          this.logEvent("session.pipeline.completed", {
            level: "info",
            sessionId,
            projectId: session.project,
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
          const { nextStepNotBefore: _nextStepNotBefore, ...pipelineBase } = session.pipeline;
          writeSession(this.config.dataDir, {
            ...session,
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
      if (agentState === "waiting" && !isFresh(stepUpdatedAt, PIPELINE_READY_GRACE_MS)) {
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

      const agentState = await this.classifySessionState(session);
      if (agentState === "working") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "needs_input") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (agentState === "waiting" && !isFresh(messageUpdatedAt, PIPELINE_READY_GRACE_MS)) {
        return "ready";
      }

      await sleep(PIPELINE_POLL_INTERVAL_MS);
    }
  }

  private async confirmAgentExited(
    session: Pick<SessionRecord, "tmuxSession" | "agent">,
  ): Promise<boolean> {
    if (await tmuxSessionExists(session.tmuxSession)) {
      if (await isProcessRunningInTmux(session.tmuxSession, session.agent)) {
        return false;
      }
    }
    // Retry once after a short delay to guard against transient tmux/ps failures.
    await sleep(PIPELINE_POLL_INTERVAL_MS);
    if (await tmuxSessionExists(session.tmuxSession)) {
      return !(await isProcessRunningInTmux(session.tmuxSession, session.agent));
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

  private async enrich(session: SessionRecord): Promise<SessionView> {
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    const updatedAt = new Date(session.updatedAt);
    const tmuxActivityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
    const processAlive = runtimeAlive
      ? await isProcessRunningInTmux(session.tmuxSession, session.agent)
      : false;
    const lastActivityAt = (latestActivityAt(updatedAt, tmuxActivityAt) ?? updatedAt).toISOString();

    let state: SessionState;
    let stateSource: StateSource = "status";
    if (session.status === "killed") {
      state = "killed";
    } else if (session.status === "paused" || session.status === "completed") {
      state = "stopped";
    } else if (session.status === "errored") {
      state = "error";
    } else if (session.status === "spawning") {
      state = "working";
    } else if (!runtimeAlive || !processAlive) {
      state = "stopped";
    } else if (session.agent === "claude") {
      // Claude: JSONL-based state classification.
      const jsonlResult = await readClaudeJsonlState(
        session.worktreePath,
        this.claudeJsonlReaders.get(session.id),
      );
      if (jsonlResult) {
        this.claudeJsonlReaders.set(session.id, jsonlResult.reader);
        state = jsonlResult.state;
        stateSource = "jsonl";
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: ${state} (jsonl, records=${jsonlResult.reader.tailRecords.length})`,
        });
      } else {
        // No JSONL file yet (agent just started). Default to working.
        state = "working";
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: ${state} (no jsonl)`,
        });
      }
    } else {
      // Codex: hook-based state classification.
      stateSource = "pane"; // keep "pane" for now as the source label
      const hookState = readAgentHookState(this.config.dataDir, session.id);
      if (hookState) {
        state = hookState.state;
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: ${state} (hook=${hookState.state}, event=${hookState.hookEvent ?? "?"}, hookAge=${Math.round((Date.now() - new Date(hookState.updatedAt).getTime()) / 1000)}s)`,
        });
      } else {
        state = "waiting";
        this.logEvent("session.state.classified", {
          level: "info",
          sessionId: session.id,
          projectId: session.project,
          message: `State: ${state} (no hook)`,
        });
      }
    }

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
      history.push({ state, at: new Date(now).toISOString(), source: stateSource });
      if (history.length > STATE_HISTORY_LIMIT) {
        history.splice(0, history.length - STATE_HISTORY_LIMIT);
      }
      this.stateHistory.set(session.id, history);
    }

    const services: ServiceInstanceView[] = [];
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      services.push(await this.enrichService(service));
    }

    const projectSidecars = this.resolveProjectForSession(session)?.sidecars ?? {};
    const sidecars: { name: string; alive: boolean }[] = [];
    for (const name of Object.keys(projectSidecars)) {
      sidecars.push({ name, alive: await sidecarTmuxAlive(session.id, name) });
    }

    return {
      ...session,
      planMode: resolvePlanMode(session),
      runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      ...(history.length > 0 ? { stateHistory: history } : {}),
      lastActivityAt,
      services,
      sidecars,
    };
  }

  private async classifySessionState(
    session: Pick<SessionRecord, "id" | "agent" | "tmuxSession" | "worktreePath">,
  ): Promise<SessionState> {
    if (session.agent === "claude") {
      const jsonlResult = await readClaudeJsonlState(
        session.worktreePath,
        this.claudeJsonlReaders.get(session.id),
      );
      if (jsonlResult) {
        this.claudeJsonlReaders.set(session.id, jsonlResult.reader);
        return jsonlResult.state;
      }
      return "working";
    }

    // Codex: hooks only
    const hookState = readAgentHookState(this.config.dataDir, session.id);
    return hookState?.state ?? "waiting";
  }
}
