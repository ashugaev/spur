import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
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

describe("runtime config", () => {
  it("disables host-derived memory floors", async () => {
    const context = await createRuntimeTestContext(0, { useFakeTools: false });
    try {
      const configPath = await context.writeConfig("test.yaml", "projects: {}\n");
      expect(await readFile(configPath, "utf8")).toBe(`admission:
  memoryGuard:
    enforceFloors: false
projects: {}
`);
    } finally {
      await context.cleanup();
    }
  });
});
