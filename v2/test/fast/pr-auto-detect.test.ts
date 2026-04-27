import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";

const ghMock = vi.fn();
const listSessionsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const syncTmuxStatusMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
const getTmuxSessionActivityMock = vi.fn();
const setTmuxSocketNameMock = vi.fn();
const readClaudeJsonlStateMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/claude-jsonl-state.js", () => ({
  readClaudeJsonlState: readClaudeJsonlStateMock,
}));
vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: vi.fn(),
  buildAgentRestorePlan: vi.fn(),
  buildAgentResumePlan: vi.fn(),
  findAgentSessionId: vi.fn(),
  parseAgentName: vi.fn((a: string) => a),
  setupAgentHooks: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
  loadProjectConfig: vi.fn(),
  findProjectConfigPath: vi.fn(),
}));
vi.mock("../../src/preflight.js", () => ({
  runSpawnPreflight: vi.fn(),
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));
vi.mock("../../src/desktop-notify.js", () => ({
  sendDesktopNotification: vi.fn(),
}));
vi.mock("../../src/ids.js", () => ({
  reserveNextSessionId: vi.fn(),
}));
vi.mock("../../src/metadata.js", () => ({
  deleteServiceInstance: vi.fn(),
  deleteServiceInstancesForSession: vi.fn(),
  deleteServiceSourceStatesForService: vi.fn(),
  deleteServiceSourceStatesForSession: vi.fn(),
  listActiveServiceProblems: vi.fn().mockReturnValue([]),
  listServiceInstancesForSession: vi.fn().mockReturnValue([]),
  listSessions: listSessionsMock,
  readServiceInstance: vi.fn(),
  readSession: readSessionMock,
  writeServiceInstance: vi.fn(),
  writeSession: writeSessionMock,
}));
vi.mock("../../src/agent-hook-state.js", () => ({
  deleteAgentHookState: vi.fn(),
  readAgentHookState: vi.fn(),
}));
vi.mock("../../src/runtime-tmux.js", () => ({
  createTmuxSession: vi.fn(),
  createTmuxCommandSession: vi.fn(),
  createTmuxSidecarSession: vi.fn(),
  sidecarTmuxAlive: vi.fn(),
  sidecarTmuxSession: vi.fn((id: string, name: string) => `${id}--${name}`),
  killSidecarTmux: vi.fn(),
  getTmuxSessionActivity: getTmuxSessionActivityMock,
  isProcessRunningInTmux: isProcessRunningInTmuxMock,
  killTmuxSession: vi.fn(),
  setTmuxSocketName: setTmuxSocketNameMock,
  sendMessageToTmux: vi.fn(),
  syncTmuxStatus: syncTmuxStatusMock,
  tmuxPaneDead: vi.fn(),
  tmuxSessionExists: tmuxSessionExistsMock,
  waitForTmuxReady: vi.fn(),
}));
vi.mock("../../src/session-slots.js", () => ({
  AGENT_STATE_TOOL_NAME: "spur-agent-state",
  SLOT_TOOL_NAME: "spur-slots",
  applySlotsUpdate: applySlotsUpdateMock,
  ensureSessionSlotTool: vi.fn(),
  normalizeSlotsUpdate: vi.fn(
    (request: {
      title?: string;
      clearTitle?: boolean;
      links?: Array<{ label: string; url: string }>;
      unlinkLabels?: string[];
    }) => ({
      ...(request.title !== undefined ? { title: request.title } : {}),
      clearTitle: request.clearTitle === true,
      links: request.links ?? [],
      unlinkLabels: request.unlinkLabels ?? [],
    }),
  ),
  removeSessionSlotTool: vi.fn(),
  withSessionSlotInstructions: vi.fn(),
}));
vi.mock("../../src/workspace.js", () => ({
  createWorktree: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  hasUnpushedCommits: vi.fn(),
  readCurrentBranch: readCurrentBranchMock,
  removeWorktree: vi.fn(),
  resolveRepoPathFromWorktree: vi.fn(),
  workspaceExists: vi.fn().mockReturnValue(true),
}));
vi.mock("../../src/spawn-overrides.js", () => ({
  parseSpawnOverrides: vi.fn(),
}));
vi.mock("../../src/registry.js", () => ({
  buildMergedConfig: vi.fn().mockReturnValue({
    config: baseConfig(),
    configPaths: ["/tmp/spur.yaml"],
  }),
  upsertConfigRegistryPath: vi.fn().mockReturnValue(["/tmp/spur.yaml"]),
  writeConfigRegistry: vi.fn(),
}));
vi.mock("../../src/pipeline.js", () => ({
  PIPELINE_STEP_TIMEOUT_MS: 600_000,
  formatPipelineStepMessage: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    realpathSync: vi.fn((p: string) => p),
    writeFileSync: vi.fn(),
  };
});

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
        symlinks: [],
      },
    },
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    agent: "claude",
    prompt: "fix the bug",
    branch: "spur/auto-detect-pr-slot",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api-a1b2",
    tmuxSession: "api-a1b2",
    launchCommand: "claude",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setupEnrich(state: string = "working"): void {
  tmuxSessionExistsMock.mockResolvedValue(true);
  isProcessRunningInTmuxMock.mockResolvedValue(true);
  getTmuxSessionActivityMock.mockResolvedValue(new Date());
  readClaudeJsonlStateMock.mockResolvedValue({
    state,
    reader: { tailRecords: [] },
  });
}

