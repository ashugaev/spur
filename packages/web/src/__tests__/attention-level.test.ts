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
  it("puts errored sessions in the error lane", () => {
    const session = toDashboardSession(
      baseView({
        status: "errored",
        state: "error",
        runtimeAlive: false,
        error: "Agent runtime exited unexpectedly.",
      }),
    );

    expect(getAttentionLevel(session)).toBe("error");
  });

  it("puts stopped sessions with explicit errors in the error lane", () => {
    const session = toDashboardSession(
      baseView({
        status: "stopped",
        state: "error",
        runtimeAlive: false,
        error: "agent exited 1",
      }),
    );

    expect(getAttentionLevel(session)).toBe("error");
  });

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

  it("keeps needs_input separate from technical errors", () => {
    const session = toDashboardSession(
      baseView({
        status: "running",
        state: "needs_input",
      }),
    );

    expect(getAttentionLevel(session)).toBe("respond");
  });
});

describe("toDashboardSession", () => {
  it("defaults running sidecars to an empty array", () => {
    expect(toDashboardSession(baseView()).runningSidecars).toEqual([]);
  });

  it("derives running sidecars from daemon names", () => {
    expect(
      toDashboardSession(baseView({ runningSidecarNames: ["isolated-ui"] })).runningSidecars,
    ).toEqual([{ name: "isolated-ui" }]);
  });

  it("matches running sidecars to slot links", () => {
    expect(
      toDashboardSession(
        baseView({
          runningSidecarNames: ["isolated-ui", "worker"],
          slots: {
            links: [
              { label: "isolated-ui", url: "http://127.0.0.1:5625/" },
              { label: "tracker", url: "https://tracker.example.com/TASK-1" },
            ],
          },
        }),
      ).runningSidecars,
    ).toEqual([
      { name: "isolated-ui", url: "http://127.0.0.1:5625/" },
      { name: "worker" },
    ]);
  });
});
