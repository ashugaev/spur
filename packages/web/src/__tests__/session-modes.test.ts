import { describe, expect, it } from "vitest";
import { reconcileSessionMode, sessionModeOptions } from "@/lib/session-modes";
import type { SessionModeInfo } from "@/lib/types";

describe("session-modes", () => {
  describe("no modes", () => {
    it("sessionModeOptions is empty", () => {
      expect(sessionModeOptions(undefined)).toEqual([]);
    });

    it("an empty modes map behaves like no modes", () => {
      expect(sessionModeOptions({})).toEqual([]);
      expect(reconcileSessionMode({}, null)).toBeNull();
    });
  });

  describe("a default entry exists", () => {
    const modes: Record<string, SessionModeInfo> = {
      manager: { skill: "manager", default: true },
      council: { skill: "council" },
    };

    it("sessionModeOptions lists only configured names, no sentinel", () => {
      expect(sessionModeOptions(modes)).toEqual([
        { value: "manager", label: "manager" },
        { value: "council", label: "council" },
      ]);
    });
  });

  describe("no default entry", () => {
    const modes: Record<string, SessionModeInfo> = {
      council: { skill: "council" },
    };

    it("reconcileSessionMode resolves to null when nothing is picked", () => {
      expect(reconcileSessionMode(modes, null)).toBeNull();
    });

    it("sessionModeOptions leads with a No mode sentinel", () => {
      expect(sessionModeOptions(modes)).toEqual([
        { value: "", label: "No mode" },
        { value: "council", label: "council" },
      ]);
    });
  });

  describe("reconcileSessionMode", () => {
    const modesWithDefault: Record<string, SessionModeInfo> = {
      manager: { skill: "manager", default: true },
      council: { skill: "council" },
    };
    const modesNoDefault: Record<string, SessionModeInfo> = {
      council: { skill: "council" },
    };

    it("keeps a candidate that is still configured", () => {
      expect(reconcileSessionMode(modesWithDefault, "council")).toBe("council");
    });

    it("falls back to the default name for a stale candidate", () => {
      expect(reconcileSessionMode(modesWithDefault, "ghost")).toBe("manager");
    });

    it("falls back to null for a stale candidate with no default", () => {
      expect(reconcileSessionMode(modesNoDefault, "ghost")).toBeNull();
    });

    it("treats a null candidate as unset and resolves the default", () => {
      expect(reconcileSessionMode(modesWithDefault, null)).toBe("manager");
    });

    it("treats __proto__ as an unknown candidate name", () => {
      expect(reconcileSessionMode(modesWithDefault, "__proto__")).toBe("manager");
      expect(reconcileSessionMode(modesNoDefault, "__proto__")).toBeNull();
    });

    it("treats constructor as an unknown candidate name", () => {
      expect(reconcileSessionMode(modesWithDefault, "constructor")).toBe("manager");
      expect(reconcileSessionMode(modesNoDefault, "constructor")).toBeNull();
    });

    it("resolves to null when there are no modes at all", () => {
      expect(reconcileSessionMode(undefined, "manager")).toBeNull();
    });
  });
});