async function loadModule() {
  vi.resetModules();
  return import("../../src/session-service.js");
}

const PR_WAITING_LIMIT = 5;

describe("PR auto-detect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-detects PR and sets slot when gh returns a URL", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockResolvedValue(
      JSON.stringify([
        {
          number: 42,
          title: "Keep PR binding native",
          url: "https://github.com/org/repo/pull/42",
        },
      ]),
    );

    const { SessionService } = await loadModule();
    const service = new SessionService();

    // First poll runs on construct; advance to let async settle
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledWith(
      session.worktreePath,
      "pr",
      "list",
      "--head",
      session.branch,
      "--json",
      "number,title,url",
      "--limit",
      "1",
    );
    expect(writeSessionMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        pr: {
          number: 42,
          repo: "org/repo",
          url: "https://github.com/org/repo/pull/42",
        },
      }),
    );
    expect(syncTmuxStatusMock).toHaveBeenCalledWith("api-a1b2", {
      links: [{ label: "pr", url: "https://github.com/org/repo/pull/42" }],
    });

    service.dispose();
  });

  it("prefers the live worktree branch for initial PR discovery", async () => {
    const session = makeSession({ branch: "stale-session-branch" });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    readCurrentBranchMock.mockResolvedValueOnce("feature/live");
    ghMock.mockResolvedValue(JSON.stringify([]));

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledWith(
      session.worktreePath,
      "pr",
      "list",
      "--head",
      "feature/live",
      "--json",
      "number,title,url",
      "--limit",
      "1",
    );

    service.dispose();
  });

  it("skips check when session already has a PR binding", async () => {
    const session = makeSession({
      pr: {
        number: 1,
        repo: "org/repo",
        url: "https://github.com/org/repo/pull/1",
      },
    });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).not.toHaveBeenCalled();
    service.dispose();
  });

  it("skips check when session has no worktree", async () => {
    const session = makeSession({ worktree: false, worktreePath: "" });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich("working");
    tmuxSessionExistsMock.mockResolvedValue(true);
    isProcessRunningInTmuxMock.mockResolvedValue(true);

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).not.toHaveBeenCalled();
    service.dispose();
  });

  it("does not call gh again when PR already found", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockResolvedValue(
      JSON.stringify([{ number: 42, title: "t", url: "https://github.com/org/repo/pull/42" }]),
    );

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Advance past throttle and trigger another poll
    await vi.advanceTimersByTimeAsync(35_000);
    // gh should not be called again since tracker.found = true
    expect(ghMock).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("throttles gh calls to 30s minimum", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockResolvedValue(JSON.stringify([]));

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Advance 5s (one poll interval) — should be throttled
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Advance past 30s throttle
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("backs off after 5 checks in waiting state with no state change", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich("waiting");
    ghMock.mockResolvedValue(JSON.stringify([]));

    const { SessionService } = await loadModule();
    const service = new SessionService();

    // Initial poll fires on construct; let it settle
    await vi.advanceTimersByTimeAsync(100);
    const initialCalls = ghMock.mock.calls.length; // 1 (initial)

    // Run checks spaced > 30s apart until we hit the limit
    for (let i = initialCalls; i < PR_WAITING_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(35_000);
    }
    const callsAtLimit = ghMock.mock.calls.length;
    expect(callsAtLimit).toBe(PR_WAITING_LIMIT);

    // Next check should be skipped (backoff)
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ghMock).toHaveBeenCalledTimes(callsAtLimit);

    service.dispose();
  });

  it("resets waiting backoff on state change", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich("waiting");
    ghMock.mockResolvedValue(JSON.stringify([]));

    const { SessionService } = await loadModule();
    const service = new SessionService();

    // Exhaust the waiting checks
    await vi.advanceTimersByTimeAsync(100);
    for (let i = ghMock.mock.calls.length; i < PR_WAITING_LIMIT; i++) {
      await vi.advanceTimersByTimeAsync(35_000);
    }
    const callsAfterBackoff = ghMock.mock.calls.length;

    // Confirm backoff is in effect
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ghMock).toHaveBeenCalledTimes(callsAfterBackoff);

    // State changes to working → resets backoff
    readClaudeJsonlStateMock.mockResolvedValue({
      state: "working",
      reader: { tailRecords: [] },
    });
    // Advance past throttle so next poll can fire
    await vi.advanceTimersByTimeAsync(35_000);
    const callsAfterReset = ghMock.mock.calls.length;
    // Should have made at least one new call after backoff was lifted
    expect(callsAfterReset).toBeGreaterThan(callsAfterBackoff);

    service.dispose();
  });

  it("silently handles gh failures", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockRejectedValue(new Error("gh not found"));

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    // Should log the failure but not throw
    expect(logSpurEventMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "session.pr_auto_detect.failed",
      }),
    );

    service.dispose();
  });

  it("does not overwrite a pr slot that was set between check and write", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    // On re-read, session now has a PR binding.
    readSessionMock.mockReturnValue({
      ...session,
      pr: {
        number: 99,
        repo: "org/repo",
        url: "https://github.com/org/repo/pull/99",
      },
    });
    setupEnrich();
    ghMock.mockResolvedValue(
      JSON.stringify([{ number: 42, title: "t", url: "https://github.com/org/repo/pull/42" }]),
    );

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(writeSessionMock).not.toHaveBeenCalled();

    service.dispose();
  });
});
