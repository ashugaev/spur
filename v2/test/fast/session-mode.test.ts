import { describe, expect, it, vi } from "vitest";
import {
  renderModeInstruction,
  resolveCarriedSessionMode,
  resolveSessionMode,
} from "../../src/session-mode.js";
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

  it("treats --mode __proto__ as unknown instead of resolving via the prototype chain", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager", default: true },
    };
    expect(() => resolveSessionMode("__proto__", modes)).toThrow(
      'Unknown mode "__proto__"; configured modes: manager',
    );
  });

  it("treats --mode constructor as unknown instead of resolving via the prototype chain", () => {
    const modes: Record<string, SessionModeConfig> = {
      manager: { skill: "manager", default: true },
    };
    expect(() => resolveSessionMode("constructor", modes)).toThrow(
      'Unknown mode "constructor"; configured modes: manager',
    );
  });
});

describe("resolveCarriedSessionMode", () => {
  it("returns undefined without warning when the session had no mode", () => {
    const warn = vi.fn();
    expect(resolveCarriedSessionMode(undefined, { manager: { skill: "manager" } }, warn)).toBe(
      undefined,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("resolves a still-configured carried mode without warning", () => {
    const warn = vi.fn();
    const modes: Record<string, SessionModeConfig> = { council: { skill: "council" } };
    expect(resolveCarriedSessionMode("council", modes, warn)).toEqual({
      name: "council",
      skill: "council",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades to undefined and warns when the carried mode is no longer configured", () => {
    const warn = vi.fn();
    const modes: Record<string, SessionModeConfig> = { manager: { skill: "manager" } };
    expect(resolveCarriedSessionMode("retired-mode", modes, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Mode "retired-mode" is no longer configured; carrying the session forward without a mode.',
    );
  });

  it("degrades to undefined and warns when the project no longer has any modes configured", () => {
    const warn = vi.fn();
    expect(resolveCarriedSessionMode("retired-mode", undefined, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does not resolve __proto__ via the prototype chain and degrades it instead", () => {
    const warn = vi.fn();
    const modes: Record<string, SessionModeConfig> = { manager: { skill: "manager" } };
    expect(resolveCarriedSessionMode("__proto__", modes, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("renderModeInstruction", () => {
  it("renders the exact instruction line", () => {
    expect(renderModeInstruction({ name: "council", skill: "council" })).toBe(
      "Mode: council. Load the `council` skill and follow it as your behavior contract for this session.",
    );
  });
});
