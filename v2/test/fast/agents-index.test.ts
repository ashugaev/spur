import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClaudeModule from "../../src/agents/claude.js";

const { ensureCodexHooksConfigMock, ensureClaudeRestrictWritesSettingsMock } = vi.hoisted(() => ({
  ensureCodexHooksConfigMock: vi.fn(),
  ensureClaudeRestrictWritesSettingsMock: vi.fn(),
}));

vi.mock("../../src/agents/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeModule>();
  return {
    ...actual,
    ensureClaudeRestrictWritesSettings: ensureClaudeRestrictWritesSettingsMock,
  };
});

vi.mock("../../src/agents/codex.js", () => ({
  buildCodexPlan: vi.fn(),
  buildCodexRestorePlan: vi.fn(),
  buildCodexResumePlan: vi.fn(),
  codexCommand: vi.fn(() => "codex"),
  ensureCodexHooksConfig: ensureCodexHooksConfigMock,
  findCodexSessionId: vi.fn(),
}));

import { setupAgentHooks, buildAgentLaunchPlan } from "../../src/agents/index.js";

beforeEach(() => {
  ensureCodexHooksConfigMock.mockReset();
  ensureClaudeRestrictWritesSettingsMock.mockReset();
});

describe("setupAgentHooks", () => {
  it("does not configure hooks for claude", async () => {
    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
    });

    expect(result).toEqual({});
    expect(ensureCodexHooksConfigMock).not.toHaveBeenCalled();
  });

  it("returns claude settings path when restrictWrites is enabled", async () => {
    ensureClaudeRestrictWritesSettingsMock.mockResolvedValue(
      "/tmp/spur-data/session-tools/api-1/claude/settings.json",
    );

    const result = await setupAgentHooks({
      agent: "claude",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      restrictWrites: true,
    });

    expect(ensureClaudeRestrictWritesSettingsMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
    );
    expect(result).toEqual({
      claudeSettingsPath: "/tmp/spur-data/session-tools/api-1/claude/settings.json",
    });
  });

  it("trusts the session worktree path for codex", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");

    const result = await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith("/tmp/spur-data/session-tools/api-1", [
      "/tmp/spur-worktrees/api/api-1",
    ]);
    expect(result).toEqual({
      codexHomePath: "/tmp/spur-data/session-tools/api-1/codex-home",
    });
  });

  it("forwards restrictWrites to codex hook setup", async () => {
    ensureCodexHooksConfigMock.mockResolvedValue("/tmp/spur-data/session-tools/api-1/codex-home");

    await setupAgentHooks({
      agent: "codex",
      worktreePath: "/tmp/spur-worktrees/api/api-1",
      sessionToolDir: "/tmp/spur-data/session-tools/api-1",
      restrictWrites: true,
    });

    expect(ensureCodexHooksConfigMock).toHaveBeenCalledWith(
      "/tmp/spur-data/session-tools/api-1",
      ["/tmp/spur-worktrees/api/api-1"],
      { restrictWrites: true },
    );
  });
});

describe("buildAgentLaunchPlan", () => {
  it("omits --force for cursor when restrictWrites is enabled", () => {
    const plan = buildAgentLaunchPlan("cursor", "review only", { restrictWrites: true });
    expect(plan.launchCommand).toBe("agent");
    expect(plan.launchCommand).not.toContain("--force");
    expect(plan.launchCommand).not.toContain("--plan");
  });
});
