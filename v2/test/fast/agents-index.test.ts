import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClaudeModule from "../../src/agents/claude.js";

const {
  ensureCodexHooksConfigMock,
  ensureClaudeRestrictWritesSettingsMock,
  captureCodexRolloutBaselineMock,
  scanCodexRolloutForMessageMock,
  captureClaudeSubmitBaselineMock,
  scanClaudeJsonlForMessageMock,
  captureCursorSubmitBaselineMock,
  scanCursorJsonlForMessageMock,
} = vi.hoisted(() => ({
  ensureCodexHooksConfigMock: vi.fn(),
  ensureClaudeRestrictWritesSettingsMock: vi.fn(),
  captureCodexRolloutBaselineMock: vi.fn(),
  scanCodexRolloutForMessageMock: vi.fn(),
  captureClaudeSubmitBaselineMock: vi.fn(),
  scanClaudeJsonlForMessageMock: vi.fn(),
  captureCursorSubmitBaselineMock: vi.fn(),
  scanCursorJsonlForMessageMock: vi.fn(),
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
  captureCodexRolloutBaseline: captureCodexRolloutBaselineMock,
  scanCodexRolloutForMessage: scanCodexRolloutForMessageMock,
}));

vi.mock("../../src/agents/claude-submit-ack.js", () => ({
  captureClaudeSubmitBaseline: captureClaudeSubmitBaselineMock,
  scanClaudeJsonlForMessage: scanClaudeJsonlForMessageMock,
}));

vi.mock("../../src/agents/cursor-submit-ack.js", () => ({
  captureCursorSubmitBaseline: captureCursorSubmitBaselineMock,
  scanCursorJsonlForMessage: scanCursorJsonlForMessageMock,
}));

import {
  buildAgentLaunchPlan,
  createAgentSubmitAckBinding,
  setupAgentHooks,
} from "../../src/agents/index.js";

beforeEach(() => {
  ensureCodexHooksConfigMock.mockReset();
  ensureClaudeRestrictWritesSettingsMock.mockReset();
  captureCodexRolloutBaselineMock.mockReset();
  scanCodexRolloutForMessageMock.mockReset();
  captureClaudeSubmitBaselineMock.mockReset();
  scanClaudeJsonlForMessageMock.mockReset();
  captureCursorSubmitBaselineMock.mockReset();
  scanCursorJsonlForMessageMock.mockReset();
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

describe("createAgentSubmitAckBinding", () => {
  const ctx = {
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    codexSessionsDir: "/tmp/spur-data/session-tools/api-1/codex-home/sessions",
  };

  it("returns null for claude when no JSONL baseline can be captured", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue(null);
    const binding = await createAgentSubmitAckBinding("claude", ctx);
    expect(binding).toBeNull();
  });

  it("returns a binding for claude that scans the captured baseline", async () => {
    captureClaudeSubmitBaselineMock.mockResolvedValue({ file: "/some/file.jsonl", size: 42 });
    scanClaudeJsonlForMessageMock.mockResolvedValue(true);

    const binding = await createAgentSubmitAckBinding("claude", ctx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");
    expect(result).toEqual({ found: true, lastScannedFile: "/some/file.jsonl" });
    expect(scanClaudeJsonlForMessageMock).toHaveBeenCalledWith(
      { file: "/some/file.jsonl", size: 42 },
      "hello",
      ctx.worktreePath,
    );
  });

  it("returns a binding for codex that scans the rollout dir", async () => {
    const baseline = new Map<string, number>([["/some/rollout.jsonl", 100]]);
    captureCodexRolloutBaselineMock.mockResolvedValue(baseline);
    scanCodexRolloutForMessageMock.mockResolvedValue({
      found: true,
      lastScannedFile: "/some/rollout.jsonl",
    });

    const binding = await createAgentSubmitAckBinding("codex", ctx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");
    expect(result).toEqual({ found: true, lastScannedFile: "/some/rollout.jsonl" });
    expect(scanCodexRolloutForMessageMock).toHaveBeenCalledWith(
      ctx.codexSessionsDir,
      "hello",
      baseline,
    );
  });

  it("returns null for cursor when no transcript baseline can be captured", async () => {
    captureCursorSubmitBaselineMock.mockResolvedValue(null);
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    expect(binding).toBeNull();
  });

  it("returns a binding for cursor that scans the captured transcript", async () => {
    captureCursorSubmitBaselineMock.mockResolvedValue({ file: "/some/chat.jsonl", size: 7 });
    scanCursorJsonlForMessageMock.mockResolvedValue(true);

    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    expect(binding).not.toBeNull();
    const result = await binding?.scan("hello");
    expect(result).toEqual({ found: true, lastScannedFile: "/some/chat.jsonl" });
    expect(scanCursorJsonlForMessageMock).toHaveBeenCalledWith(
      { file: "/some/chat.jsonl", size: 7 },
      "hello",
      ctx.worktreePath,
    );
  });
});
