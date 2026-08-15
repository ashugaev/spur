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
    canReadProcessEnv: canReadProcessEnvMock,
    snapshotProcessLiveness: snapshotProcessLivenessMock,
    signalPid: signalPidMock,
  };
});

const listSessionsMock = vi.fn<() => SessionRecord[]>(() => []);
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

const {
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
  listProcessesMock.mockClear();
  snapshotProcessesMock.mockClear();
  readProcessIdentityMock.mockClear();
  readProcessEnvValueMock.mockClear();
  canReadProcessEnvMock.mockClear();
  snapshotProcessLivenessMock.mockClear();
  signalPidMock.mockClear();
  listSessionsMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("capturePaneAgentProcesses", () => {
  it("returns an empty capture when panePid is null", async () => {
    expect(await capturePaneAgentProcesses({ panePid: null, processMatchers: ["claude"] })).toEqual(
      {
        status: "ok",
        processes: [],
      },
    );
  });

  it("reports unavailable when the process table cannot be read, never an empty capture", async () => {
    // An empty capture would make terminateAgentProcesses report "clear",
    // letting a failOnSurvivors:true caller relaunch over a possibly-live
    // agent — the duplicate this module exists to prevent. The capture must
    // stay distinguishable from "the pane had no agent processes".
    processSnapshotUnavailable = true;
    expect(await capturePaneAgentProcesses({ panePid: 1, processMatchers: ["claude"] })).toEqual({
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
    const capture = await capturePaneAgentProcesses({ panePid: 1, processMatchers: ["claude"] });
    expect(snapshotProcessesMock).toHaveBeenCalledTimes(2);
    expect(capture).toEqual({ status: "ok", processes: [{ pid: 2, identity: null }] });
  });

  it("records each captured pid's identity so a recycled pid can be told apart later", async () => {
    identities = new Map([[2, "starttime-2"]]);
    fakeTable = [
      { pid: 1, ppid: 0, rssKb: 1, elapsedSeconds: 1, args: "-zsh" },
      { pid: 2, ppid: 1, rssKb: 1, elapsedSeconds: 1, args: "/usr/bin/claude" },
    ];
    const capture = await capturePaneAgentProcesses({ panePid: 1, processMatchers: ["claude"] });
    expect(capture).toEqual({ status: "ok", processes: [{ pid: 2, identity: "starttime-2" }] });
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
    const capture = await capturePaneAgentProcesses({ panePid: 1, processMatchers: ["claude"] });
    expect(capture.status).toBe("ok");
    if (capture.status !== "ok") throw new Error("unreachable");
    expect(capture.processes.map((ref) => ref.pid)).toEqual([2]);
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

describe("findForeignAgentProcessesForSession", () => {
  it("is unavailable when the process environment cannot be read", async () => {
    envReadable = false;
    const scan = await findForeignAgentProcessesForSession({
      sessionId: "api-1",
      processMatchers: ["claude"],
      excludePanePid: null,
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
      excludePanePid: 1,
    });
    expect(scan).toEqual({ status: "ok", pids: [2] });
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
      excludePanePid: null,
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
});
