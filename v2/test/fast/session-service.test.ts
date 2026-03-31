import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstanceRecord, SessionRecord } from "../../src/types.js";

const buildAgentLaunchPlanMock = vi.fn();
const buildAgentResumePlanMock = vi.fn();
const findAgentSessionIdMock = vi.fn();
const ensureAgentStatusHooksMock = vi.fn();
const parseAgentNameMock = vi.fn((agent: string) => agent);
const loadConfigMock = vi.fn();
const reserveNextSessionIdMock = vi.fn();
const listSessionsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const deleteServiceInstanceMock = vi.fn();
const deleteServiceInstancesForSessionMock = vi.fn();
const deleteServiceSourceStatesForServiceMock = vi.fn();
const deleteServiceSourceStatesForSessionMock = vi.fn();
const listActiveServiceProblemsMock = vi.fn();
const listServiceInstancesForSessionMock = vi.fn();
const readServiceInstanceMock = vi.fn();
const writeServiceInstanceMock = vi.fn();
const createTmuxSessionMock = vi.fn();
const createTmuxCommandSessionMock = vi.fn();
const getTmuxSessionActivityMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
const killTmuxSessionMock = vi.fn();
const sendMessageToTmuxMock = vi.fn();
const syncTmuxStatusMock = vi.fn();
const tmuxPaneDeadMock = vi.fn();
const captureTmuxPaneMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const waitForTmuxReadyMock = vi.fn();
const createWorktreeMock = vi.fn();
const hasUncommittedChangesMock = vi.fn();
const hasUnpushedCommitsMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const removeWorktreeMock = vi.fn();
const resolveRepoPathFromWorktreeMock = vi.fn();
const workspaceExistsMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const ensureSessionSlotToolMock = vi.fn();
const removeSessionSlotToolMock = vi.fn();
const removeAgentStatusHooksMock = vi.fn();
const withSessionSlotInstructionsMock = vi.fn();
const runSpawnPreflightMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: buildAgentLaunchPlanMock,
  buildAgentResumePlan: buildAgentResumePlanMock,
  findAgentSessionId: findAgentSessionIdMock,
  parseAgentName: parseAgentNameMock,
}));

vi.mock("../../src/agents/status-hooks.js", () => ({
  ensureAgentStatusHooks: ensureAgentStatusHooksMock,
  removeAgentStatusHooks: removeAgentStatusHooksMock,
  STATUS_HOOK_GIT_STATUS_EXCLUDES: [".claude/", ".codex/"],
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
  deleteServiceInstance: deleteServiceInstanceMock,
  deleteServiceInstancesForSession: deleteServiceInstancesForSessionMock,
  deleteServiceSourceStatesForService: deleteServiceSourceStatesForServiceMock,
  deleteServiceSourceStatesForSession: deleteServiceSourceStatesForSessionMock,
  listActiveServiceProblems: listActiveServiceProblemsMock,
  listServiceInstancesForSession: listServiceInstancesForSessionMock,
  listSessions: listSessionsMock,
  readServiceInstance: readServiceInstanceMock,
  readSession: readSessionMock,
  writeServiceInstance: writeServiceInstanceMock,
  writeSession: writeSessionMock,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  createTmuxSession: createTmuxSessionMock,
  createTmuxCommandSession: createTmuxCommandSessionMock,
  getTmuxSessionActivity: getTmuxSessionActivityMock,
  isProcessRunningInTmux: isProcessRunningInTmuxMock,
  killTmuxSession: killTmuxSessionMock,
  sendMessageToTmux: sendMessageToTmuxMock,
  syncTmuxStatus: syncTmuxStatusMock,
  tmuxPaneDead: tmuxPaneDeadMock,
  captureTmuxPane: captureTmuxPaneMock,
  tmuxSessionExists: tmuxSessionExistsMock,
  waitForTmuxReady: waitForTmuxReadyMock,
}));

