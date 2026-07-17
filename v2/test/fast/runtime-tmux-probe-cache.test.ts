import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileAsync = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsyncMock = vi.fn<ExecFileAsync>();
const execFileMock: ((...args: unknown[]) => void) & {
  [promisify.custom]: typeof execFileAsyncMock;
} = Object.assign(vi.fn(), {
  [promisify.custom]: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const SESSION_COUNT = 50;
const sessionNames = Array.from({ length: SESSION_COUNT }, (_, i) => `api-${i}`);

// Mirrors readRuntimeSnapshot's per-session probe order in session-service.ts,
// isolated from SessionService so it exercises the real runtime-tmux.ts
// caches (session-service.test.ts mocks the whole module, so it never
// exercises this cache layer).
async function simulateReadRuntimeSnapshot(sessionName: string): Promise<{
  runtimeAlive: boolean;
  paneUsable: boolean;
  processAlive: boolean;
}> {
  const { tmuxSessionExists, tmuxPaneDead, isProcessRunningInTmux } =
    await import("../../src/runtime-tmux.js");
  const runtimeAlive = await tmuxSessionExists(sessionName);
  const paneUsable = runtimeAlive ? !(await tmuxPaneDead(sessionName)) : false;
  const processAlive =
    runtimeAlive && paneUsable ? await isProcessRunningInTmux(sessionName, ["node"]) : false;
  return { runtimeAlive, paneUsable, processAlive };
}

function callsFor(matcher: (file: string, args: string[]) => boolean): number {
  return execFileAsyncMock.mock.calls.filter(([file, args]) => matcher(file, args)).length;
}

function installFleetTmuxMock(): void {
  execFileAsyncMock.mockImplementation(async (file, args) => {
    if (file === "tmux" && args.includes("list-sessions")) {
      return { stdout: sessionNames.join("\n"), stderr: "" };
    }
    if (file === "tmux" && args.includes("list-panes")) {
      const target = args[args.indexOf("-t") + 1] ?? "";
      const sessionName = target.replace(/^=/, "").replace(/:$/, "");
      return { stdout: `/dev/pts/${sessionNames.indexOf(sessionName)}`, stderr: "" };
    }
    if (file === "tmux" && args.includes("display-message") && args.includes("#{pane_dead}")) {
      return { stdout: "0", stderr: "" };
    }
    if (
      file === "tmux" &&
      args.includes("display-message") &&
      args.includes("#{session_activity}")
    ) {
      return { stdout: "1700000000", stderr: "" };
    }
    if (file === "ps") {
      const psLines = sessionNames.map((_, i) => `1${i} pts/${i} node agent`);
      return { stdout: psLines.join("\n"), stderr: "" };
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });
}

describe("runtime-tmux shared probe cache", () => {
  afterEach(() => {
    execFileAsyncMock.mockReset();
    vi.resetModules();
  });

  it("bounds a fleet-wide dashboard tick to O(1) list-sessions/ps forks, not O(N)", async () => {
    installFleetTmuxMock();

    await Promise.all(sessionNames.map((name) => simulateReadRuntimeSnapshot(name)));

    const listSessionsCalls = callsFor(
      (file, args) => file === "tmux" && args.includes("list-sessions"),
    );
    const psCalls = callsFor((file) => file === "ps");
    const totalCalls = execFileAsyncMock.mock.calls.length;

    // Fleet existence and the process table each cost exactly one fork
    // regardless of fleet size — the fork-storm fix's core invariant.
    expect(listSessionsCalls).toBe(1);
    expect(psCalls).toBe(1);
    // Per-session capture (list-panes tty lookup + pane-dead + activity)
    // still costs up to 3 forks per session on a cold tick, but the two
    // bulk-shared probes (has-session, ps) that used to run once per
    // session are now O(1): total forks must stay well under the old 5N.
    expect(totalCalls).toBeLessThan(5 * SESSION_COUNT);
    expect(totalCalls).toBeLessThanOrEqual(3 * SESSION_COUNT + 2);

    execFileAsyncMock.mockClear();

    // A second tick within the TTL window must reuse every cached probe:
    // zero additional forks of any kind, including the per-session ones.
    await Promise.all(sessionNames.map((name) => simulateReadRuntimeSnapshot(name)));
    expect(execFileAsyncMock.mock.calls).toHaveLength(0);
  });

  it("keeps a cached probe result identical to what a live probe returned in the same TTL window", async () => {
    installFleetTmuxMock();
    const { tmuxSessionExists, tmuxPaneDead, getTmuxSessionActivity, isProcessRunningInTmux } =
      await import("../../src/runtime-tmux.js");

    const sessionName = "api-3";
    const coldRuntimeAlive = await tmuxSessionExists(sessionName);
    const coldPaneDead = await tmuxPaneDead(sessionName);
    const coldActivity = await getTmuxSessionActivity(sessionName);
    const coldProcessAlive = await isProcessRunningInTmux(sessionName, ["node"]);

    // Change what a *fresh* probe would return — a warm read must ignore
    // this and keep serving the frozen cold-probe result within the TTL.
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-sessions")) {
        return { stdout: "", stderr: "" };
      }
      if (file === "tmux" && args.includes("display-message") && args.includes("#{pane_dead}")) {
        return { stdout: "1", stderr: "" };
      }
      if (
        file === "tmux" &&
        args.includes("display-message") &&
        args.includes("#{session_activity}")
      ) {
        return { stdout: "1", stderr: "" };
      }
      if (file === "ps") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const warmRuntimeAlive = await tmuxSessionExists(sessionName);
    const warmPaneDead = await tmuxPaneDead(sessionName);
    const warmActivity = await getTmuxSessionActivity(sessionName);
    const warmProcessAlive = await isProcessRunningInTmux(sessionName, ["node"]);

    expect(warmRuntimeAlive).toBe(coldRuntimeAlive);
    expect(warmPaneDead).toBe(coldPaneDead);
    expect(warmActivity).toEqual(coldActivity);
    expect(warmProcessAlive).toBe(coldProcessAlive);
  });

  it("degrades to an empty fleet (never throws) when no tmux server is running", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-sessions")) {
        const error = new Error("no server running on /tmp/tmux-0/default");
        throw Object.assign(error, { code: 1 });
      }
      if (file === "ps") {
        throw new Error("ps failed");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { tmuxSessionExists, isProcessRunningInTmux, listTmuxSessionNames } =
      await import("../../src/runtime-tmux.js");

    await expect(listTmuxSessionNames()).resolves.toEqual(new Set());
    await expect(tmuxSessionExists("api-1")).resolves.toBe(false);
    await expect(isProcessRunningInTmux("api-1", ["node"])).resolves.toBe(false);
  });
});
