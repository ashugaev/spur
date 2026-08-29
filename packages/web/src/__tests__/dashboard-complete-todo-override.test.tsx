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

const completedOk = () => new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));

// One fetch mock for every scenario: each POST to /complete consumes the next
// reply in `replies` (the last entry repeats once exhausted), so a test names
// its whole exchange as a short response sequence instead of a bespoke
// duplicated mock function.
function mockFetchComplete(completeBodies: unknown[], replies: ReadonlyArray<() => Response>) {
  let callIndex = 0;
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
      const reply = replies[Math.min(callIndex, replies.length - 1)];
      callIndex += 1;
      return reply();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function clickDone() {
  const done = await screen.findByRole("button", { name: "Mark api-c9e9 as done" });
  fireEvent.click(done);
}

describe("Dashboard complete with a todo override", () => {
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

  it("completes a session with open ToDo items in a single POST and no dialog", async () => {
    const completeBodies: unknown[] = [];
    mockFetchComplete(completeBodies, [completedOk]);
    render(<Dashboard />);

    await clickDone();

    await waitFor(() => expect(completeBodies).toHaveLength(1));
    expect(completeBodies).toEqual([{ scope: "desk" }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // A 409 todo_open_work is no longer a special case in the UI: it falls
  // through to the same generic error toast as any other failed complete,
  // with no dialog and no retry affordance.
  it("shows a generic error toast with no dialog on a 409 todo_open_work", async () => {
    const completeBodies: unknown[] = [];
    mockFetchComplete(completeBodies, [
      () =>
        new Response(
          JSON.stringify({
            code: "todo_open_work",
            sessions: [{ sessionId: "api-c9e9", openItemIds: ["item-1"], heldItemIds: [] }],
            error: "Spur ToDo has open or held items.",
          }),
          { status: 409 },
        ),
    ]);
    render(<Dashboard />);

    await clickDone();

    await waitFor(() => expect(completeBodies).toHaveLength(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Spur ToDo has open or held items.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // A failed complete never leaves the optimistic desk-wide write in place. The
  // finally block's invalidateQueries refetch would otherwise mask a missing
  // rollback, so the second /api/sessions call (the refetch) is gated open
  // only after the assertion, proving the restore itself — not a later
  // refetch — put the row back. The failure is a plain 500 (no ToDo coupling):
  // the daemon-side ToDo gate no longer surfaces through this UI at all.
  it("restores the optimistic write before the refetch settles", async () => {
    const completeBodies: unknown[] = [];
    let releaseSecondSessionsFetch: (() => void) | undefined;
    const secondSessionsGate = new Promise<void>((resolve) => {
      releaseSecondSessionsFetch = resolve;
    });
    let sessionsCallCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") {
        sessionsCallCount += 1;
        if (sessionsCallCount > 1) await secondSessionsGate;
        return new Response(JSON.stringify(sessionsResponse));
      }
      if (url === "/api/tags") return new Response(JSON.stringify({ tags: [] }));
      if (url === "/api/sessions/api-c9e9/complete") {
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
        completeBodies.push(body);
        return new Response("Internal Server Error", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<Dashboard />);

    await clickDone();
    await waitFor(() => expect(completeBodies).toHaveLength(1));

    // A missing rollback would leave the row's status "completed", hiding
    // Done (canComplete gates on isTerminalSession) until the gated refetch
    // below resolves and masks the gap.
    expect(screen.getByRole("button", { name: "Mark api-c9e9 as done" })).toBeInTheDocument();

    releaseSecondSessionsFetch?.();
    await waitFor(() => expect(sessionsCallCount).toBeGreaterThan(1));
  });
});
