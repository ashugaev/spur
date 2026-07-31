import type { Page } from "@playwright/test";
import type { AvailableBacklogItem, ProjectInfo, SpurSessionView } from "../src/lib/types";

const NOW = new Date().toISOString();
const DEFAULT_GITHUB_STATUS = {
  ok: true,
  requestedAt: "2026-04-28T10:00:00.000Z",
  configured: true,
};
const DEFAULT_GITLAB_STATUS = {
  ok: true,
  requestedAt: "2026-04-28T10:00:00.000Z",
  configured: true,
};

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
    runningSidecarNames: [],
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

export function makeErroredSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-errored-1"),
    runtimeAlive: false,
    tmuxSession: null,
    status: "errored",
    state: "error",
    error: "Agent runtime exited unexpectedly.",
    ...overrides,
  };
}

export function makeRateLimitedSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-rate-limited-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-rate-limited-1",
    status: "running",
    state: "rate_limited",
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

function normalizeProject(project: ProjectInfo): ProjectInfo {
  return {
    ...project,
    configured: project.configured ?? true,
    prefix: project.prefix ?? project.id,
    path: project.path ?? "",
  };
}

export async function mockSessions(
  page: Page,
  sessions: SpurSessionView[] | (() => SpurSessionView[]),
  projects?: ProjectInfo[] | (() => ProjectInfo[]),
  backlog?: AvailableBacklogItem[] | (() => AvailableBacklogItem[]),
): Promise<void> {
  // Match /api/sessions but not /api/sessions/<id>
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const rawProjects = typeof projects === "function" ? projects() : (projects ?? []);
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: typeof sessions === "function" ? sessions() : sessions,
        projects: rawProjects.map(normalizeProject),
        backlog: typeof backlog === "function" ? backlog() : (backlog ?? []),
      }),
    });
  });

  await page.route(/\/api\/sessions\/([^/]+)\/opened$/, (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2) ?? "");
    const currentSessions = typeof sessions === "function" ? sessions() : sessions;
    const openedSession = currentSessions.find((session) => session.id === id);
    void route.fulfill({
      status: openedSession ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(
        openedSession
          ? {
              ...openedSession,
              hasUnseenAttention: false,
              lastOpenedAt: new Date().toISOString(),
            }
          : { error: "Session not found" },
      ),
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
  await mockGitLabStatus(page, DEFAULT_GITLAB_STATUS);
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

export async function mockGitLabStatus(
  page: Page,
  body: Record<string, unknown>,
  options?: { status?: number },
): Promise<void> {
  await page.route("/api/gitlab-status", (route) => {
    void route.fulfill({
      status: options?.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/**
 * Stub `POST /api/pr-status/batch` with a fixed `url -> PrStatusResponse`
 * map and a request counter, so E2E specs can both drive the PR-ready
 * filter and assert the batch endpoint is never called while it's off.
 */
export async function mockPrStatusBatch(
  page: Page,
  byUrl: Record<string, Record<string, unknown>>,
): Promise<{ count: () => number }> {
  let requestCount = 0;
  await page.route(/\/api\/pr-status\/batch$/, (route) => {
    requestCount += 1;
    const payload = route.request().postDataJSON() as { urls?: unknown } | null;
    const urls = Array.isArray(payload?.urls) ? payload.urls : [];
    const results: Record<string, unknown> = {};
    for (const url of urls) {
      if (typeof url === "string" && byUrl[url]) {
        results[url] = byUrl[url];
      }
    }
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results }),
    });
  });
  return { count: () => requestCount };
}

export async function mockTagCatalog(page: Page): Promise<void> {
  await page.route("/api/tags", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tags: [] }),
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
  // Wait for the loading state to clear — the dashboard replaces "Loading..."
  // with actual content once the first mocked fetch resolves.
  await page.waitForFunction(() => !document.body.innerText.includes("Loading..."), {
    timeout: 8000,
  });
}
