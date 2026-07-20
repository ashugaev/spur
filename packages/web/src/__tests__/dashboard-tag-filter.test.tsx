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
  sessions: [
    session("api-bug", "Bug session", ["bug"]),
    session("api-docs", "Docs session", ["docs"]),
    session("api-plain", "Plain session", []),
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

describe("Dashboard tag filter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    mockFetch();
  });

  it("keeps sessions carrying any selected tag (OR) and persists the array", async () => {
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.getByText("Plain session")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Filter by tag/ }));
    fireEvent.click(screen.getByRole("button", { name: "bug" }));

    await waitFor(() => expect(screen.queryByText("Plain session")).not.toBeInTheDocument());
    expect(screen.getByText("Bug session")).toBeInTheDocument();
    expect(screen.queryByText("Docs session")).not.toBeInTheDocument();

    // Add a second tag: OR keeps sessions matching either tag.
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    await waitFor(() => expect(screen.getByText("Docs session")).toBeInTheDocument());
    expect(screen.getByText("Bug session")).toBeInTheDocument();
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();

    expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug", "docs"]));

    // Deselect one tag narrows the list back down.
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    await waitFor(() => expect(screen.queryByText("Docs session")).not.toBeInTheDocument());
    expect(screen.getByText("Bug session")).toBeInTheDocument();
    expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug"]));
  });

  it("restores all persisted tags on remount", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["bug", "docs"]));
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.getByText("Docs session")).toBeInTheDocument();
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();
  });

  it("clears the selection via All tags and empties storage", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["bug"]));
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Filter by tag/ }));
    fireEvent.click(screen.getByRole("button", { name: "All tags" }));
    await waitFor(() => expect(screen.getByText("Plain session")).toBeInTheDocument());
    expect(window.localStorage.getItem("spur:tag-filters")).toBeNull();
  });

  it("clears the selection via Reset Filters when the filter empties the list", async () => {
    // A stat filter that hides everything forces the empty placeholder + Reset Filters.
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["bug"]));
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());

    // Narrow search so no session matches, revealing the empty placeholder.
    fireEvent.change(screen.getByPlaceholderText(/^Filter/i), {
      target: { value: "zzz-no-match" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reset Filters" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset Filters" }));
    await waitFor(() => expect(screen.getByText("Plain session")).toBeInTheDocument());
    expect(window.localStorage.getItem("spur:tag-filters")).toBeNull();
  });

  it("drops an unknown tag from a mixed array once the catalog loads", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["bug", "ghost"]));
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();
    expect(screen.queryByText("Docs session")).not.toBeInTheDocument();
    // The stale "ghost" tag is self-healed out of the persisted selection.
    await waitFor(() =>
      expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug"])),
    );
  });

  it("self-heals a selection of only stale tags back to unfiltered", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["ghost"]));
    render(<Dashboard />);
    // The only selected tag is absent from the catalog, so the filter clears
    // and every session (including untagged) becomes visible again.
    await waitFor(() => expect(screen.getByText("Plain session")).toBeInTheDocument());
    expect(screen.getByText("Bug session")).toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem("spur:tag-filters")).toBeNull());
  });

  it("trims whitespace around persisted tag names on load", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify(["  bug  ", "   "]));
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug"])),
    );
  });

  it("migrates the legacy single-tag key to a one-element array and drops the old key", async () => {
    window.localStorage.setItem("spur:tag-filter", "bug");
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug"])),
    );
    expect(window.localStorage.getItem("spur:tag-filter")).toBeNull();
  });

  it("falls through to the legacy key when the new key holds an empty array", async () => {
    window.localStorage.setItem("spur:tag-filters", JSON.stringify([]));
    window.localStorage.setItem("spur:tag-filter", "bug");
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());
    // The still-valid legacy value is migrated instead of being lost to the [].
    expect(screen.queryByText("Plain session")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem("spur:tag-filters")).toBe(JSON.stringify(["bug"])),
    );
    expect(window.localStorage.getItem("spur:tag-filter")).toBeNull();
  });

  it("omits configured tags that no visible session carries", async () => {
    const scoped = {
      ...sessionsResponse,
      sessions: [session("api-bug", "Bug session", ["bug"]), session("api-plain", "Plain", [])],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") return new Response(JSON.stringify(scoped));
      if (url === "/api/tags") return new Response(JSON.stringify(tagCatalogResponse));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<Dashboard />);
    await waitFor(() => expect(screen.getByText("Bug session")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Filter by tag/ }));
    expect(screen.getByRole("button", { name: "bug" })).toBeInTheDocument();
    // "docs" is in the catalog but applied to no session, so it must not appear.
    expect(screen.queryByRole("button", { name: "docs" })).not.toBeInTheDocument();
  });
});
