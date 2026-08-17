import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  _liveTmuxSocketsForTests,
  buildTmuxSocketArgs,
  createRuntimeTestContext,
  setActiveTmuxSocketName,
  withTmuxSocket,
} from "../helpers/runtime.js";

// Regression guard for issue #350: the runtime test harness must never fall
// through to the host's default tmux server. withTmuxSocket throws unless an
// isolated `-L` socket is armed, so a missing activation fails fast instead of
// poisoning the default socket via `set-environment -g`.

afterEach(() => {
  setActiveTmuxSocketName(null);
});

describe("withTmuxSocket", () => {
  it("throws when no isolated socket is active", () => {
    setActiveTmuxSocketName(null);
    expect(() => withTmuxSocket(["has-session"])).toThrow(/no isolated tmux socket active/);
  });

  it("prefixes args with -L <socket> once a socket is armed", () => {
    setActiveTmuxSocketName("x");
    expect(withTmuxSocket(["has-session", "-t", "s"])).toEqual([
      "-L",
      "x",
      "has-session",
      "-t",
      "s",
    ]);
  });

  it("re-arms the guard after the socket is cleared", () => {
    setActiveTmuxSocketName("x");
    expect(withTmuxSocket(["kill-server"])).toEqual(["-L", "x", "kill-server"]);
    setActiveTmuxSocketName(null);
    expect(() => withTmuxSocket(["kill-server"])).toThrow(/no isolated tmux socket active/);
  });
});

// Pure/in-memory only — no real tmux invocation, to keep the fast tier
// hermetic. The real-kill behavior of killTmuxServer/killTmuxSessionsByPrefix
// is pinned with a real tmux server in test/runtime/tmux-ledger.runtime.test.ts
// ("kills a real session on socket B while socket A is the armed global"),
// which is the only place a real-tmux assertion is meaningful (Revision 2,
// M9: a fast-tier "does not throw" pin here is vacuous either way, since
// killTmuxSessionsByPrefix's catch swallows any error unconditionally).
describe("armed-socket tracking (set-based exit net)", () => {
  afterEach(() => {
    _liveTmuxSocketsForTests.delete("track-a");
    _liveTmuxSocketsForTests.delete("track-b");
    _liveTmuxSocketsForTests.delete("track-argv");
  });

  it("tracks two sequentially armed sockets, not just the first", () => {
    setActiveTmuxSocketName("track-a");
    setActiveTmuxSocketName("track-b");
    expect(_liveTmuxSocketsForTests.has("track-a")).toBe(true);
    expect(_liveTmuxSocketsForTests.has("track-b")).toBe(true);
  });

  it("buildTmuxSocketArgs yields exactly ['-L', socket, ...args] with the global cleared", () => {
    setActiveTmuxSocketName("track-argv");
    setActiveTmuxSocketName(null);
    expect(buildTmuxSocketArgs("track-argv", ["list-sessions"])).toEqual([
      "-L",
      "track-argv",
      "list-sessions",
    ]);
  });
});

describe("runtime config", () => {
  it("disables host-derived memory floors", async () => {
    const context = await createRuntimeTestContext(0, { useFakeTools: false });
    try {
      const configPath = await context.writeConfig("test.yaml", "projects: {}\n");
      expect(await readFile(configPath, "utf8")).toBe(`admission:
  enabled: false
  memoryGuard:
    enforceFloors: false
projects: {}
`);
    } finally {
      await context.cleanup();
    }
  });
});
