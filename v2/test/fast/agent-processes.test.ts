import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as processTreeModule from "../../src/process-tree.js";
import type { AgentName, SessionRecord } from "../../src/types.js";

interface FakeProc {
  pid: number;
  ppid: number;
  rssKb: number;
  elapsedSeconds: number;
  args: string;
  env?: Record<string, string>;
  // Kernel session id; undefined reads as an unreadable /proc stat.
  sid?: number | undefined;
}

let fakeTable: FakeProc[] = [];
let envReadable = true;
let deadPids = new Set<number>();
// terminateAgentProcesses tests: force every queried pid alive regardless of
// deadPids, simulating a process that received every signal and never died.
let forceAllAlive = false;
// Simulates snapshotProcessLiveness's own fail-safe contract: "unavailable"
// must never read as "found nobody, so treat every pid as dead".
let snapshotUnavailable = false;
// Simulates snapshotProcesses failing (a wedged or unforkable `ps`) for the
// pre-kill capture, which must refuse rather than report an empty capture.
let processSnapshotUnavailable = false;
// pid -> /proc starttime token. A pid absent here reads as null identity
// ("this platform cannot verify"), which is the macOS/no-procfs degrade path.
let identities = new Map<number, string>();

function toEntries(): processTreeModule.ProcessSnapshotEntry[] {
  return fakeTable.map(({ pid, ppid, rssKb, elapsedSeconds, args }) => ({
    pid,
    ppid,
    rssKb,
    elapsedSeconds,
    args,
  }));
}

const listProcessesMock = vi.fn(async () => toEntries());
const snapshotProcessesMock = vi.fn(async () =>
  processSnapshotUnavailable
    ? ({ status: "unavailable" } as const)
    : ({ status: "ok", processes: toEntries() } as const),
);
const readProcessIdentityMock = vi.fn(async (pid: number) => identities.get(pid) ?? null);
const listSessionMemberPidsMock = vi.fn(async (sid: number) =>
  fakeTable.filter((proc) => proc.sid === sid).map((proc) => proc.pid),
);
const readProcessStatMock = vi.fn(async (pid: number) => {
  const sid = fakeTable.find((proc) => proc.pid === pid)?.sid;
  const identity = identities.get(pid);
  return sid === undefined || identity === undefined ? null : { sid, identity };
});
// Real /proc reads on the fake pids used below (10/11/20/21/70/etc.) would hit
// live kernel-thread pids on this host — the vi.mock spread only passes an
// UNNAMED export through to the real implementation, so this must be named
// explicitly. Default resolves null (unreadable cwd), overridden per test.
let cwdByPid = new Map<number, string>();
const readProcessCwdMock = vi.fn(async (pid: number) => cwdByPid.get(pid) ?? null);
const readProcessEnvValueMock = vi.fn(async (pid: number, key: string) => {
  if (!envReadable) return { status: "unreadable" as const };
  const proc = fakeTable.find((entry) => entry.pid === pid);
  if (!proc) return { status: "unreadable" as const };
  return { status: "ok" as const, value: proc.env?.[key] };
});
const canReadProcessEnvMock = vi.fn(async () => envReadable);
const snapshotProcessLivenessMock = vi.fn(async () => {
  if (snapshotUnavailable) {
    return { status: "unavailable" as const };
  }
  const alivePids: ReadonlySet<number> = {
    has: (pid: number) => forceAllAlive || !deadPids.has(pid),
  } as ReadonlySet<number>;
  return { status: "ok" as const, alivePids };
});
const signalPidMock = vi.fn((pid: number) => {
  deadPids.add(pid);
});

vi.mock("../../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof processTreeModule>();
  return {
    ...actual,
    listProcesses: listProcessesMock,
    snapshotProcesses: snapshotProcessesMock,
    readProcessEnvValue: readProcessEnvValueMock,
    readProcessIdentity: readProcessIdentityMock,
    listSessionMemberPids: listSessionMemberPidsMock,
    readProcessStat: readProcessStatMock,
    readProcessCwd: readProcessCwdMock,
    canReadProcessEnv: canReadProcessEnvMock,
    snapshotProcessLiveness: snapshotProcessLivenessMock,
    signalPid: signalPidMock,
  };
});

const listSessionsMock = vi.fn<(dataDir: string) => SessionRecord[]>(() => []);
vi.mock("../../src/metadata.js", () => ({
  listSessions: listSessionsMock,
}));

const agentProcessMatchersMock = vi.fn((agent: AgentName) => {
  if (agent === "cursor") return ["cursor-agent", "agent"];
  return [agent];
});
vi.mock("../../src/agents/index.js", () => ({
  agentProcessMatchers: agentProcessMatchersMock,
}));

let resolveRegisteredDataDirsResult: string[] = [];
const resolveRegisteredDataDirsMock = vi.fn(() => resolveRegisteredDataDirsResult);
vi.mock("../../src/registry.js", () => ({
  resolveRegisteredDataDirs: resolveRegisteredDataDirsMock,
}));

