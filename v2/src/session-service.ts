import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { buildAgentLaunchPlan, buildAgentRestorePlan, parseAgentName } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { reserveNextSessionId } from "./ids.js";
import { listSessions, readSession, writeSession } from "./metadata.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";
import {
  createTmuxSession,
  getTmuxSessionActivity,
  isProcessRunningInTmux,
  killTmuxSession,
  sendMessageToTmux,
  syncTmuxStatus,
  captureTmuxPane,
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
  type ProjectConfig,
  type RuntimeInfo,
  type SendMessageRequest,
  type SessionRecord,
  type SessionState,
  type SessionView,
  type SpawnOverrides,
  type SpawnSessionRequest,
  type UpdateSessionSlotsRequest,
} from "./types.js";
import { createWorktree, readCurrentBranch, removeWorktree, workspaceExists } from "./workspace.js";

const DELIVERY_GRACE_MS = 30_000;
const WORKING_SIGNAL_WINDOW_MS = 90_000;
const WAITING_INPUT_TAIL_LINES = 12;
const PROMPT_RE = /^[❯›>$#](?:\s.*)?$/;
const TRAILING_UI_RE = [
  /^[─━]+$/,
  /^⏵⏵ /,
  /^Claude in Chrome enabled\b/,
  /^Update available!\b/,
  /^gpt-[\w.-]+\b.*·/,
];
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
const RESTORE_PROMPT_PREFIX =
  "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:";

function nowIso(): string {
  return new Date().toISOString();
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

export function isRestorableSession(
  session: Pick<SessionView, "status" | "state" | "workspaceExists" | "worktree">,
): boolean {
  return (
    session.worktree &&
    session.status === "running" &&
    session.state === "stopped" &&
    session.workspaceExists
  );
}

function buildRestorePrompt(prompt: string): string {
  return `${RESTORE_PROMPT_PREFIX}\n\n${prompt}`;
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
    SPUR_SLOT_COMMAND: SLOT_TOOL_NAME,
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
  worktree: boolean;
  fallbackBranch: string;
}): Promise<ResolvedSpawnBranch> {
  if (args.worktree) {
    const requestedBranch = args.requestBranch?.trim();
    if (requestedBranch) {
      return { branch: requestedBranch, branchSource: "explicit" };
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

  constructor(configPath?: string, startedAt = nowIso()) {
    this.config = loadConfig(configPath);
    this.startedAt = startedAt;
    mkdirSync(this.config.dataDir, { recursive: true });
  }

  info(): RuntimeInfo {
    return createRuntimeInfo(this.config, this.startedAt);
  }

  private getProject(projectId: string): ProjectConfig {
    const project = this.config.projects[projectId];
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  async list(): Promise<SessionView[]> {
    const sessions = listSessions(this.config.dataDir);
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
    const project = this.getProject(request.project);
    if (typeof request.prompt !== "string" || !request.prompt.trim()) {
      throw new Error("prompt must be a non-empty string");
    }
    if (
      request.branch !== undefined &&
      (typeof request.branch !== "string" || !request.branch.trim())
    ) {
      throw new Error("branch must be a non-empty string when provided");
    }

    const overrides = parseSpawnOverrides(request.overrides, "overrides");
    const worktree = resolveSpawnWorktree(project, overrides);
    const defaultBranch = resolveSpawnDefaultBranch({ project, worktree, overrides });
    const agent = parseAgentName(request.agent ?? project.defaultAgent ?? this.config.defaultAgent);
    const sessionId = await reserveNextSessionId(
      this.config.dataDir,
      request.project,
      project.sessionPrefix,
    );
    const resolvedBranch = await resolveSpawnBranch({
      repoPath: project.path,
      requestBranch: request.branch,
      worktree,
      fallbackBranch: sessionId,
    });
    const tmuxSession = sessionId;
    const createdAt = nowIso();

    const placeholder: SessionRecord = {
      id: sessionId,
      project: request.project,
      agent,
      prompt: request.prompt,
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

    let workspacePath = placeholder.worktreePath;
    try {
      const sessionToolDir = ensureSessionSlotTool({
        dataDir: this.config.dataDir,
        sessionId,
        configPath: this.config.configPath,
      });
      if (worktree) {
        workspacePath = await createWorktree({
          repoPath: project.path,
          worktreeBaseDir: this.config.worktreeDir,
          projectId: request.project,
          sessionId,
          defaultBranch,
          branch: resolvedBranch.branch,
          symlinks: project.symlinks,
        });
      }

      const launchPlan = buildAgentLaunchPlan(agent, request.prompt);
      const runningRecord: SessionRecord = {
        ...placeholder,
        worktreePath: workspacePath,
        launchCommand: launchPlan.launchCommand,
        status: "running",
        updatedAt: nowIso(),
      };

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
      await syncTmuxStatus(tmuxSession, runningRecord.slots);
      await waitForTmuxReady(tmuxSession, launchPlan.readyMarkers);
      await sendMessageToTmux(
        tmuxSession,
        withSessionSlotInstructions(launchPlan.initialMessage),
      );

      writeSession(this.config.dataDir, runningRecord);
      return await this.enrich(runningRecord);
    } catch (error) {
      await killTmuxSession(tmuxSession);
      removeSessionSlotTool(this.config.dataDir, sessionId);
      if (worktree && workspacePath) {
        await removeWorktree(project.path, workspacePath);
      }

      const message = error instanceof Error ? error.message : String(error);
      const erroredRecord: SessionRecord = {
        ...placeholder,
        worktreePath: workspacePath,
        status: "errored",
        updatedAt: nowIso(),
        error: message,
      };
      writeSession(this.config.dataDir, erroredRecord);
      throw new Error(`Failed to spawn ${sessionId}: ${message}`, { cause: error });
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

    await sendMessageToTmux(session.tmuxSession, message, options);
    const updated: SessionRecord = {
      ...session,
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    return this.enrich(updated);
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
    return this.enrich(updated);
  }

  async kill(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await killTmuxSession(session.tmuxSession);
    if (session.worktree && session.worktreePath) {
      const project = this.getProject(session.project);
      await removeWorktree(project.path, session.worktreePath);
    }
    removeSessionSlotTool(this.config.dataDir, sessionId);

    if (session.status === "killed") {
      return this.enrich(session);
    }

    const record: SessionRecord = {
      ...session,
      status: "killed",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, record);
    return this.enrich(record);
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

    const restorePrompt = buildRestorePrompt(current.prompt);
    const launchPlan = await waitForRestorePlan(current.agent, current.worktreePath, restorePrompt);
    if (!launchPlan) {
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
      throw new Error(`Failed to restore ${sessionId}: ${message}`, { cause: error });
    }

    const { error: _ignoredError, ...restoredBase } = current;
    const restored: SessionRecord = {
      ...restoredBase,
      launchCommand: launchPlan.launchCommand,
      status: "running",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, restored);
    return this.enrich(restored);
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
