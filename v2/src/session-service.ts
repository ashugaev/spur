import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAgentLaunchPlan,
  buildAgentResumePlan,
  findAgentSessionId,
  observeAgentStatus,
  parseAgentName,
} from "./agents/index.js";
import { logSpurEvent, type SpurLogEntry } from "./event-log.js";
import { reserveNextSessionId } from "./ids.js";
import {
  deleteServiceInstance,
  deleteServiceInstancesForSession,
  deleteServiceSourceStatesForService,
  deleteServiceSourceStatesForSession,
  listActiveServiceProblems,
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
  createTmuxSession,
  getTmuxSessionActivity,
  isProcessRunningInTmux,
  killTmuxSession,
  sendMessageToTmux,
  syncTmuxStatus,
  tmuxPaneDead,
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
import { buildMergedConfig, upsertConfigRegistryPath, writeConfigRegistry } from "./registry.js";
import {
  SPUR_DAEMON_API_VERSION,
  type AppConfig,
  type BranchSource,
  type KillSessionRequest,
  type ProjectConfig,
  type RunServiceRequest,
  type RuntimeInfo,
  type ServiceInstanceRecord,
  type ServiceInstanceView,
  type SendMessageRequest,
  type SessionRecord,
  type SessionStatus,
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
  resolveRepoPathFromWorktree,
  workspaceExists,
} from "./workspace.js";

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
const PIPELINE_STEP_DELAY_MS = 30_000;
const PIPELINE_READY_GRACE_MS = 2_000;
const PERMISSION_PROMPTS = [
  /approval required/i,
  /Do you want to proceed\?/i,
  /\((?:y|Y)\)es.*\((?:n|N)\)o/i,
];
const INTERVIEW_ENTER_RE = /\bEnter to select\b/i;
const INTERVIEW_ESCAPE_RE = /\bEsc to cancel\b/i;
const INTERVIEW_OPTION_RE = /^\d+\.\s/;
const RESTORE_PROMPT_PREFIX =
  "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:";
type ManualSessionStatus = "paused" | "completed";
interface SessionProjectContext {
  repoPath: string;
  symlinks: string[];
}

function isTerminalSessionStatus(status: SessionStatus): status is "completed" | "killed" {
  return status === "completed" || status === "killed";
}

function isRestorableStatus(status: SessionStatus): boolean {
  return status === "paused" || status === "exited";
}

function isLiveSessionStatus(status: SessionStatus): boolean {
  return status === "working" || status === "waiting" || status === "needs_input";
}

function isStickySessionStatus(status: SessionStatus): boolean {
  return status === "paused" || status === "completed" || status === "killed" || status === "error";
}

function isSendableStatus(status: SessionStatus): boolean {
  return isLiveSessionStatus(status) || isRestorableStatus(status);
}

function canRunPipeline(
  session: Pick<SessionRecord, "status" | "pipeline"> | null | undefined,
): session is Pick<SessionRecord, "status" | "pipeline"> & {
  pipeline: NonNullable<SessionRecord["pipeline"]>;
} {
  if (!session?.pipeline) {
    return false;
  }
  return isLiveSessionStatus(session.status) && !session.pipeline.error;
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

function normalizeSpawnRequest(request: SpawnSessionRequest): {
  prompt: string;
  steps?: string[];
} {
  if (typeof request.prompt !== "string" || !request.prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
  const steps = request.steps?.map((step, index) => {
    if (typeof step !== "string" || !step.trim()) {
      throw new Error(`steps[${index}] must be a non-empty string`);
    }
    return step.trim();
  });
  if (!steps || steps.length === 0) {
    return { prompt: request.prompt.trim() };
  }
  return { prompt: request.prompt.trim(), steps };
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

function isPromptReadyState(pane: string): boolean {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) {
    return false;
  }
  const lastLine = lines.at(-1)?.trim() ?? "";
  return Boolean(lastLine) && PROMPT_RE.test(lastLine);
}

function classifyPipelinePaneState(
  pane: string,
): Extract<SessionStatus, "working" | "waiting" | "needs_input"> {
  const lines = normalizePaneLines(pane);
  if (isWaitingInput(lines)) {
    return "needs_input";
  }
  const lastLine = lines.at(-1)?.trim() ?? "";
  return lastLine && PROMPT_RE.test(lastLine) ? "waiting" : "working";
}

export function isRestorableSession(
  session: Pick<SessionView, "status" | "workspaceExists" | "worktree">,
): boolean {
  return session.worktree && isRestorableStatus(session.status) && session.workspaceExists;
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
  configPath: string;
  repoPath: string;
  symlinks: string[];
}): Record<string, string> {
  const env: Record<string, string> = {
    SPUR_SESSION: args.sessionId,
    SPUR_PROJECT: args.projectId,
    SPUR_AGENT: args.agent,
    SPUR_CONFIG: args.configPath,
    SPUR_SLOT_COMMAND: join(args.sessionToolDir, SLOT_TOOL_NAME),
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
  private readonly pipelineRuns = new Map<string, Promise<void>>();

  constructor(configPath?: string, startedAt = nowIso()) {
    const initial = buildMergedConfig(configPath ?? process.env["SPUR_CONFIG"] ?? "", [], {
      skipInvalid: false,
    });
    this.bootstrapConfigPath = initial.config.configPath;
    this.startedAt = startedAt;
    mkdirSync(initial.config.dataDir, { recursive: true });
    mkdirSync(initial.config.worktreeDir, { recursive: true });
    this.registryPaths = upsertConfigRegistryPath(
      initial.config.dataDir,
      initial.config.configPath,
    );
    const merged = buildMergedConfig(this.bootstrapConfigPath, this.registryPaths, {
      skipInvalid: true,
      warn: (message) => {
        logSpurEvent(initial.config.dataDir, {
          event: "daemon.registry.warning",
          level: "warn",
          message,
        });
      },
    });
    this.config = initial.config;
    this.registryPaths = [];
    this.applyConfig(merged.config, merged.configPaths);
  }

  previewConfigSync(configPath: string): {
    config: AppConfig;
    registryPaths: string[];
    changed: boolean;
    warnings: string[];
  } {
    const nextRegistryPaths = [...this.registryPaths];
    if (!nextRegistryPaths.includes(configPath)) {
      nextRegistryPaths.push(configPath);
    }
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
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
    writeConfigRegistry(this.config.dataDir, this.registryPaths);
    this.resumeRunningPipelines();
  }

  getRegistryPaths(): string[] {
    return [...this.registryPaths];
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

  private findProjectByRepoPath(repoPath: string): ProjectConfig | undefined {
    const resolvedRepoPath = tryRealpath(repoPath);
    return Object.values(this.config.projects).find(
      (project) => tryRealpath(project.path) === resolvedRepoPath,
    );
  }

  private async resolveSessionProjectContext(
    session: SessionRecord,
  ): Promise<SessionProjectContext> {
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
      (session) => !isTerminalSessionStatus(session.status),
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
    if (!isLiveSessionStatus(session.status)) {
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
    let preflightOutcome: "branch" | "defer" | undefined;
    let preflightBranch: string | undefined;
    try {
      project = this.getProject(request.project);
      ({ prompt, steps } = normalizeSpawnRequest({
        ...request,
        ...(request.steps === undefined && project.spawn?.steps !== undefined
          ? { steps: project.spawn.steps }
          : {}),
      }));
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

      const firstStage = steps?.[0];
      const initialMessage =
        steps && firstStage
          ? formatPipelineStepMessage(prompt, firstStage, 0, steps.length)
          : prompt;
      const launchPlan = buildAgentLaunchPlan(agent, initialMessage);
      const pipeline = steps
        ? {
            steps,
            nextStepIndex: 1,
            awaitingStepIndex: 0,
          }
        : undefined;
      const runningRecord: SessionRecord = {
        ...placeholder,
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        status: "working",
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
          configPath: this.config.configPath,
          repoPath: project.path,
          symlinks: project.symlinks,
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
      this.logEvent("session.spawn.initial_prompt_sent", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Sent initial prompt to ${sessionId}`,
        details: {
          messageLength: launchPlan.initialMessage.length,
        },
      });

      stage = "record.write";
      writeSession(this.config.dataDir, runningRecord);
      this.logEvent("session.spawn.completed", {
        level: "info",
        sessionId,
        projectId: request.project,
        message: `Spawned ${sessionId}`,
        details: {
          worktreePath: workspacePath,
          tmuxSession,
          agent,
        },
      });
      if (runningRecord.pipeline) {
        this.schedulePipelineRunner(runningRecord.id);
      }

      return await this.enrich(runningRecord);
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
          prompt,
          branch: resolvedBranch?.branch ?? sessionId,
          ...(resolvedBranch?.branchSource ? { branchSource: resolvedBranch.branchSource } : {}),
          worktree,
          worktreePath: workspacePath,
          tmuxSession: sessionId,
          launchCommand: "",
          status: "error",
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
    if (!isSendableStatus(session.status)) {
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
        status: "working",
        updatedAt: nowIso(),
      };
      writeSession(this.config.dataDir, updated);
      this.logEvent("session.message.sent", {
        level: "info",
        sessionId,
        projectId: session.project,
        message: `Delivered message to ${sessionId}`,
        details: {
          interrupt,
          messageLength: message.length,
        },
      });
      return await this.enrich(updated);
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

  private async cleanupSessionServices(session: SessionRecord): Promise<void> {
    for (const service of listServiceInstancesForSession(this.config.dataDir, session.id)) {
      await killTmuxSession(service.tmuxSession);
    }
    deleteServiceSourceStatesForSession(this.config.dataDir, session.project, session.id);
    deleteServiceInstancesForSession(this.config.dataDir, session.id);
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
      await this.cleanupSessionServices(session);
      if (targetStatus === "completed") {
        if (session.worktree && session.worktreePath && workspaceExists(session.worktreePath)) {
          const projectContext = await this.resolveSessionProjectContext(session);
          await removeWorktree(projectContext.repoPath, session.worktreePath);
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
      const projectContext = await this.resolveSessionProjectContext(session);
      const reasons: string[] = [];
      if (await hasUncommittedChanges(session.worktreePath, projectContext.symlinks)) {
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
        const projectContext = await this.resolveSessionProjectContext(session);
        await removeWorktree(projectContext.repoPath, session.worktreePath);
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

  private async ensureSessionReadyForSend(session: SessionRecord): Promise<SessionRecord> {
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    let processAlive = false;
    if (runtimeAlive) {
      processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
      if (processAlive) {
        return session;
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
      },
    });

    if (session.status === "killed") {
      throw new Error(`Session ${session.id} was killed and cannot be recovered`);
    }
    if (session.status === "completed") {
      throw new Error(`Session ${session.id} was completed and cannot be recovered`);
    }
    if (session.status === "error") {
      throw new Error(`Session ${session.id} errored and cannot be recovered`);
    }
    if (!session.worktree || !session.worktreePath || !workspacePresent) {
      throw new Error(`Session ${session.id} cannot be recovered because its worktree is missing`);
    }

    await killTmuxSession(session.tmuxSession);
    const agentSessionId = await findAgentSessionId(session.agent, session.worktreePath);
    if (!agentSessionId) {
      throw new Error(`No native resume state found for ${session.agent} session ${session.id}`);
    }
    const baseLaunchPlan = buildAgentLaunchPlan(session.agent, session.prompt);
    const baseLaunchCommand = session.launchCommand || baseLaunchPlan.launchCommand;
    const recoveryPlan = buildAgentResumePlan(session.agent, agentSessionId, baseLaunchCommand);
    const projectContext = await this.resolveSessionProjectContext(session);
    this.logEvent("session.recover.started", {
      level: "info",
      sessionId: session.id,
      projectId: session.project,
      message: `Recovering ${session.id}`,
      details: {
        agent: session.agent,
        recoveryMode: "native_resume",
        agentSessionId,
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
      configPath: this.config.configPath,
      repoPath: projectContext.repoPath,
      symlinks: projectContext.symlinks,
    });

    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: recoveryPlan.launchCommand,
        env,
      });
      await syncTmuxStatus(session.tmuxSession, session.slots);
      await waitForTmuxReady(session.tmuxSession, recoveryPlan.readyMarkers);
      if (!(await isProcessRunningInTmux(session.tmuxSession, session.agent))) {
        throw new Error(`Agent ${session.agent} exited before recovery became ready`);
      }
    } catch (error) {
      await killTmuxSession(session.tmuxSession);
      throw error;
    }

    const recovered: SessionRecord = {
      ...session,
      launchCommand: baseLaunchCommand,
      status: "waiting",
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
        agentSessionId,
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
    const sessionToolDir = ensureSessionSlotTool({
      dataDir: this.config.dataDir,
      sessionId: current.id,
      configPath: this.config.configPath,
    });
    const agentSessionId = await findAgentSessionId(current.agent, current.worktreePath);
    if (!agentSessionId) {
      this.logEvent("session.restore.failed", {
        level: "error",
        sessionId,
        projectId: current.project,
        message: `Failed to restore ${sessionId}: no native resume state`,
      });
      throw new Error(`No native resume state found for ${current.agent} session ${sessionId}`);
    }
    const baseLaunchPlan = buildAgentLaunchPlan(current.agent, current.prompt);
    const baseLaunchCommand = current.launchCommand || baseLaunchPlan.launchCommand;
    const resumePlan = buildAgentResumePlan(current.agent, agentSessionId, baseLaunchCommand);
    const projectContext = await this.resolveSessionProjectContext(current);

    try {
      await killTmuxSession(current.tmuxSession);
      await createTmuxSession({
        sessionName: current.tmuxSession,
        cwd: current.worktreePath,
        launchCommand: resumePlan.launchCommand,
        env: buildSessionEnv({
          agent: current.agent,
          projectId: current.project,
          sessionId: current.id,
          sessionToolDir,
          configPath: this.config.configPath,
          repoPath: projectContext.repoPath,
          symlinks: projectContext.symlinks,
        }),
      });
      await syncTmuxStatus(current.tmuxSession, current.slots);
      await waitForTmuxReady(current.tmuxSession, resumePlan.readyMarkers);
      if (!(await isProcessRunningInTmux(current.tmuxSession, current.agent))) {
        throw new Error(`Agent ${current.agent} exited before restore became ready`);
      }
      await sendMessageToTmux(current.tmuxSession, withSessionSlotInstructions(restorePrompt));
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
      launchCommand: baseLaunchCommand,
      status: "working",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, restored);
    this.logEvent("session.restore.completed", {
      level: "info",
      sessionId,
      projectId: current.project,
      message: `Restored ${sessionId}`,
      details: {
        agent: current.agent,
        agentSessionId,
      },
    });
    if (restored.pipeline) {
      this.schedulePipelineRunner(restored.id);
    }
    return this.enrich(restored);
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
    if (!canRunPipeline(session)) {
      return;
    }

    const run = this.runPipeline(sessionId).finally(() => {
      this.pipelineRuns.delete(sessionId);
    });
    this.pipelineRuns.set(sessionId, run);
  }

  private async runPipeline(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const session = readSession(this.config.dataDir, sessionId);
        if (!canRunPipeline(session)) {
          return;
        }

        if (session.pipeline.awaitingStepIndex !== undefined) {
          const waitOutcome = await this.waitForPipelineStep(sessionId);
          if (waitOutcome === "stopped") {
            return;
          }
          if (waitOutcome === "ready") {
            const latest = readSession(this.config.dataDir, sessionId);
            if (!canRunPipeline(latest)) {
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
                ? pipelineBase
                : {
                    ...pipelineBase,
                    nextStepNotBefore: new Date(Date.now() + PIPELINE_STEP_DELAY_MS).toISOString(),
                  };
            writeSession(this.config.dataDir, {
              ...latest,
              updatedAt: nowIso(),
              pipeline: completedPipeline,
            });
            if (latest.pipeline.nextStepIndex >= latest.pipeline.steps.length) {
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
            nextStepNotBefore: _nextStepNotBefore,
            error: _pipelineError,
            ...pipelineBase
          } = session.pipeline;
          writeSession(this.config.dataDir, {
            ...session,
            updatedAt: nowIso(),
            pipeline: pipelineBase,
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
        await sendMessageToTmux(
          session.tmuxSession,
          formatPipelineStepMessage(session.prompt, step, stepIndex, session.pipeline.steps.length),
        );

        const latest = readSession(this.config.dataDir, sessionId);
        if (!canRunPipeline(latest)) {
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
      if (!canRunPipeline(session)) {
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

      const stepUpdatedAt = new Date(session.updatedAt);
      const pane = await captureTmuxPane(session.tmuxSession, 80);
      const paneState = classifyPipelinePaneState(pane);
      if (paneState === "needs_input") {
        await sleep(PIPELINE_POLL_INTERVAL_MS);
        continue;
      }
      if (paneState === "waiting" && !isFresh(stepUpdatedAt, PIPELINE_READY_GRACE_MS)) {
        return "ready";
      }

      await sleep(PIPELINE_POLL_INTERVAL_MS);
    }

    return "timeout";
  }

  private markPipelineErrored(sessionId: string, message: string): void {
    const session = readSession(this.config.dataDir, sessionId);
    if (!canRunPipeline(session)) {
      return;
    }

    writeSession(this.config.dataDir, {
      ...session,
      updatedAt: nowIso(),
      pipeline: {
        ...session.pipeline,
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
    const observedStatus = workspacePresent
      ? await observeAgentStatus(session.agent, session.worktreePath, {
          processAlive,
          signalWindowMs: WORKING_SIGNAL_WINDOW_MS,
        })
      : null;
    const lastActivityAt = (
      latestActivityAt(updatedAt, tmuxActivityAt, observedStatus?.signalAt ?? null) ?? updatedAt
    ).toISOString();
    let status = session.status;
    if (!isStickySessionStatus(status)) {
      if (observedStatus) {
        status = observedStatus.status;
      } else if (!runtimeAlive || !processAlive) {
        status = "exited";
      }
    }
    const nextSession =
      status === session.status
        ? session
        : {
            ...session,
            status,
            updatedAt: nowIso(),
          };
    if (nextSession !== session) {
      const latest = readSession(this.config.dataDir, session.id);
      if (
        latest &&
        latest.updatedAt !== session.updatedAt &&
        latest.status !== session.status &&
        isStickySessionStatus(latest.status)
      ) {
        return {
          ...latest,
          runtimeAlive,
          workspaceExists: workspacePresent,
          lastActivityAt,
          services: await Promise.all(
            listServiceInstancesForSession(this.config.dataDir, latest.id).map((service) =>
              this.enrichService(service),
            ),
          ),
        };
      }
      writeSession(this.config.dataDir, nextSession);
    }

    const services: ServiceInstanceView[] = [];
    for (const service of listServiceInstancesForSession(this.config.dataDir, nextSession.id)) {
      services.push(await this.enrichService(service));
    }

    return {
      ...nextSession,
      runtimeAlive,
      workspaceExists: workspacePresent,
      lastActivityAt,
      services,
    };
  }
}
