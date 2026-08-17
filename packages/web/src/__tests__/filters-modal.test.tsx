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

  it("shows an unknown state for Ready to merge before the toggle has ever fetched", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    // The toggle is off, so `usePrReadyUrls` has never fetched: the count
    // must read as "not counted yet", not a literal 0.
    expect(screen.getByRole("button", { name: /^Ready to merge: –$/ })).toBeInTheDocument();
  });

  it("All tags chip is pressed with no tag filter, unpressed after selecting a tag, and clicking it clears the filter", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    const allTags = screen.getByRole("button", { name: /^All tags:/ });
    expect(allTags).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    await waitFor(() => expect(screen.queryByText("web-1")).not.toBeInTheDocument());
    expect(allTags).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(allTags);
    await waitFor(() => expect(screen.getByText("web-1")).toBeInTheDocument());
    expect(allTags).toHaveAttribute("aria-pressed", "true");
  });

  it("All agents chip is pressed with no agent filter, unpressed after selecting an agent, and clicking it clears the filter", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    const allAgents = screen.getByRole("button", { name: /^All agents:/ });
    expect(allAgents).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /^codex:/ }));
    await waitFor(() => expect(screen.queryByText("api-1")).not.toBeInTheDocument());
    expect(allAgents).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(allAgents);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());
    expect(allAgents).toHaveAttribute("aria-pressed", "true");
  });

  it("Reset tag filters clears only the tag dimension, leaving agent filters untouched", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    fireEvent.click(screen.getByRole("button", { name: /^docs:/ }));
    fireEvent.click(screen.getByRole("button", { name: /^codex:/ }));

    const trigger = screen.getByRole("button", { name: "Filters" });
    await waitFor(() => expect(trigger).toHaveTextContent("3"));

    fireEvent.click(screen.getByRole("button", { name: "Reset tag filters" }));

    await waitFor(() => expect(trigger).toHaveTextContent("1"));
    expect(screen.getByRole("button", { name: /^codex:/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^All tags:/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Reset agent filters clears only the agent dimension, leaving the tag chip pressed", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    fireEvent.click(screen.getByRole("button", { name: /^codex:/ }));

    fireEvent.click(screen.getByRole("button", { name: "Reset agent filters" }));

    expect(screen.queryByRole("button", { name: "Reset agent filters" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^bug:/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^All agents:/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides both reset buttons when neither section has an active selection", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    expect(screen.queryByRole("button", { name: "Reset tag filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset agent filters" })).not.toBeInTheDocument();
  });

  it("styles the reset button as text-only tertiary with no border or background", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^bug:/ }));
    const reset = screen.getByRole("button", { name: "Reset tag filters" });

    expect(reset).toHaveClass("text-[var(--color-text-tertiary)]");
    expect(reset.className).not.toMatch(/\b(border|bg-)/);
  });

  it("All tags count reflects desks matching other filters, not the sum of individual tag chip counts", async () => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    const multiTagResponse = {
      projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
      sessions: [
        session("api-1", "api", "claude", "running", "working", ["bug", "docs"]),
        session("api-2", "api", "codex", "stopped", "stopped", []),
        session("api-3", "api", "codex", "stopped", "stopped", []),
      ],
      daemonAlive: true,
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") return new Response(JSON.stringify(multiTagResponse));
      if (url === "/api/tags") return new Response(JSON.stringify(tagCatalogResponse));
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    // Sum of individual tag chip counts: bug=1 desk, docs=1 desk -> 2 (the
    // bug+docs desk is counted once per tag it carries).
    expect(screen.getByRole("button", { name: /^bug:/ })).toHaveTextContent("bug:1");
    expect(screen.getByRole("button", { name: /^docs:/ })).toHaveTextContent("docs:1");
    // All tags counts every desk matching other filters once, including the
    // two untagged desks (api-2, api-3) -> 3 desks total, which does NOT
    // equal the 2-chip sum above.
    expect(screen.getByRole("button", { name: /^All tags:/ })).toHaveTextContent("All tags:3");
  });

  it("traps focus inside the dialog and puts initial focus there", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    const dialog = screen.getByRole("dialog", { name: "Filters" });

    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    const doneButton = screen.getByRole("button", { name: "done" });
    doneButton.focus();
    expect(document.activeElement).toBe(doneButton);

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Tabbing forward off the last focusable control wraps back to the first.
    expect(document.activeElement).not.toBe(doneButton);
  });
});

describe("Filters modal — PR-ready batch failure", () => {
  const sessionsWithReviewLink = {
    projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
    sessions: [
      {
        ...session("api-1", "api", "claude", "running", "working", []),
        slots: {
          title: "api-1",
          links: [{ label: "github-pr", url: "https://github.com/test/repo/pull/1" }],
          tags: [],
        },
      },
    ],
    daemonAlive: true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") return new Response(JSON.stringify(sessionsWithReviewLink));
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
      if (url === "/api/pr-status/batch") return new Response("{}", { status: 500 });
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });

  it("gives a subtle unavailable hint when the toggle is on but the batch failed", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("api-1")).toBeInTheDocument());

    openFilters();
    fireEvent.click(screen.getByRole("button", { name: /^Ready to merge:/ }));

    await waitFor(() => {
      const toggle = screen.getByRole("button", { name: /^Ready to merge: –$/ });
      expect(toggle).toHaveAttribute("title", "GitHub only — status unavailable");
    });
  });
});
