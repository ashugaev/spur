import { describe, expect, it } from "vitest";
import {
  describeSession,
  renderInteractiveSessionList,
  renderRuntimeSummary,
} from "../../src/cli-view.js";
import { SPUR_DAEMON_API_VERSION, type RuntimeInfo, type SessionView } from "../../src/types.js";

function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "test",
    branch: "main",
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
    ...overrides,
  };
}

function runtimeInfo(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    ok: true,
    apiVersion: SPUR_DAEMON_API_VERSION,
    pid: 36319,
    host: "127.0.0.1",
    port: 4311,
    dataDir: "/tmp/spur-data",
    worktreeDir: "/tmp/spur-worktrees",
    configPath: "/tmp/spur.yaml",
    startedAt: "2026-03-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("cli-view.describeSession", () => {
  it("labels shared workspaces without implying a broken worktree", () => {
    expect(
      describeSession(
        session({
          worktree: false,
          worktreePath: "/repo/api",
        }),
      ),
    ).toContain("shared workspace live");
  });

  it("marks killed sessions as not restorable", () => {
    expect(
      describeSession(
        session({
          status: "killed",
          state: "killed",
          runtimeAlive: false,
          workspaceExists: false,
        }),
      ),
    ).toContain("not restorable");
  });

  it("surfaces done sessions as finished work", () => {
    expect(
      describeSession(
        session({
          status: "done",
          state: "done",
        }),
      ),
    ).toContain("task finished");
  });
});

describe("cli-view.renderRuntimeSummary", () => {
  it("keeps the daemon summary line unbranded", () => {
    expect(renderRuntimeSummary(runtimeInfo())).toMatch(
      /^daemon 127\.0\.0\.1:4311 {2}pid 36319 {2}started /,
    );
  });
});

describe("cli-view.renderInteractiveSessionList", () => {
  it("shows only Esc in the quit hint", () => {
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [session({})],
      selectedSessionId: "api-1",
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 2,
    });

    expect(output).toContain("Esc quit");
    expect(output).not.toContain("q/Esc quit");
  });
});
