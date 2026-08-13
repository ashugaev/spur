import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ghModule from "../../src/gh.js";
import type * as prLookupModule from "../../src/pr-lookup.js";
import type { AppConfig, ProjectConfig, SessionRecord, SessionSlots } from "../../src/types.js";

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
}));
const ghMock = vi.fn();
const glabMock = vi.fn();
const readRemoteUrlsMock = vi.fn();
const listSessionsMock = vi.fn();
const readSessionMock = vi.fn();
const writeSessionMock = vi.fn();
const writeWorkspaceStateMock = vi.fn();
const applySlotsUpdateMock = vi.fn();
const readCurrentBranchMock = vi.fn();
const tmuxSessionExistsMock = vi.fn();
const isProcessRunningInTmuxMock = vi.fn();
const getTmuxSessionActivityMock = vi.fn();
const captureTmuxPaneMock = vi.fn(() => Promise.resolve(""));
const setTmuxSocketNameMock = vi.fn();
const readClaudeJsonlStateMock = vi.fn();
const readClaudeSessionStatusMock = vi.fn();
const logSpurEventMock = vi.fn();
const buildMergedConfigMock = vi.fn();
const upsertConfigRegistryPathMock = vi.fn();
const writeConfigRegistryMock = vi.fn();
const agentProcessMatchersMock = vi.fn();
const agentStateStrategyMock = vi.fn();
const agentWaitsForSubmitAckMock = vi.fn();

