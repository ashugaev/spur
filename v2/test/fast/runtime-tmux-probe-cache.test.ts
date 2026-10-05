import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
    if (file === "tmux" && args.includes("list-windows")) {
      // "#{session_name} #{window_activity}" — one line per window.
      const lines = sessionNames.map((name) => `${name} 1700000000`);
      return { stdout: lines.join("\n"), stderr: "" };
    }
    if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
      const lines = sessionNames.map((name, index) => fleetPaneLine(name, index));
      return { stdout: lines.join("\n"), stderr: "" };
    }
    if (file === "ps") {
      const psLines = sessionNames.map(
        (_, i) => `${1000 + i} 1 ${1000 + i} ${1000 + i} pts/${i} 51200 node agent`,
      );
      return { stdout: psLines.join("\n"), stderr: "" };
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });
}

describe("runtime-tmux shared probe cache", () => {
  // The mocked tmux never runs the pane, so the launcher's env file (a copy of
  // the runner's process.env) is never consumed; keep it in a per-file dir
  // that is removed afterwards.
  const originalTmpdir = process.env["TMPDIR"];
  let testTmpDir = "";

  beforeAll(() => {
    testTmpDir = mkdtempSync(join(tmpdir(), "spur-probe-cache-test-"));
    process.env["TMPDIR"] = testTmpDir;
  });

  afterAll(() => {
    if (originalTmpdir === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = originalTmpdir;
    rmSync(testTmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    execFileAsyncMock.mockReset();
    vi.resetModules();
  });

  it.each([
    ["list-windows", "api-1"],
    ["list-panes", "api-1 1 1 invalid 100 /dev/pts/1"],
    ["ps", "100 broken 100 100 pts/1 10 node"],
  ])(
    "reports malformed %s output as unknown and observes a fresh recovery",
    async (command, output) => {
      let malformed = true;
      execFileAsyncMock.mockImplementation(async (file, args) => {
        const probe = file === "ps" ? "ps" : args.find((arg) => arg.startsWith("list-"));
        if (malformed && probe === command) return { stdout: output, stderr: "" };
        if (probe === "list-windows") return { stdout: "api-1 1700000000", stderr: "" };
        if (probe === "list-panes") return { stdout: "api-1 1 1 0 100 /dev/pts/1", stderr: "" };
        return {
          stdout: "PID PPID PGID TPGID TT RSS COMMAND\n100 1 100 100 pts/1 10 node",
          stderr: "",
        };
      });
      const { getTmuxSessionPresence, getTmuxPanePresence, probeTmuxProcessMatch } =
        await import("../../src/runtime-tmux.js");
      if (command === "list-windows") {
        expect((await getTmuxSessionPresence("api-1")).diagnostic).toContain("malformed");
        malformed = false;
        expect(await getTmuxSessionPresence("api-1", { fresh: true })).toEqual({
          present: true,
          unresponsive: false,
        });
      } else if (command === "list-panes") {
        expect((await getTmuxPanePresence("api-1")).diagnostic).toContain("malformed");
        malformed = false;
        expect(await getTmuxPanePresence("api-1", { fresh: true })).toEqual({
          dead: false,
          unresponsive: false,
        });
      } else {
        expect((await probeTmuxProcessMatch("api-1", ["node"])).diagnostic).toContain("malformed");
        malformed = false;
        expect(await probeTmuxProcessMatch("api-1", ["node"], { fresh: true })).toEqual({
          alive: true,
          matchedByName: true,
          unresponsive: false,
        });
      }
    },
  );

  it.each([
    new Error("ps access denied"),
    Object.assign(new Error("ps timed out"), { killed: true }),
    Object.assign(new Error("stdout maxBuffer exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    }),
  ])("keeps failed process-table reads unknown: %s", async (error) => {
    execFileAsyncMock.mockImplementation(async (file) => {
      if (file === "ps") throw error;
      return { stdout: "api-1 1 1 0 100 /dev/pts/1", stderr: "" };
    });
    const { probeTmuxProcessMatch, isProcessRunningInTmux } =
      await import("../../src/runtime-tmux.js");
    expect(await probeTmuxProcessMatch("api-1", ["node"])).toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: false,
      diagnostic: `ps failed: ${error.message}`,
    });
    await expect(isProcessRunningInTmux("api-1", ["node"])).rejects.toThrow(error.message);
  });

  it("keeps successful empty fleet and process snapshots known", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { getTmuxSessionPresence, getTmuxPanePresence, probeTmuxProcessMatch } =
      await import("../../src/runtime-tmux.js");
    expect(await getTmuxSessionPresence("api-1")).toEqual({ present: false, unresponsive: false });
    expect(await getTmuxPanePresence("api-1")).toEqual({ dead: true, unresponsive: false });
    expect(await probeTmuxProcessMatch("api-1", ["node"])).toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: false,
    });
  });

  it("bounds a fleet-wide dashboard tick to a small constant fork count, not O(N)", async () => {
    installFleetTmuxMock();

    await Promise.all(sessionNames.map((name) => simulateReadRuntimeSnapshot(name)));

    const listWindowsCalls = callsFor(
      (file, args) => file === "tmux" && args.includes("list-windows"),
    );
    const listPanesCalls = callsFor(
      (file, args) => file === "tmux" && args.includes("list-panes") && args.includes("-a"),
    );
    const psCalls = callsFor((file) => file === "ps");
    const totalCalls = execFileAsyncMock.mock.calls.length;

    // Fleet existence+activity, fleet pane state, and the process table each
    // cost exactly one fork regardless of fleet size — the fork-storm fix's
    // core invariant. A cold tick over 50 sessions must stay a small
    // constant (list-windows -a + list-panes -a + ps), NOT the old 3N+2 (still
    // one list-panes/pane-dead/activity fork per session) or the original 5N.
    expect(listWindowsCalls).toBe(1);
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
      if (file === "tmux" && args.includes("list-windows")) {
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

  it("attributes a sidecar pane's rss to its owning session id, summed with the agent pane, at one ps fork", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        const lines = sessionNames.map((name) => `${name} 1700000000`);
        return { stdout: lines.join("\n"), stderr: "" };
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        const lines = sessionNames.map((name, index) => fleetPaneLine(name, index));
        // sidecarTmuxSession naming (`${sessionId}--${sidecarName}`): a
        // playwright MCP pane owned by api-3, on its own pid/tty.
        lines.push("api-3--playwright 1 1 0 9000 /dev/pts/900");
        return { stdout: lines.join("\n"), stderr: "" };
      }
      if (file === "ps") {
        const psLines = sessionNames.map(
          (_, i) => `${1000 + i} 1 ${1000 + i} ${1000 + i} pts/${i} 51200 node agent`,
        );
        psLines.push("9000 1 9000 9000 pts/900 20480 node playwright-mcp");
        return { stdout: psLines.join("\n"), stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { getFleetSessionRssBytes } = await import("../../src/runtime-tmux.js");

    const results = await Promise.all(
      Array.from({ length: SESSION_COUNT }, () => getFleetSessionRssBytes()),
    );

    expect(callsFor((file) => file === "ps")).toBe(1);
    for (const rssBySessionId of results) {
      expect(rssBySessionId.get("api-3")).toBe((51_200 + 20_480) * 1024);
      expect(rssBySessionId.get("api-0")).toBe(51_200 * 1024);
    }
  });

  it("attributes a terminal workspace anchor's shared sidecar rss once to its live successor", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        return {
          stdout: ["api-1--dev 1 1 0 1001 /dev/pts/1", "api-2 1 1 0 1002 /dev/pts/2"].join("\n"),
          stderr: "",
        };
      }
      if (file === "ps") {
        return {
          stdout: [
            "1001 1 1001 1001 pts/1 20480 node dev",
            "1002 1 1002 1002 pts/2 51200 node agent",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { getFleetSessionRssBytes } = await import("../../src/runtime-tmux.js");
    const rssBySessionId = await getFleetSessionRssBytes(new Map([["api-1", "api-2"]]));

    expect(rssBySessionId.get("api-2")).toBe((20_480 + 51_200) * 1024);
    expect(rssBySessionId.has("api-1")).toBe(false);
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

  it("resolves a rejected capture-pane fork to null, distinct from a genuinely blank pane", async () => {
    let captureCalls = 0;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args[0] === "capture-pane") {
        captureCalls += 1;
        throw new Error("capture-pane failed");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { captureTmuxPane, captureTmuxPaneOrEmpty } = await import("../../src/runtime-tmux.js");

    await expect(captureTmuxPane("api-0")).resolves.toBeNull();
    expect(captureCalls).toBe(1);

    // The rejected fork is evicted (memoizedProbe's evict-on-reject), so a
    // second call within the same TTL window re-forks rather than serving a
    // stale rejection.
    await expect(captureTmuxPane("api-0")).resolves.toBeNull();
    expect(captureCalls).toBe(2);

    // captureTmuxPaneOrEmpty collapses the same rejection into "", never
    // null, for display-only callers.
    await expect(captureTmuxPaneOrEmpty("api-0")).resolves.toBe("");
    expect(captureCalls).toBe(3);
  });

  it("still shares a resolved capture-pane result within the TTL after a prior rejection", async () => {
    let shouldFail = true;
    let captureCalls = 0;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args[0] === "capture-pane") {
        captureCalls += 1;
        if (shouldFail) throw new Error("capture-pane failed");
        return { stdout: "pane text", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { captureTmuxPane } = await import("../../src/runtime-tmux.js");

    await expect(captureTmuxPane("api-1")).resolves.toBeNull();
    expect(captureCalls).toBe(1);

    shouldFail = false;
    await expect(captureTmuxPane("api-1")).resolves.toBe("pane text");
    expect(captureCalls).toBe(2);

    // A second read within the TTL shares the resolved capture — no
    // additional fork, even though the very first read for this session had
    // rejected.
    await expect(captureTmuxPane("api-1")).resolves.toBe("pane text");
    expect(captureCalls).toBe(2);
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
        return { stdout: "222 1 222 222 pts/51 1024 agent-on-split-pane --flag", stderr: "" };
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

  it("reads activity from the pane-output clock, taking the newest window of a multi-window session", async () => {
    const rows = [
      // Two sessions interleaved, each with several windows. The newest window
      // wins per session; a row whose activity field is unparseable must not
      // clobber an already-seen newer value.
      "multi-window 1700000000",
      "other-session 1700000500",
      "multi-window 1700009999",
      "multi-window 1700000042",
      "multi-window not-a-number",
    ];
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: rows.join("\n"), stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { getTmuxSessionActivity, listTmuxSessionNames } =
      await import("../../src/runtime-tmux.js");

    await expect(getTmuxSessionActivity("multi-window")).resolves.toEqual(
      new Date(1700009999 * 1000),
    );

    // `#{session_activity}` is a client-attach clock on tmux 3.4: it jumps to
    // now whenever anything runs `attach-session` (opening the web terminal)
    // and never moves for pane output. Activity must come from
    // `#{window_activity}` instead, so merely opening a session cannot reset
    // its lastActivityAt and a busy detached agent still reports fresh.
    const firstCall = execFileAsyncMock.mock.calls[0];
    expect(firstCall?.[0]).toBe("tmux");
    const probeArgs = (firstCall?.[1] ?? []).join(" ");
    expect(probeArgs).toContain("list-windows");
    expect(probeArgs).toContain("#{window_activity}");
    expect(probeArgs).not.toContain("#{session_activity}");

    await expect(getTmuxSessionActivity("other-session")).resolves.toEqual(
      new Date(1700000500 * 1000),
    );
    await expect(getTmuxSessionActivity("absent-session")).resolves.toBeNull();
    // Every live tmux session has at least one window, so `list-windows -a`
    // still enumerates the fleet for existence checks.
    await expect(listTmuxSessionNames()).resolves.toEqual(
      new Set(["multi-window", "other-session"]),
    );
  });

  it("invalidates the fleet caches after a real tmux create so a just-created session isn't read as stale-absent", async () => {
    let sessionExists = false;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: sessionExists ? "fresh-api-1 1700000000" : "", stderr: "" };
      }
      if (file === "tmux" && args.includes("new-session")) {
        sessionExists = true;
        return { stdout: "", stderr: "" };
      }
      if (file === "tmux") {
        // send-keys/cancel/paste etc. inside sendMessageToTmux — no-ops.
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { tmuxSessionExists, createTmuxSession } = await import("../../src/runtime-tmux.js");

    // Cold read: the session doesn't exist yet — cached for the TTL.
    await expect(tmuxSessionExists("fresh-api-1")).resolves.toBe(false);

    await createTmuxSession({
      sessionName: "fresh-api-1",
      cwd: "/tmp/worktree",
      launchCommand: "claude --dangerously-skip-permissions",
      launchScriptDir: mkdtempSync(join(tmpdir(), "spur-launch-script-test-")),
    });

    // Without invalidation this would still serve the stale cached `false`
    // for up to ~2s after a real create — a just-created session/sidecar
    // reading as absent/"stopped" is exactly the regression real tmux-backed
    // runtime tests hit.
    await expect(tmuxSessionExists("fresh-api-1")).resolves.toBe(true);
  });

  it("invalidates the fleet caches after a real tmux kill so a just-killed session isn't read as stale-alive", async () => {
    let sessionExists = true;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: sessionExists ? "dying-api-1 1700000000" : "", stderr: "" };
      }
      if (file === "tmux" && args.includes("kill-session")) {
        sessionExists = false;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { tmuxSessionExists, killTmuxSession } = await import("../../src/runtime-tmux.js");

    await expect(tmuxSessionExists("dying-api-1")).resolves.toBe(true);
    await killTmuxSession("dying-api-1");
    // Without invalidation this would still serve the stale cached `true`
    // for up to ~2s after a real kill/pause.
    await expect(tmuxSessionExists("dying-api-1")).resolves.toBe(false);
  });

  it("keeps failed fleet probes unknown rather than authorizing absence", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
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
    await expect(tmuxSessionExists("api-1")).rejects.toThrow("tmux list-windows failed");
    await expect(isProcessRunningInTmux("api-1", ["node"])).rejects.toThrow(
      "tmux list-panes failed",
    );
  });

  it.each([
    "no server running on /tmp/test-tmux/socket\n",
    "error connecting to /tmp/test-tmux/socket (No such file or directory)\n",
  ])("recognizes structured absent-server stderr: %s", async (stderr) => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("tmux failed"), {
        code: 1,
        killed: false,
        signal: null,
        stdout: "",
        stderr,
      }),
    );
    const runtime = await import("../../src/runtime-tmux.js");
    expect(await runtime.getTmuxSessionPresence("api-1")).toEqual({
      present: false,
      unresponsive: false,
    });
    expect(await runtime.getTmuxPanePresence("api-1")).toEqual({ dead: true, unresponsive: false });
    expect(await runtime.tmuxSessionExists("api-1")).toBe(false);
    expect(await runtime.tmuxPaneDead("api-1")).toBe(true);
    expect(await runtime.isProcessRunningInTmux("api-1", ["node"])).toBe(false);
    expect(callsFor((file) => file === "ps")).toBe(0);
    execFileAsyncMock.mockImplementation(async (_file, args) => ({
      stdout: args.includes("list-windows") ? "api-1 1700000000" : "api-1 1 1 0 100 /dev/pts/1",
      stderr: "",
    }));
    expect(await runtime.tmuxSessionExists("api-1")).toBe(false);
    expect(await runtime.tmuxSessionExists("api-1", { fresh: true })).toBe(true);
    expect(await runtime.tmuxPaneDead("api-1", { fresh: true })).toBe(false);
  });

  it.each([
    { code: "ENOENT" },
    { code: "EACCES" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { code: 2 },
    { killed: true },
    { signal: "SIGTERM" },
    { stdout: "partial" },
    { stderr: "permission denied" },
    { stderr: "no server running on /tmp/socket\nextra" },
    { stderr: "no server running on /tmp/socket extra text" },
    { stderr: "no server running on " },
    { stderr: undefined },
    { killed: undefined },
    { signal: undefined },
    { stdout: undefined },
  ])("keeps ambiguous absence evidence unknown: %j", async (override) => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("no server running on /tmp/socket"), {
        code: 1,
        killed: false,
        signal: null,
        stdout: "",
        stderr: "no server running on /tmp/socket",
        ...override,
      }),
    );
    const runtime = await import("../../src/runtime-tmux.js");
    expect((await runtime.getTmuxSessionPresence("api-1")).diagnostic).toContain(
      "list-windows failed",
    );
    expect((await runtime.getTmuxPanePresence("api-1")).diagnostic).toContain("list-panes failed");
    await expect(runtime.tmuxSessionExists("api-1")).rejects.toThrow();
    await expect(runtime.tmuxPaneDead("api-1")).rejects.toThrow();
    await expect(runtime.isProcessRunningInTmux("api-1", ["node"])).rejects.toThrow();
  });

  // Issue #807 / DELTA 1: a single combined reader (present+unresponsive off
  // ONE fleet-snapshot fetch), not two separate exported readers — a second
  // top-level call for the unresponsive flag alone would risk missing an
  // already-expired memoizedProbe cache entry (a timeout kill takes 5s, the
  // cache TTL is 2s) and re-forking.
  it("AC1/A1: marks a fleet-session/fleet-pane probe unresponsive only for a timeout kill, never for an ordinary tmux failure", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        throw new Error("no server running on socket");
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        throw new Error("no server running on socket");
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { getTmuxSessionPresence, getTmuxPanePresence } =
      await import("../../src/runtime-tmux.js");

    await expect(getTmuxSessionPresence("api-1")).resolves.toEqual({
      present: false,
      unresponsive: false,
      diagnostic: expect.stringContaining("list-windows failed"),
    });
    await expect(getTmuxPanePresence("api-1")).resolves.toEqual({
      dead: true,
      unresponsive: false,
      diagnostic: expect.stringContaining("list-panes failed"),
    });
  });

  it("AC1/A1: a list-windows/list-panes fork killed by its own timeout reads unresponsive:true", async () => {
    const timeoutKill = () =>
      Object.assign(new Error("tmux timed out"), { killed: true, signal: "SIGTERM" });
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        throw timeoutKill();
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        throw timeoutKill();
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { getTmuxSessionPresence, getTmuxPanePresence, tmuxSessionExists, tmuxPaneDead } =
      await import("../../src/runtime-tmux.js");

    await expect(getTmuxSessionPresence("api-1")).resolves.toEqual({
      present: false,
      unresponsive: true,
      diagnostic: expect.stringContaining("list-windows failed"),
    });
    await expect(getTmuxPanePresence("api-1")).resolves.toEqual({
      dead: true,
      unresponsive: true,
      diagnostic: expect.stringContaining("list-panes failed"),
    });
    await expect(tmuxSessionExists("api-1")).rejects.toThrow("list-windows failed");
    await expect(tmuxPaneDead("api-1")).rejects.toThrow("list-panes failed");
  });

  // AC11 (rewritten, DELTA 1): a getTmuxSessionPresence/getTmuxPanePresence
  // read costs no additional tmux fork beyond the ONE that
  // tmuxSessionExists/tmuxPaneDead already pay for the same fleet snapshot —
  // including when that one fork is a timeout kill whose swallow-into-
  // readable:false means memoizedProbe's cache entry is never evicted (see
  // A2), so a same-tick second reader must reuse it, not re-fork.
  it("AC11: getTmuxSessionPresence/getTmuxPanePresence issue no extra fork beyond the shared fleet snapshot, even under a timeout-killed probe", async () => {
    let listWindowsCalls = 0;
    let listPanesCalls = 0;
    const timeoutKill = () =>
      Object.assign(new Error("tmux timed out"), { killed: true, signal: "SIGTERM" });
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        listWindowsCalls += 1;
        throw timeoutKill();
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        listPanesCalls += 1;
        throw timeoutKill();
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { tmuxSessionExists, tmuxPaneDead, getTmuxSessionPresence, getTmuxPanePresence } =
      await import("../../src/runtime-tmux.js");

    // Mirrors readRuntimeSnapshot's real call order: the plain boolean read
    // first, the combined presence read second, same tick, same TTL window.
    await expect(tmuxSessionExists("api-1")).rejects.toThrow("list-windows failed");
    await expect(getTmuxSessionPresence("api-1")).resolves.toEqual({
      present: false,
      unresponsive: true,
      diagnostic: expect.stringContaining("list-windows failed"),
    });
    await expect(tmuxPaneDead("api-1")).rejects.toThrow("list-panes failed");
    await expect(getTmuxPanePresence("api-1")).resolves.toEqual({
      dead: true,
      unresponsive: true,
      diagnostic: expect.stringContaining("list-panes failed"),
    });

    expect(listWindowsCalls).toBe(1);
    expect(listPanesCalls).toBe(1);
  });

  // Issue #903: a timeout-killed `ps` fork must not read as "process absent".
  const psTimeoutKill = () =>
    Object.assign(new Error("ps timed out"), { killed: true, signal: "SIGTERM" });

  function installPsMock(onPs: () => Promise<{ stdout: string; stderr: string }>): {
    psCalls: () => number;
  } {
    let psCalls = 0;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: "api-1 1700000000", stderr: "" };
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        return { stdout: fleetPaneLine("api-1", 0), stderr: "" };
      }
      if (file === "ps") {
        psCalls += 1;
        return onPs();
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });
    return { psCalls: () => psCalls };
  }

  it("AC1: a ps fork killed by its own timeout reads unresponsive:true while tmux answers", async () => {
    installPsMock(async () => {
      throw psTimeoutKill();
    });
    const { probeTmuxProcessMatch } = await import("../../src/runtime-tmux.js");

    await expect(probeTmuxProcessMatch("api-1", ["node"])).resolves.toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: true,
      diagnostic: expect.stringContaining("ps failed:"),
    });
  });

  it.each([
    [
      "exit 0, no matching row",
      async () => ({ stdout: "1000 1 1000 1000 pts/0 1 zsh", stderr: "" }),
    ],
    [
      "nonzero exit (killed:false)",
      async () => {
        throw Object.assign(new Error("bad column spec"), { killed: false, signal: null });
      },
    ],
    [
      "maxBuffer overrun (killed undefined)",
      async () => {
        throw Object.assign(new Error("maxBuffer exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    ],
  ])("AC2: ps %s reads unresponsive:false", async (_label, onPs) => {
    installPsMock(onPs);
    const { probeTmuxProcessMatch } = await import("../../src/runtime-tmux.js");

    await expect(probeTmuxProcessMatch("api-1", ["node"])).resolves.toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: false,
      ...(_label === "exit 0, no matching row"
        ? {}
        : { diagnostic: expect.stringContaining("ps failed:") }),
    });
  });

  it("AC3: a ps timeout kill costs one ps fork per TTL window and the boolean wrapper rejects unknown", async () => {
    const mock = installPsMock(async () => {
      throw psTimeoutKill();
    });
    const { probeTmuxProcessMatch, isProcessRunningInTmux } =
      await import("../../src/runtime-tmux.js");

    await expect(probeTmuxProcessMatch("api-1", ["node"])).resolves.toMatchObject({
      unresponsive: true,
    });
    await expect(isProcessRunningInTmux("api-1", ["node"])).rejects.toMatchObject({
      name: "TmuxProbeUnknownError",
      message: expect.stringContaining("ps failed:"),
    });
    expect(mock.psCalls()).toBe(1);
  });

  // AC10 (amendment 1): probeTmuxProcessMatch({fresh:true}) forks its OWN
  // list-panes -a, independent of the caller's pane read. Only that second
  // fork is killed here; the first answers.
  it("AC10: a timeout-killed SECOND list-panes -a fork (fresh probe) reads unresponsive:true", async () => {
    let listPanesCalls = 0;
    let psCalls = 0;
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-windows")) {
        return { stdout: "api-1 1700000000", stderr: "" };
      }
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        listPanesCalls += 1;
        if (listPanesCalls === 2) {
          throw psTimeoutKill();
        }
        return { stdout: fleetPaneLine("api-1", 0), stderr: "" };
      }
      if (file === "ps") {
        psCalls += 1;
        return { stdout: "1000 1 1000 1000 pts/0 51200 node agent", stderr: "" };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });
    const { getTmuxPanePresence, probeTmuxProcessMatch } =
      await import("../../src/runtime-tmux.js");

    await expect(getTmuxPanePresence("api-1", { fresh: true })).resolves.toEqual({
      dead: false,
      unresponsive: false,
    });
    await expect(probeTmuxProcessMatch("api-1", ["node"], { fresh: true })).resolves.toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: true,
      diagnostic: expect.stringContaining("tmux list-panes failed:"),
    });
    expect(listPanesCalls).toBe(2);
    expect(psCalls).toBe(0);
  });

  it("probeTmuxProcessMatch fresh read issues ONE list-panes fork and reports unresponsive when it is timeout-killed", async () => {
    execFileAsyncMock.mockImplementation(async (file, args) => {
      if (file === "tmux" && args.includes("list-panes") && args.includes("-a")) {
        throw Object.assign(new Error("tmux timed out"), { killed: true, signal: "SIGTERM" });
      }
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    const { probeTmuxProcessMatch } = await import("../../src/runtime-tmux.js");

    await expect(probeTmuxProcessMatch("api-1", ["node"], { fresh: true })).resolves.toEqual({
      alive: false,
      matchedByName: false,
      unresponsive: true,
      diagnostic: expect.stringContaining("list-panes failed: tmux timed out"),
    });
    expect(
      callsFor(
        (file, args) => file === "tmux" && args.includes("list-panes") && args.includes("-a"),
      ),
    ).toBe(1);
  });
});
