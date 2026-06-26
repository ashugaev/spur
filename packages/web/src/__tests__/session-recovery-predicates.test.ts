import { describe, expect, it } from "vitest";
import {
  canRecover,
  isRestorable,
  isSessionNotRestorablePayload,
  toDashboardSession,
  type SpurSessionView,
} from "@/lib/types.js";

function baseView(overrides: Partial<SpurSessionView> = {}): SpurSessionView {
  return {
    id: "recover-session",
    project: "p",
    agent: "claude",
    prompt: "task",
    branch: "main",
    worktree: true,
    tmuxSession: "recover-session",
    status: "running",
    state: "working",
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    lastActivityAt: "2026-01-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/recover-session",
    ...overrides,
  };
}

describe("isRestorable", () => {
  it("is false when the workspace no longer exists", () => {
    const session = toDashboardSession(
      baseView({ status: "stopped", state: "stopped", runtimeAlive: false, workspaceExists: false }),
    );

    expect(isRestorable(session)).toBe(false);
  });

  it("is true for a stopped session whose workspace still exists", () => {
    const session = toDashboardSession(
      baseView({ status: "stopped", state: "stopped", runtimeAlive: false }),
    );

    expect(isRestorable(session)).toBe(true);
  });
});

describe("canRecover", () => {
  it("is true for a non-terminal session with a missing workspace", () => {
    const session = toDashboardSession(
      baseView({ status: "errored", state: "error", runtimeAlive: false, workspaceExists: false }),
    );

    expect(canRecover(session)).toBe(true);
  });

  it("is false for a restorable session", () => {
    const session = toDashboardSession(
      baseView({ status: "stopped", state: "stopped", runtimeAlive: false }),
    );

    expect(canRecover(session)).toBe(false);
  });

  it("is false for a terminal session", () => {
    const session = toDashboardSession(
      baseView({ status: "killed", state: "killed", runtimeAlive: false, workspaceExists: false }),
    );

    expect(canRecover(session)).toBe(false);
  });
});

describe("isSessionNotRestorablePayload", () => {
  it("accepts a valid payload", () => {
    expect(
      isSessionNotRestorablePayload({
        code: "session_not_restorable",
        sessionId: "api-1",
        reason: "Session api-1 is not restorable",
        availableActions: ["force_kill", "respawn"],
      }),
    ).toBe(true);
  });

  it("rejects payloads with an unknown action or wrong code", () => {
    expect(
      isSessionNotRestorablePayload({
        code: "session_not_restorable",
        sessionId: "api-1",
        reason: "nope",
        availableActions: ["force_kill", "boom"],
      }),
    ).toBe(false);
    expect(
      isSessionNotRestorablePayload({
        code: "open_pr_action_required",
        sessionId: "api-1",
        reason: "nope",
        availableActions: ["force_kill"],
      }),
    ).toBe(false);
  });
});
