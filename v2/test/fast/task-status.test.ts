import { describe, expect, it } from "vitest";
import {
  normalizeTaskStatus,
  parseTaskStatusRequest,
  projectTaskStatus,
  readTaskStatus,
} from "../../src/task-status.js";
import type { SessionRecord, SessionState } from "../../src/types.js";

const task = {
  status: "running",
  agentLaunchId: "launch-a",
  taskStatusRevision: 2,
  taskStatus: {
    state: "completed",
    revision: 2,
    agentLaunchId: "launch-a",
    updatedAt: "2026-11-15T00:00:00Z",
  },
} satisfies Pick<SessionRecord, "status" | "agentLaunchId" | "taskStatusRevision" | "taskStatus">;

describe("task-status", () => {
  it("validates the external mutation shape", () => {
    expect(parseTaskStatusRequest({ state: "clear", revision: 0, agentLaunchId: "a" })).toEqual({
      state: "clear",
      revision: 0,
      agentLaunchId: "a",
    });
    for (const value of [
      null,
      [],
      {},
      { state: "done", revision: 0, agentLaunchId: "a" },
      { state: "completed", revision: -1, agentLaunchId: "a" },
      { state: "needs_input", revision: 1.5, agentLaunchId: "a" },
      { state: "clear", revision: 0, agentLaunchId: "" },
    ]) {
      expect(() => parseTaskStatusRequest(value)).toThrow();
    }
  });

  it("drops malformed persisted declarations", () => {
    expect(normalizeTaskStatus(task.taskStatus)).toEqual(task.taskStatus);
    expect(normalizeTaskStatus({ ...task.taskStatus, updatedAt: "invalid" })).toBeUndefined();
    expect(
      normalizeTaskStatus({ ...task.taskStatus, revision: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeUndefined();
  });

  it("projects only current idle task outcomes and preserves the helper tail", () => {
    expect(projectTaskStatus(task, "waiting", "waiting", true, true)).toBe("completed");
    expect(projectTaskStatus(task, "working", "waiting", true, true)).toBe("working");
    expect(projectTaskStatus(task, "waiting", "waiting", true, true)).toBe("completed");
    expect(readTaskStatus({ ...task, agentLaunchId: "launch-b" })).toEqual({ revision: 2 });
    expect(readTaskStatus({ ...task, taskStatusRevision: 3 })).toEqual({ revision: 3 });
    expect(
      projectTaskStatus({ ...task, status: "completed" }, "stopped", "stopped", false, true),
    ).toBe("stopped");
    expect(projectTaskStatus(task, "waiting", "waiting", false, true)).toBe("waiting");
    expect(projectTaskStatus(task, "waiting", "waiting", true, false)).toBe("waiting");
  });

  it.each<SessionState>(["working", "needs_input", "rate_limited", "error", "stopped", "killed"])(
    "native %s outranks a declaration",
    (state) => {
      expect(projectTaskStatus(task, state, "waiting", true, true)).toBe(state);
    },
  );
});
