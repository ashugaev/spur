import type { Page } from "@playwright/test";
import type { ProjectInfo, SpurSessionView } from "../src/lib/types";

const NOW = new Date().toISOString();
const DEFAULT_GITHUB_STATUS = { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" };

function baseSession(id: string): SpurSessionView {
  return {
    id,
    project: "test-project",
    agent: "claude",
    prompt: "Implement the feature",
    branch: "feature/test",
    worktree: true,
    tmuxSession: `spur-${id}`,
    status: "running",
    state: "working",
    createdAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: `/tmp/worktrees/${id}`,
    services: [],
    artifacts: [],
    queuedMessages: {
      messages: [],
      awaitingPrompt: false,
    },
    sidecars: [],
    slots: { links: [] },
  };
}

export function makeWorkingSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-working-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-working-1",
    status: "running",
    state: "working",
    ...overrides,
  };
}

export function makeSpawningSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-spawning-1"),
    runtimeAlive: false,
    status: "spawning",
    state: "working",
    workspaceExists: false,
    ...overrides,
  };
}

export function makeStoppedSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-stopped-1"),
    runtimeAlive: false,
    tmuxSession: null,
    status: "stopped",
    state: "stopped",
    ...overrides,
  };
}

export function makeCompletedSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-completed-1"),
    runtimeAlive: false,
    tmuxSession: null,
    status: "completed",
    state: "stopped",
    ...overrides,
  };
}

export function makeNeedsInputSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-needs-input-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-needs-input-1",
    status: "running",
    state: "needs_input",
    ...overrides,
  };
}

export function makeWaitingSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-waiting-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-waiting-1",
    status: "running",
    state: "waiting",
    ...overrides,
  };
}

export function makeSessionWithPR(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-pr-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-pr-1",
    status: "running",
    state: "working",
    slots: {
      title: "Session with PR",
      links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/42" }],
    },
    ...overrides,
  };
}

export function makeSessionWithTracker(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-tracker-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-tracker-1",
    status: "running",
    state: "working",
    slots: {
      title: "Session with tracker",
      links: [
        {
          label: "tracker",
          url: "https://jira.example.com/browse/WEBDEV-4617",
        },
      ],
    },
    ...overrides,
  };
}

export function makeSessionWithSidecar(
  name: string,
  alive: boolean,
  overrides?: Partial<SpurSessionView>,
): SpurSessionView {
  return {
    ...baseSession("session-sidecar-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-sidecar-1",
    status: "running",
    state: "working",
    sidecars: [{ name, alive }],
    ...overrides,
  };
}

export async function mockSessions(
  page: Page,
  sessions: SpurSessionView[] | (() => SpurSessionView[]),
  projects?: ProjectInfo[] | (() => ProjectInfo[]),
): Promise<void> {
  // Match /api/sessions and /api/sessions?project=... but NOT /api/sessions/<id>
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: typeof sessions === "function" ? sessions() : sessions,
        projects: typeof projects === "function" ? projects() : (projects ?? []),
      }),
    });
  });

  await page.route("/api/runtime/resources", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: false, daemonAlive: true }),
    });
  });

  await mockGitHubStatus(page, DEFAULT_GITHUB_STATUS);
}

export async function mockGitHubStatus(
  page: Page,
  body: Record<string, unknown>,
  options?: { status?: number },
): Promise<void> {
  await page.route("/api/github-status", (route) => {
    void route.fulfill({
      status: options?.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/**
 * Navigate to the given path after setting up mocks and wait until the
 * dashboard has rendered the mocked data. This prevents races where the
 * first `getBy*` assertion fires before the component has re-rendered.
 */
export async function gotoMocked(
  page: Page,
  path: string,
  sessions: SpurSessionView[],
  projects?: ProjectInfo[],
): Promise<void> {
  await mockSessions(page, sessions, projects);
  await page.goto(path);
  // Wait for the loading state to clear — the dashboard replaces "Loading
  // sessions..." with actual content once the first mocked fetch resolves.
  await page.waitForFunction(() => !document.body.innerText.includes("Loading sessions"), {
    timeout: 8000,
  });
}
