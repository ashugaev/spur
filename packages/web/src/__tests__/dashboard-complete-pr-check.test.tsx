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

const PR_URL = "https://github.com/test/repo/pull/42";

const sessionsResponse = {
  projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
  sessions: [
    {
      id: "api-done",
      project: "api",
      agent: "claude",
      prompt: "prompt",
      branch: "feature/done",
      worktree: true,
      tmuxSession: "api-done",
      status: "running",
      state: "waiting",
      createdAt: "2026-04-02T10:00:00.000Z",
      updatedAt: "2026-04-02T10:00:00.000Z",
      lastActivityAt: "2026-04-02T10:00:00.000Z",
      runtimeAlive: true,
      workspaceExists: true,
      worktreePath: "/tmp/api-done",
      services: [],
      slots: { title: "Merged session", links: [{ label: "pr", url: PR_URL }], tags: [] },
    },
  ],
  daemonAlive: true,
};

const prCheckUnavailablePayload = {
  code: "github_pr_check_unavailable",
  sessionId: "api-done",
  pr: { number: 42, repo: "test/repo", url: PR_URL },
  rateLimited: true,
};

function mockFetch(completeResponses: Array<() => Response>) {
  const completeBodies: string[] = [];
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
    if (url.startsWith("/api/pr-status?")) {
      return new Response(JSON.stringify({ state: "merged", canMerge: false }));
    }
    if (url === "/api/sessions/api-done/complete") {
      completeBodies.push(typeof init?.body === "string" ? init.body : "");
      const next = completeResponses.shift();
      if (!next) throw new Error("Unexpected extra complete request");
      return next();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return completeBodies;
}

function unavailable() {
  return new Response(JSON.stringify(prCheckUnavailablePayload), { status: 409 });
}

function completed() {
  return new Response(JSON.stringify({ completedIds: ["api-done"] }));
}

async function clickDone() {
  const done = await screen.findByRole("button", { name: "Mark api-done as done" });
  fireEvent.click(done);
}

describe("Dashboard complete with an unavailable GitHub PR check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("opens the recovery dialog instead of failing the row", async () => {
    mockFetch([unavailable]);
    render(<Dashboard />);
    await clickDone();

    await waitFor(() =>
      expect(screen.getByText("GitHub PR Check Unavailable")).toBeInTheDocument(),
    );
    // The row is rolled back to its pre-click state, not left half-completed.
    expect(screen.getByText("Merged session")).toBeInTheDocument();
  });

  it("resends the complete request with skipPrCheck when the user skips", async () => {
    const bodies = mockFetch([unavailable, completed]);
    render(<Dashboard />);
    await clickDone();

    const skip = await screen.findByRole("button", { name: /Skip PR Check/i });
    fireEvent.click(skip);

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1] ?? "{}")).toMatchObject({ scope: "desk", skipPrCheck: true });
    await waitFor(() =>
      expect(screen.queryByText("GitHub PR Check Unavailable")).not.toBeInTheDocument(),
    );
  });

  it("keeps the dialog open when the retry hits the same rate limit", async () => {
    const bodies = mockFetch([unavailable, unavailable]);
    render(<Dashboard />);
    await clickDone();

    const retry = await screen.findByRole("button", { name: /Retry PR Check/i });
    fireEvent.click(retry);

    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(JSON.parse(bodies[1] ?? "{}")).not.toHaveProperty("skipPrCheck");
    expect(screen.getByText("GitHub PR Check Unavailable")).toBeInTheDocument();
  });
});