vi.mock("../../src/gh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ghModule>()),
  gh: ghMock,
}));
vi.mock("../../src/glab.js", () => ({
  glab: glabMock,
}));
vi.mock("../../src/claude-jsonl-state.js", () => ({
  readClaudeJsonlState: readClaudeJsonlStateMock,
}));
vi.mock("../../src/claude-session-status.js", () => ({
  readClaudeSessionStatus: readClaudeSessionStatusMock,
}));
vi.mock("../../src/agents/index.js", () => ({
  buildAgentLaunchPlan: vi.fn(),
  buildAgentRestorePlan: vi.fn(),
  buildAgentResumePlan: vi.fn(),
  findAgentSessionId: vi.fn(),
  agentProcessMatchers: agentProcessMatchersMock,
  agentSessionConfig: vi.fn(() => ({})),
  agentStateStrategy: agentStateStrategyMock,
  agentWaitsForSubmitAck: agentWaitsForSubmitAckMock,
  parseAgentName: vi.fn((a: string) => a),
  setupAgentHooks: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
  loadProjectConfig: vi.fn(),
  findProjectConfigPathInDirectory: vi.fn(),
  DEFAULT_PROJECT_CONFIG_FILES: ["spur.yaml", "spur.yml"] as const,
}));
vi.mock("../../src/preflight.js", () => ({
  runSpawnPreflight: vi.fn(),
}));
vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
  // The reaper tick flushes the warn-collapse map; these tests advance timers
  // past REAP_INTERVAL_MS, so the mock has to carry it.
  flushEventLogCollapse: vi.fn(),
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
// node:fs is stubbed below (existsSync always true, mkdirSync/writeFileSync
// no-ops) for the rest of this suite's needs, which breaks
// workspace-store.js's real tmp-file-and-rename write (renameSync is real
// and would throw ENOENT on the never-actually-written tmp file). This
// suite only cares that a found PR binding lands on the session record via
// writeSession, so resolve workspace state straight off the passed-in
// record — the same "no workspace file yet" value the real resolver would
// give here, since every test in this file uses a single non-desk session
// id (`workspaceId === id`) and never actually writes a workspace file.
vi.mock("../../src/workspace-store.js", () => ({
  resolveWorkspaceState: (
    _dataDir: string,
    record: { slots?: SessionSlots; pr?: SessionRecord["pr"] },
  ) => ({
    ...(record.slots ? { slots: record.slots } : {}),
    ...(record.pr ? { pr: record.pr } : {}),
  }),
  writeWorkspaceState: writeWorkspaceStateMock,
  deleteWorkspaceState: vi.fn(),
  readWorkspaceState: vi.fn().mockReturnValue(null),
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
  captureTmuxPane: captureTmuxPaneMock,
  getTmuxSessionActivity: getTmuxSessionActivityMock,
  getTmuxPanePid: vi.fn(() => Promise.resolve(null)),
  isProcessRunningInTmux: isProcessRunningInTmuxMock,
  killTmuxSession: vi.fn(),
  setTmuxSocketName: setTmuxSocketNameMock,
  sendMessageToTmux: vi.fn(),
  sendSubmitKeyToTmux: vi.fn(),
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
  readRemoteUrls: readRemoteUrlsMock,
  removeWorktree: vi.fn(),
  resolveRepoPathFromWorktree: vi.fn(),
  workspaceExists: vi.fn().mockReturnValue(true),
  probeWorkspace: vi.fn().mockReturnValue({ exists: true, missing: false }),
}));
vi.mock("../../src/spawn-overrides.js", () => ({
  parseSpawnOverrides: vi.fn(),
}));
vi.mock("../../src/registry.js", () => ({
  buildMergedConfig: buildMergedConfigMock,
  upsertConfigRegistryPath: upsertConfigRegistryPathMock,
  writeConfigRegistry: writeConfigRegistryMock,
  mutateConfigRegistry: vi.fn((_dataDir: string, mutate: (current: unknown) => unknown) =>
    mutate({ configPaths: [], unconfiguredProjects: [] }),
  ),
  readConfigRegistryFile: vi.fn(() => ({ configPaths: [], unconfiguredProjects: [] })),
  dropWorktreeInternalPaths: vi.fn((paths: string[]) => paths),
  canonicalConfigKey: vi.fn((path: string) => path),
  isInsideWorktreeDir: vi.fn(() => false),
  removeConfigRegistryPath: vi.fn(() => []),
  // Keep existing per-test buildMergedConfigMock setups driving the merged config.
  ConfigRegistryScanner: vi.fn().mockImplementation(() => ({
    invalidateRemovedPaths: vi.fn(),
    canonicalizePath: vi.fn((path: string) => path),
    scan: () => {
      const merged = buildMergedConfigMock() as { config: unknown; configPaths: string[] };
      return {
        config: merged.config,
        configPaths: merged.configPaths,
        newDiagnostics: [],
      };
    },
  })),
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
    existsSync: existsSyncMock,
    realpathSync: vi.fn((p: string) => p),
    writeFileSync: vi.fn(),
  };
});

