import { describe, expect, it } from "vitest";
import {
  ATTENTION_ZONE_ORDER,
  getAttentionLevel,
  isRestorable,
  toDashboardSession,
  type SpurSessionView,
} from "@/lib/types.js";

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

  it("treats waiting sessions with a live shared workspace as pending", () => {
    const session = toDashboardSession(
      baseView({
        worktree: false,
        state: "waiting",
        workspaceExists: true,
      }),
    );

    expect(getAttentionLevel(session)).toBe("pending");
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

  it("puts rate_limited sessions in the rate_limited lane", () => {
    const session = toDashboardSession(
      baseView({
        status: "running",
        state: "rate_limited",
      }),
    );

    expect(getAttentionLevel(session)).toBe("rate_limited");
  });

  it("lets hard error evidence outrank a rate_limited state", () => {
    const session = toDashboardSession(
      baseView({
        status: "errored",
        state: "rate_limited",
        error: "Agent runtime exited unexpectedly.",
      }),
    );

    expect(getAttentionLevel(session)).toBe("error");
  });

  it("puts a stale-parked session in the stopped lane and keeps it restorable", () => {
    const session = toDashboardSession(
      baseView({
        status: "stopped",
        state: "stale",
        runtimeAlive: false,
      }),
    );

    expect(getAttentionLevel(session)).toBe("stopped");
    expect(isRestorable(session)).toBe(true);
  });

  it("ranks the rate_limited zone directly under errors", () => {
    expect(ATTENTION_ZONE_ORDER.indexOf("rate_limited")).toBe(
      ATTENTION_ZONE_ORDER.indexOf("error") + 1,
    );
    expect(ATTENTION_ZONE_ORDER.indexOf("rate_limited")).toBeLessThan(
      ATTENTION_ZONE_ORDER.indexOf("respond"),
    );
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
    ).toEqual([{ name: "isolated-ui", url: "http://127.0.0.1:5625/" }, { name: "worker" }]);
  });
});
