import { describe, expect, it } from "vitest";
import { resolveClaudeAuthPlanOptions } from "../../src/session-service.js";
import type { ClaudeAuthProfile } from "../../src/types.js";

const profiles: ClaudeAuthProfile[] = [
  { name: "primary", configDir: "/abs/primary", default: true },
  { name: "backup", configDir: "/abs/backup" },
];

describe("resolveClaudeAuthPlanOptions", () => {
  it("returns {} when no profiles are configured (back-compat)", () => {
    expect(resolveClaudeAuthPlanOptions([], { agent: "claude" })).toEqual({});
  });

  it("returns {} for non-claude agents", () => {
    expect(resolveClaudeAuthPlanOptions(profiles, { agent: "codex" })).toEqual({});
  });

  it("picks the default profile when activeAuthProfile is unset", () => {
    expect(resolveClaudeAuthPlanOptions(profiles, { agent: "claude" })).toEqual({
      claudeConfigDir: "/abs/primary",
    });
  });

  it("picks the named profile when activeAuthProfile is set", () => {
    expect(
      resolveClaudeAuthPlanOptions(profiles, { agent: "claude", activeAuthProfile: "backup" }),
    ).toEqual({ claudeConfigDir: "/abs/backup" });
  });

  it("falls back to the default profile when activeAuthProfile is unknown", () => {
    expect(
      resolveClaudeAuthPlanOptions(profiles, { agent: "claude", activeAuthProfile: "ghost" }),
    ).toEqual({ claudeConfigDir: "/abs/primary" });
  });
});
