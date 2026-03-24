import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAgentLaunchPlan,
  buildAgentRestorePlan,
  buildAgentResumePlan,
  findAgentSessionId,
  parseAgentName,
} from "./agents/index.js";
import { loadConfig } from "./config.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { reserveNextSessionId } from "./ids.js";
import { listSessions, readSession, writeSession } from "./metadata.js";
import { runSpawnPreflight } from "./preflight.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";
import {
  PIPELINE_STEP_TIMEOUT_MS,
  createSessionPipeline,
  formatPipelineStepMessage,
} from "./pipeline.js";
import {
  captureTmuxPane,
  createTmuxSession,
  getTmuxSessionActivity,
  isProcessRunningInTmux,
  killTmuxSession,
  sendMessageToTmux,
  syncTmuxStatus,
  tmuxSessionExists,
  waitForTmuxReady,
} from "./runtime-tmux.js";
import {
  SLOT_TOOL_NAME,
  applySlotsUpdate,
  ensureSessionSlotTool,
  removeSessionSlotTool,
  withSessionSlotInstructions,
} from "./session-slots.js";
import {
  SPUR_DAEMON_API_VERSION,
  type AppConfig,
  type BranchSource,
  type KillSessionRequest,
  type ProjectConfig,
  type RuntimeInfo,
  type SendMessageRequest,
  type SessionRecord,
  type SessionStatus,
  type SessionState,
  type SessionView,
  type SpawnOverrides,
  type SpawnSessionRequest,
  type UpdateSessionSlotsRequest,
} from "./types.js";
import {
  createWorktree,
  hasUncommittedChanges,
  hasUnpushedCommits,
  readCurrentBranch,
  removeWorktree,
  workspaceExists,
} from "./workspace.js";

const DELIVERY_GRACE_MS = 30_000;
const WORKING_SIGNAL_WINDOW_MS = 90_000;
const WAITING_INPUT_TAIL_LINES = 12;
const KILL_CONFIRMATION_REQUIRED_PREFIX = "Kill confirmation required";
const PROMPT_RE = /^[❯›>$#](?:\s.*)?$/;
const TRAILING_UI_RE = [
  /^[─━]+$/,
  /^⏵⏵ /,
  /^Claude in Chrome enabled\b/,
  /^Update available!\b/,
  /^gpt-[\w.-]+\b.*·/,
];
const PIPELINE_POLL_INTERVAL_MS = 1_000;
const PERMISSION_PROMPTS = [
  /approval required/i,
  /Do you want to proceed\?/i,
  /\((?:y|Y)\)es.*\((?:n|N)\)o/i,
];
const INTERVIEW_ENTER_RE = /\bEnter to select\b/i;
const INTERVIEW_ESCAPE_RE = /\bEsc to cancel\b/i;
const INTERVIEW_OPTION_RE = /^\d+\.\s/;
const RESTORE_PLAN_WAIT_MS = 5_000;
const RESTORE_PLAN_POLL_MS = 250;
const AGENT_SESSION_ID_INITIAL_WAIT_MS = 5_000;
const AGENT_SESSION_ID_REFRESH_WAIT_MS = 1_500;
const AGENT_SESSION_ID_POLL_INTERVAL_MS = 250;
const RESTORE_PROMPT_PREFIX =
  "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:";
type ManualSessionStatus = "paused" | "completed";

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

function normalizeSteps(request: SpawnSessionRequest): string[] {
  const rawRequest = request as unknown as Record<string, unknown>;
  if (rawRequest["prompt"] !== undefined) {
    throw new Error("spawn.prompt was removed; use steps");
  }

  if (!Array.isArray(request.steps) || request.steps.length === 0) {
    throw new Error("steps must be a non-empty array of non-empty strings");
  }

  return request.steps.map((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`steps[${index}] must be a non-empty string`);
    }
    return step.trim();
  });
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

export function isWaitingInput(lines: string[]): boolean {
  const tailLines = lines.slice(-WAITING_INPUT_TAIL_LINES).map((line) => line.trim());
  const tail = tailLines.join("\n");
  if (PERMISSION_PROMPTS.some((pattern) => pattern.test(tail))) {
    return true;
  }
  return (
    tailLines.some((line) => INTERVIEW_ENTER_RE.test(line)) &&
    tailLines.some((line) => INTERVIEW_ESCAPE_RE.test(line)) &&
    tailLines.filter((line) => INTERVIEW_OPTION_RE.test(line)).length >= 2
  );
}

function normalizePaneLines(pane: string): string[] {
  const lines = pane
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  while (lines.length > 0) {
    const trimmed = lines.at(-1)?.trim() ?? "";
    if (!TRAILING_UI_RE.some((pattern) => pattern.test(trimmed))) {
      break;
    }
    lines.pop();
  }
  return lines;
}