const {
  captureAgentProcessesForLaunch,
  capturePaneAgentProcesses,
  checkAgentProcessOwnership,
  findForeignAgentProcessesForSession,
  scanUnownedAgentProcesses,
  terminateAgentProcesses,
} = await import("../../src/agent-processes.js");

function session(
  overrides: Partial<SessionRecord> & Pick<SessionRecord, "id" | "status">,
): SessionRecord {
  return {
    project: "api",
    agent: "claude",
    prompt: "hello",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    tmuxSession: overrides.id,
    launchCommand: "claude --dangerously-skip-permissions",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fakeTable = [];
  envReadable = true;
  deadPids = new Set();
  forceAllAlive = false;
  snapshotUnavailable = false;
  processSnapshotUnavailable = false;
  identities = new Map();
  cwdByPid = new Map();
  resolveRegisteredDataDirsResult = [];
  listProcessesMock.mockClear();
  snapshotProcessesMock.mockClear();
  readProcessIdentityMock.mockClear();
  listSessionMemberPidsMock.mockClear();
  readProcessStatMock.mockClear();
  readProcessCwdMock.mockClear();
  readProcessEnvValueMock.mockClear();
  canReadProcessEnvMock.mockClear();
  snapshotProcessLivenessMock.mockClear();
  signalPidMock.mockClear();
  resolveRegisteredDataDirsMock.mockClear();
  listSessionsMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("capturePaneAgentProcesses", () => {
  it("returns an empty capture when the session has no panes", async () => {
    expect(
      await capturePaneAgentProcesses({
        sessionId: "api-1",
        panePids: [],
        livePanePids: [],
        processMatchers: ["claude"],
      }),
    ).toEqual({
      status: "ok",
      processes: [],
    });
  });

  it("reports unavailable when the process table cannot be read, never an empty capture", async () => {
    // An empty capture would make terminateAgentProcesses report "clear",
    // letting a failOnSurvivors:true caller relaunch over a possibly-live
    // agent — the duplicate this module exists to prevent. The capture must
    // stay distinguishable from "the pane had no agent processes".
    processSnapshotUnavailable = true;
    expect(
      await capturePaneAgentProcesses({
        sessionId: "api-1",
        panePids: [1],
        livePanePids: [1],
        processMatchers: ["claude"],
      }),
    ).toEqual({
      status: "unavailable",
    });
  });

  it("retries once before giving up on an unavailable process table", async () => {
    processSnapshotUnavailable = true;
    snapshotProcessesMock.mockImplementationOnce(async () => {
      processSnapshotUnavailable = false;
      return { status: "unavailable" } as const;
    });
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      { pid: 2, ppid: 1, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
    ];
    const capture = await capturePaneAgentProcesses({
      sessionId: "api-1",
      panePids: [1],
      livePanePids: [1],
      processMatchers: ["claude"],
    });
    expect(snapshotProcessesMock).toHaveBeenCalledTimes(2);
    expect(capture).toEqual({ status: "ok", processes: [{ pid: 2, identity: null }] });
  });

  it("records each captured pid's identity so a recycled pid can be told apart later", async () => {
    identities = new Map([[2, "starttime-2"]]);
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      { pid: 2, ppid: 1, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
    ];
    const capture = await capturePaneAgentProcesses({
      sessionId: "api-1",
      panePids: [1],
      livePanePids: [1],
      processMatchers: ["claude"],
    });
    expect(capture).toEqual({ status: "ok", processes: [{ pid: 2, identity: "starttime-2" }] });
  });

  it("captures agents under every pane pid of the session", async () => {
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      { pid: 2, ppid: 1, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
      { pid: 10, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      { pid: 11, ppid: 10, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
      { pid: 20, ppid: 999, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
    ];
    const capture = await capturePaneAgentProcesses({
      sessionId: "api-1",
      panePids: [1, 10],
      livePanePids: [1, 10],
      processMatchers: ["claude"],
    });
    expect(capture.status).toBe("ok");
    if (capture.status !== "ok") throw new Error("unreachable");
    expect(capture.processes.map((ref) => ref.pid)).toEqual([2, 11]);
  });

  it("captures only pane descendants whose args match", async () => {
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 100, elapsedSeconds: 1, args: "-zsh" },
      {
        pid: 2,
        ppid: 1,
        rssKb: 200,
        elapsedSeconds: 1,
        args: "/usr/bin/claude --dangerously-skip-permissions",
      },
      { pid: 3, ppid: 0, rssKb: 300, elapsedSeconds: 1, args: "/usr/bin/claude --other" },
    ];
    const capture = await capturePaneAgentProcesses({
      sessionId: "api-1",
      panePids: [1],
      livePanePids: [1],
      processMatchers: ["claude"],
    });
    expect(capture.status).toBe("ok");
    if (capture.status !== "ok") throw new Error("unreachable");
    expect(capture.processes.map((ref) => ref.pid)).toEqual([2]);
    expect(listSessionMemberPidsMock).not.toHaveBeenCalled();
  });

  describe("pane kernel session members", () => {
    const row = (pid: number, ppid: number, args: string, sid?: number): FakeProc => ({
      pid,
      ppid,
      rssKb: 1,
      elapsedSeconds: 1,
      args,
      sid,
      env: { SPUR_SESSION: "api-1", SPUR_AGENT_LAUNCH_ID: "launch-1" },
    });
    const pane = (paneDead = false): Parameters<typeof capturePaneAgentProcesses>[0] => ({
      sessionId: "api-1",
      agentLaunchId: "launch-1",
      panePids: [100],
      livePanePids: paneDead ? [] : [100],
      processMatchers: ["codex"],
    });
    const capturedPids = async (
      input: Parameters<typeof capturePaneAgentProcesses>[0],
    ): Promise<number[]> => {
      const capture = await capturePaneAgentProcesses(input);
      if (capture.status !== "ok") throw new Error("unreachable");
      return capture.processes.map((ref) => ref.pid);
    };

    it("T1 captures a re-parented native binary and its non-matching MCP child", async () => {
      identities = new Map([
        [100, "s100"],
        [901, "s901"],
        [902, "s902"],
      ]);
      fakeTable = [
        row(100, 1, "-zsh", 100),
        row(901, 900, "/opt/codex/native/codex", 100),
        row(902, 901, "npm exec @playwright/mcp", 100),
      ];
      const capture = await capturePaneAgentProcesses(pane());
      expect(capture).toEqual({
        status: "ok",
        processes: [
          { pid: 901, identity: "s901" },
          { pid: 902, identity: "s902" },
        ],
      });
    });

    it("T2 ignores a matching process from another session that is not a pane descendant", async () => {
      identities = new Map([
        [100, "s100"],
        [50, "s50"],
      ]);
      fakeTable = [row(100, 1, "-zsh", 100), row(51, 1, "codex", 50), row(52, 1, "codex")];
      expect(await capturedPids(pane())).toEqual([]);
    });

    it("T3 never captures the daemon pid or the pane leader", async () => {
      identities = new Map([
        [100, "s100"],
        [process.pid, "daemon"],
      ]);
      fakeTable = [row(100, 1, "-zsh", 100), row(process.pid, 1, "node spur", 100)];
      expect(await capturedPids(pane())).toEqual([]);
    });

    it("T4 reads nothing for a session with no panes", async () => {
      expect(
        await capturePaneAgentProcesses({
          sessionId: "api-1",
          agentLaunchId: "launch-1",
          panePids: [],
          livePanePids: [],
          processMatchers: ["x"],
        }),
      ).toEqual({ status: "ok", processes: [] });
      expect(listSessionMemberPidsMock).not.toHaveBeenCalled();
      expect(readProcessStatMock).not.toHaveBeenCalled();
    });

    it("T6 terminateAgentProcesses signals the re-parented members", async () => {
      identities = new Map([
        [100, "s100"],
        [901, "s901"],
        [902, "s902"],
      ]);
      fakeTable = [
        row(100, 1, "-zsh", 100),
        row(901, 900, "codex", 100),
        row(902, 901, "npm exec @playwright/mcp", 100),
      ];
      const capture = await capturePaneAgentProcesses(pane());
      if (capture.status !== "ok") throw new Error("unreachable");
      await terminateAgentProcesses(capture.processes, {
        hupGraceMs: 5,
        termGraceMs: 5,
        killGraceMs: 5,
      });
      expect(signalPidMock).toHaveBeenCalledWith(901, "SIGHUP");
      expect(signalPidMock).toHaveBeenCalledWith(902, "SIGHUP");
    });

    it("T7 drops a member whose stat is unreadable", async () => {
      identities = new Map([
        [100, "s100"],
        [902, "s902"],
      ]);
      fakeTable = [
        row(100, 1, "-zsh", 100),
        row(901, 1, "codex-helper", 100),
        row(902, 1, "npm exec @playwright/mcp", 100),
      ];
      expect(await capturedPids(pane())).toEqual([902]);
    });

    it("T8 skips the session pass when the pane pid is not a session leader", async () => {
      identities = new Map([
        [100, "s100"],
        [901, "s901"],
      ]);
      fakeTable = [row(100, 1, "-zsh", 7), row(901, 1, "codex", 100)];
      expect(await capturedPids(pane())).toEqual([]);
      expect(listSessionMemberPidsMock).not.toHaveBeenCalled();
    });

    it("T9 equals the descendant pass when the member listing is empty", async () => {
      identities = new Map([[100, "s100"]]);
      fakeTable = [row(100, 1, "-zsh", 100), row(101, 100, "codex")];
      listSessionMemberPidsMock.mockResolvedValueOnce([]);
      expect(await capturePaneAgentProcesses(pane())).toEqual({
        status: "ok",
        processes: [{ pid: 101, identity: null }],
      });
    });

    it("T10 never runs the session pass for a dead pane even when a live leader holds its pid", async () => {
      identities = new Map([
        [100, "s100"],
        [901, "s901"],
      ]);
      fakeTable = [row(100, 1, "-zsh", 100), row(901, 1, "other-session-member", 100)];
      expect(await capturedPids(pane(true))).toEqual([]);
      expect(listSessionMemberPidsMock).not.toHaveBeenCalled();
    });

    it("T11 runs the session pass for every live pane, skipping a dead one", async () => {
      identities = new Map([
        [100, "s100"],
        [200, "s200"],
        [901, "s901"],
        [902, "s902"],
      ]);
      fakeTable = [
        row(100, 1, "-zsh", 100),
        row(901, 1, "native-mcp-helper", 100),
        row(200, 1, "-zsh", 200),
        row(902, 1, "native-mcp-helper", 200),
      ];
      expect(await capturedPids({ ...pane(), panePids: [100, 200], livePanePids: [200] })).toEqual([
        902,
      ]);
      expect(listSessionMemberPidsMock).toHaveBeenCalledExactlyOnceWith(200);
    });

    const captureAndTerminate = async (input = pane()): Promise<number[]> => {
      const capture = await capturePaneAgentProcesses(input);
      if (capture.status !== "ok") throw new Error("expected readable capture");
      await terminateAgentProcesses(capture.processes, {
        hupGraceMs: 0,
        termGraceMs: 0,
        killGraceMs: 0,
      });
      return capture.processes.map((ref) => ref.pid);
    };

    const ownedOrphan = (): FakeProc => {
      identities = new Map([
        [100, "recycled-leader"],
        [901, "helper-generation"],
      ]);
      const helper = row(901, 1, "native-mcp-helper", 100);
      fakeTable = [row(100, 1, "-zsh", 100), helper];
      return helper;
    };

    it("retains an owned helper when its leader exits during enumeration", async () => {
      ownedOrphan();
      listSessionMemberPidsMock.mockImplementationOnce(async () => {
        identities.delete(100);
        fakeTable = fakeTable.filter((proc) => proc.pid !== 100);
        return [901];
      });
      expect(await captureAndTerminate()).toEqual([901]);
      expect(signalPidMock).toHaveBeenCalledExactlyOnceWith(901, "SIGHUP");
    });

    it("does not add duplicate SID refs or reread matched descendants", async () => {
      ownedOrphan();
      fakeTable.push({ ...row(101, 100, "codex", 100), env: {} });
      identities.set(101, "baseline");
      listSessionMemberPidsMock.mockResolvedValueOnce([100, 101, 901, 901, process.pid]);
      expect(await captureAndTerminate()).toEqual([101, 901]);
      expect(readProcessEnvValueMock.mock.calls).toEqual([
        [901, "SPUR_SESSION"],
        [901, "SPUR_AGENT_LAUNCH_ID"],
      ]);
      expect(signalPidMock.mock.calls).toEqual([
        [901, "SIGHUP"],
        [101, "SIGHUP"],
      ]);
    });

    it.each([
      ["foreign session", "SPUR_SESSION", "peer"],
      ["overridden session", "SPUR_SESSION", "configured-override"],
      ["new launch", "SPUR_AGENT_LAUNCH_ID", "launch-2"],
      ["absent session", "SPUR_SESSION", undefined],
      ["absent launch", "SPUR_AGENT_LAUNCH_ID", undefined],
    ])(
      "rejects a recycled leader's member with %s through termination",
      async (_label, key, value) => {
        const helper = ownedOrphan();
        if (value === undefined) delete helper.env?.[key];
        else if (helper.env) helper.env[key] = value;
        // Baseline matched descendants remain eligible without markers.
        fakeTable.push({ ...row(101, 100, "codex", 100), env: {} });
        identities.set(101, "baseline");
        expect(await captureAndTerminate()).toEqual([101]);
        expect(signalPidMock).toHaveBeenCalledExactlyOnceWith(101, "SIGHUP");
        expect(signalPidMock).not.toHaveBeenCalledWith(901, expect.anything());
      },
    );

    it.each(["SPUR_SESSION", "SPUR_AGENT_LAUNCH_ID"])(
      "rejects an unreadable %s through termination",
      async (unreadableKey) => {
        ownedOrphan();
        const readMarker = async (_pid: number, key: string) =>
          key === unreadableKey
            ? ({ status: "unreadable" } as const)
            : ({ status: "ok", value: key === "SPUR_SESSION" ? "api-1" : "launch-1" } as const);
        readProcessEnvValueMock
          .mockImplementationOnce(readMarker)
          .mockImplementationOnce(readMarker);
        expect(await captureAndTerminate()).toEqual([]);
        expect(signalPidMock).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, ""])(
      "keeps baseline capture without expected launch token %s",
      async (agentLaunchId) => {
        ownedOrphan();
        fakeTable.push(row(101, 100, "codex", 100));
        expect(await captureAndTerminate({ ...pane(), agentLaunchId })).toEqual([101]);
        expect(readProcessEnvValueMock).not.toHaveBeenCalled();
        expect(signalPidMock).not.toHaveBeenCalledWith(901, expect.anything());
      },
    );

    it.each([
      ["SPUR_SESSION", "identity"],
      ["SPUR_AGENT_LAUNCH_ID", "identity"],
      ["SPUR_SESSION", "sid"],
      ["SPUR_AGENT_LAUNCH_ID", "sid"],
      ["SPUR_SESSION", "unreadable stat"],
      ["SPUR_AGENT_LAUNCH_ID", "unreadable stat"],
    ])("rejects %s read changing %s before signaling", async (mutationKey, mutation) => {
      const helper = ownedOrphan();
      const readMarker = async (_pid: number, key: string) => {
        if (key === mutationKey) {
          if (mutation === "identity") identities.set(901, "replacement");
          else if (mutation === "sid") helper.sid = 200;
          else identities.delete(901);
        }
        return { status: "ok", value: helper.env?.[key] } as const;
      };
      readProcessEnvValueMock.mockImplementationOnce(readMarker).mockImplementationOnce(readMarker);
      expect(await captureAndTerminate()).toEqual([]);
      expect(signalPidMock).not.toHaveBeenCalled();
    });

    it("drops an attested helper whose generation changes after capture", async () => {
      ownedOrphan();
      const capture = await capturePaneAgentProcesses(pane());
      expect(capture).toEqual({
        status: "ok",
        processes: [{ pid: 901, identity: "helper-generation" }],
      });
      if (capture.status !== "ok") throw new Error("expected readable capture");
      identities.set(901, "replacement");
      expect(await terminateAgentProcesses(capture.processes)).toEqual({ status: "clear" });
      expect(signalPidMock).not.toHaveBeenCalled();
    });
  });
});

describe("terminateAgentProcesses", () => {
  it("returns clear when nothing is alive", async () => {
    deadPids.add(5);
    const outcome = await terminateAgentProcesses([{ pid: 5, identity: null }]);
    expect(outcome).toEqual({ status: "clear" });
  });

  it("stops escalating as soon as SIGHUP clears the pid", async () => {
    const outcome = await terminateAgentProcesses([{ pid: 7, identity: null }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(signalPidMock).toHaveBeenCalledWith(7, "SIGHUP");
    expect(signalPidMock).not.toHaveBeenCalledWith(7, "SIGTERM");
    expect(outcome.status).toBe("clear");
  });

  it("reports survivors when the pid never dies", async () => {
    forceAllAlive = true;
    const outcome = await terminateAgentProcesses([{ pid: 9, identity: null }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(outcome).toEqual({ status: "survivors", pids: [9] });
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGHUP");
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGTERM");
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGKILL");
  });

  it("treats an unavailable liveness snapshot as still alive, not clear — the fail-safe this guard depends on", async () => {
    // If a snapshot failure (fork pressure: EAGAIN/EMFILE) ever collapsed
    // into "found nobody, so everyone is dead", a live agent would read as
    // a clean "clear" and a failOnSurvivors:true caller would launch a real
    // duplicate over it — exactly the bug this whole guard exists to close.
    snapshotUnavailable = true;
    const outcome = await terminateAgentProcesses([{ pid: 99, identity: null }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(outcome).toEqual({ status: "survivors", pids: [99] });
  });

  it("never signals a pid whose identity changed after capture, and never counts it a survivor", async () => {
    // The pane is killed before escalation starts, so a captured pid can be
    // recycled inside the ~6s signal window. Signalling it would hit an
    // unrelated process; counting it a survivor would block the relaunch
    // forever on a process that is not ours.
    forceAllAlive = true;
    identities = new Map([[11, "recycled"]]);
    const outcome = await terminateAgentProcesses([{ pid: 11, identity: "original" }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(outcome).toEqual({ status: "clear" });
    expect(signalPidMock).not.toHaveBeenCalled();
  });

  it("still signals a pid whose identity is unchanged", async () => {
    forceAllAlive = true;
    identities = new Map([[12, "same"]]);
    const outcome = await terminateAgentProcesses([{ pid: 12, identity: "same" }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(outcome).toEqual({ status: "survivors", pids: [12] });
    expect(signalPidMock).toHaveBeenCalledWith(12, "SIGKILL");
  });

  it("treats a null captured identity as unverifiable and keeps escalating — the no-procfs degrade path", async () => {
    forceAllAlive = true;
    identities = new Map();
    const outcome = await terminateAgentProcesses([{ pid: 13, identity: null }], {
      hupGraceMs: 5,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    expect(outcome).toEqual({ status: "survivors", pids: [13] });
    expect(signalPidMock).toHaveBeenCalledWith(13, "SIGKILL");
  });
});

describe("captureAgentProcessesForLaunch", () => {
  it("captures only the exact session launch and preserves pid identity", async () => {
    identities.set(30, "start-30");
    fakeTable = [
      {
        pid: 30,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1", SPUR_AGENT_LAUNCH_ID: "launch-a" },
      },
      {
        pid: 31,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1", SPUR_AGENT_LAUNCH_ID: "launch-b" },
      },
      {
        pid: 32,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "other-1", SPUR_AGENT_LAUNCH_ID: "launch-a" },
      },
    ];

    await expect(
      captureAgentProcessesForLaunch({
        sessionId: "api-1",
        agentLaunchId: "launch-a",
        processMatchers: ["claude"],
      }),
    ).resolves.toEqual({ status: "ok", processes: [{ pid: 30, identity: "start-30" }] });
  });

  it("fails closed when the process table is unavailable", async () => {
    processSnapshotUnavailable = true;

    await expect(
      captureAgentProcessesForLaunch({
        sessionId: "api-1",
        agentLaunchId: "launch-a",
        processMatchers: ["claude"],
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});

describe("findForeignAgentProcessesForSession", () => {
  it("is unavailable when the process environment cannot be read", async () => {
    envReadable = false;
    const scan = await findForeignAgentProcessesForSession({
      sessionId: "api-1",
      processMatchers: ["claude"],
      excludePanePids: [],
    });
    expect(scan).toEqual({ status: "unavailable" });
  });

  it("excludes the calling pane's own descendants", async () => {
    fakeTable = [
      {
        pid: 1,
        ppid: 0,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
      {
        pid: 2,
        ppid: 999,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const scan = await findForeignAgentProcessesForSession({
      sessionId: "api-1",
      processMatchers: ["claude"],
      excludePanePids: [1],
    });
    expect(scan).toEqual({ status: "ok", pids: [2] });
  });

  it("excludes descendants of every pane of the session", async () => {
    const row = (pid: number, ppid: number) => ({
      pid,
      ppid,
      rssKb: 1,
      elapsedSeconds: 1,
      args: "claude",
      env: { SPUR_SESSION: "api-1" },
    });
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      row(2, 1),
      { pid: 10, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      row(11, 10),
      row(20, 999),
    ];
    const scan = await findForeignAgentProcessesForSession({
      sessionId: "api-1",
      processMatchers: ["claude"],
      excludePanePids: [1, 10],
    });
    expect(scan).toEqual({ status: "ok", pids: [20] });
  });

  it("resolves a ppid cycle between two candidates to exactly one survivor, never zero", async () => {
    // A genuine OS ppid chain cannot cycle, but the collapse step must stay
    // bounded against a synthetic/adversarial table anyway: two candidates
    // whose ppid fields point at each other would otherwise each "cover"
    // the other and both get filtered out, silently reporting no live
    // process at all instead of refusing the launch over a real one.
    fakeTable = [
      {
        pid: 30,
        ppid: 31,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
      {
        pid: 31,
        ppid: 30,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const scan = await findForeignAgentProcessesForSession({
      sessionId: "api-1",
      processMatchers: ["claude"],
      excludePanePids: [],
    });
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.pids).toHaveLength(1);
  });
});

describe("scanUnownedAgentProcesses / checkAgentProcessOwnership", () => {
  it("collapses a nested agent onto its outer ancestor — not a duplicate", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    fakeTable = [
      {
        pid: 10,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
      // Nested claude launched by the outer one (e.g. via the Bash tool).
      {
        pid: 11,
        ppid: 10,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan).toEqual({ status: "ok", processes: [] });
  });

  it("collapses cursor's bare 'agent' process descending from the session's agent — not a duplicate", async () => {
    listSessionsMock.mockReturnValue([
      session({ id: "cursor-1", status: "running", agent: "cursor" }),
    ]);
    fakeTable = [
      {
        pid: 20,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "cursor-agent",
        env: { SPUR_SESSION: "cursor-1" },
      },
      {
        pid: 21,
        ppid: 20,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "/opt/foo/agent",
        env: { SPUR_SESSION: "cursor-1" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan).toEqual({ status: "ok", processes: [] });
  });

  it("flags two unrelated processes carrying the same session id as duplicate_for_session", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    fakeTable = [
      {
        pid: 30,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
      {
        pid: 31,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes.map((proc) => proc.reason)).toEqual([
      "duplicate_for_session",
      "duplicate_for_session",
    ]);
    expect(scan.processes.map((proc) => proc.pid).sort()).toEqual([30, 31]);
  });

  it("does not flag two sessions sharing a worktree — different session ids never trigger", async () => {
    listSessionsMock.mockReturnValue([
      session({ id: "desk-a", status: "running", worktreePath: "/tmp/spur-worktrees/api/desk-a" }),
      session({
        id: "desk-b",
        status: "running",
        worktreePath: "/tmp/spur-worktrees/api/desk-a",
        workspaceId: "desk-a",
      }),
    ]);
    fakeTable = [
      {
        pid: 40,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "desk-a" },
      },
      {
        pid: 41,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "desk-b" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan).toEqual({ status: "ok", processes: [] });
  });

  it("flags a live process under a completed record as terminal_record", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "completed" })]);
    fakeTable = [
      {
        pid: 50,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes).toEqual([
      {
        pid: 50,
        rssKb: 1,
        elapsedSeconds: 1,
        sessionId: "api-1",
        agent: "claude",
        worktreePath: "/tmp/spur-worktrees/api/api-1",
        reason: "terminal_record",
      },
    ]);
  });

  it.each(["stopped", "paused", "spawning", "errored"] as const)(
    "does not flag a live process under a %s record",
    async (status) => {
      listSessionsMock.mockReturnValue([session({ id: "api-1", status })]);
      fakeTable = [
        {
          pid: 60,
          ppid: 1,
          rssKb: 1,
          elapsedSeconds: 1,
          args: "claude",
          env: { SPUR_SESSION: "api-1" },
        },
      ];
      const scan = await scanUnownedAgentProcesses("/data");
      expect(scan).toEqual({ status: "ok", processes: [] });
    },
  );

  it("reports 'unavailable' -> checkAgentProcessOwnership 'cannot determine', ok:true, severity info", async () => {
    envReadable = false;
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan).toEqual({ status: "unavailable" });
    const check = await checkAgentProcessOwnership("/data");
    expect(check).toEqual({
      id: "agent-process-ownership",
      ok: true,
      severity: "info",
      detail: "cannot determine agent process ownership on this platform",
    });
  });

  it("includes pid, agent, rss and age in a seeded finding's detail string", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "completed" })]);
    fakeTable = [
      {
        pid: 70,
        ppid: 1,
        rssKb: 204_800,
        elapsedSeconds: 125,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const check = await checkAgentProcessOwnership("/data");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("pid 70");
    expect(check.detail).toContain("agent claude");
    expect(check.detail).toContain("rss 200.0MB");
    expect(check.detail).toContain("age 2m");
  });

  it("unknown_session carries the inferred agent and the mocked cwd as worktreePath", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    cwdByPid = new Map([[80, "/tmp/spur-runtime-abc/v2"]]);
    fakeTable = [
      {
        pid: 80,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "gone-session" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes).toEqual([
      {
        pid: 80,
        rssKb: 1,
        elapsedSeconds: 1,
        sessionId: "gone-session",
        agent: "claude",
        worktreePath: "/tmp/spur-runtime-abc/v2",
        reason: "unknown_session",
      },
    ]);
    expect(readProcessCwdMock).toHaveBeenCalledWith(80);
  });

  it("an unresolvable cwd yields worktreePath '' and stays unknown_session", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    fakeTable = [
      {
        pid: 81,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "gone-session-2" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes).toEqual([
      {
        pid: 81,
        rssKb: 1,
        elapsedSeconds: 1,
        sessionId: "gone-session-2",
        agent: "claude",
        worktreePath: "",
        reason: "unknown_session",
      },
    ]);
  });

  it("an ambiguous matcher (two agents match the same args) yields agent: null", async () => {
    listSessionsMock.mockReturnValue([
      session({ id: "claude-sess", status: "running", agent: "claude" }),
      session({ id: "cursor-sess", status: "running", agent: "cursor" }),
    ]);
    fakeTable = [
      {
        pid: 82,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        // Bare "agent" matches cursor's matcher AND claude's matcher (both
        // resolve to the literal "agent" set below).
        args: "agent",
        env: { SPUR_SESSION: "gone-session-3" },
      },
    ];
    agentProcessMatchersMock.mockImplementationOnce((agent: AgentName) =>
      agent === "cursor" ? ["cursor-agent", "agent"] : ["agent"],
    );
    const scan = await scanUnownedAgentProcesses("/data");
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes[0]?.agent).toBeNull();
    expect(scan.processes[0]?.reason).toBe("unknown_session");
  });

  it("emits foreign_instance when the record-less session id resolves in a foreign dataDir", async () => {
    listSessionsMock.mockImplementation((dir: string) => {
      if (dir === "/data") return [];
      if (dir === "/foreign-data") {
        return [
          session({
            id: "foreign-session",
            status: "running",
            agent: "codex",
            worktreePath: "/tmp/foreign-worktree",
          }),
        ];
      }
      return [];
    });
    fakeTable = [
      {
        pid: 90,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "codex",
        env: { SPUR_SESSION: "foreign-session" },
      },
    ];
    // scanUnownedAgentProcesses needs a non-empty matcherSet of its own —
    // seed it via a dummy own-dataDir session so the codex matcher compiles.
    listSessionsMock.mockImplementationOnce((dir: string) => {
      if (dir === "/data") return [session({ id: "other", status: "running", agent: "codex" })];
      return [];
    });
    const scan = await scanUnownedAgentProcesses("/data", {
      resolveForeignDataDirs: () => ["/foreign-data"],
    });
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes).toEqual([
      {
        pid: 90,
        rssKb: 1,
        elapsedSeconds: 1,
        sessionId: "foreign-session",
        agent: "codex",
        worktreePath: "/tmp/foreign-worktree",
        reason: "foreign_instance",
      },
    ]);
  });

  it("a TERMINAL foreign record (completed/killed) stays unknown_session at warn, never foreign_instance", async () => {
    listSessionsMock.mockImplementationOnce((dir: string) => {
      if (dir === "/data") return [session({ id: "other", status: "running", agent: "codex" })];
      return [];
    });
    listSessionsMock.mockImplementation((dir: string) => {
      if (dir === "/data") return [];
      if (dir === "/foreign-data") {
        return [
          session({
            id: "foreign-session-terminal",
            status: "completed",
            agent: "codex",
            worktreePath: "/tmp/foreign-worktree",
          }),
        ];
      }
      return [];
    });
    fakeTable = [
      {
        pid: 93,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "codex",
        env: { SPUR_SESSION: "foreign-session-terminal" },
      },
    ];
    const scan = await scanUnownedAgentProcesses("/data", {
      resolveForeignDataDirs: () => ["/foreign-data"],
    });
    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") throw new Error("unreachable");
    expect(scan.processes).toHaveLength(1);
    expect(scan.processes[0]?.reason).toBe("unknown_session");
  });

  it.each([
    ["non-terminal-first", ["/foreign-nonterminal", "/foreign-terminal"]],
    ["terminal-first", ["/foreign-terminal", "/foreign-nonterminal"]],
  ] as const)(
    "a terminal foreign record wins over a non-terminal one for the same sessionId, regardless of iteration order (%s)",
    async (_label, foreignDirOrder) => {
      listSessionsMock.mockImplementationOnce((dir: string) => {
        if (dir === "/data") return [session({ id: "other", status: "running", agent: "codex" })];
        return [];
      });
      listSessionsMock.mockImplementation((dir: string) => {
        if (dir === "/data") return [];
        if (dir === "/foreign-nonterminal") {
          return [
            session({
              id: "foreign-session-collision",
              status: "running",
              agent: "cursor",
              worktreePath: "/tmp/foreign-worktree-nonterminal",
            }),
          ];
        }
        if (dir === "/foreign-terminal") {
          return [
            session({
              id: "foreign-session-collision",
              status: "killed",
              agent: "codex",
              worktreePath: "/tmp/foreign-worktree-terminal",
            }),
          ];
        }
        return [];
      });
      fakeTable = [
        {
          pid: 96,
          ppid: 1,
          rssKb: 1,
          elapsedSeconds: 1,
          args: "codex",
          env: { SPUR_SESSION: "foreign-session-collision" },
        },
      ];
      const scan = await scanUnownedAgentProcesses("/data", {
        resolveForeignDataDirs: () => foreignDirOrder,
      });
      expect(scan.status).toBe("ok");
      if (scan.status !== "ok") throw new Error("unreachable");
      expect(scan.processes).toHaveLength(1);
      expect(scan.processes[0]?.reason).toBe("unknown_session");
    },
  );

  it("a foreign-only scan renders ok:true, severity:info via checkAgentProcessOwnership", async () => {
    resolveRegisteredDataDirsResult = ["/foreign-data"];
    listSessionsMock.mockImplementation((dir: string) => {
      if (dir === "/data") return [session({ id: "other", status: "running", agent: "codex" })];
      if (dir === "/foreign-data") {
        return [
          session({
            id: "foreign-session",
            status: "running",
            agent: "codex",
            worktreePath: "/tmp/foreign-worktree",
          }),
        ];
      }
      return [];
    });
    fakeTable = [
      {
        pid: 91,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "codex",
        env: { SPUR_SESSION: "foreign-session" },
      },
    ];
    const check = await checkAgentProcessOwnership("/data");
    expect(check).toEqual({
      id: "agent-process-ownership",
      ok: true,
      severity: "info",
      detail: "1 live agent process(es) belong to another registered instance (foreign_instance)",
    });
  });

  it("falls back to unknown_session at warn when the foreign dataDir cannot resolve the session id", async () => {
    resolveRegisteredDataDirsResult = ["/foreign-data"];
    listSessionsMock.mockImplementation((dir: string) => {
      if (dir === "/data") return [session({ id: "other", status: "running", agent: "codex" })];
      if (dir === "/foreign-data") return [];
      return [];
    });
    fakeTable = [
      {
        pid: 92,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "codex",
        env: { SPUR_SESSION: "unresolvable-session" },
      },
    ];
    const check = await checkAgentProcessOwnership("/data");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.detail).toContain("unresolvable-session");
    expect(check.detail).toContain("unknown_session");
  });

  it("never resolves foreign dataDirs when every process is record-owned (lazy gate)", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    fakeTable = [
      {
        pid: 94,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "api-1" },
      },
    ];
    const check = await checkAgentProcessOwnership("/data");
    expect(check.ok).toBe(true);
    expect(resolveRegisteredDataDirsMock).toHaveBeenCalledTimes(0);
  });

  it("resolves foreign dataDirs at most once when a record-less process exists", async () => {
    listSessionsMock.mockReturnValue([session({ id: "api-1", status: "running" })]);
    fakeTable = [
      {
        pid: 95,
        ppid: 1,
        rssKb: 1,
        elapsedSeconds: 1,
        args: "claude",
        env: { SPUR_SESSION: "gone-session-lazy" },
      },
    ];
    const check = await checkAgentProcessOwnership("/data");
    expect(check.ok).toBe(false);
    expect(resolveRegisteredDataDirsMock.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
