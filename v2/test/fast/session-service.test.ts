import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildAgentLaunchPlanMock = vi.fn();
const buildAgentRestorePlanMock = vi.fn();
const buildAgentResumePlanMock = vi.fn();
const findAgentSessionIdMock = vi.fn();
const parseAgentNameMock = vi.fn((agent: string) => agent);
const loadConfigMock = vi.fn();
const reserveNextSessionIdMock = vi.fn();
const listSessionsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const createTmuxSessionMock = vi.fn();
const getTmuxSessionActivityMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
const killTmuxSessionMock = vi.fn();
const sendMessageToTmuxMock = vi.fn();
const syncTmuxStatusMock = vi.fn();
const captureTmuxPaneMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const waitForTmuxReadyMock = vi.fn();
const createWorktreeMock = vi.fn();
const hasUncommittedChangesMock = vi.fn();
const hasUnpushedCommitsMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const removeWorktreeMock = vi.fn();
const workspaceExistsMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const ensureSessionSlotToolMock = vi.fn();
const removeSessionSlotToolMock = vi.fn();
const withSessionSlotInstructionsMock = vi.fn();
const runSpawnPreflightMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: buildAgentLaunchPlanMock,
  buildAgentRestorePlan: buildAgentRestorePlanMock,
  buildAgentResumePlan: buildAgentResumePlanMock,
  findAgentSessionId: findAgentSessionIdMock,
  parseAgentName: parseAgentNameMock,
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../src/preflight.js", () => ({
  runSpawnPreflight: runSpawnPreflightMock,
}));

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

vi.mock("../../src/ids.js", () => ({
  reserveNextSessionId: reserveNextSessionIdMock,
}));

vi.mock("../../src/metadata.js", () => ({
  listSessions: listSessionsMock,
  readSession: readSessionMock,
  writeSession: writeSessionMock,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  createTmuxSession: createTmuxSessionMock,
  getTmuxSessionActivity: getTmuxSessionActivityMock,
  isProcessRunningInTmux: isProcessRunningInTmuxMock,
  killTmuxSession: killTmuxSessionMock,
  sendMessageToTmux: sendMessageToTmuxMock,
  syncTmuxStatus: syncTmuxStatusMock,
  captureTmuxPane: captureTmuxPaneMock,
  tmuxSessionExists: tmuxSessionExistsMock,
  waitForTmuxReady: waitForTmuxReadyMock,
}));

vi.mock("../../src/session-slots.js", () => ({
  SLOT_TOOL_NAME: "spur-slots",
  applySlotsUpdate: applySlotsUpdateMock,
  ensureSessionSlotTool: ensureSessionSlotToolMock,
  removeSessionSlotTool: removeSessionSlotToolMock,
  withSessionSlotInstructions: withSessionSlotInstructionsMock,
}));

vi.mock("../../src/workspace.js", () => ({
  createWorktree: createWorktreeMock,
  hasUncommittedChanges: hasUncommittedChangesMock,
  hasUnpushedCommits: hasUnpushedCommitsMock,
  readCurrentBranch: readCurrentBranchMock,
  removeWorktree: removeWorktreeMock,
  workspaceExists: workspaceExistsMock,
}));

function baseConfig() {
  return {
    configPath: "/tmp/spur.yaml",
    server: { host: "127.0.0.1", port: 4310 },
    dataDir: "/tmp/spur-data",
    worktreeDir: "/tmp/spur-worktrees",
    defaultAgent: "claude",
    projects: {
      api: {
        path: "/repo/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        symlinks: [".env"],
      },
    },
  };
}

async function loadSessionServiceModule() {
  vi.resetModules();
  return import("../../src/session-service.js");
}

