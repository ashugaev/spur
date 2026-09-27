import { test as base } from "playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import type {
  AvailableBacklogItem,
  ProjectInfo,
  SpurSessionSidecarView,
  SpurSessionView,
} from "../src/lib/types";
import type { PrState } from "../src/lib/pr-status-shape";

const NOW = new Date().toISOString();

interface AgentModelFixture {
  id: string;
  label: string;
  isDefault?: boolean;
}

// A baseline, non-empty catalog per agent so a spec that never touches the
// model picker still resolves to a concrete preselection instead of hitting
// the real daemon. A spec exercising the picker itself registers its own
// /api/models route after calling mockSessions to override this.
const DEFAULT_AGENT_MODELS: Record<string, AgentModelFixture[]> = {
  claude: [
    { id: "opus", label: "Opus", isDefault: true },
    { id: "sonnet", label: "Sonnet" },
  ],
  codex: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }],
  cursor: [
    { id: "auto", label: "Auto", isDefault: true },
    { id: "composer-2.5", label: "Composer 2.5" },
  ],
  opencode: [{ id: "openai/gpt-5", label: "OpenAI GPT-5", isDefault: true }],
};

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
    // A real session always has a resolved launch model; respawn/handoff
    // carry it forward so their model control opens pre-resolved. A spec
    // testing the resolved-empty carve-out overrides with `model: undefined`.
    model: "opus",
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

// The daemon always publishes each sidecar's pane name, and for a session that
// is not a desk member that name is `<sessionId>--<name>`. Fixtures may leave it
// out and get the same value the daemon would send, so a spec only spells it out
// when it is testing a desk-shared sidecar (whose pane belongs to the anchor).
type SidecarFixture = Omit<SpurSessionSidecarView, "tmuxSession"> & {
  tmuxSession?: string;
};

function withSidecarPaneNames(
  session: Omit<SpurSessionView, "sidecars"> & { sidecars?: SidecarFixture[] },
): SpurSessionView {
  return {
    ...session,
    sidecars: (session.sidecars ?? []).map((sidecar) => ({
      ...sidecar,
      tmuxSession: sidecar.tmuxSession ?? `${session.id}--${sidecar.name}`,
    })),
  };
}

type SessionOverrides = Partial<Omit<SpurSessionView, "sidecars">> & {
  sidecars?: SidecarFixture[];
};

export function makeWorkingSession(overrides?: SessionOverrides): SpurSessionView {
  return withSidecarPaneNames({
    ...baseSession("session-working-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-working-1",
    status: "running",
    state: "working",
    ...overrides,
  });
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
  overrides?: SessionOverrides,
): SpurSessionView {
  return withSidecarPaneNames({
    ...baseSession("session-sidecar-1"),
    runtimeAlive: true,
    tmuxSession: "spur-session-sidecar-1",
    status: "running",
    state: "working",
    sidecars: [{ name, alive }],
    ...overrides,
  });
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

  await mockAgentModels(page, DEFAULT_AGENT_MODELS);
  await mockSpawnDefaults(page);
  await mockGitHubStatus(page, DEFAULT_GITHUB_STATUS);
  await mockGitLabStatus(page, DEFAULT_GITLAB_STATUS);
}

/**
 * Stub `GET /api/models?agent=<name>`. A spec exercising the model picker
 * with its own catalog calls this after `mockSessions` (or standalone, for a
 * spec that never calls `mockSessions`) — the later `page.route` registration
 * wins.
 */
export async function mockAgentModels(
  page: Page,
  byAgent: Record<string, AgentModelFixture[]>,
): Promise<void> {
  await page.route(/\/api\/models(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const agent = url.searchParams.get("agent") ?? "";
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: byAgent[agent] ?? [] }),
    });
  });
}

/**
 * Stub `GET /api/projects/:id/spawn-defaults`, same override rule as
 * {@link mockAgentModels}.
 */
export async function mockSpawnDefaults(
  page: Page,
  response: { model: string | null; worktree: boolean } = { model: null, worktree: true },
): Promise<void> {
  await page.route(/\/api\/projects\/[^/]+\/spawn-defaults(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
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

export async function mockPrState(page: Page, state: PrState): Promise<void> {
  await page.route(/\/api\/pr-status\?/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        state,
        ciStatus: null,
        canMerge: false,
        totalThreads: 0,
        unresolvedThreads: 0,
      }),
    });
  });
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

