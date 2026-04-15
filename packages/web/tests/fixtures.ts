import type { Page } from "@playwright/test";

export interface SpurSessionLink {
  label: string;
  url: string;
}

export interface SpurServiceView {
  serviceId: string;
  status: "running" | "stopped" | "errored";
  state: "running" | "problem" | "stopped" | "error";
  command: string;
  cwd: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  port?: number;
}

export type SpurSessionStatus =
  | "spawning"
  | "running"
  | "paused"
  | "errored"
  | "completed"
  | "killed";

export type SpurSessionState =
  | "working"
  | "waiting"
  | "needs_input"
  | "stopped"
  | "error"
  | "killed";

export interface SpurSessionView {
  id: string;
  project: string;
  agent: "claude" | "codex";
  prompt: string;
  branch: string;
  worktree: boolean;
  tmuxSession: string | null;
  status: SpurSessionStatus;
  state: SpurSessionState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  runtimeAlive: boolean;
  workspaceExists: boolean;
  worktreePath: string;
  services: SpurServiceView[];
  sidecars?: { name: string; alive: boolean }[];
  slots?: {
    title?: string;
    links: SpurSessionLink[];
  };
  error?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
}

const NOW = new Date().toISOString();

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

export function makeStoppedSession(overrides?: Partial<SpurSessionView>): SpurSessionView {
  return {
    ...baseSession("session-stopped-1"),
    runtimeAlive: false,
    tmuxSession: null,
    status: "paused",
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
      links: [{ label: "pr", url: "https://github.com/test/repo/pull/42" }],
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
  sessions: SpurSessionView[],
  projects?: ProjectInfo[],
): Promise<void> {
  const body = JSON.stringify({
    sessions,
    projects: projects ?? [],
  });

  // Match /api/sessions and /api/sessions?project=... but NOT /api/sessions/<id>
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body,
    });
  });

  await page.route("/api/runtime/resources", (route) => {
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ available: false }),
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