describe("SessionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));

    buildAgentLaunchPlanMock.mockReset().mockReturnValue({
      agent: "claude",
      launchCommand: "claude --dangerously-skip-permissions",
      initialMessage: "hello",
      readyMarkers: ["Claude Code", "❯"],
    });
    buildAgentRestorePlanMock.mockReset().mockResolvedValue({
      agent: "claude",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      initialMessage:
        "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
      readyMarkers: ["❯"],
    });
    buildAgentResumePlanMock.mockReset().mockReturnValue({
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      readyMarkers: ["❯"],
    });
    findAgentSessionIdMock.mockReset().mockResolvedValue("session-uuid");
    parseAgentNameMock.mockReset().mockImplementation((agent: string) => agent);
    loadConfigMock.mockReset().mockReturnValue(baseConfig());
    runSpawnPreflightMock.mockReset().mockResolvedValue({});
    reserveNextSessionIdMock.mockReset().mockResolvedValue("api-1");
    listSessionsMock.mockReset().mockReturnValue([]);
    readSessionMock.mockReset();
    writeSessionMock.mockReset();
    createTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    getTmuxSessionActivityMock.mockReset().mockResolvedValue(new Date("2026-03-18T10:04:30.000Z"));
    isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
    killTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    sendMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
    captureTmuxPaneMock.mockReset().mockResolvedValue("Claude Code\n❯");
    tmuxSessionExistsMock.mockReset().mockResolvedValue(true);
    waitForTmuxReadyMock.mockReset().mockResolvedValue(undefined);
    createWorktreeMock.mockReset().mockResolvedValue("/tmp/spur-worktrees/api/api-1");
    hasUncommittedChangesMock.mockReset().mockResolvedValue(false);
    hasUnpushedCommitsMock.mockReset().mockResolvedValue(false);
    readCurrentBranchMock.mockReset().mockResolvedValue("main");
    removeWorktreeMock.mockReset().mockResolvedValue(undefined);
    workspaceExistsMock.mockReset().mockReturnValue(true);
    syncTmuxStatusMock.mockReset().mockResolvedValue(undefined);
    logSpurEventMock.mockReset();
    ensureSessionSlotToolMock.mockReset().mockReturnValue("/tmp/spur-tools/api-1");
    removeSessionSlotToolMock.mockReset();
    withSessionSlotInstructionsMock.mockReset().mockImplementation((prompt: string) => {
      return `slot-instructions\n${prompt}`;
    });
    applySlotsUpdateMock.mockReset().mockImplementation((current, request) => {
      const links = [...(current?.links ?? [])];
      if (request.unlinkLabels) {
        for (const label of request.unlinkLabels) {
          const index = links.findIndex((link) => link.label === label);
          if (index !== -1) {
            links.splice(index, 1);
          }
        }
      }
      if (request.links) {
        for (const link of request.links) {
          const index = links.findIndex((entry) => entry.label === link.label);
          if (index === -1) {
            links.push(link);
          } else {
            links[index] = link;
          }
        }
      }
      const title = request.clearTitle ? undefined : (request.title ?? current?.title);
      return title || links.length > 0 ? { ...(title ? { title } : {}), links } : undefined;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns a session through one clear path and returns the enriched view", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(createWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo/api",
      worktreeBaseDir: "/tmp/spur-worktrees",
      projectId: "api",
      sessionId: "api-1",
      defaultBranch: "main",
      branch: "api-1",
      symlinks: [".env"],
    });
    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello");
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-1", undefined);
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "slot-instructions\nhello");
    expect(writeSessionMock).toHaveBeenCalledTimes(2);
    expect(writeSessionMock.mock.calls[0]?.[1].status).toBe("spawning");
    expect(writeSessionMock.mock.calls[1]?.[1].status).toBe("running");
    expect(result.id).toBe("api-1");
    expect(result.state).toBe("working");
    expect(result.runtimeAlive).toBe(true);
    expect(result.workspaceExists).toBe(true);
    expect(result.worktree).toBe(true);
    expect(result.branch).toBe("api-1");
    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toEqual([
      "session.spawn.started",
      "session.spawn.worktree_created",
      "session.spawn.tmux_created",
      "session.spawn.ready",
      "session.spawn.prompt_sent",
      "session.agent_session_id.discovered",
      "session.spawn.completed",
    ]);
  });

  it("spawns against the shared project path when worktree is disabled", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          worktree: false,
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(readCurrentBranchMock).toHaveBeenCalledWith("/repo/api");
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/repo/api",
      launchCommand: "claude --dangerously-skip-permissions",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(result.branch).toBe("main");
    expect(result.branchSource).toBe("shared_workspace");
    expect(result.worktree).toBe(false);
    expect(result.worktreePath).toBe("/repo/api");
    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
      "session.spawn.shared_workspace",
    );
  });

  it("logs message delivery after updating tmux and metadata", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.send("api-1", { message: "follow up" });

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", { interrupt: false });
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        id: "api-1",
        updatedAt: "2026-03-18T10:05:00.000Z",
      }),
    );
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.message.sent",
        sessionId: "api-1",
      }),
    );
    expect(result.id).toBe("api-1");
  });

  it("hides completed and killed sessions from list while keeping paused sessions", async () => {
    listSessionsMock.mockReturnValue([
      {
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "hello",
        branch: "api-1",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
      },
      {
        id: "api-2",
        project: "api",
        agent: "claude",
        prompt: "hello",
        branch: "api-2",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-2",
        tmuxSession: "api-2",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "paused",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
      },
      {
        id: "api-3",
        project: "api",
        agent: "claude",
        prompt: "hello",
        branch: "api-3",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-3",
        tmuxSession: "api-3",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "completed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
      },
      {
        id: "api-4",
        project: "api",
        agent: "claude",
        prompt: "hello",
        branch: "api-4",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-4",
        tmuxSession: "api-4",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "killed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
      },
    ]);
    tmuxSessionExistsMock.mockImplementation(async (sessionName: string) => sessionName === "api-1");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const listed = await service.list();

    expect(listed.map((session) => session.id)).toEqual(["api-1", "api-2"]);
    expect(listed[1]?.status).toBe("paused");
    expect(listed[1]?.state).toBe("stopped");
  });

  it("pauses a session without removing its worktree", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    tmuxSessionExistsMock.mockResolvedValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.pause("api-1");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removeSessionSlotToolMock).not.toHaveBeenCalled();
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        id: "api-1",
        status: "paused",
      }),
    );
    expect(result.status).toBe("paused");
    expect(result.state).toBe("stopped");
    expect(result.workspaceExists).toBe(true);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.pause.completed",
        sessionId: "api-1",
      }),
    );
  });

  it("completes a session, removes its worktree, and keeps completed metadata", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    tmuxSessionExistsMock.mockResolvedValue(false);
    workspaceExistsMock.mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.complete("api-1");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        id: "api-1",
        status: "completed",
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.state).toBe("stopped");
    expect(result.workspaceExists).toBe(false);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.complete.completed",
        sessionId: "api-1",
      }),
    );
  });

  it("resumes a paused session on send and marks it running again", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      agentSessionId: "session-uuid",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "paused",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.send("api-1", { message: "resume work" });

    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "resume work", {
      interrupt: false,
    });
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        id: "api-1",
        status: "running",
      }),
    );
    expect(result.status).toBe("running");
  });

  it("respects a per-spawn worktree override without changing the project default", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          worktree: false,
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "hello",
      overrides: {
        worktree: true,
      },
    });

    expect(createWorktreeMock).toHaveBeenCalledOnce();
    expect(readCurrentBranchMock).not.toHaveBeenCalled();
  });

  it("uses a per-spawn defaultBranch override when creating a new worktree branch", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "hello",
      overrides: {
        defaultBranch: "release",
      },
    });

    expect(createWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo/api",
      worktreeBaseDir: "/tmp/spur-worktrees",
      projectId: "api",
      sessionId: "api-1",
      defaultBranch: "release",
      branch: "api-1",
      symlinks: [".env"],
    });
  });

  it("keeps an explicit worktree branch", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
      branch: "feature/api-1",
    });

    expect(createWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo/api",
      worktreeBaseDir: "/tmp/spur-worktrees",
      projectId: "api",
      sessionId: "api-1",
      defaultBranch: "main",
      branch: "feature/api-1",
      symlinks: [".env"],
    });
    expect(result.branchSource).toBe("explicit");
    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
  });

  it("uses a configured spawn preflight branch before creating the worktree", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          preflight: {
            prompt: "Suggest a branch name from the task context.",
          },
        },
      },
    });
    runSpawnPreflightMock.mockResolvedValue({ branch: "feature/runtime-preflight" });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "Fix runtime regression from PR #42",
    });

    expect(runSpawnPreflightMock).toHaveBeenCalledWith({
      agent: "claude",
      projectId: "api",
      project: {
        path: "/repo/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        symlinks: [".env"],
        preflight: {
          prompt: "Suggest a branch name from the task context.",
        },
      },
      baseBranch: "main",
      worktree: true,
      prompt: "Fix runtime regression from PR #42",
    });
    expect(createWorktreeMock).toHaveBeenCalledWith({
      repoPath: "/repo/api",
      worktreeBaseDir: "/tmp/spur-worktrees",
      projectId: "api",
      sessionId: "api-1",
      defaultBranch: "main",
      branch: "feature/runtime-preflight",
      symlinks: [".env"],
    });
    expect(result.branch).toBe("feature/runtime-preflight");
    expect(result.branchSource).toBe("preflight");
  });

  it("skips spawn preflight when an explicit branch is provided", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          preflight: {
            prompt: "Suggest a branch name from the task context.",
          },
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "Fix runtime regression from PR #42",
      branch: "feature/manual-branch",
    });

    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
  });

  it("fails before reserving a session id when configured spawn preflight errors", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          preflight: {
            prompt: "Suggest a branch name from the task context.",
          },
        },
      },
    });
    runSpawnPreflightMock.mockRejectedValue(new Error("Spawn preflight returned invalid JSON"));

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "Fix runtime regression from PR #42",
      }),
    ).rejects.toThrow("Spawn preflight returned invalid JSON");
    expect(reserveNextSessionIdMock).not.toHaveBeenCalled();
    expect(writeSessionMock).not.toHaveBeenCalled();
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
  });

  it("rejects invalid spawn overrides before reserving a session id", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
        overrides: {
          worktree: "nope",
        } as never,
      }),
    ).rejects.toThrow("overrides.worktree must be a boolean");

    expect(reserveNextSessionIdMock).not.toHaveBeenCalled();
  });

  it("rejects a defaultBranch override for shared workspace sessions", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          worktree: false,
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
        overrides: {
          defaultBranch: "release",
        },
      }),
    ).rejects.toThrow("defaultBranch override requires worktree=true");

    expect(reserveNextSessionIdMock).not.toHaveBeenCalled();
  });

  it("cleans up worktree and tmux state when spawn fails after writing placeholder metadata", async () => {
    createTmuxSessionMock.mockRejectedValueOnce(new Error("tmux boom"));

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
      }),
    ).rejects.toThrow("Failed to spawn api-1: tmux boom");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(writeSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      id: "api-1",
      status: "errored",
      error: "tmux boom",
    });
    expect(logSpurEventMock.mock.calls.at(-1)?.[1]).toMatchObject({
      event: "session.spawn.failed",
      details: expect.objectContaining({
        stage: "tmux.create",
      }),
    });
  });

  it("rejects a branch override that would mutate the shared workspace", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          worktree: false,
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
        branch: "feature/shared",
      }),
    ).rejects.toThrow("branch override requires worktree=true; shared workspace is on branch main");

    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("keeps repeated kill idempotent and does not rewrite terminal metadata", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "killed",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    tmuxSessionExistsMock.mockResolvedValue(false);
    workspaceExistsMock.mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.kill("api-1");

    expect(writeSessionMock).not.toHaveBeenCalled();
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(result.status).toBe("killed");
    expect(result.state).toBe("killed");
    expect(result.runtimeAlive).toBe(false);
    expect(result.workspaceExists).toBe(false);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.kill.noop",
        sessionId: "api-1",
      }),
    );
  });

  it("kills a shared workspace session without removing the project path", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "main",
      worktree: false,
      worktreePath: "/repo/api",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.kill("api-1");

    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(writeSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      id: "api-1",
      worktree: false,
      status: "killed",
    });
  });

  it("refuses to kill a dirty worktree session", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    hasUncommittedChangesMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.kill("api-1")).rejects.toThrow(
      "Kill confirmation required for api-1: uncommitted changes in its worktree",
    );

    expect(killTmuxSessionMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("refuses to kill a worktree session with unpushed commits", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    hasUnpushedCommitsMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.kill("api-1")).rejects.toThrow(
      "Kill confirmation required for api-1: unpushed commits",
    );

    expect(killTmuxSessionMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("allows force killing a risky worktree session", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    hasUncommittedChangesMock.mockResolvedValue(true);
    hasUnpushedCommitsMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.kill("api-1", { force: true });

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(result.status).toBe("killed");
  });

  it("updates slots without changing the session timestamp", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      slots: {
        title: "Existing title",
        links: [{ label: "tracker", url: "https://tracker.example.com/1" }],
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.updateSlots("api-1", {
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/1" }],
    });

    expect(applySlotsUpdateMock).toHaveBeenCalledWith(
      {
        title: "Existing title",
        links: [{ label: "tracker", url: "https://tracker.example.com/1" }],
      },
      {
        links: [{ label: "pr", url: "https://github.com/org/repo/pull/1" }],
      },
    );
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        updatedAt: "2026-03-18T10:01:00.000Z",
        slots: {
          title: "Existing title",
          links: [
            { label: "tracker", url: "https://tracker.example.com/1" },
            { label: "pr", url: "https://github.com/org/repo/pull/1" },
          ],
        },
      }),
    );
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-1", {
      title: "Existing title",
      links: [
        { label: "tracker", url: "https://tracker.example.com/1" },
        { label: "pr", url: "https://github.com/org/repo/pull/1" },
      ],
    });
    expect(result.slots?.links).toHaveLength(2);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.slots.updated",
        sessionId: "api-1",
      }),
    );
  });

  it("restores through the agent-specific resume plan and keeps the same session id", async () => {
    findAgentSessionIdMock.mockResolvedValueOnce(null).mockResolvedValue("session-uuid");
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const restored = await service.restore("api-1");

    expect(buildAgentRestorePlanMock).toHaveBeenCalledWith(
      "claude",
      "/tmp/spur-worktrees/api/api-1",
      "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
    );
    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-1", undefined);
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining(
        "slot-instructions\nThis session was restored after the agent exited.",
      ),
    );
    expect(buildAgentLaunchPlanMock).not.toHaveBeenCalled();
    expect(restored.id).toBe("api-1");
    expect(restored.runtimeAlive).toBe(true);
    expect(restored.state).toBe("working");
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
      "session.restore.started",
    );
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
      "session.restore.completed",
    );
  });

  it("fails restore when native resume state is unavailable", async () => {
    findAgentSessionIdMock.mockResolvedValue(null);
    buildAgentRestorePlanMock.mockResolvedValue(null);
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const restorePromise = service.restore("api-1");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(restorePromise).rejects.toThrow(
      "No native resume state found for claude session api-1",
    );

    expect(buildAgentLaunchPlanMock).not.toHaveBeenCalled();
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
    expect(logSpurEventMock.mock.calls.at(-1)?.[1]).toMatchObject({
      event: "session.restore.failed",
      sessionId: "api-1",
    });
  });

  it("waits for native resume state to appear before restoring", async () => {
    findAgentSessionIdMock.mockResolvedValueOnce(null).mockResolvedValue("session-uuid");
    buildAgentRestorePlanMock.mockResolvedValueOnce(null).mockResolvedValue({
      agent: "claude",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      initialMessage:
        "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
      readyMarkers: ["❯"],
    });
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const restorePromise = service.restore("api-1");
    await vi.advanceTimersByTimeAsync(250);
    const restored = await restorePromise;

    expect(buildAgentRestorePlanMock.mock.calls.length).toBeGreaterThan(1);
    expect(restored.id).toBe("api-1");
    expect(restored.runtimeAlive).toBe(true);
  });

  it("fails restore before sending the prompt when the resumed agent exits back to the shell", async () => {
    findAgentSessionIdMock.mockResolvedValue(null);
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.restore("api-1")).rejects.toThrow(
      "Failed to restore api-1: Agent claude exited before restore became ready",
    );

    expect(sendMessageToTmuxMock).not.toHaveBeenCalled();
  });

  it("rejects restore for shared workspace sessions", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "main",
      worktree: false,
      worktreePath: "/repo/api",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.restore("api-1")).rejects.toThrow(
      "Session is not restorable without a worktree: api-1",
    );
    expect(buildAgentRestorePlanMock).not.toHaveBeenCalled();
  });

  it("rejects restore when the session is not restorable", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.restore("api-1")).rejects.toThrow("Session is not restorable: api-1");
    expect(buildAgentRestorePlanMock).not.toHaveBeenCalled();
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
  });
});