export { expect, devices } from "playwright/test";
export type { Browser, Locator, Page } from "playwright/test";

/**
 * Every spec imports `test` from here, so an /api request no spec mocked is
 * aborted and reported instead of reaching whatever daemon the environment
 * resolves to. Registered before the spec body runs, and Playwright checks the
 * most recently registered route first, so a spec's own narrower `page.route`
 * still wins. The throw lives after `use()` because a throw inside a route
 * handler is swallowed.
 */
const NEUTRAL_PR_STATUS = {
  state: null,
  ciStatus: null,
  canMerge: false,
  totalThreads: 0,
  unresolvedThreads: 0,
};

// Routes every page fetches on load, independent of what a spec exercises.
// Registered after the catch-all (so they win over it) and before the spec body
// (so a spec's own route wins over them).
const APP_SHELL_ROUTES: { pattern: string | RegExp; status?: number; body: unknown }[] = [
  { pattern: "**/api/runtime/info", body: { version: "0.0.0-test" } },
  {
    pattern: "**/api/runtime/versions",
    body: { current: "0.0.0-test", autoUpdate: false, available: [] },
  },
  { pattern: "**/api/runtime/voice", body: { available: false } },
  { pattern: "**/api/runtime/resources", body: { available: false, daemonAlive: true } },
  { pattern: "**/api/tags", body: { tags: [] } },
  { pattern: "**/api/github-status", body: DEFAULT_GITHUB_STATUS },
  { pattern: "**/api/gitlab-status", body: DEFAULT_GITLAB_STATUS },
  { pattern: /\/api\/pr-status\/batch$/, body: { results: {} } },
  { pattern: /\/api\/pr-status\?/, body: NEUTRAL_PR_STATUS },
  { pattern: /\/api\/models(\?.*)?$/, body: { models: [] } },
  {
    pattern: /\/api\/projects\/[^/]+\/spawn-defaults(\?.*)?$/,
    body: { model: null, worktree: true },
  },
  {
    pattern: /\/api\/projects\/[^/]+\/branches\/exists(\?.*)?$/,
    body: { exists: false, remote: false, checkedOutAt: null },
  },
  {
    pattern: /\/api\/sessions\/[^/]+\/todo$/,
    body: {
      revision: "event-0",
      status: "empty",
      counts: { total: 0, open: 0, held: 0, completed: 0, cancelled: 0 },
      items: [],
    },
  },
  {
    pattern: /\/api\/sessions\/[^/]+\/conversation(\?.*)?$/,
    body: { entries: [], messages: [], durationMs: 0, state: "working" },
  },
  // Artifact bytes belong to the spec that fabricated the artifact row; a run
  // that never mocked one gets the daemon's own answer for a file it does not
  // have.
  { pattern: /\/api\/sessions\/[^/]+\/artifacts\//, status: 404, body: { error: "Not found" } },
];

type ApiRouteTarget = Page | BrowserContext;

async function installApiRouteGuards(target: ApiRouteTarget, seen: string[]): Promise<void> {
  await target.route("**/api/**", async (route) => {
    seen.push(route.request().url());
    await route.abort("failed");
  });
  for (const { pattern, status, body } of APP_SHELL_ROUTES) {
    await target.route(pattern, async (route) => {
      await route.fulfill({
        status: status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }
}

export async function installApiRouteGuardsOnContext(context: BrowserContext): Promise<void> {
  await installApiRouteGuards(context, []);
}

export const test = base.extend<{ unmockedApiRequests: string[] }>({
  unmockedApiRequests: [
    async ({ page }, use) => {
      const seen: string[] = [];
      await installApiRouteGuards(page, seen);
      await use(seen);
      if (seen.length > 0) {
        throw new Error(`Unmocked /api request(s): ${seen.join(", ")}`);
      }
    },
    { auto: true },
  ],
});

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
  // Wait for route-level feedback to clear before interacting with content.
  await page.waitForFunction(() => !document.querySelector(".loader-bar, .loader-centered-mark"), {
    timeout: 8000,
  });
}
