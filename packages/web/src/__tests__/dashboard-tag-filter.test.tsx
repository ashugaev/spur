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

function session(id: string, title: string, tags: string[]) {
  return {
    id,
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
    worktreePath: `/tmp/${id}`,
    services: [],
    slots: { title, links: [], tags },
  };
}

const sessionsResponse = {
  projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
  sessions: [session("api-bug", "Bug session", ["bug"]), session("api-plain", "Plain session", [])],
  tags: [
    { name: "bug", description: "A defect", color: "hsl(0 62% 64%)" },
    { name: "docs", description: "Docs only", color: "hsl(120 62% 64%)" },
  ],
  daemonAlive: true,
};

function mockFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("Dashboard tag filter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    mockFetch();
  });

  it("filters sessions to the selected tag and persists it to localStorage", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.getByText("Plain session")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Filter by tag"));
    fireEvent.click(screen.getByRole("button", { name: "bug" }));

    await waitFor(() => expect(screen.queryByText("Plain session")).not.toBeInTheDocument());
    expect(screen.getByText("Bug session")).toBeInTheDocument();
    expect(window.localStorage.getItem("spur:tag-filter")).toBe("bug");
  });

  it("omits configured tags that no visible session carries", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Filter by tag"));
    expect(screen.getByRole("button", { name: "bug" })).toBeInTheDocument();
    // "docs" is in the catalog but applied to no session, so it must not appear.
    expect(screen.queryByRole("button", { name: "docs" })).not.toBeInTheDocument();
  });

  it("auto-applies the persisted tag filter on load", async () => {
    window.localStorage.setItem("spur:tag-filter", "bug");
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();
  });
});
