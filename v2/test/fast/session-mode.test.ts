import { describe, expect, it } from "vitest";
import { renderModeInstruction, resolveSessionMode } from "../../src/session-mode.js";
import type { SessionModeConfig } from "../../src/types.js";

describe("resolveSessionMode", () => {
  it("returns undefined when no modes are configured", () => {
    expect(resolveSessionMode(undefined, undefined)).toBeUndefined();
  });

  it("returns undefined when modes are configured but none default", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager" },
    };
    expect(resolveSessionMode(undefined, modes)).toBeUndefined();
  });

  it("resolves the project default mode when no request mode is given", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager", default: true },
      council: { skill: "council" },
    };
    expect(resolveSessionMode(undefined, modes)).toEqual({ name: "manager", skill: "manager" });
  });

  it("prefers an explicit request mode over the project default", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager", default: true },
      council: { skill: "council" },
    };
    expect(resolveSessionMode("council", modes)).toEqual({ name: "council", skill: "council" });
  });

  it("throws on an unknown mode name, listing configured names", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager", default: true },
      council: { skill: "council" },
    };
    expect(() => resolveSessionMode("bogus", modes)).toThrow(
      'Unknown mode "bogus"; configured modes: manager, council',
    );
  });

  it("throws on an unknown mode name when no modes are configured", () => {
    expect(() => resolveSessionMode("bogus", undefined)).toThrow(
      'Unknown mode "bogus"; configured modes: none configured',
    );
  });
});

describe("renderModeInstruction", () => {
  it("renders the exact instruction line", () => {
    expect(renderModeInstruction({ name: "council", skill: "council" })).toBe(
      "Mode: council. Load the `council` skill and follow it as your behavior contract for this session.",
    );
  });
});
