import { describe, expect, it } from "vitest";
import { getAttentionLevel, toDashboardSession, type SpurSessionView } from "@/lib/types.js";

function baseView(overrides: Partial<SpurSessionView> = {}): SpurSessionView {
  return {
    id: "attention-session",
    project: "p",
    agent: "claude",
    prompt: "task",
    branch: "main",
    worktree: true,
    tmuxSession: "attention-session",
    status: "running",
    state: "working",
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    lastActivityAt: "2026-01-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/attention-session",
    ...overrides,
  };
}

describe("getAttentionLevel", () => {
  it("treats spawning sessions with missing workspace as working", () => {
    const session = toDashboardSession(
      baseView({
        status: "spawning",
        state: "working",
        runtimeAlive: false,
        workspaceExists: false,
      }),
    );

    expect(getAttentionLevel(session)).toBe("working");
  });

  it("treats running working sessions with missing workspace as needing response", () => {
    const session = toDashboardSession(
      baseView({
        status: "running",
        state: "working",
        workspaceExists: false,
      }),
    );

    expect(getAttentionLevel(session)).toBe("respond");
  });

  it("keeps spawning needs_input sessions in needs response", () => {
    const session = toDashboardSession(
      baseView({
        status: "spawning",
        state: "needs_input",
        runtimeAlive: false,
        workspaceExists: false,
      }),
    );

    expect(getAttentionLevel(session)).toBe("respond");
  });
});
