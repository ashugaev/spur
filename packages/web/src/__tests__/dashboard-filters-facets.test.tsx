import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

function render(ui: ReactElement, options?: RenderOptions) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));
vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => <div>{`terminal ${sessionId}`}</div>,
}));

// Two subagent sessions sharing `deskId: "desk-1"` — one desk, one row in
// every Filters modal facet (Status, Project, Agent) even though there are
// two underlying sessions.
function deskMember(id: string, title: string) {
  return {
    id,
    deskId: "desk-1",
    project: "api",
    agent: "claude",
    prompt: "prompt",
    branch: "main",
    worktree: false,
    tmuxSession: id,
    status: "running",
    state: "working",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    lastActivityAt: "2026-04-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/desk-1",
    services: [],
    slots: { title, links: [], tags: [] },
  };
}

const sessionsResponse = {
  projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
  sessions: [deskMember("api-anchor", "Desk anchor"), deskMember("api-sub", "Desk subagent")],
  daemonAlive: true,
};

function readyPrInfo(ready: boolean) {
  return {
    state: "open",
    reviewDecision: ready ? null : "changes_requested",
    ciStatus: null,
    canMerge: true,
    mergeConflict: false,
    totalThreads: 0,
    unresolvedThreads: 0,
  };
}

function mockFetch(readyUrlsByUrl: Record<string, boolean> = {}) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
    if (url === "/api/pr-status/batch") {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      const results: Record<string, unknown> = {};
      for (const prUrl of body.urls) {
        results[prUrl] = readyPrInfo(readyUrlsByUrl[prUrl] ?? false);
      }
      return new Response(JSON.stringify({ results }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
}

describe("Dashboard Filters modal facet counts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("counts a multi-subagent desk as 1 in Status, Project, and Agent facets alike", async () => {
    mockFetch();
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Desk anchor")).toBeInTheDocument());
    // Only the collapsed desk row renders, not one row per subagent.
    expect(screen.queryByText("Desk subagent")).not.toBeInTheDocument();

    openFilters();

    expect(screen.getByRole("button", { name: /^All statuses: 1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All: 1$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Claude: 1$/i })).toBeInTheDocument();
  });
});

// The desk's anchor session (picked by `collapseDeskRows` on activity/id
// order — "api-anchor" sorts first) carries no review link at all; only its
// subagent does. `prReadyFilteredSessions` already treats the desk as ready
// when ANY member has a ready PR — these guard the Filters modal chip count
// against reading only the anchor and under-counting.
describe("Dashboard Filters modal PR-ready facet", () => {
  const prUrl = "https://github.com/test/repo/pull/900";

  function sessionsWithReviewOnSubagentOnly() {
    const anchor = deskMember("api-anchor", "Desk anchor");
    const sub = {
      ...deskMember("api-sub", "Desk subagent"),
      slots: { title: "Desk subagent", links: [{ label: "github-pr", url: prUrl }], tags: [] },
    };
    return { ...sessionsResponse, sessions: [anchor, sub] };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("counts a desk as ready when the ready PR link is on a subagent, not the anchor", async () => {
    const responseWithSubagentPr = sessionsWithReviewOnSubagentOnly();
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") return new Response(JSON.stringify(responseWithSubagentPr));
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
      if (url === "/api/pr-status/batch") {
        const body = JSON.parse(String(init?.body)) as { urls: string[] };
        const results: Record<string, unknown> = {};
        for (const requested of body.urls) results[requested] = readyPrInfo(true);
        return new Response(JSON.stringify({ results }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Desk anchor")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Ready to merge:/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Ready to merge: 1$/ })).toBeInTheDocument(),
    );
  });

  it("honors prReadyOnly in the Project and Agent facet counts, not just Status", async () => {
    const readyUrl = "https://github.com/test/repo/pull/910";
    const notReadyUrl = "https://github.com/test/repo/pull/911";
    const sessions = {
      projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
      sessions: [
        {
          ...deskMember("ready-1", "Ready session"),
          slots: {
            title: "Ready session",
            links: [{ label: "github-pr", url: readyUrl }],
            tags: [],
          },
        },
        {
          ...deskMember("not-ready-1", "Not ready session"),
          deskId: "desk-2",
          slots: {
            title: "Not ready session",
            links: [{ label: "github-pr", url: notReadyUrl }],
            tags: [],
          },
        },
      ],
      daemonAlive: true,
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") return new Response(JSON.stringify(sessions));
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
      if (url === "/api/pr-status/batch") {
        const body = JSON.parse(String(init?.body)) as { urls: string[] };
        const results: Record<string, unknown> = {};
        for (const requested of body.urls) results[requested] = readyPrInfo(requested === readyUrl);
        return new Response(JSON.stringify({ results }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Ready session")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Ready to merge:/ }));

    // Only one of the two desks is ready, so once the toggle is honored the
    // Project ("All") and Agent ("Claude") facet counts must drop from 2 to
    // 1 — before the fix they stayed pinned at the pre-toggle value.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^All: 1$/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Claude: 1$/i })).toBeInTheDocument();
  });
});
