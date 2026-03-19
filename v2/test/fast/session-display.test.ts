import { describe, expect, it } from "vitest";
import { compareSessionsForList, displayState, sortSessionsForList } from "../../src/session-display.js";
import type { SessionView } from "../../src/types.js";

function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "test",
    branch: "api-1",
    worktreePath: "/tmp/worktree",
    tmuxSession: "api-1",
    launchCommand: "claude --dangerously-skip-permissions",
    status: "running",
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-18T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    activity: "ready",
    lastActivityAt: "2026-03-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("session-display", () => {
  it("uses activity for running sessions and status for terminal sessions", () => {
    expect(displayState(session({ activity: "waiting_input" }))).toBe("waiting_input");
    expect(displayState(session({ status: "killed", activity: "ready" }))).toBe("killed");
  });

  it("keeps waiting_input and errored sessions above normal ready sessions", () => {
    const ordered = sortSessionsForList([
      session({ id: "api-3", activity: "ready" }),
      session({ id: "api-1", activity: "waiting_input" }),
      session({ id: "api-2", status: "errored", activity: "exited" }),
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
