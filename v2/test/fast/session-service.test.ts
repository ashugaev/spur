import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildAgentLaunchPlanMock = vi.fn();
const buildAgentRestorePlanMock = vi.fn();
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
const captureTmuxPaneMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const waitForTmuxReadyMock = vi.fn();
const createWorktreeMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const removeWorktreeMock = vi.fn();
const workspaceExistsMock = vi.fn();

vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: buildAgentLaunchPlanMock,
  buildAgentRestorePlan: buildAgentRestorePlanMock,
  parseAgentName: parseAgentNameMock,
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: loadConfigMock,
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
  captureTmuxPane: captureTmuxPaneMock,
  tmuxSessionExists: tmuxSessionExistsMock,
  waitForTmuxReady: waitForTmuxReadyMock,
}));

vi.mock("../../src/workspace.js", () => ({
  createWorktree: createWorktreeMock,
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
    parseAgentNameMock.mockReset().mockImplementation((agent: string) => agent);
    loadConfigMock.mockReset().mockReturnValue(baseConfig());
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
    readCurrentBranchMock.mockReset().mockResolvedValue("main");
    removeWorktreeMock.mockReset().mockResolvedValue(undefined);
    workspaceExistsMock.mockReset().mockReturnValue(true);
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
      },
    });
    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello");
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "hello");
    expect(writeSessionMock).toHaveBeenCalledTimes(2);
    expect(writeSessionMock.mock.calls[0]?.[1].status).toBe("spawning");
    expect(writeSessionMock.mock.calls[1]?.[1].status).toBe("running");
    expect(result.id).toBe("api-1");
    expect(result.state).toBe("working");
    expect(result.runtimeAlive).toBe(true);
    expect(result.workspaceExists).toBe(true);
    expect(result.worktree).toBe(true);
    expect(result.branch).toBe("api-1");
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
      },
    });
    expect(result.branch).toBe("main");
    expect(result.branchSource).toBe("shared_workspace");
    expect(result.worktree).toBe(false);
    expect(result.worktreePath).toBe("/repo/api");
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
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(writeSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      id: "api-1",
      status: "errored",
      error: "tmux boom",
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
    expect(result.status).toBe("killed");
    expect(result.state).toBe("killed");
    expect(result.runtimeAlive).toBe(false);
    expect(result.workspaceExists).toBe(false);
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
    expect(writeSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      id: "api-1",
      worktree: false,
      status: "killed",
    });
  });

  it("restores through the agent-specific resume plan and keeps the same session id", async () => {
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
      },
    });
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining("This session was restored after the agent exited."),
    );
    expect(buildAgentLaunchPlanMock).not.toHaveBeenCalled();
    expect(restored.id).toBe("api-1");
    expect(restored.runtimeAlive).toBe(true);
    expect(restored.state).toBe("working");
  });

  it("fails restore when native resume state is unavailable", async () => {
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
  });

  it("waits for native resume state to appear before restoring", async () => {
    buildAgentRestorePlanMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
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
