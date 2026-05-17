import { describe, expect, it } from "vitest";
import { compareSessionsForList, sortSessionsForList } from "../../src/session-display.js";
import type { SessionView } from "../../src/types.js";

function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "test",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/worktree",
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    state: "waiting",
    lastActivityAt: "2026-03-18T10:00:00.000Z",
    artifacts: [],
    services: [],
    sidecars: [],
    ...overrides,
  };
}

describe("session-display", () => {
  it("keeps needs_input and error sessions above normal waiting sessions", () => {
    const ordered = sortSessionsForList([
      session({ id: "api-3", state: "waiting" }),
      session({ id: "api-1", state: "needs_input" }),
      session({ id: "api-2", state: "error", status: "errored" }),
    ]).map((entry) => entry.id);

    expect(ordered).toEqual(["api-1", "api-2", "api-3"]);
  });

  it("breaks ties by most recent activity, then project, then id", () => {
    const left = session({
      id: "api-2",
      project: "api",
      lastActivityAt: "2026-03-18T10:05:00.000Z",
    });
    const right = session({
      id: "api-1",
      project: "web",
      lastActivityAt: "2026-03-18T10:04:00.000Z",
    });

    expect(compareSessionsForList(left, right)).toBeLessThan(0);
  });
});
