import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { ServiceInstanceRecord, SessionRecord } from "../../src/types.js";

const upsertConfigRegistryPathMock = vi.fn();
const buildAgentLaunchPlanMock = vi.fn();
const buildAgentRestorePlanMock = vi.fn();
const buildAgentResumePlanMock = vi.fn();
const findAgentSessionIdMock = vi.fn();
const parseAgentNameMock = vi.fn((agent: string) => agent);
const setupAgentHooksMock = vi.fn();
const deleteAgentHookStateMock = vi.fn();
const readAgentHookStateMock = vi.fn();
const loadConfigMock = vi.fn();
const loadProjectConfigMock = vi.fn();
const findProjectConfigPathMock = vi.fn();
const reserveNextSessionIdMock = vi.fn();
const listSessionsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const deleteServiceInstanceMock = vi.fn();
const deleteServiceInstancesForSessionMock = vi.fn();
const deleteServiceSourceStatesForServiceMock = vi.fn();
const deleteServiceSourceStatesForSessionMock = vi.fn();
const listActiveServiceProblemsMock = vi.fn();
const listServiceInstancesMock = vi.fn();
const listServiceInstancesForSessionMock = vi.fn();
const readServiceInstanceMock = vi.fn();
const writeServiceInstanceMock = vi.fn();
const serviceRecords = new Map<string, ServiceInstanceRecord>();
const createTmuxSessionMock = vi.fn();
const createTmuxCommandSessionMock = vi.fn();
const createTmuxSidecarSessionMock = vi.fn();
const sidecarTmuxAliveMock = vi.fn();
const sidecarTmuxSessionMock = vi.fn((id: string, name: string) => `${id}--${name}`);
const killSidecarTmuxMock = vi.fn();
const getTmuxSessionActivityMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
const killTmuxSessionMock = vi.fn();
const sendMessageToTmuxMock = vi.fn();
const sendSubmitKeyToTmuxMock = vi.fn();
const syncTmuxStatusMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();
const tmuxPaneDeadMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const waitForTmuxReadyMock = vi.fn();
const createWorktreeMock = vi.fn();
const findWorktreePathForBranchMock = vi.fn();
const hasUncommittedChangesMock = vi.fn();
const hasUnpushedCommitsMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const removeWorktreeMock = vi.fn();
const resolveRepoPathFromWorktreeMock = vi.fn();
const workspaceExistsMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const ensureSessionSlotToolMock = vi.fn();
const removeSessionSlotToolMock = vi.fn();
const withSessionSlotInstructionsMock = vi.fn();
const runSpawnPreflightMock = vi.fn();
const logSpurEventMock = vi.fn();
const readClaudeJsonlStateMock = vi.fn();
const sendDesktopNotificationMock = vi.fn();

vi.mock("../../src/registry.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<any>();
  return {
    ...actual,
    upsertConfigRegistryPath: upsertConfigRegistryPathMock,
    writeConfigRegistry: vi.fn(),
  };
});

vi.mock("../../src/claude-jsonl-state.js", () => ({
  readClaudeJsonlState: readClaudeJsonlStateMock,
}));

vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: buildAgentLaunchPlanMock,
  buildAgentRestorePlan: buildAgentRestorePlanMock,
  buildAgentResumePlan: buildAgentResumePlanMock,
  findAgentSessionId: findAgentSessionIdMock,
  parseAgentName: parseAgentNameMock,
  setupAgentHooks: setupAgentHooksMock,
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: loadConfigMock,
  loadProjectConfig: loadProjectConfigMock,
  findProjectConfigPath: findProjectConfigPathMock,
}));

vi.mock("../../src/preflight.js", () => ({
  runSpawnPreflight: runSpawnPreflightMock,
}));

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

vi.mock("../../src/desktop-notify.js", () => ({
  sendDesktopNotification: sendDesktopNotificationMock,
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
  listServiceInstances: listServiceInstancesMock,
  listServiceInstancesForSession: listServiceInstancesForSessionMock,
  listSessions: listSessionsMock,
  readServiceInstance: readServiceInstanceMock,
  readSession: readSessionMock,
  writeServiceInstance: writeServiceInstanceMock,
  writeSession: writeSessionMock,
}));

vi.mock("../../src/agent-hook-state.js", () => ({
  deleteAgentHookState: deleteAgentHookStateMock,
  readAgentHookState: readAgentHookStateMock,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  createTmuxSession: createTmuxSessionMock,
  createTmuxCommandSession: createTmuxCommandSessionMock,
  createTmuxSidecarSession: createTmuxSidecarSessionMock,
  sidecarTmuxAlive: sidecarTmuxAliveMock,
  sidecarTmuxSession: sidecarTmuxSessionMock,
  killSidecarTmux: killSidecarTmuxMock,
  getTmuxSessionActivity: getTmuxSessionActivityMock,
  isProcessRunningInTmux: isProcessRunningInTmuxMock,
  killTmuxSession: killTmuxSessionMock,
  setTmuxSocketName: setTmuxSocketNameMock,
  sendMessageToTmux: sendMessageToTmuxMock,
  sendSubmitKeyToTmux: sendSubmitKeyToTmuxMock,
  syncTmuxStatus: syncTmuxStatusMock,
  tmuxPaneDead: tmuxPaneDeadMock,
  tmuxSessionExists: tmuxSessionExistsMock,
  waitForTmuxReady: waitForTmuxReadyMock,
}));

vi.mock("../../src/session-slots.js", () => ({
  AGENT_STATE_TOOL_NAME: "spur-agent-state",
  SLOT_TOOL_NAME: "spur-slots",
  applySlotsUpdate: applySlotsUpdateMock,
  ensureSessionSlotTool: ensureSessionSlotToolMock,
  removeSessionSlotTool: removeSessionSlotToolMock,
  withSessionSlotInstructions: withSessionSlotInstructionsMock,
}));

