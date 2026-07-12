import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "@/components/SessionDetail";
import type { SpurSessionView } from "@/lib/types";

// Mount the real SessionDetail so its actual tag flow — POST to
// /api/sessions/:id/tags, error parsing, error toast on failure, loadSession()
// refresh on success — is exercised end to end. Mirrors session-detail.test.tsx:
// same QueryClientProvider wrapper (needed by useTagCatalog) and fetch mocking.
function TestProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TestProviders });
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => <div>{`terminal ${sessionId}`}</div>,
}));

const tagCatalog = [
  { name: "bug", description: "A defect to fix", color: "hsl(0 62% 64%)" },
  { name: "docs", description: "Documentation only", color: "hsl(120 62% 64%)" },
];

function sessionFixture(tags: string[]): SpurSessionView {
  return {
    id: "api-a1",
    project: "api",
    agent: "claude",
    prompt: "Fix auth",
    branch: "feat/auth",
    worktree: true,
    tmuxSession: "api-a1",
    status: "running",
    state: "working",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    lastActivityAt: "2026-04-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/api-a1",
    services: [],
    artifacts: [],
    queuedMessages: { messages: [], awaitingPrompt: false },
    slots: { links: [], tags },
  } as unknown as SpurSessionView;
}

describe("SessionDetail tag flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("renders full-name chips from session.tags", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture(["bug"])), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") return new Response("not found", { status: 404 });
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: tagCatalog }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const chip = await screen.findByText("bug");
    expect(chip.getAttribute("style")).toContain("color-mix(in srgb");
  });

  it("POSTs the added tag and refreshes the session on success", async () => {
    let applied: string[] = [];
    let postBody: unknown = null;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture(applied)), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") return new Response("not found", { status: 404 });
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: tagCatalog }), { status: 200 });
      if (url === "/api/sessions/api-a1/tags" && init?.method === "POST") {
        postBody = JSON.parse(String(init.body));
        applied = ["bug"];
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByLabelText("Manage tags"));
    fireEvent.click(await screen.findByText("A defect to fix"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/api-a1/tags",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(postBody).toEqual({ add: ["bug"], remove: [] });

    // loadSession() refresh after the successful POST surfaces the new chip.
    expect(await screen.findByText("bug")).toBeInTheDocument();
  });

  it("shows an error toast and leaves chips unchanged when the POST fails", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture([])), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") return new Response("not found", { status: 404 });
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: tagCatalog }), { status: 200 });
      if (url === "/api/sessions/api-a1/tags" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Tag update rejected" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByLabelText("Manage tags"));
    fireEvent.click(await screen.findByText("A defect to fix"));

    expect(await screen.findByText("Tag update rejected")).toBeInTheDocument();
    // No chip was added: the popover closed and the session still carries no tags,
    // so "bug" appears nowhere (neither as a chip nor as an open add option).
    expect(screen.queryByText("bug")).not.toBeInTheDocument();
  });
});
