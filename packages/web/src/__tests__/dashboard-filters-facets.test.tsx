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

function mockFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
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
    mockFetch();
  });

  it("counts a multi-subagent desk as 1 in Status, Project, and Agent facets alike", async () => {
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
