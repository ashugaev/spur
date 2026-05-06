import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureCodexHooksConfigMock,
  captureCodexRolloutBaselineMock,
  scanCodexRolloutForMessageMock,
  captureClaudeSubmitBaselineMock,
  scanClaudeJsonlForMessageMock,
} = vi.hoisted(() => ({
  ensureCodexHooksConfigMock: vi.fn(),
  captureCodexRolloutBaselineMock: vi.fn(),
  scanCodexRolloutForMessageMock: vi.fn(),
  captureClaudeSubmitBaselineMock: vi.fn(),
  scanClaudeJsonlForMessageMock: vi.fn(),
}));

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

import {
  agentWaitsForSubmitAck,
  createAgentSubmitAckBinding,
  setupAgentHooks,
} from "../../src/agents/index.js";

beforeEach(() => {
  ensureCodexHooksConfigMock.mockReset();
  captureCodexRolloutBaselineMock.mockReset();
  scanCodexRolloutForMessageMock.mockReset();
  captureClaudeSubmitBaselineMock.mockReset();
  scanClaudeJsonlForMessageMock.mockReset();
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
});

describe("agentWaitsForSubmitAck", () => {
  it("returns true for claude and codex, false for cursor", () => {
    expect(agentWaitsForSubmitAck("claude")).toBe(true);
    expect(agentWaitsForSubmitAck("codex")).toBe(true);
    expect(agentWaitsForSubmitAck("cursor")).toBe(false);
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

  it("returns null for cursor (no submit ack)", async () => {
    const binding = await createAgentSubmitAckBinding("cursor", ctx);
    expect(binding).toBeNull();
  });
});
