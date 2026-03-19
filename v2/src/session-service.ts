import { mkdirSync } from "node:fs";
import { buildAgentLaunchPlan, buildAgentRestorePlan, parseAgentName } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { reserveNextSessionId } from "./ids.js";
import { listSessions, readSession, writeSession } from "./metadata.js";
import {
  createTmuxSession,
  getTmuxSessionActivity,
  isProcessRunningInTmux,
  killTmuxSession,
  sendMessageToTmux,
  captureTmuxPane,
  tmuxSessionExists,
  waitForTmuxReady,
} from "./runtime-tmux.js";
import {
  SPUR_DAEMON_API_VERSION,
  type AppConfig,
  type ProjectConfig,
  type RuntimeInfo,
  type SendMessageRequest,
  type SessionActivity,
  type SessionRecord,
  type SessionView,
  type SpawnSessionRequest,
} from "./types.js";
import type {
  AppConfig,
} from "./types.js";
import { createWorktree, removeWorktree, workspaceExists } from "./workspace.js";

const IDLE_THRESHOLD_MS = 300_000;
const WAITING_INPUT_TAIL_LINES = 12;
const PROMPT_RE = /^[❯›>$#](?:\s.*)?$/;
const TRAILING_UI_RE = [
  /^[─━]+$/,
  /^⏵⏵ /,
  /^Claude in Chrome enabled\b/,
  /^Update available!\b/,
  /^gpt-[\w.-]+\b.*·/,
];
const ACTIVE_UI_RE = [/^• Working \(/];
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

function resolveLastActivityAt(sessionUpdatedAt: string, activityAt: Date | null): Date {
  const updatedAt = new Date(sessionUpdatedAt);
  if (activityAt === null || activityAt < updatedAt) {
    return updatedAt;
  }
  return activityAt;
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

export function classifyActivity(
  pane: string,
  lastActivityAt: Date,
): SessionActivity {
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
  const lastLine = lines.at(-1)?.trim() ?? "";
  if (lines.slice(-5).some((line) => ACTIVE_UI_RE.some((pattern) => pattern.test(line.trim())))) {
    return "active";
  }
  if (PROMPT_RE.test(lastLine)) {
    return Date.now() - lastActivityAt.getTime() > IDLE_THRESHOLD_MS ? "idle" : "ready";
  }
  if (isWaitingInput(lines)) {
    return "waiting_input";
  }

  return "active";
}

export function isRestorableSession(
  session: Pick<SessionView, "status" | "activity" | "workspaceExists">,
): boolean {
  return session.status === "running" && session.activity === "exited" && session.workspaceExists;
}

function buildRestorePrompt(prompt: string): string {
  return `${RESTORE_PROMPT_PREFIX}\n\n${prompt}`;
}

export class SessionService {
  readonly config: AppConfig;
  readonly startedAt: string;

  constructor(configPath?: string, startedAt = nowIso()) {
    this.config = loadConfig(configPath);
    this.startedAt = startedAt;
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
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

    const agent = parseAgentName(
      request.agent ?? project.defaultAgent ?? this.config.defaultAgent,
    );
    const sessionId = await reserveNextSessionId(
      this.config.dataDir,
      request.project,
      project.sessionPrefix,
    );
    const branch = request.branch?.trim() || sessionId;
    const tmuxSession = sessionId;
    const createdAt = nowIso();

    const placeholder: SessionRecord = {
      id: sessionId,
      project: request.project,
      agent,
      prompt: request.prompt,
      branch,
      worktreePath: "",
      tmuxSession,
      launchCommand: "",
      status: "spawning",
      createdAt,
      updatedAt: createdAt,
    };
    writeSession(this.config.dataDir, placeholder);

    let worktreePath = "";
    try {
      worktreePath = await createWorktree({
        repoPath: project.path,
        worktreeBaseDir: this.config.worktreeDir,
        projectId: request.project,
        sessionId,
        defaultBranch: project.defaultBranch,
        branch,
        symlinks: project.symlinks,
      });

      const launchPlan = buildAgentLaunchPlan(agent, request.prompt);
      const runningRecord: SessionRecord = {
        ...placeholder,
        worktreePath,
        launchCommand: launchPlan.launchCommand,
        status: "running",
        updatedAt: nowIso(),
      };

      await createTmuxSession({
        sessionName: tmuxSession,
        cwd: worktreePath,
        launchCommand: launchPlan.launchCommand,
        env: {
          SPUR_SESSION: sessionId,
          SPUR_PROJECT: request.project,
          SPUR_AGENT: agent,
        },
      });
      await waitForTmuxReady(tmuxSession, launchPlan.readyMarkers);
      await sendMessageToTmux(tmuxSession, launchPlan.initialMessage);

      writeSession(this.config.dataDir, runningRecord);
      return this.enrich(runningRecord);
    } catch (error) {
      await killTmuxSession(tmuxSession);
      if (worktreePath) {
        await removeWorktree(project.path, worktreePath);
      }

      const message = error instanceof Error ? error.message : String(error);
      const erroredRecord: SessionRecord = {
        ...placeholder,
        worktreePath,
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

  async kill(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await killTmuxSession(session.tmuxSession);
    if (session.worktreePath) {
      const project = this.getProject(session.project);
      await removeWorktree(project.path, session.worktreePath);
    }

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
    if (!isRestorableSession(current)) {
      throw new Error(`Session is not restorable: ${sessionId}`);
    }

    const restorePrompt = buildRestorePrompt(session.prompt);
    const launchPlan = await buildAgentRestorePlan(
      session.agent,
      session.worktreePath,
      restorePrompt,
    );
    if (!launchPlan) {
      throw new Error(`No native resume state found for ${session.agent} session ${sessionId}`);
    }

    await killTmuxSession(session.tmuxSession);

    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: launchPlan.launchCommand,
        env: {
          SPUR_SESSION: session.id,
          SPUR_PROJECT: session.project,
          SPUR_AGENT: session.agent,
        },
      });
      await waitForTmuxReady(session.tmuxSession, launchPlan.readyMarkers);
      if (!(await isProcessRunningInTmux(session.tmuxSession, session.agent))) {
        throw new Error(`Agent ${session.agent} exited before restore became ready`);
      }
      await sendMessageToTmux(session.tmuxSession, launchPlan.initialMessage);
    } catch (error) {
      await killTmuxSession(session.tmuxSession);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to restore ${sessionId}: ${message}`, { cause: error });
    }

    const { error: _ignoredError, ...restoredBase } = session;
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

    let activity: SessionActivity;
    let lastActivityAt: string;

    if (session.status === "spawning") {
      const activityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
      activity = "active";
      lastActivityAt = resolveLastActivityAt(session.updatedAt, activityAt).toISOString();
    } else if (!runtimeAlive) {
      activity = "exited";
      lastActivityAt = session.updatedAt;
    } else {
      const processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
      const activityAt = resolveLastActivityAt(
        session.updatedAt,
        await getTmuxSessionActivity(session.tmuxSession),
      );
      lastActivityAt = activityAt.toISOString();

      if (!processAlive) {
        activity = "exited";
      } else {
        const pane = await captureTmuxPane(session.tmuxSession, 80);
        activity = classifyActivity(pane, activityAt);
      }
    }

    return {
      ...session,
      runtimeAlive,
      workspaceExists: workspacePresent,
      activity,
      lastActivityAt,
    };
  }
}
