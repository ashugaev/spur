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

// A fleet-wide `list-panes -a` row per session: window_active pane_active
// pane_dead pane_pid pane_tty — all alive, all panes usable.
function fleetPaneLine(name: string, index: number): string {
  return `${name} 1 1 0 ${1000 + index} /dev/pts/${index}`;
}

function installFleetTmuxMock(): void {
  execFileAsyncMock.mockImplementation(async (file, args) => {
    if (file === "tmux" && args.includes("list-sessions")) {
      // "#{session_name} #{session_activity}" — one line per session.
      const lines = sessionNames.map((name) => `${name} 1700000000`);
      return { stdout: lines.join("\n"), stderr: "" };
    }
    if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
      const lines = sessionNames.map((name, index) => fleetPaneLine(name, index));
      return { stdout: lines.join("\n"), stderr: "" };
    }
    if (file === "ps") {
      const psLines = sessionNames.map((_, i) => `${1000 + i} pts/${i} node agent`);
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

  it("bounds a fleet-wide dashboard tick to a small constant fork count, not O(N)", async () => {
    installFleetTmuxMock();

    await Promise.all(sessionNames.map((name) => simulateReadRuntimeSnapshot(name)));

    const listSessionsCalls = callsFor(
      (file, args) => file === "tmux" && args.includes("list-sessions"),
    );
    const listPanesCalls = callsFor(
      (file, args) => file === "tmux" && args.includes("list-panes") && args.includes("-a"),
    );
    const psCalls = callsFor((file) => file === "ps");
    const totalCalls = execFileAsyncMock.mock.calls.length;

    // Fleet existence+activity, fleet pane state, and the process table each
    // cost exactly one fork regardless of fleet size — the fork-storm fix's
    // core invariant. A cold tick over 50 sessions must stay a small
    // constant (list-sessions + list-panes -a + ps), NOT the old 3N+2 (still
    // one list-panes/pane-dead/activity fork per session) or the original 5N.
    expect(listSessionsCalls).toBe(1);
    expect(listPanesCalls).toBe(1);
    expect(psCalls).toBe(1);
    expect(totalCalls).toBeLessThanOrEqual(5);
    expect(totalCalls).toBeLessThan(3 * SESSION_COUNT + 2);

    execFileAsyncMock.mockClear();

    // A second tick within the TTL window must reuse every cached probe:
    // zero additional forks of any kind.
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
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        // Now dead, on a different pid/tty, to prove a warm read ignores it.
        return { stdout: `${sessionName} 1 1 1 9999 /dev/pts/9`, stderr: "" };
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

  it("caches capture-pane per (session, lines) so a repeat scan within the TTL forks nothing extra", async () => {
    let captureCalls = 0;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args[0] === "capture-pane") {
        captureCalls += 1;
        return { stdout: "pane text", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { captureTmuxPane } = await import("../../src/runtime-tmux.js");

    // capture-pane can't be batched fleet-wide (no `-a` form returns text per
    // session), so one concurrent capture per session — mirroring a dashboard
    // tick, the attention monitor, or desk-sibling lookups all scanning at
    // once — still costs one fork per session.
    await Promise.all(sessionNames.map((name) => captureTmuxPane(name)));
    expect(captureCalls).toBe(SESSION_COUNT);

    // A second read of the same sessions within the TTL — e.g. the dashboard
    // tick, the attention monitor, and the viewed page's own poll landing in
    // the same ~2s window — must all share the cached capture.
    await Promise.all(sessionNames.map((name) => captureTmuxPane(name)));
    expect(captureCalls).toBe(SESSION_COUNT);

    // A different tail-length request (e.g. the attention notice's 15-line
    // tail vs classify's default 200) is cached independently, not conflated
    // with the default-length cache entry.
    const firstSession = sessionNames[0];
    if (firstSession === undefined) {
      throw new Error("expected at least one session name");
    }
    await captureTmuxPane(firstSession, 15);
    expect(captureCalls).toBe(SESSION_COUNT + 1);
  });

  it("prunes expired capture-pane cache entries instead of accumulating them forever", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      execFileAsyncMock.mockImplementation(async (file, args) => {
        if (file === "tmux" && args[0] === "capture-pane") {
          return { stdout: "pane text", stderr: "" };
        }
        throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
      });

      const { captureTmuxPane, _capturePaneCacheSizeForTests } =
        await import("../../src/runtime-tmux.js");

      // A fleet-wide capture burst leaves one resident entry per session.
      await Promise.all(sessionNames.map((name) => captureTmuxPane(name)));
      expect(_capturePaneCacheSizeForTests()).toBe(SESSION_COUNT);

      // Advance well past the ~2s TTL, then probe a single session. On a
      // long-running daemon, every session ever captured would otherwise
      // stay resident forever; the sweep inside memoizedProbe must prune all
      // expired entries so the cache shrinks to just the one fresh entry.
      vi.setSystemTime(10_000);
      const firstSession = sessionNames[0];
      if (firstSession === undefined) {
        throw new Error("expected at least one session name");
      }
      await captureTmuxPane(firstSession);
      expect(_capturePaneCacheSizeForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks the active window's active pane from multiple list-panes -a rows for one session", async () => {
    const sessionName = "multi-pane-session";
    // Three panes for the same session: an inactive window's pane (dead),
    // the active window's non-active split pane (alive, different pid/tty),
    // and the active window's active pane (alive) — the one a no-window/
    // no-pane target (`=name:`) actually resolves to.
    const rows = [
      `${sessionName} 0 1 1 111 /dev/pts/50`,
      `${sessionName} 1 0 0 222 /dev/pts/51`,
      `${sessionName} 1 1 0 333 /dev/pts/52`,
    ];
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        return { stdout: rows.join("\n"), stderr: "" };
      }
      if (file === "ps") {
        return { stdout: "222 pts/51 agent-on-split-pane --flag", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { tmuxPaneDead, getTmuxPanePid, isProcessRunningInTmux } =
      await import("../../src/runtime-tmux.js");

    // Active pane (row 3) is alive with pid 333 — not the inactive window's
    // dead pane (row 1) nor the active window's non-active split pane (row 2).
    await expect(tmuxPaneDead(sessionName)).resolves.toBe(false);
    await expect(getTmuxPanePid(sessionName)).resolves.toBe(333);

    // isProcessRunningInTmux must see every pane's tty across the session,
    // including the non-active split pane (row 2's pts/51), not just the
    // active pane's.
    await expect(isProcessRunningInTmux(sessionName, ["agent-on-split-pane"])).resolves.toBe(true);
  });

  it("degrades to an empty fleet (never throws) when no tmux server is running", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-sessions")) {
        const error = new Error("no server running on /tmp/tmux-0/default");
        throw Object.assign(error, { code: 1 });
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
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