function isFresh(timestamp: Date, thresholdMs: number): boolean {
  return Date.now() - timestamp.getTime() <= thresholdMs;
}

export function classifyRunningState(args: {
  pane: string;
  updatedAt: Date;
  signalAt: Date | null;
}): SessionState {
  const lines = normalizePaneLines(args.pane);
  if (isWaitingInput(lines)) {
    return "needs_input";
  }
  const lastLine = lines.at(-1)?.trim() ?? "";
  if (lastLine && !PROMPT_RE.test(lastLine)) {
    return "working";
  }
  if (isFresh(args.updatedAt, DELIVERY_GRACE_MS)) {
    return "working";
  }
  if (args.signalAt && isFresh(args.signalAt, WORKING_SIGNAL_WINDOW_MS)) {
    return "working";
  }
  return "waiting";
}

function isPromptReadyState(pane: string): boolean {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) {
    return false;
  }
  const lastLine = lines.at(-1)?.trim() ?? "";
  return Boolean(lastLine) && PROMPT_RE.test(lastLine);
}

export function isRestorableSession(
  session: Pick<SessionView, "status" | "state" | "workspaceExists" | "worktree">,
): boolean {
  return (
    session.worktree &&
    isRestorableStatus(session.status) &&
    session.state === "stopped" &&
    session.workspaceExists
  );
}

function buildRestorePrompt(prompt: string): string {
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
}): Record<string, string> {
  return {
    SPUR_SESSION: args.sessionId,
    SPUR_PROJECT: args.projectId,
    SPUR_AGENT: args.agent,
    SPUR_SLOT_COMMAND: join(args.sessionToolDir, SLOT_TOOL_NAME),
    PATH: `${args.sessionToolDir}:${process.env["PATH"] ?? ""}`,
  };
}