vi.mock("../../src/session-slots.js", () => ({
  SLOT_TOOL_NAME: "spur-slots",
  STATUS_TOOL_NAME: "spur-session-status",
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
  resolveRepoPathFromWorktree: resolveRepoPathFromWorktreeMock,
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
        sources: {},
        triggers: {},
      },
    },
  };
}

async function loadSessionServiceModule() {
  vi.resetModules();
  return import("../../src/session-service.js");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "hello",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/worktree",
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "working",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    ...overrides,
  };
}

function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();
  readSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session ? clone(session) : null;
  });
  writeSessionMock.mockImplementation((_dataDir: string, session: SessionRecord) => {
    sessions.set(session.id, clone(session));
  });
  listSessionsMock.mockImplementation(() =>
    [...sessions.values()].map((session) => clone(session)),
  );
  return sessions;
}

function serviceKey(sessionId: string, serviceId: string): string {
  return `${sessionId}:${serviceId}`;
}

function resetServiceStore() {
  const services = new Map<string, ServiceInstanceRecord>();
  listServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) =>
    [...services.values()]
      .filter((service) => service.sessionId === sessionId)
      .map((service) => clone(service)),
  );
  readServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      const service = services.get(serviceKey(sessionId, serviceId));
      return service ? clone(service) : undefined;
    },
  );
  writeServiceInstanceMock.mockImplementation(
    (_dataDir: string, service: ServiceInstanceRecord) => {
      services.set(serviceKey(service.sessionId, service.serviceId), clone(service));
    },
  );
  deleteServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      services.delete(serviceKey(sessionId, serviceId));
    },
  );
  deleteServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    for (const key of services.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        services.delete(key);
      }
    }
  });
}

