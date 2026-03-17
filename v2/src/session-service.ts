import { mkdirSync } from "node:fs";
import { buildAgentLaunchPlan, parseAgentName } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { reserveNextSessionId } from "./ids.js";
import { listSessions, readSession, writeSession } from "./metadata.js";
import {
  createTmuxSession,
  killTmuxSession,
  sendMessageToTmux,
  tmuxSessionExists,
  waitForTmuxReady,
} from "./runtime-tmux.js";
import type {
  AppConfig,
  RuntimeInfo,
  SendMessageRequest,
  SessionRecord,
  SessionView,
  SpawnSessionRequest,
} from "./types.js";
import { createWorktree, removeWorktree, workspaceExists } from "./workspace.js";

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

    await sendMessageToTmux(session.tmuxSession, request.message);
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
      const project = this.config.projects[session.project];
      await removeWorktree(project.path, session.worktreePath);
    }

    const runtimeAlive = await tmuxSessionExists(session.tmuxSession);
    const workspacePresent = session.worktreePath ? workspaceExists(session.worktreePath) : false;
    if (session.status === "killed" && !runtimeAlive && !workspacePresent) {
      return {
        ...session,
        runtimeAlive,
        workspaceExists: workspacePresent,
      };
    }

    const updated: SessionRecord = {
      ...session,
      status: "killed",
      updatedAt: nowIso(),
    };
    writeSession(this.config.dataDir, updated);
    return {
      ...updated,
      runtimeAlive,
      workspaceExists: workspacePresent,
    };
  }

  private async enrich(session: SessionRecord): Promise<SessionView> {
    return {
      ...session,
      runtimeAlive: await tmuxSessionExists(session.tmuxSession),
      workspaceExists: session.worktreePath ? workspaceExists(session.worktreePath) : false,
    };
  }
}
