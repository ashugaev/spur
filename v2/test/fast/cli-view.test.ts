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

  it("labels a stale-parked session as parked by idle timeout, not stopped by user", () => {
    const output = describeSession(
      session({
        status: "stopped",
        stopReason: "stale_timeout",
        state: "stale",
      }),
    );

    expect(output).toContain("parked by idle timeout");
    expect(output).not.toContain("stopped by user");
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

  it("shows a compact sidecar age indicator when a sidecar has a resolvable age", () => {
    const output = describeSession(
      session({
        sidecars: [
          {
            name: "front-local",
            alive: true,
            ports: [],
            tmuxSession: "api-1--front-local",
            ageSeconds: 46_800,
          },
        ],
      }),
    );

    expect(output).toContain("sidecar front-local 13h");
  });

  it("marks the sidecar age fact when it is past the age-warn threshold", () => {
    const output = describeSession(
      session({
        sidecars: [
          {
            name: "front-local",
            alive: true,
            ports: [],
            tmuxSession: "api-1--front-local",
            ageSeconds: 46_800,
            ageWarn: true,
          },
        ],
      }),
    );

    expect(output).toContain("sidecar front-local 13h!");
  });

  it("names only the oldest sidecar and folds the rest into a count", () => {
    const output = describeSession(
      session({
        sidecars: [
          {
            name: "front-local",
            alive: true,
            ports: [],
            tmuxSession: "api-1--front-local",
            ageSeconds: 60,
          },
          {
            name: "front-pp-tunnel",
            alive: true,
            ports: [],
            tmuxSession: "api-1--front-pp-tunnel",
            ageSeconds: 46_800,
          },
        ],
      }),
    );

    expect(output).toContain("sidecar front-pp-tunnel 13h +1 more");
    expect(output).not.toContain("front-local");
  });

  it("adds no sidecar fact when no sidecar has a resolvable age", () => {
    const output = describeSession(
      session({
        sidecars: [
          { name: "front-local", alive: true, ports: [], tmuxSession: "api-1--front-local" },
        ],
      }),
    );

    expect(output).not.toContain("sidecar");
  });

  it("shows a queued fact for a session with real queued messages (A5)", () => {
    const output = describeSession(
      session({ queuedMessages: { messages: ["a", "b"], awaitingPrompt: false } }),
    );

    expect(output).toContain("queued 2");
  });

  it("adds no queued fact when queuedMessages is absent (A6)", () => {
    const output = describeSession(session({}));

    expect(output).not.toContain("queued");
  });

  it("adds no queued fact when only pipelineMessages is set (A7)", () => {
    const output = describeSession(
      session({
        queuedMessages: { messages: [], awaitingPrompt: false, pipelineMessages: ["auto-step"] },
      }),
    );

    expect(output).not.toContain("queued");
  });

  it("adds no queued fact for the real post-delivery shape {messages: [], awaitingPrompt: true} (A10)", () => {
    const output = describeSession(
      session({ queuedMessages: { messages: [], awaitingPrompt: true } }),
    );

    expect(output).not.toContain("queued");
  });

  it("shows queued 2 while the agent is mid-turn (A12)", () => {
    const output = describeSession(
      session({ queuedMessages: { messages: ["a", "b"], awaitingPrompt: true } }),
    );

    expect(output).toContain("queued 2");
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
      selectedDetail: session({}),
      detailLoading: false,
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
      selectedDetail: null,
      detailLoading: false,
      totalSessions: 2,
      windowStart: 0,
      maxDetailLines: 2,
    });

    expect(output).toContain("Use ↑↓ to reselect before acting.");
  });

  it("shows compact link ids in selected session details", () => {
    const detail = session({
      slots: {
        links: [{ label: "jira", url: "https://jira.example.com/browse/OPS-9" }],
      },
    });
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [detail],
      selectedSessionId: "api-1",
      selectedDetail: detail,
      detailLoading: false,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });

    expect(output).toContain("jira OPS-9");
    expect(output).not.toContain("https://jira.example.com/browse/OPS-9");
  });

  it("shows a queued detail field for the selected session with 2 real queued messages at maxDetailLines 3 (A5/A1.1)", () => {
    const detail = session({ queuedMessages: { messages: ["a", "b"], awaitingPrompt: false } });
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [detail],
      selectedSessionId: "api-1",
      selectedDetail: detail,
      detailLoading: false,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });

    expect(output).toContain("queued 2");
  });

  it("shows no queued detail field for a selected session with no queuedMessages", () => {
    const detail = session({});
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [detail],
      selectedSessionId: "api-1",
      selectedDetail: detail,
      detailLoading: false,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });

    expect(output).not.toContain("queued");
  });

  it("shows no queued detail field for the real post-delivery shape {messages: [], awaitingPrompt: true} (A11)", () => {
    const detail = session({ queuedMessages: { messages: [], awaitingPrompt: true } });
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [detail],
      selectedSessionId: "api-1",
      selectedDetail: detail,
      detailLoading: false,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });

    expect(output).not.toContain("queued");
  });

  // Regression pin for the sessions-payload-projection change: the list row
  // no longer carries `prompt`/`launchCommand`, so the detail pane MUST read
  // them off a separately fetched `selectedDetail`, never off the row found
  // in `sessions`. cli-view.test.ts's own `session()` fixture supplies both
  // fields on every object it builds, so a case that passes a PROJECTED row
  // (no prompt/launchCommand) as the list entry, with the full detail
  // supplied only via `selectedDetail`, is the one case that actually
  // exercises the split — anything using `session()` for both would stay
  // green even if the pane read the wrong argument.
  it("detail pane renders prompt and launch from the fetched detail, not the list row", () => {
    const { prompt: _prompt, launchCommand: _launchCommand, ...projectedRow } = session({});
    const detail = session({ prompt: "Ship the feature", launchCommand: "claude --resume" });
    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [projectedRow],
      selectedSessionId: "api-1",
      selectedDetail: detail,
      detailLoading: false,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 8,
    });

    expect(output).toContain("Ship the feature");
    expect(output).toContain("claude --resume");
  });

  it("renders a loading line and does not throw while the detail fetch is in flight", () => {
    expect(() =>
      renderInteractiveSessionList({
        info: runtimeInfo(),
        sessions: [session({})],
        selectedSessionId: "api-1",
        selectedDetail: null,
        detailLoading: true,
        totalSessions: 1,
        windowStart: 0,
        maxDetailLines: 3,
      }),
    ).not.toThrow();

    const output = renderInteractiveSessionList({
      info: runtimeInfo(),
      sessions: [session({})],
      selectedSessionId: "api-1",
      selectedDetail: null,
      detailLoading: true,
      totalSessions: 1,
      windowStart: 0,
      maxDetailLines: 3,
    });
    expect(output).toContain("Loading");
  });
});
