import { describe, expect, it } from "vitest";
import {
  describeSession,
  renderInteractiveSessionList,
  renderRuntimeSummary,
} from "../../src/cli-view.js";
import { formatSessionLinkDisplay } from "../../src/session-link-display.js";
import { SPUR_DAEMON_API_VERSION, type RuntimeInfo, type SessionView } from "../../src/types.js";

function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
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
    artifacts: [],
    services: [],
    sidecars: [],
    ...overrides,
  };
}

function runtimeInfo(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    ok: true,
    apiVersion: SPUR_DAEMON_API_VERSION,
    version: "0.1.0",
    pid: 36319,
    host: "127.0.0.1",
    port: 4311,
    dataDir: "/tmp/spur-data",
    worktreeDir: "/tmp/spur-worktrees",
    configPath: "/tmp/spur.yaml",
    tmuxSocketName: "spur-4311",
    uiPort: 5555,
    startedAt: "2026-03-18T10:00:00.000Z",
    tags: [],
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

  it("labels rate_limited sessions for spur list", () => {
    expect(
      describeSession(
        session({
          state: "rate_limited",
          agent: "codex",
          prompt: "Codex out of credits",
        }),
      ),
    ).toContain("hit rate or usage limit");
  });

  it("shows compact persisted link ids instead of full URLs", () => {
    const output = describeSession(
      session({
        slots: {
          links: [
            { label: "pr", url: "https://github.com/acme/api/pull/42" },
            { label: "tracker", url: "https://tracker.example.com/browse/API-7" },
          ],
        },
      }),
    );

    expect(output).toContain("pr #42");
    expect(output).toContain("tracker API-7");
    expect(output).not.toContain("https://github.com/acme/api/pull/42");
    expect(output).not.toContain("https://tracker.example.com/browse/API-7");
  });
});

describe("session-link-display", () => {
  it("formats pr and tracker links as compact ids", () => {
    expect(
      formatSessionLinkDisplay({
        label: "pr",
        url: "https://github.com/acme/api/pull/42",
      }).text,
    ).toBe("pr #42");
    expect(
      formatSessionLinkDisplay({
        label: "tracker",
        url: "https://tracker.example.com/browse/API-7",
      }).text,
    ).toBe("tracker API-7");
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
  it("shows the full live-list action hint", () => {
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [session({})],
      selectedSessionId: "api-1",
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 2,
    });

    expect(output).toContain("Esc quit");
    expect(output).toContain("p pause");
    expect(output).toContain("c complete");
    expect(output).toContain("l logs");
    expect(output).toContain("Ctrl+G detach");
    expect(output).not.toContain("q/Esc quit");
  });

  it("shows a live service port in the session description", () => {
    expect(
      describeSession(
        session({
          services: [
            {
              sessionId: "api-1",
              project: "api",
              serviceId: "web",
              port: 3000,
              command: "pnpm dev",
              cwd: "/tmp/worktree",
              tmuxSession: "api-1--svc--web",
              status: "running",
              createdAt: "2026-03-18T10:00:00.000Z",
              updatedAt: "2026-03-18T10:00:00.000Z",
              runtimeAlive: true,
              state: "running",
              lastActivityAt: "2026-03-18T10:00:00.000Z",
              problemRuleIds: [],
            },
          ],
        }),
      ),
    ).toContain("service web:3000");
  });

  it("asks the user to reselect before acting when nothing is selected", () => {
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [session({}), session({ id: "api-2", tmuxSession: "api-2", branch: "api-2" })],
      selectedSessionId: null,
      totalSessions: 2,
      windowStart: 0,
      maxDetailLines: 2,
    });

    expect(output).toContain("Use ↑↓ to reselect before acting.");
  });

  it("shows compact link ids in selected session details", () => {
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [
        session({
          slots: {
            links: [{ label: "jira", url: "https://jira.example.com/browse/OPS-9" }],
          },
        }),
      ],
      selectedSessionId: "api-1",
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });

    expect(output).toContain("jira OPS-9");
    expect(output).not.toContain("https://jira.example.com/browse/OPS-9");
  });
});