vi.mock("../../src/workspace.js", () => ({
  createWorktree: createWorktreeMock,
  findWorktreePathForBranch: findWorktreePathForBranchMock,
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
    tmux: { socketName: "spur-4310" },
    ui: { port: 5555 },
    projects: {
      api: {
        path: "/repo/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        symlinks: [".env"],
        sidecars: {},
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

function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();
  readSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    const session = sessions.get(sessionId);
    return session ? clone(session) : undefined;
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
  serviceRecords.clear();
  listServiceInstancesMock.mockImplementation(() =>
    [...serviceRecords.values()].map((service) => clone(service)),
  );
  listServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) =>
    [...serviceRecords.values()]
      .filter((service) => service.sessionId === sessionId)
      .map((service) => clone(service)),
  );
  readServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      const service = serviceRecords.get(serviceKey(sessionId, serviceId));
      return service ? clone(service) : undefined;
    },
  );
  writeServiceInstanceMock.mockImplementation(
    (_dataDir: string, service: ServiceInstanceRecord) => {
      serviceRecords.set(serviceKey(service.sessionId, service.serviceId), clone(service));
    },
  );
  deleteServiceInstanceMock.mockImplementation(
    (_dataDir: string, sessionId: string, serviceId: string) => {
      serviceRecords.delete(serviceKey(sessionId, serviceId));
    },
  );
  deleteServiceInstancesForSessionMock.mockImplementation((_dataDir: string, sessionId: string) => {
    for (const key of serviceRecords.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        serviceRecords.delete(key);
      }
    }
  });
}
async function advanceSeconds(seconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

function mockClaudeJsonlState(state: string) {
  readClaudeJsonlStateMock.mockResolvedValue({
    state,
    reader: { filePath: "test.jsonl", lastOffset: 0, lastMtimeMs: 0, tailRecords: [] },
  });
}

type SessionServiceInternals = {
  waitForCodexHookBaseline(sessionId: string): Promise<{
    state: "working" | "waiting";
    updatedAt: string;
    hookEvent?: string;
    turnId?: string;
    fileMtimeMs?: number;
  } | null>;
  waitForCodexSubmitAck(
    sessionId: string,
    baseline: {
      state: "working" | "waiting";
      updatedAt: string;
      hookEvent?: string;
      turnId?: string;
      fileMtimeMs?: number;
    } | null,
  ): Promise<boolean>;
  sendAgentMessage(
    session: { id: string; tmuxSession: string; agent: "claude" | "codex" },
    message: string,
    options?: { interrupt?: boolean },
  ): Promise<void>;
};

function sessionServiceInternals(service: unknown): SessionServiceInternals {
  return service as SessionServiceInternals;
}

describe("SessionService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:05:00.000Z"));

    upsertConfigRegistryPathMock.mockReset().mockReturnValue(["/tmp/spur.yaml"]);

    buildAgentLaunchPlanMock
      .mockReset()
      .mockImplementation(
        (agent: string, initialMessage: string, options?: { planMode?: boolean }) => ({
          agent,
          launchCommand:
            agent === "codex"
              ? "codex --dangerously-bypass-approvals-and-sandbox"
              : options?.planMode
                ? "claude --dangerously-skip-permissions --permission-mode plan"
                : "claude --dangerously-skip-permissions",
          initialMessage,
          readyMarkers: agent === "codex" ? ["OpenAI Codex", "›"] : ["Claude Code", "❯"],
        }),
      );
    buildAgentRestorePlanMock.mockReset().mockResolvedValue({
      agent: "claude",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      initialMessage:
        "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
      readyMarkers: ["❯"],
    });
    buildAgentResumePlanMock
      .mockReset()
      .mockImplementation(
        (
          _agent: string,
          _agentSessionId: string,
          _launchCommand: string,
          options?: { planMode?: boolean },
        ) => ({
          launchCommand: options?.planMode
            ? "claude --resume session-uuid --dangerously-skip-permissions --permission-mode plan"
            : "claude --resume session-uuid --dangerously-skip-permissions",
          readyMarkers: ["❯"],
        }),
      );
    findAgentSessionIdMock.mockReset().mockResolvedValue("session-uuid");
    parseAgentNameMock.mockReset().mockImplementation((agent: string) => agent);
    setupAgentHooksMock.mockReset().mockResolvedValue({});
    deleteAgentHookStateMock.mockReset();
    readAgentHookStateMock.mockReset().mockReturnValue(null);
    readClaudeJsonlStateMock.mockReset().mockResolvedValue(null);
    loadConfigMock.mockReset().mockReturnValue(baseConfig());
    loadProjectConfigMock.mockReset();
    findProjectConfigPathMock.mockReset().mockReturnValue(undefined);
    runSpawnPreflightMock.mockReset().mockResolvedValue({});
    reserveNextSessionIdMock.mockReset().mockResolvedValue("api-1");
    listSessionsMock.mockReset().mockReturnValue([]);
    readSessionMock.mockReset();
    writeSessionMock.mockReset();
    deleteServiceInstanceMock.mockReset();
    deleteServiceInstancesForSessionMock.mockReset();
    deleteServiceSourceStatesForServiceMock.mockReset();
    deleteServiceSourceStatesForSessionMock.mockReset();
    listActiveServiceProblemsMock.mockReset().mockReturnValue([]);
    listServiceInstancesMock.mockReset().mockReturnValue([]);
    listServiceInstancesForSessionMock.mockReset().mockReturnValue([]);
    readServiceInstanceMock.mockReset().mockReturnValue(undefined);
    writeServiceInstanceMock.mockReset();
    resetServiceStore();
    createTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    createTmuxCommandSessionMock.mockReset().mockResolvedValue(undefined);
    createTmuxSidecarSessionMock.mockReset().mockResolvedValue(undefined);
    sidecarTmuxAliveMock.mockReset().mockResolvedValue(false);
    sidecarTmuxSessionMock
      .mockReset()
      .mockImplementation((id: string, name: string) => `${id}--${name}`);
    killSidecarTmuxMock.mockReset().mockResolvedValue(undefined);
    getTmuxSessionActivityMock.mockReset().mockResolvedValue(new Date("2026-03-18T10:04:30.000Z"));
    isProcessRunningInTmuxMock.mockReset().mockResolvedValue(true);
    killTmuxSessionMock.mockReset().mockResolvedValue(undefined);
    sendMessageToTmuxMock.mockReset().mockResolvedValue(undefined);
    sendSubmitKeyToTmuxMock.mockReset().mockResolvedValue(undefined);
    tmuxPaneDeadMock.mockReset().mockResolvedValue(false);
    tmuxSessionExistsMock.mockReset().mockResolvedValue(true);
    waitForTmuxReadyMock.mockReset().mockResolvedValue(undefined);
    createWorktreeMock.mockReset().mockResolvedValue("/tmp/spur-worktrees/api/api-1");
    findWorktreePathForBranchMock.mockReset().mockResolvedValue(null);
    hasUncommittedChangesMock.mockReset().mockResolvedValue(false);
    hasUnpushedCommitsMock.mockReset().mockResolvedValue(false);
    readCurrentBranchMock.mockReset().mockResolvedValue("main");
    removeWorktreeMock.mockReset().mockResolvedValue(undefined);
    resolveRepoPathFromWorktreeMock.mockReset().mockResolvedValue(undefined);
    workspaceExistsMock.mockReset().mockReturnValue(true);
    syncTmuxStatusMock.mockReset().mockResolvedValue(undefined);
    logSpurEventMock.mockReset();
    sendDesktopNotificationMock.mockReset().mockResolvedValue(undefined);
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
    mockClaudeJsonlState("waiting");
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
      agent: "claude",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SESSION_TOOL_DIR: expect.any(String),
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        SPUR_AGENT_STATE_COMMAND: "/tmp/spur-tools/api-1/spur-agent-state",
        SPUR_AGENT_STATE_FILE: "/tmp/spur-data/session-agent-state/api-1.json",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello", {});
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-1", undefined);
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "slot-instructions\nhello", {
      agent: "claude",
    });
    expect(writeSessionMock).toHaveBeenCalledTimes(2);
    expect(writeSessionMock.mock.calls[0]?.[1].status).toBe("spawning");
    expect(writeSessionMock.mock.calls[1]?.[1].status).toBe("running");
    expect(result.id).toBe("api-1");
    expect(result.state).toBe("waiting");
    expect(result.runtimeAlive).toBe(true);
    expect(result.workspaceExists).toBe(true);
    expect(result.worktree).toBe(true);
    expect(result.planMode).toBe(false);
    expect(result.branch).toBe("api-1");
    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    expect(
      logSpurEventMock.mock.calls
        .map(([, entry]) => entry.event)
        .filter((e) => e !== "session.state.classified"),
    ).toEqual([
      "session.spawn.started",
      "session.spawn.worktree_created",
      "session.spawn.tmux_created",
      "session.spawn.ready",
      "session.spawn.initial_prompt_sent",
      "session.agent_session_id.discovered",
      "session.spawn.completed",
    ]);
  });

  it("adds sidecar-only testing instructions to the initial message when sidecars are configured", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
    });
    mockClaudeJsonlState("waiting");
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining(
        'Sidecars: use Sidecar for testing by default. Run `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name <name>` to start one.',
      ),
      { agent: "claude" },
    );
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining("Do not start app, dev server, or test helper processes directly"),
      { agent: "claude" },
    );
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining("See `v2/README.md` for sidecar usage."),
      { agent: "claude" },
    );
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining("Available: `dev`."),
      { agent: "claude" },
    );
  });

  it("reserves sidecar ports during spawn and passes them into sidecar env", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: {
            dev: {
              command: "pnpm dev",
              autoStart: true,
              ports: {
                http: { env: "SPUR_RESERVED_PORT_DEV", start: 3000, end: 3001 },
              },
            },
          },
        },
      },
    });
    mockClaudeJsonlState("waiting");
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(writeSessionMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        sidecarPorts: {
          dev: {
            SPUR_RESERVED_PORT_DEV: 3000,
          },
        },
      }),
    );
    expect(createTmuxSidecarSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sidecarName: "dev",
        env: expect.objectContaining({
          SPUR_SIDECAR_NAME: "dev",
          SPUR_RESERVED_PORT_DEV: "3000",
        }),
      }),
    );
  });

  it("fails spawn when another live session already holds the only reserved sidecar port", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: {
            dev: {
              command: "pnpm dev",
              autoStart: false,
              ports: {
                http: { env: "SPUR_RESERVED_PORT_DEV", start: 3000, end: 3000 },
              },
            },
          },
        },
      },
    });
    listSessionsMock.mockReturnValue([
      {
        id: "api-existing",
        project: "api",
        agent: "claude",
        prompt: "existing",
        branch: "api-existing",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-existing",
        tmuxSession: "api-existing",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-03-18T09:00:00.000Z",
        updatedAt: "2026-03-18T09:01:00.000Z",
        sidecarPorts: {
          dev: {
            SPUR_RESERVED_PORT_DEV: 3000,
          },
        },
      },
    ]);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
      }),
    ).rejects.toThrow("No free reserved port for sidecar dev.http in range 3000-3000");
    expect(writeSessionMock).not.toHaveBeenCalled();
  });

  it("passes planMode to launch planning and persists it on the session", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "hello",
      planMode: true,
    });

    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello", {
      planMode: true,
    });
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchCommand: "claude --dangerously-skip-permissions --permission-mode plan",
        agent: "claude",
      }),
    );
    expect(writeSessionMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        planMode: true,
      }),
    );
    expect(writeSessionMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        planMode: true,
      }),
    );
    expect(result.planMode).toBe(true);
  });

  it("accepts planMode for codex spawn but keeps codex launch behavior unchanged", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    vi.spyOn(sessionServiceInternals(service), "waitForCodexHookBaseline").mockResolvedValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:05:00.000Z",
      hookEvent: "Stop",
    });
    vi.spyOn(sessionServiceInternals(service), "waitForCodexSubmitAck").mockResolvedValue(true);

    const result = await service.spawn({
      project: "api",
      agent: "codex",
      prompt: "hello",
      planMode: true,
    });

    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("codex", "hello", {
      planMode: true,
    });
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
        agent: "codex",
      }),
    );
    expect(result.planMode).toBe(true);
  });

  it("starts a pipelined session by sending only the first step immediately", async () => {
    const sessions = createSessionStore();
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "ship the task",
      steps: ["research", "test"],
    });

    expect(result.prompt).toBe("ship the task");
    expect(sendMessageToTmuxMock.mock.calls[0]?.[0]).toBe("api-1");
    expect(sendMessageToTmuxMock.mock.calls[0]?.[1]).toContain("[Spur step 1/2: research]");
    expect(sendMessageToTmuxMock.mock.calls[0]?.[1]).toContain("ship the task");
    expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(1);

    expect(sessions.get("api-1")?.pipeline).toMatchObject({
      status: "running",
      nextStepIndex: 1,
      awaitingStepIndex: 0,
    });
  });

  it("uses project default spawn steps when the request does not provide them", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          spawn: {
            steps: ["research", "test"],
          },
        },
      },
    });
    const { SessionService } = await loadSessionServiceModule();
    createSessionStore();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "ship the task",
    });

    expect(result.pipeline).toMatchObject({
      steps: ["research", "test"],
      nextStepIndex: 1,
      awaitingStepIndex: 0,
      status: "running",
    });
    expect(sendMessageToTmuxMock).toHaveBeenNthCalledWith(
      1,
      "api-1",
      expect.stringContaining("[Spur step 1/2: research]"),
      { agent: "claude" },
    );
  });

  it("lets request spawn steps override the project default steps", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          spawn: {
            steps: ["research", "test"],
          },
        },
      },
    });
    const { SessionService } = await loadSessionServiceModule();
    createSessionStore();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "ship the task",
      steps: ["review"],
    });

    expect(result.pipeline).toMatchObject({
      steps: ["review"],
      nextStepIndex: 1,
      awaitingStepIndex: 0,
      status: "running",
    });
    expect(sendMessageToTmuxMock).toHaveBeenNthCalledWith(
      1,
      "api-1",
      expect.stringContaining("[Spur step 1/1: review]"),
      { agent: "claude" },
    );
  });

  it("allows spawn without a prompt and skips preflight, default steps, and the initial send", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          spawn: {
            steps: ["research", "test"],
          },
          preflight: {
            prompt: "Suggest a branch name from the task context.",
          },
        },
      },
    });
    const { SessionService } = await loadSessionServiceModule();
    createSessionStore();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
    });

    expect(result.prompt).toBe("");
    expect(result.pipeline).toBeUndefined();
    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "", {});
    expect(sendMessageToTmuxMock).not.toHaveBeenCalled();
    expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    expect(
      logSpurEventMock.mock.calls
        .map(([, entry]) => entry.event)
        .filter((e) => e !== "session.state.classified"),
    ).not.toContain("session.spawn.initial_prompt_sent");
  });

  it("resumes an unfinished pipeline into a cooldown before the next auto-step", async () => {
    mockClaudeJsonlState("waiting");
    const sessions = createSessionStore();
    sessions.set(
      "api-1",
      clone({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "ship the task",
        branch: "api-1",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "running",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
        pipeline: {
          steps: ["research", "test"],
          nextStepIndex: 1,
          awaitingStepIndex: 0,
          status: "running",
        },
      }),
    );

    const { SessionService } = await loadSessionServiceModule();
    new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await Promise.resolve();
    await advanceSeconds(2);
    expect(sendMessageToTmuxMock).toHaveBeenCalledTimes(0);
    expect(sessions.get("api-1")?.pipeline).toMatchObject({
      status: "running",
      steps: ["research", "test"],
      nextStepIndex: 1,
      nextStepNotBefore: "2026-03-18T10:05:30.000Z",
    });
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
      agent: "claude",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SESSION_TOOL_DIR: expect.any(String),
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        SPUR_AGENT_STATE_COMMAND: "/tmp/spur-tools/api-1/spur-agent-state",
        SPUR_AGENT_STATE_FILE: "/tmp/spur-data/session-agent-state/api-1.json",
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
    mockClaudeJsonlState("waiting");
    const sessions = createSessionStore();
    sessions.set("api-1", {
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
    service.dispose();

    const result = await service.send("api-1", { message: "follow up" });
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", {
      interrupt: false,
      agent: "claude",
    });
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

  it("passes the codex agent to tmux delivery", async () => {
    const sessions = createSessionStore();
    listSessionsMock.mockReturnValue([]);
    sessions.set("api-1", {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --enable codex_hooks --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock
      .mockReturnValueOnce({
        state: "waiting",
        updatedAt: "2026-03-18T10:05:00.000Z",
        hookEvent: "Stop",
      })
      .mockReturnValue({
        state: "working",
        updatedAt: "2026-03-18T10:05:01.000Z",
        hookEvent: "UserPromptSubmit",
      });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    vi.spyOn(sessionServiceInternals(service), "waitForCodexSubmitAck").mockResolvedValue(true);
    service.dispose();

    await sessionServiceInternals(service).sendAgentMessage(
      {
        id: "api-1",
        tmuxSession: "api-1",
        agent: "codex",
      },
      "follow up",
      { interrupt: false },
    );

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", {
      interrupt: false,
      agent: "codex",
    });
    expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();
  });

  it("accepts a rewritten codex hook file even after UserPromptSubmit has already advanced", async () => {
    const sessions = createSessionStore();
    listSessionsMock.mockReturnValue([]);
    sessions.set("api-1", {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --enable codex_hooks --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock
      .mockReturnValueOnce({
        state: "waiting",
        updatedAt: "2026-03-18T10:05:00.000Z",
        hookEvent: "Stop",
        fileMtimeMs: 1_000,
      })
      .mockReturnValue({
        state: "waiting",
        updatedAt: "2026-03-18T10:05:00.000Z",
        hookEvent: "Stop",
        fileMtimeMs: 1_001,
      });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    const sendPromise = service.deliver("api-1", "follow up");
    await vi.advanceTimersByTimeAsync(250);
    await sendPromise;

    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", {
      interrupt: false,
      agent: "codex",
    });
    expect(sendSubmitKeyToTmuxMock).not.toHaveBeenCalled();
  });

  it("retries codex submit with a bare Enter when the first ack does not arrive", async () => {
    const sessions = createSessionStore();
    listSessionsMock.mockReturnValue([]);
    sessions.set("api-1", {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --enable codex_hooks --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock
      .mockReturnValueOnce({
        state: "waiting",
        updatedAt: "2026-03-18T10:04:59.000Z",
      })
      .mockReturnValue({
        state: "waiting",
        updatedAt: "2026-03-18T10:04:59.000Z",
      });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    const sendPromise = service.deliver("api-1", "follow up");
    await vi.advanceTimersByTimeAsync(5_000);
    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:05:06.000Z",
      hookEvent: "UserPromptSubmit",
    });
    await vi.advanceTimersByTimeAsync(250);
    await sendPromise;

    expect(sendSubmitKeyToTmuxMock).toHaveBeenCalledWith("api-1");
  });

  it("fails codex delivery when submit ack never arrives", async () => {
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();
    vi.spyOn(sessionServiceInternals(service), "waitForCodexHookBaseline").mockResolvedValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:05:00.000Z",
      hookEvent: "Stop",
    });
    const waitForAckMock = vi
      .spyOn(service as never, "waitForCodexSubmitAck")
      .mockResolvedValue(false);

    await expect(
      sessionServiceInternals(service).sendAgentMessage(
        {
          id: "api-1",
          tmuxSession: "api-1",
          agent: "codex",
        },
        "follow up",
      ),
    ).rejects.toThrow("Timed out waiting for Codex submit acknowledgment for api-1");
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "follow up", {
      agent: "codex",
    });
    expect(sendSubmitKeyToTmuxMock).toHaveBeenCalledTimes(1);
    expect(waitForAckMock).toHaveBeenCalledTimes(2);
  });

  it("queues manual send messages while the agent is busy", async () => {
    const sessions = createSessionStore();
    sessions.set("api-1", {
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
    listSessionsMock.mockReturnValue([]);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    await service.send("api-1", { message: "follow up" });
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessageToTmuxMock).not.toHaveBeenCalled();
    expect(sessions.get("api-1")?.queuedMessages).toEqual({
      messages: ["follow up"],
      awaitingPrompt: false,
    });

    expect(sendMessageToTmuxMock).not.toHaveBeenCalled();
  });

  it("delivers a manual send before the next pipeline step when the agent is waiting", async () => {
    mockClaudeJsonlState("waiting");
    const sessions = createSessionStore();
    sessions.set("api-1", {
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "ship the task",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
      pipeline: {
        steps: ["research", "test"],
        nextStepIndex: 1,
        status: "running",
      },
    });
    listSessionsMock.mockReturnValue([]);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    await service.send("api-1", { message: "follow up" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessageToTmuxMock).toHaveBeenCalled();
    expect(sendMessageToTmuxMock).toHaveBeenNthCalledWith(1, "api-1", "follow up", {
      interrupt: false,
      agent: "claude",
    });
  });

  it("classifies waiting state from JSONL for claude sessions", async () => {
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
    mockClaudeJsonlState("waiting");
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("waiting");
    expect(readClaudeJsonlStateMock).toHaveBeenCalledWith(
      "/tmp/spur-worktrees/api/api-1",
      undefined,
    );
  });

  it("trusts hook working state for codex sessions", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --enable codex_hooks --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(readAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(result.state).toBe("working");
  });

  it("classifies working state from hook for codex sessions", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("working");
  });

  it("defaults codex to waiting when no hook state exists (SPUR1614 regression)", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue(null);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("waiting");
  });

  it("Claude: defaults to working when no JSONL exists yet", async () => {
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
    // No JSONL file yet — defaults to working.
    readClaudeJsonlStateMock.mockResolvedValue(null);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("working");
  });

  it("reports stopped when the runtime is gone", async () => {
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

    const result = await service.get("api-1");

    expect(result.state).toBe("stopped");
    expect(result.runtimeAlive).toBe(false);
  });

  it("trusts JSONL waiting state for claude sessions", async () => {
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
    mockClaudeJsonlState("waiting");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("waiting");
  });

  it("reports needs_input from JSONL when claude agent needs input", async () => {
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
    mockClaudeJsonlState("needs_input");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("needs_input");
  });

  it("detects needs_input from JSONL for claude sessions with tool use", async () => {
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
    mockClaudeJsonlState("needs_input");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("needs_input");
  });

  it("detects needs_input for Codex from hook state", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "needs_input",
      updatedAt: "2026-03-18T10:04:59.000Z",
      hookEvent: "on_agent_question",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.state).toBe("needs_input");
  });

  it("uses startup attention state as a baseline without notifying immediately", async () => {
    const sessions = createSessionStore();
    sessions.set(
      "api-1",
      clone({
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
      }),
    );
    mockClaudeJsonlState("needs_input");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await vi.advanceTimersByTimeAsync(0);
    await advanceSeconds(5);

    expect(sendDesktopNotificationMock).not.toHaveBeenCalled();
    service.dispose();
  });

  it("debounce: holds previous state when new state disagrees within hold window", async () => {
    const runningCodexSession = {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running" as const,
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };
    readSessionMock.mockReturnValue(runningCodexSession);
    readAgentHookStateMock.mockReturnValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const first = await service.get("api-1");
    expect(first.state).toBe("waiting");

    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });
    const second = await service.get("api-1");

    expect(second.state).toBe("waiting");
  });

  it("debounce: repeated polls do not extend the hold window forever", async () => {
    const runningCodexSession = {
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running" as const,
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    };
    readSessionMock.mockReturnValue(runningCodexSession);
    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const first = await service.get("api-1");
    expect(first.state).toBe("working");

    readAgentHookStateMock.mockReturnValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:05:00.000Z",
    });

    const second = await service.get("api-1");
    expect(second.state).toBe("working");

    vi.advanceTimersByTime(3_000);
    const third = await service.get("api-1");
    expect(third.state).toBe("working");

    vi.advanceTimersByTime(1_500);
    const fourth = await service.get("api-1");
    expect(fourth.state).toBe("waiting");
  });

  it("notifies once per attention transition and re-notifies only after the session clears", async () => {
    const sessions = createSessionStore();
    sessions.set(
      "api-1",
      clone({
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
      }),
    );
    const jsonlReader = { filePath: "test.jsonl", lastOffset: 0, lastMtimeMs: 0, tailRecords: [] };
    readClaudeJsonlStateMock
      .mockResolvedValueOnce({ state: "waiting", reader: jsonlReader })
      .mockResolvedValueOnce({ state: "needs_input", reader: jsonlReader })
      .mockResolvedValueOnce({ state: "needs_input", reader: jsonlReader })
      .mockResolvedValueOnce({ state: "waiting", reader: jsonlReader })
      .mockResolvedValueOnce({ state: "needs_input", reader: jsonlReader });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await vi.advanceTimersByTimeAsync(0);
    await advanceSeconds(5);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendDesktopNotificationMock).toHaveBeenLastCalledWith({
      title: "Spur needs input [api-1]",
      message: "Agent is waiting for a reply or approval.\nRun `spur list` to respond.",
      urgent: false,
    });

    await advanceSeconds(5);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(1);

    await advanceSeconds(5);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(1);

    await advanceSeconds(5);
    expect(sendDesktopNotificationMock).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("sends an urgent desktop notification when a session enters errored state", async () => {
    const sessions = createSessionStore();
    sessions.set(
      "api-1",
      clone({
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
      }),
    );
    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await vi.advanceTimersByTimeAsync(0);
    const session = sessions.get("api-1");
    if (!session) {
      throw new Error("Expected api-1 session to exist");
    }
    sessions.set(
      "api-1",
      clone({
        ...session,
        status: "errored",
        updatedAt: "2026-03-18T10:05:05.000Z",
        error: "tmux crashed",
      }),
    );

    await advanceSeconds(5);

    expect(sendDesktopNotificationMock).toHaveBeenCalledWith({
      title: "Spur error [api-1]",
      message: "tmux crashed\nRun `spur list` for details.",
      urgent: true,
    });
    service.dispose();
  });

  it("debounce: accepts new state after hold window expires", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const first = await service.get("api-1");
    expect(first.state).toBe("waiting");

    vi.advanceTimersByTime(5_000);

    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });
    const second = await service.get("api-1");

    expect(second.state).toBe("working");
  });

  it("debounce: transitions to needs_input bypass hold window", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "working",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const first = await service.get("api-1");
    expect(first.state).toBe("working");

    readAgentHookStateMock.mockReturnValue({
      state: "needs_input",
      updatedAt: "2026-03-18T10:04:59.000Z",
      hookEvent: "on_agent_question",
    });
    const second = await service.get("api-1");

    expect(second.state).toBe("needs_input");
  });

  it("debounce: transition to stopped bypasses hold window", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "codex",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "codex --dangerously-bypass-approvals-and-sandbox",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    readAgentHookStateMock.mockReturnValue({
      state: "waiting",
      updatedAt: "2026-03-18T10:04:59.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const first = await service.get("api-1");
    expect(first.state).toBe("waiting");

    tmuxSessionExistsMock.mockResolvedValue(false);
    const second = await service.get("api-1");

    expect(second.state).toBe("stopped");
  });

  it("runs a bound service and persists its optional port", async () => {
    const workspacePath = resolve(".");
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sources: {
            "web-watch": {
              type: "service",
              service: "web",
              intervalMs: 2_000,
              tailLines: 200,
              runOnStart: false,
              rules: {
                crash: {
                  match: "SERVICE_ERROR",
                  cooldownMs: 60_000,
                },
              },
            },
          },
        },
      },
    });
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: workspacePath,
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.runService("api-1", "web", {
      command: "pnpm dev",
      cwd: workspacePath,
      port: 3000,
    });

    expect(createTmuxCommandSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1--svc--web",
      cwd: workspacePath,
      launchCommand: "pnpm dev",
    });
    expect(writeServiceInstanceMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        sessionId: "api-1",
        serviceId: "web",
        port: 3000,
      }),
    );
    expect(result.port).toBe(3000);
  });

  it("rejects an invalid service port before launch", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sources: {
            "web-watch": {
              type: "service",
              service: "web",
              intervalMs: 2_000,
              tailLines: 200,
              runOnStart: false,
              rules: {
                crash: {
                  match: "SERVICE_ERROR",
                  cooldownMs: 60_000,
                },
              },
            },
          },
        },
      },
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

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.runService("api-1", "web", {
        command: "pnpm dev",
        cwd: "/tmp/spur-worktrees/api/api-1",
        port: 0,
      }),
    ).rejects.toThrow("service port must be an integer between 1 and 65535");
    expect(createTmuxCommandSessionMock).not.toHaveBeenCalled();
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
    tmuxSessionExistsMock.mockImplementation(
      async (sessionName: string) => sessionName === "api-1",
    );

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
    workspaceExistsMock.mockReturnValueOnce(true).mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.complete("api-1");

    expect(killTmuxSessionMock).toHaveBeenCalledWith("api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(deleteAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
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

  it("completes a renamed-project session by resolving the repo from its worktree", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        web: {
          path: "/repo/api",
          defaultBranch: "main",
          sessionPrefix: "web",
          worktree: true,
          symlinks: [".env"],
        },
      },
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
    resolveRepoPathFromWorktreeMock.mockResolvedValue("/repo/api");
    tmuxSessionExistsMock.mockResolvedValue(false);
    workspaceExistsMock.mockReturnValueOnce(true).mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.complete("api-1");

    expect(resolveRepoPathFromWorktreeMock).toHaveBeenCalledWith("/tmp/spur-worktrees/api/api-1");
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(result.status).toBe("completed");
  });

  it("completes a renamed-project session even when its worktree is already gone", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {},
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
    tmuxSessionExistsMock.mockResolvedValue(false);
    workspaceExistsMock.mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.complete("api-1");

    expect(resolveRepoPathFromWorktreeMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("resumes a paused session on send and marks it running again", async () => {
    mockClaudeJsonlState("waiting");
    const sessions = createSessionStore();
    sessions.set("api-1", {
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
    listSessionsMock.mockReturnValue([]);
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    const result = await service.send("api-1", { message: "resume work" });

    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      agent: "claude",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SESSION_TOOL_DIR: expect.any(String),
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        SPUR_AGENT_STATE_COMMAND: "/tmp/spur-tools/api-1/spur-agent-state",
        SPUR_AGENT_STATE_FILE: "/tmp/spur-data/session-agent-state/api-1.json",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith("api-1", "resume work", {
      interrupt: false,
      agent: "claude",
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

  it("uses planMode from the session as the source of truth during send recovery", async () => {
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      planMode: true,
      agentSessionId: "session-uuid",
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions --permission-mode plan",
      status: "paused",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    tmuxSessionExistsMock.mockResolvedValueOnce(false).mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.send("api-1", { message: "resume work" });

    expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "hello", {
      planMode: true,
    });
    expect(buildAgentResumePlanMock).toHaveBeenCalledWith(
      "claude",
      "session-uuid",
      "claude --dangerously-skip-permissions --permission-mode plan",
      { planMode: true },
    );
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchCommand:
          "claude --resume session-uuid --dangerously-skip-permissions --permission-mode plan",
        agent: "claude",
      }),
    );
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

  it("rejects an explicit branch that is already checked out in another worktree", async () => {
    findWorktreePathForBranchMock.mockResolvedValue("/tmp/spur-worktrees/api/api-existing");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(
      service.spawn({
        project: "api",
        prompt: "hello",
        branch: "feature/api-1",
      }),
    ).rejects.toThrow(
      'branch "feature/api-1" is already checked out in worktree /tmp/spur-worktrees/api/api-existing',
    );
    expect(createWorktreeMock).not.toHaveBeenCalled();
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
        sidecars: {},
        defaultAgent: "claude",
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
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.preflight.completed",
        sessionId: "api-1",
        projectId: "api",
        details: expect.objectContaining({
          outcome: "branch",
          branch: "feature/runtime-preflight",
        }),
      }),
    );
  });

  it("falls back to the session branch when a preflight branch is already checked out elsewhere", async () => {
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
    findWorktreePathForBranchMock.mockResolvedValue("/tmp/spur-worktrees/api/api-existing");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.spawn({
      project: "api",
      prompt: "Fix runtime regression from PR #42",
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
    expect(result.branch).toBe("api-1");
    expect(result.branchSource).toBeUndefined();
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.spawn.branch_conflict",
        sessionId: "api-1",
        details: expect.objectContaining({
          occupiedBranch: "feature/runtime-preflight",
          conflictingWorktreePath: "/tmp/spur-worktrees/api/api-existing",
          fallbackBranch: "api-1",
          branchSource: "preflight",
        }),
      }),
    );
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
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "session.preflight.failed",
        projectId: "api",
      }),
    );
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
    expect(deleteAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
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
    expect(deleteAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
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
    expect(deleteAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(removeSessionSlotToolMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
    expect(writeSessionMock.mock.calls.at(-1)?.[1]).toMatchObject({
      id: "api-1",
      worktree: false,
      status: "killed",
    });
  });

  it("kills a renamed-project session using repo-path symlink exclusions from the current config", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        web: {
          path: "/repo/api",
          defaultBranch: "main",
          sessionPrefix: "web",
          worktree: true,
          symlinks: [".env", ".claude"],
        },
      },
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
    resolveRepoPathFromWorktreeMock.mockResolvedValue("/repo/api");

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.kill("api-1");

    expect(resolveRepoPathFromWorktreeMock).toHaveBeenCalledWith("/tmp/spur-worktrees/api/api-1");
    expect(hasUncommittedChangesMock).toHaveBeenCalledWith("/tmp/spur-worktrees/api/api-1", [
      ".env",
      ".claude",
    ]);
    expect(removeWorktreeMock).toHaveBeenCalledWith("/repo/api", "/tmp/spur-worktrees/api/api-1");
    expect(result.status).toBe("killed");
  });

  it("kills a renamed-project session even when its worktree is already gone", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {},
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
    workspaceExistsMock.mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.kill("api-1");

    expect(resolveRepoPathFromWorktreeMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(result.status).toBe("killed");
  });

  it("fails closing a renamed-project session when its repo root can no longer be resolved", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {},
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

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.kill("api-1")).rejects.toThrow(
      "Cannot resolve repository root for api-1 after project rename: /tmp/spur-worktrees/api/api-1",
    );

    expect(resolveRepoPathFromWorktreeMock).toHaveBeenCalledWith("/tmp/spur-worktrees/api/api-1");
    expect(removeWorktreeMock).not.toHaveBeenCalled();
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
    expect(deleteAgentHookStateMock).toHaveBeenCalledWith("/tmp/spur-data", "api-1");
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
    mockClaudeJsonlState("waiting");
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
      {},
    );
    expect(createTmuxSessionMock).toHaveBeenCalledWith({
      sessionName: "api-1",
      cwd: "/tmp/spur-worktrees/api/api-1",
      launchCommand: "claude --resume session-uuid --dangerously-skip-permissions",
      agent: "claude",
      env: {
        SPUR_SESSION: "api-1",
        SPUR_PROJECT: "api",
        SPUR_AGENT: "claude",
        SPUR_SESSION_TOOL_DIR: expect.any(String),
        SPUR_SLOT_COMMAND: "/tmp/spur-tools/api-1/spur-slots",
        SPUR_AGENT_STATE_COMMAND: "/tmp/spur-tools/api-1/spur-agent-state",
        SPUR_AGENT_STATE_FILE: "/tmp/spur-data/session-agent-state/api-1.json",
        PATH: expect.stringContaining("/tmp/spur-tools/api-1:"),
      },
    });
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-1", undefined);
    expect(sendMessageToTmuxMock).toHaveBeenCalledWith(
      "api-1",
      expect.stringContaining(
        "slot-instructions\nThis session was restored after the agent exited.",
      ),
      { agent: "claude" },
    );
    expect(buildAgentLaunchPlanMock).not.toHaveBeenCalled();
    expect(restored.id).toBe("api-1");
    expect(restored.runtimeAlive).toBe(true);
    expect(restored.state).toBe("waiting");
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
      "session.restore.started",
    );
    expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
      "session.restore.completed",
    );
  });

  it("passes planMode through restore planning and native resume", async () => {
    findAgentSessionIdMock.mockResolvedValue("session-uuid");
    buildAgentRestorePlanMock.mockResolvedValueOnce({
      agent: "claude",
      launchCommand:
        "claude --resume session-uuid --dangerously-skip-permissions --permission-mode plan",
      initialMessage:
        "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
      readyMarkers: ["❯"],
    });
    readSessionMock.mockReturnValue({
      id: "api-1",
      project: "api",
      agent: "claude",
      planMode: true,
      prompt: "hello",
      branch: "api-1",
      worktree: true,
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      tmuxSession: "api-1",
      launchCommand: "claude --dangerously-skip-permissions --permission-mode plan",
      status: "running",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });
    isProcessRunningInTmuxMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.restore("api-1");

    expect(buildAgentRestorePlanMock).toHaveBeenCalledWith(
      "claude",
      "/tmp/spur-worktrees/api/api-1",
      "This session was restored after the agent exited. You are back in the same worktree and branch. First check whether the original task is already complete, then continue only if it is still incomplete. Original task:\n\nhello",
      { planMode: true },
    );
    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchCommand:
          "claude --resume session-uuid --dangerously-skip-permissions --permission-mode plan",
        agent: "claude",
      }),
    );
  });

  it("pins pnpm virtual store to the source repo when node_modules is symlinked into a worktree", async () => {
    const repoPath = resolve(process.cwd(), "..");
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          path: repoPath,
          symlinks: ["node_modules", ".env"],
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.spawn({
      project: "api",
      prompt: "hello",
    });

    expect(createTmuxSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          npm_config_virtual_store_dir: resolve(repoPath, "node_modules/.pnpm"),
        }),
      }),
    );
  });

  it("does not throw when native resume state is unavailable (falls back to fresh launch)", async () => {
    // This test uses real timers because waitForRestorePlan polls with
    // node:timers/promises setTimeout which fake timers do not intercept.
    vi.useRealTimers();

    findAgentSessionIdMock.mockResolvedValue(null);
    buildAgentRestorePlanMock.mockResolvedValue(null);
    buildAgentLaunchPlanMock.mockReturnValue({
      launchCommand: "claude --dangerously-skip-permissions",
      initialMessage: "hello",
      readyMarkers: ["$"],
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
    tmuxSessionExistsMock.mockResolvedValue(false);
    isProcessRunningInTmuxMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");
    service.dispose();

    const restored = await service.restore("api-1");

    expect(buildAgentLaunchPlanMock).toHaveBeenCalled();
    expect(createTmuxSessionMock).toHaveBeenCalled();
    expect(restored.id).toBe("api-1");
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

  it("startSidecar rejects when project has no matching sidecar configured", async () => {
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

    await expect(service.startSidecar("api-1", "dev")).rejects.toThrow(
      'Project api has no sidecar "dev" configured',
    );
    expect(createTmuxSidecarSessionMock).not.toHaveBeenCalled();
  });

  it("startSidecar rejects for an inactive (killed) session", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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
      status: "killed",
      createdAt: "2026-03-18T10:00:00.000Z",
      updatedAt: "2026-03-18T10:01:00.000Z",
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.startSidecar("api-1", "dev")).rejects.toThrow(
      "Session is not running: api-1",
    );
    expect(createTmuxSidecarSessionMock).not.toHaveBeenCalled();
  });

  it("startSidecar rejects when session workspace is not available", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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
    workspaceExistsMock.mockReturnValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await expect(service.startSidecar("api-1", "dev")).rejects.toThrow(
      "Session workspace is not available: api-1",
    );
    expect(createTmuxSidecarSessionMock).not.toHaveBeenCalled();
  });

  it("startSidecar is idempotent when the sidecar tmux session is already alive", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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
    sidecarTmuxAliveMock.mockResolvedValue(true);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.startSidecar("api-1", "dev");

    expect(createTmuxSidecarSessionMock).not.toHaveBeenCalled();
    expect(result.id).toBe("api-1");
  });

  it("startSidecar prefers sidecars from the session worktree config", async () => {
    findProjectConfigPathMock.mockReturnValue("/tmp/spur-worktrees/api/api-1/spur.yaml");
    loadProjectConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          path: "/tmp/spur-worktrees/api/api-1",
          sidecars: {
            dev: {
              command: "./scripts/dev.sh",
              autoStart: false,
              ports: {
                http: { env: "SPUR_RESERVED_PORT_DEV", start: 3000, end: 3001 },
              },
            },
          },
        },
      },
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
      sidecarPorts: {
        dev: {
          SPUR_RESERVED_PORT_DEV: 3000,
        },
      },
    });

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.startSidecar("api-1", "dev");

    expect(createTmuxSidecarSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "api-1",
        sidecarName: "dev",
        cwd: "/tmp/spur-worktrees/api/api-1",
        command: "./scripts/dev.sh",
        env: expect.objectContaining({
          SPUR_SIDECAR_NAME: "dev",
          SPUR_RESERVED_PORT_DEV: "3000",
        }),
      }),
    );
  });

  it("get lists sidecars from the session worktree config", async () => {
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
    findProjectConfigPathMock.mockReturnValue("/tmp/spur-worktrees/api/api-1/spur.yaml");
    loadProjectConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: {
            daemon: { command: "./scripts/daemon.sh", autoStart: true },
            ui: { command: "./scripts/ui.sh", autoStart: true },
          },
        },
      },
    });
    sidecarTmuxAliveMock.mockResolvedValue(false);

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    const result = await service.get("api-1");

    expect(result.sidecars).toEqual([
      { name: "daemon", alive: false },
      { name: "ui", alive: false },
    ]);
  });

  it("kill calls killSidecarTmux to clean up sidecar sessions", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.kill("api-1", { force: true });

    expect(killSidecarTmuxMock).toHaveBeenCalledWith("api-1", "dev");
  });

  it("complete calls killSidecarTmux to clean up sidecar sessions", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.complete("api-1");

    expect(killSidecarTmuxMock).toHaveBeenCalledWith("api-1", "dev");
  });

  it("pause calls killSidecarTmux to clean up sidecar sessions", async () => {
    loadConfigMock.mockReturnValue({
      ...baseConfig(),
      projects: {
        api: {
          ...baseConfig().projects.api,
          sidecars: { dev: { command: "pnpm dev", autoStart: false } },
        },
      },
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

    const { SessionService } = await loadSessionServiceModule();
    const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

    await service.pause("api-1");

    expect(killSidecarTmuxMock).toHaveBeenCalledWith("api-1", "dev");
  });

  describe("preflight()", () => {
    it("returns branch when project has preflight config and worktree enabled", async () => {
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
      runSpawnPreflightMock.mockResolvedValue({ branch: "feature/suggested" });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.preflight({
        project: "api",
        prompt: "Fix runtime regression from PR #42",
      });

      expect(result).toEqual({ branch: "feature/suggested" });
      expect(runSpawnPreflightMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: "claude",
          projectId: "api",
          prompt: "Fix runtime regression from PR #42",
          worktree: true,
        }),
      );
    });

    it("returns null when worktree is disabled", async () => {
      loadConfigMock.mockReturnValue({
        ...baseConfig(),
        projects: {
          api: {
            ...baseConfig().projects.api,
            worktree: false,
            preflight: {
              prompt: "Suggest a branch name from the task context.",
            },
          },
        },
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.preflight({
        project: "api",
        prompt: "Fix runtime regression from PR #42",
      });

      expect(result).toEqual({ branch: null });
      expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    });

    it("returns null when project has no preflight config", async () => {
      loadConfigMock.mockReturnValue(baseConfig());

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.preflight({
        project: "api",
        prompt: "Fix runtime regression from PR #42",
      });

      expect(result).toEqual({ branch: null });
      expect(runSpawnPreflightMock).not.toHaveBeenCalled();
    });

    it("rejects empty prompt", async () => {
      loadConfigMock.mockReturnValue(baseConfig());

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(service.preflight({ project: "api", prompt: "" })).rejects.toThrow(
        "prompt must be a non-empty string",
      );

      await expect(service.preflight({ project: "api", prompt: "   " })).rejects.toThrow(
        "prompt must be a non-empty string",
      );
    });
  });

  describe("respawn", () => {
    it("respawns a completed session by calling spawn with original params", async () => {
      mockClaudeJsonlState("waiting");
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
        branch: "api-1",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "completed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:05:00.000Z",
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.respawn("api-1");

      expect(result.id).toBe("api-1");
      expect(result.status).toBe("running");
      expect(createWorktreeMock).toHaveBeenCalled();
      expect(createTmuxSessionMock).toHaveBeenCalled();
      expect(buildAgentLaunchPlanMock).toHaveBeenCalledWith("claude", "fix the bug", {});
      expect(logSpurEventMock.mock.calls.map(([, entry]) => entry.event)).toContain(
        "session.respawn.started",
      );
    });

    it("respawns a completed session with pipeline steps", async () => {
      mockClaudeJsonlState("waiting");
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
        branch: "api-1",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "completed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:05:00.000Z",
        pipeline: {
          steps: ["write tests", "implement feature"],
          nextStepIndex: 2,
          status: "completed",
        },
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.respawn("api-1");

      expect(result.id).toBe("api-1");
      expect(result.status).toBe("running");
    });

    it("respawns a shared session back into the shared workspace", async () => {
      mockClaudeJsonlState("waiting");
      loadConfigMock.mockReturnValue({
        ...baseConfig(),
        projects: {
          api: {
            ...baseConfig().projects.api,
            worktree: true,
          },
        },
      });
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
        branch: "main",
        branchSource: "shared_workspace",
        worktree: false,
        worktreePath: "/repo/api",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "completed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:05:00.000Z",
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      const result = await service.respawn("api-1");

      expect(result.status).toBe("running");
      expect(result.worktree).toBe(false);
      expect(createWorktreeMock).not.toHaveBeenCalled();
    });

    it("preserves an explicit branch on respawn", async () => {
      mockClaudeJsonlState("waiting");
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
        branch: "feature/api-1",
        branchSource: "explicit",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "completed",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:05:00.000Z",
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await service.respawn("api-1");

      expect(createWorktreeMock).toHaveBeenCalledWith({
        repoPath: "/repo/api",
        worktreeBaseDir: "/tmp/spur-worktrees",
        projectId: "api",
        sessionId: "api-1",
        defaultBranch: "main",
        branch: "feature/api-1",
        symlinks: [".env"],
      });
    });

    it("rejects respawn of a running session", async () => {
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
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

      await expect(service.respawn("api-1")).rejects.toThrow(
        "Session api-1 is not in a terminal state",
      );
    });

    it("rejects respawn of a paused session", async () => {
      readSessionMock.mockReturnValue({
        id: "api-1",
        project: "api",
        agent: "claude",
        prompt: "fix the bug",
        branch: "api-1",
        worktree: true,
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        tmuxSession: "api-1",
        launchCommand: "claude --dangerously-skip-permissions",
        status: "paused",
        createdAt: "2026-03-18T10:00:00.000Z",
        updatedAt: "2026-03-18T10:01:00.000Z",
      });

      const { SessionService } = await loadSessionServiceModule();
      const service = new SessionService("/tmp/spur.yaml", "2026-03-18T10:00:00.000Z");

      await expect(service.respawn("api-1")).rejects.toThrow(
        "Session api-1 is not in a terminal state",
      );
    });
  });
});
