import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as processTreeModule from "../../src/process-tree.js";

// Composes the real session pane lookup with the real P1 capture/terminate and
// the real P2 foreign scan. Only the tmux fork and the process table are fake.
// Session api-1 keeps a dead (remain-on-exit) inactive pane whose pid 100 was
// recycled by an unrelated process carrying the same SPUR_SESSION from another
// launch generation; its own agent lives under the live active pane 200.

interface FakeProc {
  pid: number;
  ppid: number;
  args: string;
  sid: number;
  env: Record<string, string>;
}

const fakeTable: FakeProc[] = [
  { pid: 100, ppid: 1, args: "/usr/bin/claude --resume other", sid: 100, env: {} },
  { pid: 101, ppid: 100, args: "/usr/bin/claude mcp", sid: 100, env: {} },
  // Carries this launch's exact markers in the dead pane's kernel session: the
  // SID pass must still never root at a dead pane.
  { pid: 102, ppid: 1, args: "native-mcp-helper", sid: 100, env: {} },
  { pid: 200, ppid: 1, args: "-zsh", sid: 200, env: {} },
  { pid: 201, ppid: 200, args: "/usr/bin/claude", sid: 200, env: {} },
];
for (const proc of fakeTable) {
  proc.env = {
    SPUR_SESSION: "api-1",
    SPUR_AGENT_LAUNCH_ID: proc.pid >= 200 || proc.pid === 102 ? "launch-1" : "launch-other",
  };
}
let signalled: number[] = [];

const entries = () =>
  fakeTable.map(({ pid, ppid, args }) => ({ pid, ppid, rssKb: 1, elapsedSeconds: 1, args }));
vi.mock("../../src/process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof processTreeModule>()),
  listProcesses: vi.fn(async () => entries()),
  snapshotProcesses: vi.fn(async () => ({ status: "ok" as const, processes: entries() })),
  readProcessIdentity: vi.fn(async (pid: number) => `start-${pid}`),
  readProcessStat: vi.fn(async (pid: number) => {
    const proc = fakeTable.find((entry) => entry.pid === pid);
    return proc ? { sid: proc.sid, identity: `start-${pid}` } : null;
  }),
  listSessionMemberPids: vi.fn(async (sid: number) =>
    fakeTable.filter((proc) => proc.sid === sid).map((proc) => proc.pid),
  ),
  readProcessCwd: vi.fn(async () => null),
  canReadProcessEnv: vi.fn(async () => true),
  readProcessEnvValue: vi.fn(async (pid: number, key: string) => ({
    status: "ok" as const,
    value: fakeTable.find((proc) => proc.pid === pid)?.env[key],
  })),
  snapshotProcessLiveness: vi.fn(async () => ({
    status: "ok" as const,
    alivePids: { has: (pid: number) => !signalled.includes(pid) } as ReadonlySet<number>,
  })),
  signalPid: vi.fn((pid: number) => {
    signalled.push(pid);
  }),
}));

const execFileAsyncMock = vi.fn(async (_file: string, args: string[]) =>
  args.includes("list-panes")
    ? { stdout: "api-1 0 0 1 100 /dev/pts/1\napi-1 1 1 0 200 /dev/pts/2\n", stderr: "" }
    : { stdout: "", stderr: "" },
);
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [promisify.custom]: execFileAsyncMock }),
  spawn: vi.fn(),
}));

const { lookupTmuxSessionPanePids } = await import("../../src/runtime-tmux.js");
const { capturePaneAgentProcesses, findForeignAgentProcessesForSession, terminateAgentProcesses } =
  await import("../../src/agent-processes.js");

async function sessionPanePids(): Promise<readonly number[]> {
  const lookup = await lookupTmuxSessionPanePids("api-1", { fresh: true });
  if (lookup.status !== "ok") throw new Error("tmux lookup unavailable");
  return lookup.panePids;
}

describe("dead pane with a recycled pid", () => {
  beforeEach(() => {
    signalled = [];
  });

  it("P1 captures and signals only the live pane's agent, never the reused root, its matching child, or a marked member of the dead pane's kernel session", async () => {
    const capture = await capturePaneAgentProcesses({
      sessionId: "api-1",
      agentLaunchId: "launch-1",
      panePids: await sessionPanePids(),
      processMatchers: ["claude"],
    });
    if (capture.status !== "ok") throw new Error("expected readable capture");
    expect(capture.processes.map((ref) => ref.pid)).toEqual([201]);

    await terminateAgentProcesses(capture.processes, {
      hupGraceMs: 0,
      termGraceMs: 0,
      killGraceMs: 0,
    });
    expect(signalled).toEqual([201]);
  });

  it("P2 still reports the same-session process under the reused root as foreign", async () => {
    expect(
      await findForeignAgentProcessesForSession({
        sessionId: "api-1",
        processMatchers: ["claude"],
        excludePanePids: await sessionPanePids(),
      }),
    ).toEqual({ status: "ok", pids: [100] });
  });
});
