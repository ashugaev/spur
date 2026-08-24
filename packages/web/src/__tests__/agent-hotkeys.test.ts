import { describe, expect, it } from "vitest";
import { getAgentHotkeys } from "@/lib/agent-hotkeys";

describe("getAgentHotkeys", () => {
  it("returns hotkeys for claude including the Esc common shortcut", () => {
    const hotkeys = getAgentHotkeys("claude");
    expect(hotkeys.find((entry) => entry.id === "escape")).toBeDefined();
  });

  it("returns hotkeys for codex including the queue follow-up entry", () => {
    const hotkeys = getAgentHotkeys("codex");
    expect(hotkeys.find((entry) => entry.id === "queue")).toBeDefined();
  });

  it("returns hotkeys for cursor including the slash entry", () => {
    const hotkeys = getAgentHotkeys("cursor");
    expect(hotkeys.find((entry) => entry.id === "slash")).toBeDefined();
  });

  it("returns hotkeys for opencode including the session picker", () => {
    const hotkeys = getAgentHotkeys("opencode");
    expect(hotkeys.find((entry) => entry.id === "sessions")).toBeDefined();
  });

  it("gives every agent exactly one Tab (\\t) hotkey", () => {
    for (const agent of ["claude", "codex", "cursor", "opencode"] as const) {
      const tabs = getAgentHotkeys(agent).filter((entry) => entry.sequence === "\t");
      expect(tabs, `${agent} tab count`).toHaveLength(1);
    }
  });

  it("encodes ctrl letters as their control-byte sequences", () => {
    const claude = getAgentHotkeys("claude");
    const interrupt = claude.find((entry) => entry.id === "interrupt");
    expect(interrupt?.sequence).toBe(String.fromCharCode("C".charCodeAt(0) - 64));
  });
});
