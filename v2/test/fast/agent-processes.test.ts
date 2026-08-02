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

const listProcessesMock = vi.fn(async () =>
  fakeTable.map(({ pid, ppid, rssKb, elapsedSeconds, args }) => ({
    pid,
    ppid,
    rssKb,
    elapsedSeconds,
    args,
  })),
);
const readProcessEnvValueMock = vi.fn(async (pid: number, key: string) => {
  if (!envReadable) return { status: "unreadable" as const };
  const proc = fakeTable.find((entry) => entry.pid === pid);
  if (!proc) return { status: "unreadable" as const };
  return { status: "ok" as const, value: proc.env?.[key] };
});
const canReadProcessEnvMock = vi.fn(async () => envReadable);
const isPidAliveMock = vi.fn((pid: number) => !deadPids.has(pid));
const signalPidMock = vi.fn((pid: number) => {
  deadPids.add(pid);
});

vi.mock("../../src/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof processTreeModule>();
  return {
    ...actual,
    listProcesses: listProcessesMock,
    readProcessEnvValue: readProcessEnvValueMock,
    canReadProcessEnv: canReadProcessEnvMock,
    isPidAlive: isPidAliveMock,
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
  listProcessesMock.mockClear();
  readProcessEnvValueMock.mockClear();
  canReadProcessEnvMock.mockClear();
  isPidAliveMock.mockClear();
  signalPidMock.mockClear();
  listSessionsMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("capturePaneAgentProcesses", () => {
  it("returns [] when panePid is null", async () => {
    expect(await capturePaneAgentProcesses({ panePid: null, processMatchers: ["claude"] })).toEqual(
      [],
    );
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
    const refs = await capturePaneAgentProcesses({ panePid: 1, processMatchers: ["claude"] });
    expect(refs.map((ref) => ref.pid)).toEqual([2]);
  });
});

describe("terminateAgentProcesses", () => {
  it("returns clear when nothing is alive", async () => {
    deadPids.add(5);
    const outcome = await terminateAgentProcesses([
      { pid: 5, rssKb: 1, elapsedSeconds: 1, args: "x" },
    ]);
    expect(outcome).toEqual({ status: "clear" });
  });

  it("stops escalating as soon as SIGHUP clears the pid", async () => {
    const outcome = await terminateAgentProcesses(
      [{ pid: 7, rssKb: 1, elapsedSeconds: 1, args: "x" }],
      { hupGraceMs: 5, termGraceMs: 5, killGraceMs: 5 },
    );
    expect(signalPidMock).toHaveBeenCalledWith(7, "SIGHUP");
    expect(signalPidMock).not.toHaveBeenCalledWith(7, "SIGTERM");
    expect(outcome.status).toBe("clear");
  });

  it("reports survivors when the pid never dies", async () => {
    isPidAliveMock.mockImplementation(() => true);
    const outcome = await terminateAgentProcesses(
      [{ pid: 9, rssKb: 1, elapsedSeconds: 1, args: "x" }],
      { hupGraceMs: 5, termGraceMs: 5, killGraceMs: 5 },
    );
    expect(outcome).toEqual({ status: "survivors", pids: [9] });
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGHUP");
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGTERM");
    expect(signalPidMock).toHaveBeenCalledWith(9, "SIGKILL");
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
    expect(scan).toEqual({
      status: "ok",
      processes: [{ pid: 2, rssKb: 1, elapsedSeconds: 1, args: "claude" }],
    });
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
