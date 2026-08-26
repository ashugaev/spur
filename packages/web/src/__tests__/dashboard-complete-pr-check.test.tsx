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
import type { SpurSessionLink } from "@/lib/types";

const useSessionLinkPrInfoMock = vi.fn();

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));
vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => <div>{`terminal ${sessionId}`}</div>,
}));
// The row only renders Done for a merged/closed PR, so the live PR probe is
// stubbed rather than driven through /api/pr-status.
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: (...args: Parameters<typeof useSessionLinkPrInfoMock>) =>
    useSessionLinkPrInfoMock(...args),
  SessionLinkBadge: ({ link }: { link: SpurSessionLink }) => <a href={link.url}>{link.label}</a>,
}));

function render(ui: ReactElement, options?: RenderOptions) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

const sessionsResponse = {
  projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/tmp/api" }],
  sessions: [
    {
      id: "api-c9e9",
      project: "api",
      agent: "claude",
      prompt: "prompt",
      branch: "feature/reviewer-autospawn-fix",
      worktree: true,
      tmuxSession: "api-c9e9",
      status: "stopped",
      state: "stopped",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      lastActivityAt: "2026-08-01T10:00:00.000Z",
      runtimeAlive: false,
      workspaceExists: true,
      worktreePath: "/tmp/api-c9e9",
      services: [],
      slots: {
        title: "Cross repo session",
        links: [{ label: "pr", url: "https://github.com/other/web/pull/3938" }],
        tags: [],
      },
    },
  ],
  daemonAlive: true,
};

const prCheckUnavailablePayload = {
  code: "github_pr_check_unavailable",
  sessionId: "api-c9e9",
  rateLimited: false,
  pr: { number: 3938, repo: "other/web", url: "https://github.com/other/web/pull/3938" },
};

function mockFetch(completeBodies: unknown[], options?: { skipAlsoFails?: true }) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
    if (url === "/api/sessions/api-c9e9/complete") {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      completeBodies.push(body);
      const record = body as Record<string, unknown>;
      if (record["skipPrCheck"] === true && !options?.skipAlsoFails) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      return new Response(JSON.stringify(prCheckUnavailablePayload), { status: 409 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const openPrActionPayload = {
  code: "open_pr_action_required",
  sessionId: "api-c9e9",
  pr: { number: 3938, title: "Foreign PR", url: "https://github.com/other/web/pull/3938" },
};

// First complete asks for an open-PR action, the follow-up hits the PR-check
// 409, and the skip succeeds — the sequence that stacked both dialogs.
function mockFetchOpenPrThenUnavailable(completeBodies: unknown[]) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
    if (url === "/api/sessions/api-c9e9/complete") {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      completeBodies.push(body);
      const record = body as Record<string, unknown>;
      if (record["skipPrCheck"] === true) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      if (record["prAction"] === "close") {
        return new Response(JSON.stringify(prCheckUnavailablePayload), { status: 409 });
      }
      return new Response(JSON.stringify(openPrActionPayload), { status: 409 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

// Retry is offered only for a rate limit, the one failure that clears on its
// own. The second complete lands after the window resets.
function mockFetchRateLimitedThenRetryOk(completeBodies: unknown[]) {
  vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/resources") return new Response(JSON.stringify({ available: false }));
    if (url === "/api/runtime/voice")
      return new Response(JSON.stringify({ available: false, language: "" }));
    if (url === "/api/sessions") return new Response(JSON.stringify(sessionsResponse));
    if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
    if (url === "/api/sessions/api-c9e9/complete") {
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
      completeBodies.push(body);
      if (completeBodies.length > 1) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      return new Response(JSON.stringify({ ...prCheckUnavailablePayload, rateLimited: true }), {
        status: 409,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function clickDone() {
  const done = await screen.findByRole("button", { name: "Mark api-c9e9 as done" });
  fireEvent.click(done);
}

describe("Dashboard complete with an unavailable PR check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    useSessionLinkPrInfoMock.mockReturnValue({
      state: "merged",
      reviewDecision: null,
      ciStatus: "success",
      canMerge: false,
      totalThreads: 0,
      unresolvedThreads: 0,
      stale: false,
      fetchedAt: Date.now(),
    });
  });

  // Without this branch the 409 payload carries no `error` field, so the row's
  // failure fell through to a bare "Failed to complete Spur session" toast with
  // no way out — the dashboard never reached Skip.
  it("opens the PR-check dialog instead of a dead-end toast", async () => {
    mockFetch([]);
    render(<Dashboard />);

    await clickDone();

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Failed to complete Spur session")).not.toBeInTheDocument();
  });

  it("resends complete with skipPrCheck when skipping", async () => {
    const completeBodies: unknown[] = [];
    mockFetch(completeBodies);
    render(<Dashboard />);

    await clickDone();
    const skip = await screen.findByRole("button", { name: /Skip PR Check/i });
    fireEvent.click(skip);

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    expect(completeBodies).toEqual([{ scope: "desk" }, { scope: "desk", skipPrCheck: true }]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).not.toBeInTheDocument(),
    );
  });

  // Dismissing on anything but a real completion drops the user back to a bare
  // row with no way to reach Skip again.
  it("keeps the dialog open when the retried complete fails again", async () => {
    const completeBodies: unknown[] = [];
    mockFetch(completeBodies, { skipAlsoFails: true });
    render(<Dashboard />);

    await clickDone();
    const skip = await screen.findByRole("button", { name: /Skip PR Check/i });
    fireEvent.click(skip);

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    expect(screen.getByRole("dialog", { name: "GitHub PR Check Unavailable" })).toBeInTheDocument();
  });

  it("completes on retry once the rate limit clears, without skipping the check", async () => {
    const completeBodies: unknown[] = [];
    mockFetchRateLimitedThenRetryOk(completeBodies);
    render(<Dashboard />);

    await clickDone();
    fireEvent.click(await screen.findByRole("button", { name: /Retry PR Check/i }));

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    expect(completeBodies).toEqual([{ scope: "desk" }, { scope: "desk" }]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).not.toBeInTheDocument(),
    );
  });

  // Cancelling leaves the row in place, so its Done button has to come back.
  // Held disabled, the session can never be closed again without a reload.
  it("re-enables Done after the dialog is cancelled", async () => {
    const completeBodies: unknown[] = [];
    mockFetch(completeBodies);
    render(<Dashboard />);

    await clickDone();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    const done = await screen.findByRole("button", { name: "Mark api-c9e9 as done" });
    await waitFor(() => expect(done).not.toBeDisabled());

    fireEvent.click(done);
    await waitFor(() => expect(completeBodies).toHaveLength(2));
  });

  // The two PR dialogs are alternatives for one attempt. Stacked, the stale one
  // outlives a successful skip and can re-fire /complete on a terminal session.
  it("replaces the open-PR dialog instead of stacking both", async () => {
    const completeBodies: unknown[] = [];
    mockFetchOpenPrThenUnavailable(completeBodies);
    render(<Dashboard />);

    await clickDone();
    fireEvent.click(await screen.findByRole("button", { name: "Close Pull Request" }));

    const prCheckDialog = await screen.findByRole("dialog", {
      name: "GitHub PR Check Unavailable",
    });
    expect(prCheckDialog).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Open Pull Request" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Skip PR Check/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog", { name: "Open Pull Request" })).not.toBeInTheDocument();
  });
});