async function waitForRestorePlan(
  agent: SessionRecord["agent"],
  worktreePath: string,
  prompt: string,
) {
  const deadline = Date.now() + RESTORE_PLAN_WAIT_MS;
  let plan = await buildAgentRestorePlan(agent, worktreePath, prompt);
  while (!plan && Date.now() < deadline) {
    await sleep(RESTORE_PLAN_POLL_MS);
    plan = await buildAgentRestorePlan(agent, worktreePath, prompt);
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

export class SessionService {
  readonly config: AppConfig;
  readonly startedAt: string;
  private readonly pipelineRuns = new Map<string, Promise<void>>();

  constructor(configPath?: string, startedAt = nowIso()) {
    this.config = loadConfig(configPath);
    this.startedAt = startedAt;
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
    this.resumeRunningPipelines();
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

  private schedulePipelineRunner(sessionId: string): void {
    this.ensurePipelineRunner(sessionId);
  }

  private getProject(projectId: string): ProjectConfig {
    const project = this.config.projects[projectId];
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  async list(): Promise<SessionView[]> {
    const sessions = listSessions(this.config.dataDir).filter(
      (session) => !isTerminalSessionStatus(session.status),
    );
    return Promise.all(sessions.map((session) => this.enrich(session)));
  }

  async get(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return this.enrich(session);
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
    let firstStep = "";
    try {
      const steps = normalizeSteps(request);
      firstStep = steps[0]!;
      project = this.getProject(request.project);
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
      if (!effectiveBranch && worktree && project.preflight) {
        stage = "preflight";
        const preflight = await runSpawnPreflight({
          agent,
          projectId: request.project,
          project,
          baseBranch: defaultBranch,
          worktree,
          prompt: firstStep,
        });
        if (preflight.branch) {
          effectiveBranch = preflight.branch;
          effectiveBranchSource = "preflight";
        }
      }
      sessionId = await reserveNextSessionId(
        this.config.dataDir,
        request.project,
        project.sessionPrefix,
      );
      resolvedBranch = await resolveSpawnBranch({
        repoPath: project.path,
        requestBranch: effectiveBranch,
        ...(effectiveBranchSource ? { requestBranchSource: effectiveBranchSource } : {}),
        worktree,
        fallbackBranch: sessionId,
      });
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
        prompt: firstStep,
        branch: resolvedBranch.branch,
        ...(resolvedBranch.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
        worktree,
        worktreePath: worktree ? "" : project.path,
        tmuxSession,
        launchCommand: "",
        status: "spawning",
        createdAt,
        updatedAt: createdAt,
      };
      writeSession(this.config.dataDir, placeholder);
      placeholderWritten = true;
      workspacePath = placeholder.worktreePath;

      stage = "slot_tool";
      const sessionToolDir = ensureSessionSlotTool({
        dataDir: this.config.dataDir,
        sessionId,
        configPath: this.config.configPath,
      });

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

      const initialMessage =
        steps.length > 1 ? formatPipelineStepMessage(firstStep, 0, steps.length) : firstStep;
      const launchPlan = buildAgentLaunchPlan(agent, initialMessage);
      const pipeline = createSessionPipeline(steps);
      if (pipeline) {
        pipeline.nextStepIndex = 1;
        pipeline.awaitingStepIndex = 0;
      }
      const runningRecord: SessionRecord = {
        ...placeholder,
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        status: "running",
        updatedAt: nowIso(),
        ...(pipeline ? { pipeline } : {}),
      };

      stage = "tmux.create";
      await createTmuxSession({
        sessionName: tmuxSession,
        cwd: workspacePath,
        launchCommand: launchPlan.launchCommand,
        env: buildSessionEnv({
          agent,
          projectId: request.project,
          sessionId,
          sessionToolDir,
        }),
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

      stage = "prompt.send";
      await sendMessageToTmux(tmuxSession, withSessionSlotInstructions(launchPlan.initialMessage));
      this.logEvent("session.spawn.initial_step_sent", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Sent initial step to ${sessionId}`,
        details: {
          messageLength: launchPlan.initialMessage.length,
        },
      });

      stage = "record.write";
      const persistedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );
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
      if (persistedRecord.pipeline?.status === "running") {
        this.schedulePipelineRunner(persistedRecord.id);
      }

      return await this.enrich(persistedRecord);
    } catch (error) {
      if (sessionId && project && placeholderWritten) {
        await killTmuxSession(sessionId);
        removeSessionSlotTool(this.config.dataDir, sessionId);
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
          prompt: firstStep,
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

  async send(sessionId: string, request: SendMessageRequest): Promise<SessionView> {
    return this.deliver(sessionId, request.message, { interrupt: false });
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
        const pane = await captureTmuxPane(readySession.tmuxSession, 80);
        interrupt = !isPromptReadyState(pane);
      }
      await sendMessageToTmux(readySession.tmuxSession, message, { interrupt });
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

  async complete(sessionId: string): Promise<SessionView> {
    return this.applyManualStatus(sessionId, "completed");
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

  private async applyManualStatus(
    sessionId: string,
    targetStatus: ManualSessionStatus,
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
      if (targetStatus === "completed") {
        if (session.worktree && session.worktreePath) {
          const project = this.getProject(session.project);
          await removeWorktree(project.path, session.worktreePath);
        }
        removeSessionSlotTool(this.config.dataDir, sessionId);
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

    const record: SessionRecord = {
      ...session,
      status: targetStatus,
      updatedAt: nowIso(),
    };
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
      const project = this.getProject(session.project);
      const reasons: string[] = [];
      if (await hasUncommittedChanges(session.worktreePath, project.symlinks)) {
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
      if (session.worktree && session.worktreePath) {
        const project = this.getProject(session.project);
        await removeWorktree(project.path, session.worktreePath);
      }
      removeSessionSlotTool(this.config.dataDir, sessionId);
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
    const baseLaunchPlan = buildAgentLaunchPlan(session.agent, session.prompt);
    const baseLaunchCommand = session.launchCommand || baseLaunchPlan.launchCommand;
    const sessionWithAgentId = await this.captureAgentSessionId(session, 0);
    const recoveryPlan = sessionWithAgentId.agentSessionId
      ? buildAgentResumePlan(
          sessionWithAgentId.agent,
          sessionWithAgentId.agentSessionId,
          baseLaunchCommand,
        )
      : null;
    let recoveredAgentSessionId = sessionWithAgentId.agentSessionId;
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

    const sessionToolDir = ensureSessionSlotTool({
      dataDir: this.config.dataDir,
      sessionId: session.id,
      configPath: this.config.configPath,
    });
    const env = buildSessionEnv({
      agent: session.agent,
      projectId: session.project,
      sessionId: session.id,
      sessionToolDir,
    });

    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: recoveryPlan?.launchCommand ?? baseLaunchCommand,
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

    const { error: _ignoredError, ...recoveredBase } = sessionWithAgentId;
    const recovered: SessionRecord = {
      ...recoveredBase,
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
    if (!current.worktree) {
      throw new Error(`Session is not restorable without a worktree: ${sessionId}`);
    }
    if (!isRestorableSession(current)) {
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

    const restorePrompt = buildRestorePrompt(current.prompt);
    const launchPlan = await waitForRestorePlan(current.agent, current.worktreePath, restorePrompt);
    if (!launchPlan) {
      this.logEvent("session.restore.failed", {
        level: "error",
        sessionId,
        projectId: current.project,
        message: `Failed to restore ${sessionId}: no native resume state`,
      });
      throw new Error(`No native resume state found for ${current.agent} session ${sessionId}`);
    }

    await killTmuxSession(current.tmuxSession);

    try {
      const sessionToolDir = ensureSessionSlotTool({
        dataDir: this.config.dataDir,
        sessionId: current.id,
        configPath: this.config.configPath,
      });
      await createTmuxSession({
        sessionName: current.tmuxSession,
        cwd: current.worktreePath,
        launchCommand: launchPlan.launchCommand,
        env: buildSessionEnv({
          agent: current.agent,
          projectId: current.project,
          sessionId: current.id,
          sessionToolDir,
        }),
      });
      await syncTmuxStatus(current.tmuxSession, current.slots);
      await waitForTmuxReady(current.tmuxSession, launchPlan.readyMarkers);
      if (!(await isProcessRunningInTmux(current.tmuxSession, current.agent))) {
        throw new Error(`Agent ${current.agent} exited before restore became ready`);
      }
      await sendMessageToTmux(
        current.tmuxSession,
        withSessionSlotInstructions(launchPlan.initialMessage),
      );
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
      launchCommand:
        current.launchCommand || buildAgentLaunchPlan(current.agent, current.prompt).launchCommand,
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
    if (persistedRestored.pipeline?.status === "running") {
      this.schedulePipelineRunner(persistedRestored.id);
    }
    return this.enrich(persistedRestored);
  }

  private resumeRunningPipelines(): void {
    for (const session of listSessions(this.config.dataDir)) {
      this.ensurePipelineRunner(session.id);
    }
  }

  private ensurePipelineRunner(sessionId: string): void {
    if (this.pipelineRuns.has(sessionId)) {
      return;
    }

    const session = readSession(this.config.dataDir, sessionId);
    if (!session?.pipeline || session.status !== "running" || session.pipeline.status !== "running") {
      return;
    }

    const run = this.runPipeline(sessionId).finally(() => {
      this.pipelineRuns.delete(sessionId);
    });
    this.pipelineRuns.set(sessionId, run);
  }

  private async runPipeline(sessionId: string): Promise<void> {
    try {
      while (true) {
        const session = readSession(this.config.dataDir, sessionId);
        if (!session?.pipeline || session.status !== "running" || session.pipeline.status !== "running") {
          return;
        }

        if (session.pipeline.awaitingStepIndex !== undefined) {
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
              error: _pipelineError,
              ...pipelineBase
            } = latest.pipeline;
            const completedPipeline =
              latest.pipeline.nextStepIndex >= latest.pipeline.steps.length
                ? {
                    ...pipelineBase,
                    status: "completed" as const,
                  }
                : pipelineBase;
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

        const stepIndex = session.pipeline.nextStepIndex;
        await sendMessageToTmux(
          session.tmuxSession,
          formatPipelineStepMessage(
            session.pipeline.steps[stepIndex]!,
            stepIndex,
            session.pipeline.steps.length,
          ),
        );

        const latest = readSession(this.config.dataDir, sessionId);
        if (
          !latest?.pipeline ||
          latest.status !== "running" ||
          latest.pipeline.status !== "running"
        ) {
          return;
        }

        const { error: _pipelineError, ...pipelineBase } = latest.pipeline;
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
      if (!session?.pipeline || session.status !== "running" || session.pipeline.status !== "running") {
        return "stopped";
      }
      if (session.pipeline.awaitingStepIndex === undefined) {
        return "ready";
      }

      const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
      if (!runtimeAlive) {
        return "exited";
      }

      const processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
      if (!processAlive) {
        return "exited";
      }

      const pane = await captureTmuxPane(session.tmuxSession, 80);
      const state = classifyRunningState({
        pane,
        updatedAt: new Date(0),
        signalAt: null,
      });
      if (state === "waiting") {
        return "ready";
      }

      await sleep(PIPELINE_POLL_INTERVAL_MS);
    }

    return "timeout";
  }

  private markPipelineErrored(sessionId: string, message: string): void {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session?.pipeline || session.status !== "running" || session.pipeline.status !== "running") {
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

  private async enrich(session: SessionRecord): Promise<SessionView> {
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    const updatedAt = new Date(session.updatedAt);
    const tmuxActivityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
    const lastActivityAt = (latestActivityAt(updatedAt, tmuxActivityAt) ?? updatedAt).toISOString();

    let state: SessionState;
    if (session.status === "killed") {
      state = "killed";
    } else if (session.status === "paused" || session.status === "completed") {
      state = "stopped";
    } else if (session.status === "errored") {
      state = "error";
    } else if (session.status === "spawning") {
      state = "working";
    } else if (!runtimeAlive) {
      state = "stopped";
    } else {
      const processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
      if (!processAlive) {
        state = "stopped";
      } else {
        const pane = await captureTmuxPane(session.tmuxSession, 80);
        state = classifyRunningState({
          pane,
          updatedAt,
          signalAt: tmuxActivityAt,
        });
      }
    }

    return {
      ...session,
      runtimeAlive,
      workspaceExists: workspacePresent,
      state,
      lastActivityAt,
    };
  }
}
