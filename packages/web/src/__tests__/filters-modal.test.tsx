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

function session(
  id: string,
  project: string,
  agent: "claude" | "codex",
  status: string,
  state: string,
  tags: string[],
) {
  return {
    id,
    project,
    agent,
    prompt: "prompt",
    branch: "main",
    worktree: false,
    tmuxSession: id,
    status,
    state,
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    lastActivityAt: "2026-04-02T10:00:00.000Z",
    runtimeAlive: status === "running",
    workspaceExists: true,
    worktreePath: `/tmp/${id}`,
    services: [],
    slots: { title: id, links: [], tags },
  };
}

const sessionsResponse = {
  projects: [
    { id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" },
    { id: "web", name: "Web", configured: true, prefix: "web", path: "/tmp/web" },
  ],
  sessions: [
    session("api-1", "api", "claude", "running", "working", ["bug"]),
    session("api-2", "api", "codex", "stopped", "stopped", []),
    session("web-1", "web", "claude", "running", "needs_input", ["docs"]),
  ],
  daemonAlive: true,
};

const tagCatalogResponse = {
  tags: [
    { name: "bug", description: "A defect", color: "hsl(0 62% 64%)" },
    { name: "docs", description: "Docs only", color: "hsl(120 62% 64%)" },
  ],
};

function mockFetch() {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify(tagCatalogResponse));
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
}

describe("Filters modal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    mockFetch();
  });

  it("stays absent from the DOM until the trigger opens it", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();

    openFilters();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
  });

  it("shows no badge with no active filters and counts each dimension once selected", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    const trigger = screen.getByRole("button", { name: "Filters" });
    expect(trigger).toHaveTextContent("Filters");
    expect(trigger.querySelector(".tabular-nums")).toBeNull();

    openFilters();
    // Status
    fireEvent.click(screen.getByRole("button", { name: /^Working:/ }));
    // Project
    fireEvent.click(screen.getByRole("button", { name: /^API:/ }));
    // Agent
    fireEvent.click(screen.getByRole("button", { name: /^claude:/ }));
    // Tag
    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    // PR-ready toggle
    fireEvent.click(screen.getByRole("button", { name: /^Ready to merge:/ }));

    await waitFor(() => {
      expect(trigger).toHaveTextContent("5");
    });

    // Search text must not affect the badge count.
    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "api" } });
    expect(trigger).toHaveTextContent("5");
  });

  it("toggles the Status section and narrows the session list", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Stopped:/ }));

    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(screen.getByText("api-2")).toBeInTheDocument();
  });

  it("toggles the Project section and narrows the session list", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Web:/ }));

    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("toggles the Agent section (multi-select) and narrows the session list", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^codex:/ }));

    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(screen.getByText("api-2")).toBeInTheDocument();
    expect(screen.queryByText("web-1")).not.toBeInTheDocument();

    // Multi-select: adding claude widens the set back out.
    fireEvent.click(screen.getByRole("button", { name: /^claude:/ }));
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("toggles the Tags section and narrows the session list", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^docs:/ }));

    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("toggles Ready to merge and narrows to nothing when no session has a GitHub review link", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    const toggle = screen.getByRole("button", { name: /^Ready to merge:/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // None of the fixture sessions carry a GitHub review link, so the batch
    // (with zero GitHub URLs to fetch) resolves synchronously to an empty
    // ready set, and the list narrows to nothing.
    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(screen.queryByText("api-2")).not.toBeInTheDocument();
    expect(screen.queryByText("web-1")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());
    expect(screen.getByText("api-2")).toBeInTheDocument();
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("clear all resets every dimension including PR-ready and search", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Filter sessions"), { target: { value: "api" } });
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Working:/ }));
    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Ready to merge:/ }));

    fireEvent.click(screen.getByRole("button", { name: "clear all" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Ready to merge:/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    expect(screen.getByLabelText("Filter sessions")).toHaveValue("");
    expect(screen.getByText("api-2")).toBeInTheDocument();
  });

  it("closes on Escape and on backdrop click", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();

    openFilters();
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
  });
});