describe("SessionService", () => {
  let sessions: Map<string, SessionRecord>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));

    buildAgentLaunchPlanMock
      .mockReset()
      .mockImplementation((agent: string, initialMessage: string) => ({
        launchCommand:
          agent === "codex"
            ? "codex -c features.codex_hooks=true --dangerously-bypass-approvals-and-sandbox"
            : "claude --dangerously-skip-permissions",
        initialMessage,
        readyMarkers: agent === "codex" ? ["OpenAI Codex", "›"] : ["Claude Code", "❯"],
      }));
    buildAgentResumePlanMock
      .mockReset()
      .mockImplementation((_agent: string, agentSessionId: string, launchCommand = "") => ({
        launchCommand: launchCommand.includes("codex")
          ? `codex resume -c features.codex_hooks=true --dangerously-bypass-approvals-and-sandbox ${agentSessionId}`
          : `claude --resume ${agentSessionId} --dangerously-skip-permissions`,
        readyMarkers: launchCommand.includes("codex") ? ["›"] : ["❯"],
      }));
    findAgentSessionIdMock.mockReset().mockResolvedValue("native-123");
    ensureAgentStatusHooksMock.mockReset();
    parseAgentNameMock.mockReset().mockImplementation((agent: string) => agent);
    loadConfigMock.mockReset().mockReturnValue(baseConfig());
    runSpawnPreflightMock.mockReset().mockResolvedValue({});
    reserveNextSessionIdMock.mockReset().mockResolvedValue("api-1");
    listActiveServiceProblemsMock.mockReset().mockReturnValue([]);
    getTmuxSessionActivityMock.mockReset().mockResolvedValue(new Date("2026-03-18T10:04:30.000Z"));
    isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
    killTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    sendMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
    syncTmuxStatusMock.mockReset().mockResolvedValue(undefined);
    tmuxPaneDeadMock.mockReset().mockResolvedValue(false);
    captureTmuxPaneMock.mockReset().mockResolvedValue("Claude Code\n❯");
    tmuxSessionExistsMock.mockReset().mockResolvedValue(true);
    waitForTmuxReadyMock.mockReset().mockResolvedValue(undefined);
    createTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    createTmuxCommandSessionMock.mockReset().mockResolvedValue(undefined);
    createWorktreeMock.mockReset().mockResolvedValue("/tmp/spur-worktrees/api/api-1");
    hasUncommittedChangesMock.mockReset().mockResolvedValue(false);
    hasUnpushedCommitsMock.mockReset().mockResolvedValue(false);
    readCurrentBranchMock.mockReset().mockResolvedValue("main");
    removeWorktreeMock.mockReset().mockResolvedValue(undefined);
    resolveRepoPathFromWorktreeMock.mockReset().mockResolvedValue(undefined);
    workspaceExistsMock.mockReset().mockReturnValue(true);
    ensureSessionSlotToolMock.mockReset().mockReturnValue("/tmp/spur-tools/api-1");
    removeAgentStatusHooksMock.mockReset();
    removeSessionSlotToolMock.mockReset();
    withSessionSlotInstructionsMock
      .mockReset()
      .mockImplementation((prompt: string) => `slot-instructions\n${prompt}`);
    applySlotsUpdateMock.mockReset().mockImplementation((current, request) => {
      const links = [...(current?.links ?? [])];
      if (request.links) {
        links.push(...request.links);
      }
      const title = request.clearTitle ? undefined : (request.title ?? current?.title);
      return title || links.length > 0 ? { ...(title ? { title } : {}), links } : undefined;
    });
    logSpurEventMock.mockReset();

    sessions = createSessionStore();
    resetServiceStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns a working session through the single status path", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello");
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
      env: expect.objectContaining({
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_CONFIG: "/tmp/spur.yaml",
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
      }),
    });
    expect(createTmuxSessionMock.mock.calls[0]?.[0].env).not.toHaveProperty(
      "SPUR_AGENT_STATE_COMMAND",
    );
    expect(ensureAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "slot-instructions\nhello");
    expect(writeSessionMock.mock.calls[0]?.[1].status).toBe("spawning");
    expect(writeSessionMock.mock.calls.at(-1)?.[1].status).toBe("working");
    expect(result.status).toBe("working");
    expect(sessions.get("api-1")?.status).toBe("working");
  });

  it("keeps a fresher hook-driven waiting status after the initial prompt send", async () => {
    sendMessageToTmuxMock.mockImplementationOnce(async () => {
      const current = sessions.get("api-1");
      if (current) {
        sessions.set("api-1", {
          ...current,
          status: "waiting",
          updatedAt: "2026-03-18T10:05:01.000Z",
        });
      }
    });
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(result.status).toBe("waiting");
    expect(sessions.get("api-1")?.status).toBe("waiting");
  });

  it("stores pipeline progress without a separate pipeline status layer", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
      steps: ["research", "test"],
    });

    expect(buildAgentLaunchPlanMock.mock.calls[0]?.[1]).toContain("step 1/2");
    expect(buildAgentLaunchPlanMock.mock.calls[0]?.[1]).toContain("research");
    expect(sessions.get("api-1")?.pipeline).toEqual({
      steps: ["research", "test"],
      nextStepIndex: 1,
      awaitingStepIndex: 0,
    });
    expect(sessions.get("api-1")?.pipeline).not.toHaveProperty("status");
    expect(result.status).toBe("working");
  });

  it("cleans up and persists error when spawn fails after placeholder metadata", async () => {
    waitForTmuxReadyMock.mockRejectedValueOnce(new Error("tmux never ready"));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
      }),
    ).rejects.toThrow("Failed to spawn api-1: tmux never ready");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
    });
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(sessions.get("api-1")?.status).toBe("error");
    expect(sessions.get("api-1")?.error).toContain("tmux never ready");
  });

  it("hides completed and killed sessions from list while keeping paused sessions", async () => {
    sessions.set("api-1", sessionRecord({ id: "api-1", status: "paused" }));
    sessions.set(
      "api-2",
      sessionRecord({ id: "api-2", tmuxSession: "api-2", status: "completed" }),
    );
    sessions.set("api-3", sessionRecord({ id: "api-3", tmuxSession: "api-3", status: "killed" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const listed = await service.list();

    expect(listed.map((entry) => entry.id)).toEqual(["api-1"]);
    expect(listed[0]?.status).toBe("paused");
  });

  it("delivers directly to a waiting session and marks it working", async () => {
    sessions.set("api-1", sessionRecord({ status: "waiting" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.deliver("api-1", "follow up");

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", { interrupt: false });
    expect(result.status).toBe("working");
    expect(sessions.get("api-1")?.status).toBe("working");
  });

  it("does not overwrite a fresher waiting status after sending a follow-up", async () => {
    sessions.set("api-1", sessionRecord({ status: "waiting" }));
    sendMessageToTmuxMock.mockImplementationOnce(async () => {
      const current = sessions.get("api-1");
      if (current) {
        sessions.set("api-1", {
          ...current,
          status: "waiting",
          updatedAt: "2026-03-18T10:05:01.000Z",
        });
      }
    });
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.deliver("api-1", "follow up");

    expect(result.status).toBe("waiting");
    expect(sessions.get("api-1")?.status).toBe("waiting");
  });

  it("recovers an exited session through native resume before delivering", async () => {
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.deliver("api-1", "follow up");

    expect(findAgentSessionIdMock).toHaveBeenCalledWith("claude", "/tmp/worktree");
    expect(ensureAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/worktree",
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });
    expect(buildAgentResumePlanMock).toHaveBeenCalledWith(
      "claude",
      "native-123",
      "claude --dangerously-skip-permissions",
    );
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "api-1",
        cwd: "/tmp/worktree",
        launchCommand: "claude --resume native-123 --dangerously-skip-permissions",
      }),
    );
    expect(writeSessionMock.mock.calls.some(([, session]) => session.status === "waiting")).toBe(
      true,
    );
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", { interrupt: false });
    expect(result.status).toBe("working");
  });

  it("recovers an exited session after its project id is renamed", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        web: {
          ...baseConfig().projects.api,
          path: "/repo/api",
          sessionPrefix: "web",
        },
      },
    });
    resolveRepoPathFromWorktreeMock.mockResolvedValue("/repo/api");
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.deliver("api-1", "follow up");

    expect(resolveRepoPathFromWorktreeMock).toHaveBeenCalledWith("/tmp/worktree");
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "api-1",
        cwd: "/tmp/worktree",
        launchCommand: "claude --resume native-123 --dangerously-skip-permissions",
      }),
    );
    expect(result.status).toBe("working");
  });

  it("fails recovery when native resume state is missing", async () => {
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValue(false);
    findAgentSessionIdMock.mockResolvedValueOnce(null);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.deliver("api-1", "follow up")).rejects.toThrow(
      "No native resume state found for claude session api-1",
    );
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
  });

  it("fails recovery after project rename when the repo root cannot be resolved", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {},
    });
    resolveRepoPathFromWorktreeMock.mockResolvedValue(null);
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValue(false);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.deliver("api-1", "follow up")).rejects.toThrow(
      "Cannot resolve repository root for api-1 after project rename: /tmp/worktree",
    );
    expect(createTmuxSessionMock).not.toHaveBeenCalled();
  });

  it("persists hook-driven status updates in the flat session field", async () => {
    sessions.set("api-1", sessionRecord({ status: "working" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.updateStatus("api-1", { status: "needs_input" });

    expect(result.status).toBe("needs_input");
    expect(sessions.get("api-1")?.status).toBe("needs_input");
  });

  it("downgrades codex needs_input updates to waiting", async () => {
    sessions.set(
      "api-1",
      sessionRecord({
        agent: "codex",
        launchCommand:
          "codex -c features.codex_hooks=true --dangerously-bypass-approvals-and-sandbox",
      }),
    );
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.updateStatus("api-1", { status: "needs_input" });

    expect(result.status).toBe("waiting");
    expect(sessions.get("api-1")?.status).toBe("waiting");
  });

  it("marks dead non-terminal sessions as exited", async () => {
    sessions.set("api-1", sessionRecord({ status: "working" }));
    tmuxSessionExistsMock.mockResolvedValue(false);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.status).toBe("exited");
    expect(sessions.get("api-1")?.status).toBe("exited");
  });

  it("ignores hook updates after a manual terminal status takes over", async () => {
    sessions.set("api-1", sessionRecord({ status: "paused" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    writeSessionMock.mockClear();

    const result = await service.updateStatus("api-1", { status: "working" });

    expect(result.status).toBe("paused");
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("does not let a stale enrich overwrite a newer killed status", async () => {
    const stale = sessionRecord({ status: "working", updatedAt: "2026-03-18T10:00:00.000Z" });
    const latest = sessionRecord({ status: "killed", updatedAt: "2026-03-18T10:05:00.000Z" });
    sessions.set("api-1", latest);
    tmuxSessionExistsMock.mockResolvedValue(false);
    writeSessionMock.mockClear();
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service["enrich"](stale);

    expect(result.status).toBe("killed");
    expect(sessions.get("api-1")?.status).toBe("killed");
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("pauses a session without removing its worktree", async () => {
    sessions.set("api-1", sessionRecord({ status: "working" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.pause("api-1");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/worktree",
    });
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(removeSessionSlotToolMock).not.toHaveBeenCalled();
    expect(result.status).toBe("paused");
  });

  it("completes a session by removing owned artifacts and persisting completed", async () => {
    sessions.set("api-1", sessionRecord({ status: "working" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.complete("api-1");

    expect(removeAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/worktree",
    });
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/worktree");
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(result.status).toBe("completed");
    expect(sessions.get("api-1")?.status).toBe("completed");
  });

  it("requires confirmation for risky worktrees and kills them when forced", async () => {
    sessions.set("api-1", sessionRecord({ status: "working" }));
    hasUncommittedChangesMock.mockResolvedValue(true);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.kill("api-1")).rejects.toThrow("Kill confirmation required for api-1");

    const result = await service.kill("api-1", { force: true });

    expect(removeAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/worktree",
    });
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/worktree");
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(result.status).toBe("killed");
    expect(sessions.get("api-1")?.status).toBe("killed");
  });

  it("keeps repeated kill idempotent after cleanup", async () => {
    sessions.set("api-1", sessionRecord({ status: "killed" }));
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    writeSessionMock.mockClear();

    const result = await service.kill("api-1", { force: true });

    expect(writeSessionMock).not.toHaveBeenCalled();
    expect(result.status).toBe("killed");
  });

  it("restores an exited session through native resume and sends the restore prompt", async () => {
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.restore("api-1");

    expect(ensureAgentStatusHooksMock).toHaveBeenCalledWith({
      agent: "claude",
      worktreePath: "/tmp/worktree",
      statusCommandPath: "/tmp/spur-tools/api-1/spur-session-status",
    });
    expect(buildAgentResumePlanMock).toHaveBeenCalledWith(
      "claude",
      "native-123",
      "claude --dangerously-skip-permissions",
    );
    expect(withSessionSlotInstructionsMock.mock.calls[0]?.[0]).toContain(
      "This session was restored after the agent exited.",
    );
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining("This session was restored after the agent exited."),
    );
    expect(result.status).toBe("working");
    expect(sessions.get("api-1")?.status).toBe("working");
  });

  it("restores an exited session after its project id is renamed", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        web: {
          ...baseConfig().projects.api,
          path: "/repo/api",
          sessionPrefix: "web",
        },
      },
    });
    resolveRepoPathFromWorktreeMock.mockResolvedValue("/repo/api");
    sessions.set("api-1", sessionRecord({ status: "exited" }));
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.restore("api-1");

    expect(resolveRepoPathFromWorktreeMock).toHaveBeenCalledWith("/tmp/worktree");
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: "api-1",
        cwd: "/tmp/worktree",
        launchCommand: "claude --resume native-123 --dangerously-skip-permissions",
      }),
    );
    expect(result.status).toBe("working");
  });

  it("rejects restore for shared workspace sessions", async () => {
    sessions.set(
      "api-1",
      sessionRecord({
        status: "paused",
        worktree: false,
        worktreePath: "/repo/api",
        branch: "main",
      }),
    );
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.restore("api-1")).rejects.toThrow(
      "Session is not restorable without a worktree: api-1",
    );
  });
});