function baseConfig(): AppConfig {
  return {
    configPath: "/tmp/spur.yaml",
    server: { host: "127.0.0.1", port: 4310 },
    dataDir: "/tmp/spur-data",
    worktreeDir: "/tmp/spur-worktrees",
    projectsRoot: "/tmp/spur-data/projects",
    defaultAgent: "claude",
    tmux: { socketName: "spur-4310" },
    ui: { port: 5555 },
    models: { codexHome: "/tmp/codex" },
    voice: {
      provider: "whisper_cpp",
      language: "en",
      model: "base",
    },
    rateLimitReactivation: { afterHours: 0 },
    authRotation: {
      autoRotateOnRateLimit: false,
      cooldownMinutes: 60,
      maxRotationsPerEpisode: 2,
    },
    sessionGc: {
      enabled: false,
      olderThanDays: 30,
      intervalMinutes: 360,
      maxGroupsPerSweep: 20,
      statuses: ["completed", "killed", "stopped"],
    },
    sidecarGc: {
      enabled: true,
      idleTtlMinutes: 120,
      maxAgeWarnMinutes: 360,
    },
    admission: {
      enabled: true,
      maxLiveSessions: 1000,
      maxLiveSessionsSource: "derived",
      perSessionBytes: 1_610_612_736,
      reserveFraction: 0.7,
      memoryGuard: {
        enforce: false,
        enforceFloors: true,
        shedEnabled: true,
        minAvailableBytes: 1_073_741_824,
        minFreeSwapBytes: 0,
        admissionFloorBytes: 8_000_000_000,
        shedCriticalFloorBytes: 4_000_000_000,
        restoreFloorBytes: 9_610_612_736,
        pressureSomeAvg10Refuse: 20,
        shedSwapUsedFraction: 0.9,
      },
    },
    projects: {
      api: {
        path: "/repo/api",
        defaultBranch: "main",
        sessionPrefix: "api",
        worktree: true,
        restoreAfterReboot: false,
        symlinks: [],
        sidecars: {},
        sources: {
          review: {
            type: "github",
            runOnStart: false,
            intervalMs: 60_000,
            emitExisting: false,
          },
        },
        backlog: {},
        triggers: {},
      },
    },
    tags: [],
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    workspaceId: overrides.workspaceId ?? "api-a1b2",
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
const PR_SLUG = { host: "github.com", owner: "acme", name: "api" };
const DATA_DIR = "/tmp/spur-data";

interface GraphqlPrNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

/**
 * Builds the response for whatever branch aliases the batched query actually
 * asked for, so a test asserts on call counts instead of on argv order.
 */
function graphqlEnvelope(args: string[], prByBranch: Record<string, GraphqlPrNode> = {}): string {
  const repo: Record<string, unknown> = {
    nameWithOwner: "acme/api",
    isFork: false,
    parent: null,
  };
  for (const arg of args) {
    const match = /^b(\d+)=([\s\S]*)$/.exec(arg);
    if (!match) {
      continue;
    }
    const pr = prByBranch[match[2] ?? ""];
    repo[`a${match[1]}`] = { nodes: pr ? [pr] : [] };
  }
  return JSON.stringify({
    data: {
      rateLimit: { limit: 5000, cost: 1, remaining: 4_800, resetAt: "2026-08-04T06:00:00Z" },
      r: repo,
    },
  });
}

function mockGraphql(prByBranch: Record<string, GraphqlPrNode> = {}): void {
  ghMock.mockImplementation((_cwd: string, ...args: string[]) =>
    Promise.resolve(graphqlEnvelope(args, prByBranch)),
  );
}

function branchArgsOf(callIndex: number): string[] {
  return (ghMock.mock.calls[callIndex] ?? []).filter((arg: unknown) =>
    /^b\d+=/.test(String(arg)),
  ) as string[];
}

const OPEN_PR_42: GraphqlPrNode = {
  number: 42,
  title: "Keep PR binding native",
  url: "https://github.com/org/repo/pull/42",
  state: "OPEN",
};

describe("PR auto-detect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    buildMergedConfigMock.mockReset().mockReturnValue({
      config: baseConfig(),
      configPaths: ["/tmp/spur.yaml"],
    });
    upsertConfigRegistryPathMock.mockReset().mockReturnValue(["/tmp/spur.yaml"]);
    writeConfigRegistryMock.mockReset();
    agentProcessMatchersMock.mockReset().mockImplementation((agent: string) => [agent]);
    agentStateStrategyMock.mockReset().mockReturnValue("claude_jsonl");
    agentWaitsForSubmitAckMock.mockReset().mockReturnValue(false);
    readClaudeSessionStatusMock.mockReset().mockResolvedValue(null);
    captureTmuxPaneMock.mockReset().mockResolvedValue("");
    existsSyncMock.mockReturnValue(true);
    readRemoteUrlsMock
      .mockReset()
      .mockResolvedValue(new Map([["origin", "git@github.com:acme/api.git"]]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-detects PR and sets slot when gh returns a URL", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql({ [session.branch]: OPEN_PR_42 });

    const { SessionService } = await loadModule();
    const service = new SessionService();

    // First poll runs on construct; advance to let async settle
    await vi.advanceTimersByTimeAsync(100);

    // One batched GraphQL query, not one `gh pr list --head` per branch.
    expect(ghMock).toHaveBeenCalledTimes(1);
    const call = ghMock.mock.calls[0] ?? [];
    expect(call[0]).toBe(session.worktreePath);
    expect(call[1]).toBe("api");
    expect(call.slice(1, 4)).toEqual(["api", "--hostname", "github.com"]);
    expect(call[4]).toBe("graphql");
    expect(call).toContain("owner=acme");
    expect(call).toContain("name=api");
    expect(call).toContain(`b0=${session.branch}`);
    expect(call).not.toContain("list");
    // The binding is workspace-owned state: it lands in the workspace file
    // keyed by the workspace id, and is mirrored onto the session record for
    // the transitional legacy readers.
    expect(writeWorkspaceStateMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      session.id,
      expect.objectContaining({
        pr: {
          number: 42,
          repo: "org/repo",
          url: "https://github.com/org/repo/pull/42",
        },
      }),
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

    service.dispose();
  });

  it("falls back to GitLab after an arbitrary-host GitHub transport failure", async () => {
    const { buildMergedConfig } = await import("../../src/registry.js");
    const baseProject = baseConfig().projects.api;
    if (!baseProject) {
      throw new Error("Missing api project fixture");
    }
    const apiProject: ProjectConfig = {
      path: baseProject.path,
      defaultBranch: baseProject.defaultBranch,
      sessionPrefix: baseProject.sessionPrefix,
      worktree: baseProject.worktree,
      restoreAfterReboot: baseProject.restoreAfterReboot,
      symlinks: baseProject.symlinks,
      sidecars: baseProject.sidecars,
      backlog: baseProject.backlog,
      triggers: baseProject.triggers,
      sources: {
        github: {
          type: "github",
          runOnStart: false,
          intervalMs: 60_000,
          emitExisting: false,
        },
        gitlab: {
          type: "gitlab",
          runOnStart: false,
          intervalMs: 60_000,
          emitExisting: false,
        },
      },
    };
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    readRemoteUrlsMock.mockResolvedValue(
      new Map([["origin", "git@gitea.corp.internal:org/repo.git"]]),
    );
    ghMock.mockRejectedValue(new Error("gh: authentication failed for gitea.corp.internal"));
    glabMock.mockResolvedValue(
      JSON.stringify([
        {
          iid: 42,
          title: "Support GitLab provider",
          web_url: "https://gitlab.com/org/repo/-/merge_requests/42",
        },
      ]),
    );
    applySlotsUpdateMock.mockReturnValue({
      links: [{ label: "pr", url: "https://gitlab.com/org/repo/-/merge_requests/42" }],
    } satisfies SessionSlots);
    vi.mocked(buildMergedConfig).mockReturnValue({
      config: {
        ...baseConfig(),
        projects: {
          api: apiProject,
        },
      },
      configPaths: ["/tmp/spur.yaml"],
    });

    const { SessionService } = await loadModule();
    const service = new SessionService();

    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledOnce();
    expect(glabMock).toHaveBeenCalledWith(
      session.worktreePath,
      "api",
      "projects/:fullpath/merge_requests?source_branch=spur%2Fauto-detect-pr-slot&state=all&per_page=1",
      "--output",
      "json",
    );
    expect(applySlotsUpdateMock).toHaveBeenCalledWith(undefined, {
      links: [{ label: "pr", url: "https://gitlab.com/org/repo/-/merge_requests/42" }],
    });
    expect(writeSessionMock).toHaveBeenCalled();
    service.dispose();
  });

  function apiProjectWithSources(sources: ProjectConfig["sources"]): ProjectConfig {
    const baseProject = baseConfig().projects.api;
    if (!baseProject) {
      throw new Error("Missing api project fixture");
    }
    return {
      path: baseProject.path,
      defaultBranch: baseProject.defaultBranch,
      sessionPrefix: baseProject.sessionPrefix,
      worktree: baseProject.worktree,
      restoreAfterReboot: baseProject.restoreAfterReboot,
      symlinks: baseProject.symlinks,
      sidecars: baseProject.sidecars,
      backlog: baseProject.backlog,
      triggers: baseProject.triggers,
      sources,
    };
  }

  it("does not call glab when every remote is github.com and no PR exists", async () => {
    const { buildMergedConfig } = await import("../../src/registry.js");
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql({});
    vi.mocked(buildMergedConfig).mockReturnValue({
      config: {
        ...baseConfig(),
        projects: { api: apiProjectWithSources({}) },
      },
      configPaths: ["/tmp/spur.yaml"],
    });

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(glabMock).not.toHaveBeenCalled();
    expect(logSpurEventMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "session.pr_auto_detect.failed" }),
    );

    service.dispose();
  });

  it("does not call glab when every remote is github.com and the gh lookup errors", async () => {
    const { buildMergedConfig } = await import("../../src/registry.js");
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockRejectedValue(new Error("gh: server error"));
    vi.mocked(buildMergedConfig).mockReturnValue({
      config: {
        ...baseConfig(),
        projects: { api: apiProjectWithSources({}) },
      },
      configPaths: ["/tmp/spur.yaml"],
    });

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(glabMock).not.toHaveBeenCalled();

    service.dispose();
  });

  it("still gives glab its turn when a gitlab remote sits beside a github upstream", async () => {
    const { buildMergedConfig } = await import("../../src/registry.js");
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    readRemoteUrlsMock.mockResolvedValue(
      new Map([
        ["upstream", "git@github.com:acme/api.git"],
        ["origin", "git@gitlab.com:acme/api.git"],
      ]),
    );
    mockGraphql({});
    glabMock.mockResolvedValue(
      JSON.stringify([
        {
          iid: 42,
          title: "Support GitLab provider",
          web_url: "https://gitlab.com/org/repo/-/merge_requests/42",
        },
      ]),
    );
    applySlotsUpdateMock.mockReturnValue({
      links: [{ label: "pr", url: "https://gitlab.com/org/repo/-/merge_requests/42" }],
    } satisfies SessionSlots);
    vi.mocked(buildMergedConfig).mockReturnValue({
      config: {
        ...baseConfig(),
        projects: { api: apiProjectWithSources({}) },
      },
      configPaths: ["/tmp/spur.yaml"],
    });

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(glabMock).toHaveBeenCalled();

    service.dispose();
  });

  it("prefers the live worktree branch for initial PR discovery", async () => {
    const session = makeSession({ branch: "stale-session-branch" });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    readCurrentBranchMock.mockResolvedValueOnce("feature/live");
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(branchArgsOf(0)).toEqual(["b0=feature/live"]);

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
    mockGraphql({ [session.branch]: OPEN_PR_42 });

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

  it("holds a running session to the 30s throttle then the 60s cache backoff", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Advance 5s (one poll interval) — throttled.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Past the 30s throttle but still inside the first 60s miss backoff.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Past the backoff: exactly one more lookup.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("does not re-query an absent branch inside its backoff and does after it", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // 59s of 5s sweeps, all inside the first backoff step.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    // Second step is 2min: the sweeps in between spend nothing.
    await vi.advanceTimersByTimeAsync(115_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(ghMock).toHaveBeenCalledTimes(3);

    service.dispose();
  });

  it("backs off after 5 checks in waiting state with no state change", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich("waiting");
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();

    // Initial poll fires on construct; let it settle
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    // Cache-skipped sweeps do not consume the waiting limit. The first 175s
    // therefore contain only the initial lookup and the 60s-backoff retry.
    await vi.advanceTimersByTimeAsync(5 * 35_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    // The remaining retries follow the 2m, 4m and capped 5m backoff steps.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const callsAtLimit = ghMock.mock.calls.length;
    expect(callsAtLimit).toBe(PR_WAITING_LIMIT);
    expect(
      (
        service as unknown as { prCheckTrackers: Map<string, { waitingChecks: number }> }
      ).prCheckTrackers.get(session.id)?.waitingChecks,
    ).toBe(PR_WAITING_LIMIT);

    // Past the limit nothing is attempted again, even once the backoff expires.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ghMock).toHaveBeenCalledTimes(callsAtLimit);

    service.dispose();
  });

  it("resets waiting backoff on state change", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([]);
    readSessionMock.mockReturnValue({ ...session });
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    (
      service as unknown as {
        prCheckTrackers: Map<
          string,
          { waitingChecks: number; lastState: string | null; lastCheckAt: number; found: boolean }
        >;
        checkPrForSession(session: SessionRecord, state: string): void;
      }
    ).prCheckTrackers.set(session.id, {
      waitingChecks: PR_WAITING_LIMIT,
      lastState: "waiting",
      lastCheckAt: Date.now(),
      found: false,
    });

    (
      service as unknown as {
        checkPrForSession(session: SessionRecord, state: string): void;
      }
    ).checkPrForSession(session, "working");
    // The queued lookup rides the next sweep's flush.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("absorbs a gh failure without recording a miss", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    ghMock.mockRejectedValue(new Error("gh not found"));

    const { SessionService } = await loadModule();
    const service = new SessionService();
    const { readPrLookupEntry } = await import("../../src/pr-lookup-cache.js");
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceStateMock).not.toHaveBeenCalled();
    // A failed lookup is not an answer: no cache entry, so the branch is
    // retried on the next throttle window instead of being written off.
    expect(readPrLookupEntry(DATA_DIR, PR_SLUG, session.branch)).toBeNull();

    await vi.advanceTimersByTimeAsync(35_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

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
    mockGraphql({ [session.branch]: OPEN_PR_42 });

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(writeSessionMock).not.toHaveBeenCalled();

    service.dispose();
  });

  it("batches one project's whole eligible set into a single gh call per sweep", async () => {
    const sessions = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        makeSession({
          id: `api-stopped-${index}`,
          workspaceId: `api-stopped-${index}`,
          status: "stopped",
          branch: `feature/stopped-${index}`,
          worktreePath: `/tmp/spur-worktrees/api-stopped-${index}`,
          tmuxSession: `api-stopped-${index}`,
        }),
      ),
      ...Array.from({ length: 2 }, (_unused, index) =>
        makeSession({
          id: `api-live-${index}`,
          workspaceId: `api-live-${index}`,
          branch: `feature/live-${index}`,
          worktreePath: `/tmp/spur-worktrees/api-live-${index}`,
          tmuxSession: `api-live-${index}`,
        }),
      ),
    ];
    listSessionsMock.mockReturnValue(sessions);
    readSessionMock.mockImplementation((_dataDir: string, id: string) => ({
      ...(sessions.find((session) => session.id === id) ?? sessions[0]),
    }));
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    // 42 branches, one repo, one query.
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(branchArgsOf(0)).toHaveLength(42);

    service.dispose();
  });

  it("coalesces duplicate repo and branch sessions into one miss mutation", async () => {
    const sessions = [
      makeSession({ id: "api-a", workspaceId: "api-a", worktreePath: "/tmp/api-a" }),
      makeSession({ id: "api-b", workspaceId: "api-b", worktreePath: "/tmp/api-b" }),
    ];
    listSessionsMock.mockReturnValue(sessions);
    readSessionMock.mockImplementation((_dataDir: string, id: string) => ({
      ...(sessions.find((session) => session.id === id) ?? sessions[0]),
    }));
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const { readPrLookupEntry } = await import("../../src/pr-lookup-cache.js");
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(branchArgsOf(0)).toEqual([`b0=${sessions[0]?.branch ?? ""}`]);
    expect(readPrLookupEntry(DATA_DIR, PR_SLUG, sessions[0]?.branch ?? "")?.misses).toBe(1);

    service.dispose();
  });

  it("skips a session whose worktree directory is gone", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();
    existsSyncMock.mockReturnValue(false);

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledTimes(0);

    service.dispose();
  });

  it("drops a stopped session to the 30min throttle", async () => {
    const session = makeSession({ status: "stopped" });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(ghMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(ghMock).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("binds a PR opened by hand long after the session stopped", async () => {
    const session = makeSession({ status: "stopped" });
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);
    expect(writeWorkspaceStateMock).not.toHaveBeenCalled();

    // The user opens the PR by hand half an hour later.
    mockGraphql({ [session.branch]: OPEN_PR_42 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(writeWorkspaceStateMock).toHaveBeenCalledWith(
      DATA_DIR,
      session.id,
      expect.objectContaining({
        pr: { number: 42, repo: "org/repo", url: "https://github.com/org/repo/pull/42" },
      }),
    );

    service.dispose();
  });

  it("writes no cache entry when the graphql budget is exhausted", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    mockGraphql();

    const { SessionService } = await loadModule();
    const { GH_POLL_MIN_GRAPHQL_REMAINING, recordGraphqlBudget, _resetGhUsageForTests } =
      await import("../../src/gh.js");
    const { readPrLookupEntry } = await import("../../src/pr-lookup-cache.js");
    _resetGhUsageForTests();
    recordGraphqlBudget(GH_POLL_MIN_GRAPHQL_REMAINING - 1, Date.now() + 60 * 60_000);

    const service = new SessionService();
    await vi.advanceTimersByTimeAsync(100);

    expect(ghMock).toHaveBeenCalledTimes(0);
    expect(readPrLookupEntry(DATA_DIR, PR_SLUG, session.branch)).toBeNull();
    expect(
      (
        service as unknown as { prCheckTrackers: Map<string, { found: boolean }> }
      ).prCheckTrackers.get(session.id)?.found,
    ).toBe(false);

    // Budget recovers: the very next throttle window spends exactly one call.
    _resetGhUsageForTests();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ghMock).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("releases the sweep's poll claim when enqueuePrLookup rejects", async () => {
    const session = makeSession();
    listSessionsMock.mockReturnValue([session]);
    readSessionMock.mockReturnValue({ ...session });
    setupEnrich();
    // Real `enqueuePrLookup` never rejects (its own doc comment says so):
    // every gh failure it sees is caught and settled as a `skipped` outcome.
    // Proving `resolveQueuedPrLookup`'s finally releases the claim on a
    // rejection needs a synthetic one, scoped to this test only with
    // `vi.doMock` (not the file-wide `vi.mock`) so the other 18 tests in this
    // file keep importing a genuinely fresh, unmocked `pr-lookup.js` module
    // per `vi.resetModules()` cycle.
    vi.doMock("../../src/pr-lookup.js", async (importOriginal) => {
      const original = await importOriginal<typeof prLookupModule>();
      return { ...original, enqueuePrLookup: () => Promise.reject(new Error("gh unavailable")) };
    });

    try {
      const { SessionService } = await loadModule();
      const { claimPollPrLookup } = await import("../../src/pr-lookup.js");
      const service = new SessionService();

      await vi.advanceTimersByTimeAsync(100);

      // The rejection is not swallowed: the sweep logs it instead of hanging.
      expect(logSpurEventMock).toHaveBeenCalledWith(
        DATA_DIR,
        expect.objectContaining({ event: "session.pr_auto_detect.failed" }),
      );
      // And the claim taken before the rejecting await is released, not
      // leaked: a later claimant owns the key instead of joining a claim
      // nobody settles.
      const claim = claimPollPrLookup({
        dataDir: DATA_DIR,
        slug: PR_SLUG,
        branch: session.branch,
        capMs: 5 * 60_000,
      });
      expect(claim.status).toBe("owner");

      service.dispose();
    } finally {
      // Unregister unconditionally: an assertion failure above must not leave
      // a rejecting `enqueuePrLookup` mock for a test appended after this one.
      vi.doUnmock("../../src/pr-lookup.js");
    }
  });
});
