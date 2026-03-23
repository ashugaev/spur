import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildAgentLaunchPlan,
  buildAgentResumePlan,
  findAgentSessionId,
  parseAgentName,
} from "./agents/index.js";
import { loadConfig } from "./config.js";
import { appendEvent, errorDetails, type EventLevel } from "./event-log.js";
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
import type {
  AppConfig,
  RuntimeInfo,
  SessionActivity,
  SessionStatus,
  SendMessageRequest,
  SessionRecord,
  SessionView,
  SpawnSessionRequest,
} from "./types.js";
import { createWorktree, removeWorktree, workspaceExists } from "./workspace.js";

const IDLE_THRESHOLD_MS = 300_000;
const AGENT_SESSION_ID_INITIAL_WAIT_MS = 5_000;
const AGENT_SESSION_ID_REFRESH_WAIT_MS = 1_500;
const AGENT_SESSION_ID_POLL_INTERVAL_MS = 250;
const PROMPT_RE = /^[❯›>$#]\s*$/;
const TRAILING_UI_RE = [/^[─━]+$/, /^⏵⏵ /, /^Claude in Chrome enabled\b/, /^Update available!\b/];
const PERMISSION_PROMPTS = [
  /approval required/i,
  /Do you want to proceed\?/i,
  /\((?:y|Y)\)es.*\((?:n|N)\)o/i,
];

function nowIso(): string {
  return new Date().toISOString();
}

function createRuntimeInfo(config: AppConfig, startedAt: string): RuntimeInfo {
  return {
    ok: true,
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

function deriveStoppedStatus(session: SessionRecord, workspacePresent: boolean): SessionStatus {
  if (!workspacePresent) {
    return session.status;
  }
  if (session.status === "running" || session.status === "spawning" || session.status === "stopped") {
    return "stopped";
  }
  return session.status;
}

function classifyActivity(
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
  if (PROMPT_RE.test(lastLine)) {
    return Date.now() - lastActivityAt.getTime() > IDLE_THRESHOLD_MS ? "idle" : "ready";
  }

  const tail = lines.slice(-5).join("\n");
  if (PERMISSION_PROMPTS.some((pattern) => pattern.test(tail))) {
    return "waiting_input";
  }

  return "active";
}

export class SessionService {
  readonly config: AppConfig;
  readonly startedAt: string;
  private readonly runtimeSnapshots = new Map<string, string>();

  constructor(configPath?: string, startedAt = nowIso()) {
    this.config = loadConfig(configPath);
    this.startedAt = startedAt;
    mkdirSync(this.config.dataDir, { recursive: true });
    mkdirSync(this.config.worktreeDir, { recursive: true });
  }

  info(): RuntimeInfo {
    return createRuntimeInfo(this.config, this.startedAt);
  }

  logEvent(input: {
    event: string;
    level?: EventLevel;
    message: string;
    sessionId?: string;
    projectId?: string;
    details?: Record<string, unknown>;
  }): void {
    appendEvent(this.config.dataDir, {
      event: input.event,
      level: input.level ?? "info",
      message: input.message,
      sessionId: input.sessionId,
      projectId: input.projectId,
      details: input.details,
    });
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
    const project = this.config.projects[request.project];
    if (!project) {
      throw new Error(`Unknown project: ${request.project}`);
    }
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
      agentSessionId: undefined,
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
    this.logEvent({
      event: "session.spawn.started",
      sessionId,
      projectId: request.project,
      message: `Spawning ${sessionId}`,
      details: {
        agent,
        branch,
      },
    });

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

      const persistedRecord = await this.captureAgentSessionId(
        runningRecord,
        AGENT_SESSION_ID_INITIAL_WAIT_MS,
      );
      writeSession(this.config.dataDir, persistedRecord);
      this.logEvent({
        event: "session.spawn.completed",
        sessionId,
        projectId: request.project,
        message: `Spawned ${sessionId}`,
        details: {
          agent,
          worktreePath,
          tmuxSession,
          agentSessionId: persistedRecord.agentSessionId ?? null,
        },
      });
      return this.enrich(persistedRecord);
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
      this.logEvent({
        event: "session.spawn.failed",
        level: "error",
        sessionId,
        projectId: request.project,
        message: `Failed to spawn ${sessionId}`,
        details: {
          agent,
          branch,
          worktreePath,
          ...errorDetails(error),
        },
      });
      throw new Error(`Failed to spawn ${sessionId}: ${message}`);
    }
  }

  async send(sessionId: string, request: SendMessageRequest): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (typeof request.message !== "string" || !request.message.trim()) {
      throw new Error("message must be a non-empty string");
    }

    const activeSession = await this.ensureSessionReadyForSend(session);
    await sendMessageToTmux(activeSession.tmuxSession, request.message);
    const updatedRecord: SessionRecord = {
      ...activeSession,
      updatedAt: nowIso(),
    };
    const persistedRecord = await this.captureAgentSessionId(
      updatedRecord,
      AGENT_SESSION_ID_REFRESH_WAIT_MS,
    );
    writeSession(this.config.dataDir, persistedRecord);
    return this.enrich(persistedRecord);
  }

  async kill(sessionId: string): Promise<SessionView> {
    const session = readSession(this.config.dataDir, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await killTmuxSession(session.tmuxSession);
    if (session.worktreePath) {
      const project = this.config.projects[session.project];
      await removeWorktree(project.path, session.worktreePath);
    }

    const record: SessionRecord =
      session.status === "killed"
        ? session
        : {
            ...session,
            status: "killed",
            updatedAt: nowIso(),
          };
    if (record !== session) {
      writeSession(this.config.dataDir, record);
    }
    this.logEvent({
      event: "session.kill.completed",
      sessionId,
      projectId: session.project,
      message: `Killed ${sessionId}`,
      details: {
        tmuxSession: session.tmuxSession,
        worktreePath: session.worktreePath,
      },
    });
    return this.enrich(record);
  }

  private sessionEnv(session: SessionRecord): Record<string, string> {
    return {
      SPUR_SESSION: session.id,
      SPUR_PROJECT: session.project,
      SPUR_AGENT: session.agent,
    };
  }

  private async captureAgentSessionId(
    session: SessionRecord,
    timeoutMs: number,
  ): Promise<SessionRecord> {
    if (!session.worktreePath) {
      return session;
    }

    const deadline = Date.now() + Math.max(timeoutMs, 0);
    while (true) {
      const agentSessionId = await findAgentSessionId(session.agent, session.worktreePath);
      if (agentSessionId) {
        if (agentSessionId === session.agentSessionId) {
          return session;
        }
        this.logEvent({
          event: "session.agent_session_id.discovered",
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

      if (Date.now() >= deadline) {
        return session;
      }
      await sleep(AGENT_SESSION_ID_POLL_INTERVAL_MS);
    }
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
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    this.logEvent({
      event: "session.recover.check",
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
    if (!session.worktreePath || !workspacePresent) {
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
    this.logEvent({
      event: "session.recover.started",
      sessionId: session.id,
      projectId: session.project,
      message: `Recovering ${session.id}`,
      details: {
        agent: session.agent,
        recoveryMode: recoveryPlan ? "native_resume" : "fresh_launch",
        agentSessionId: sessionWithAgentId.agentSessionId ?? null,
      },
    });
    try {
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: recoveryPlan?.launchCommand ?? baseLaunchCommand,
        env: this.sessionEnv(session),
      });
      await waitForTmuxReady(
        session.tmuxSession,
        recoveryPlan?.readyMarkers ?? baseLaunchPlan.readyMarkers,
      );
    } catch (error) {
      if (!recoveryPlan) {
        throw error;
      }

      this.logEvent({
        event: "session.recover.resume_failed",
        level: "warn",
        sessionId: session.id,
        projectId: session.project,
        message: `Native resume failed for ${session.id}; falling back to a fresh launch`,
        details: {
          agent: session.agent,
          agentSessionId: sessionWithAgentId.agentSessionId ?? null,
          launchCommand: recoveryPlan.launchCommand,
          ...errorDetails(error),
        },
      });
      await killTmuxSession(session.tmuxSession);
      recoveredAgentSessionId = undefined;
      await createTmuxSession({
        sessionName: session.tmuxSession,
        cwd: session.worktreePath,
        launchCommand: baseLaunchCommand,
        env: this.sessionEnv(session),
      });
      await waitForTmuxReady(session.tmuxSession, baseLaunchPlan.readyMarkers);
    }

    const recovered: SessionRecord = {
      ...sessionWithAgentId,
      agentSessionId: recoveredAgentSessionId,
      launchCommand: baseLaunchCommand,
      status: "running",
      updatedAt: nowIso(),
    };
    delete recovered.error;
    writeSession(this.config.dataDir, recovered);
    this.logEvent({
      event: "session.recover.completed",
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

  private logRuntimeObservation(
    session: SessionRecord,
    view: SessionView,
    processAlive: boolean | null,
  ): void {
    const snapshot = [
      session.status,
      view.status,
      view.runtimeAlive ? "1" : "0",
      view.workspaceExists ? "1" : "0",
      processAlive === null ? "?" : processAlive ? "1" : "0",
    ].join("|");
    const previous = this.runtimeSnapshots.get(session.id);
    if (previous === snapshot) {
      return;
    }
    this.runtimeSnapshots.set(session.id, snapshot);
    this.logEvent({
      event: "session.runtime.observed",
      sessionId: session.id,
      projectId: session.project,
      message: `Observed runtime state for ${session.id}`,
      details: {
        persistedStatus: session.status,
        derivedStatus: view.status,
        runtimeAlive: view.runtimeAlive,
        workspaceExists: view.workspaceExists,
        processAlive,
        activity: view.activity,
        lastActivityAt: view.lastActivityAt,
      },
    });
  }

  private async enrich(session: SessionRecord): Promise<SessionView> {
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    const fallbackActivityAt = session.updatedAt;
    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);

    if (session.status === "spawning") {
      const activityAt = runtimeAlive ? await getTmuxSessionActivity(session.tmuxSession) : null;
      const view: SessionView = {
        ...session,
        runtimeAlive,
        workspaceExists: workspacePresent,
        activity: "active",
        lastActivityAt: resolveLastActivityAt(fallbackActivityAt, activityAt).toISOString(),
      };
      this.logRuntimeObservation(session, view, null);
      return view;
    }

    if (!runtimeAlive) {
      const view: SessionView = {
        ...session,
        status: deriveStoppedStatus(session, workspacePresent),
        runtimeAlive,
        workspaceExists: workspacePresent,
        activity: "exited",
        lastActivityAt: fallbackActivityAt,
      };
      this.logRuntimeObservation(session, view, false);
      return view;
    }

    const processAlive = await isProcessRunningInTmux(session.tmuxSession, session.agent);
    const activityAt = resolveLastActivityAt(
      session.updatedAt,
      await getTmuxSessionActivity(session.tmuxSession),
    );
    const lastActivityAt = activityAt.toISOString();
    if (!processAlive) {
      const view: SessionView = {
        ...session,
        status: deriveStoppedStatus(session, workspacePresent),
        runtimeAlive,
        workspaceExists: workspacePresent,
        activity: "exited",
        lastActivityAt,
      };
      this.logRuntimeObservation(session, view, false);
      return view;
    }

    const pane = await captureTmuxPane(session.tmuxSession, 80);
    const view: SessionView = {
      ...session,
      runtimeAlive,
      workspaceExists: workspacePresent,
      activity: classifyActivity(pane, activityAt),
      lastActivityAt,
    };
    this.logRuntimeObservation(session, view, true);
    return view;
  }
}
