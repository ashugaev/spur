import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import type { SpurSessionLink, SpurSessionsResponse, SpurSessionView } from "@/lib/types";

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
  return { ...rtlRender(ui, { wrapper: Wrapper, ...options }), client };
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
  afterEach(() => vi.useRealTimers());
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

describe("Dashboard lifecycle reconciliation", () => {
  const source: SpurSessionView = sessionsResponse.sessions[0];
  let list: SpurSessionsResponse;
  let current: Map<string, SpurSessionView>;
  let nextList: ReturnType<typeof deferredResponse> | undefined;
  let post: ReturnType<typeof deferredResponse>;
  let posts: string[];
  let detailFailure: boolean;
  let otherPost: ReturnType<typeof deferredResponse>;
  let nextDetail: ReturnType<typeof deferredResponse> | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    useSessionLinkPrInfoMock.mockReturnValue({ state: "merged", ciStatus: "success" });
    list = { ...sessionsResponse, sessions: [source] };
    current = new Map([[source.id, source]]);
    nextList = undefined;
    post = deferredResponse();
    otherPost = deferredResponse();
    nextDetail = undefined;
    posts = [];
    detailFailure = false;
    vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const json = (body: unknown, status = 200) =>
        Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (url === "/api/sessions") {
        if (nextList) {
          const held = nextList;
          nextList = undefined;
          return held.promise;
        }
        return json(list);
      }
      if (url === "/api/tags") return json({ tags: [] });
      if (url.startsWith("/api/runtime/")) return json({ available: false });
      if (url.endsWith("/complete") || url.endsWith("/restore")) {
        posts.push(url);
        return url.includes("api-other") ? otherPost.promise : post.promise;
      }
      const session = current.get(url.replace("/api/sessions/", ""));
      if (nextDetail) {
        const held = nextDetail;
        nextDetail = undefined;
        return held.promise;
      }
      if (session)
        return json(
          detailFailure ? { error: "detail failed" } : session,
          detailFailure ? 500 : 200,
        );
      throw new Error(`Unexpected fetch: ${url}`);
    });
  });
  afterEach(() => vi.useRealTimers());

  async function refetch(client: QueryClient) {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["sessions"] });
    });
  }
  const doneButton = () => screen.queryByRole("button", { name: `Mark ${source.id} as done` });
  const restoreButton = () =>
    screen.queryByRole("button", { name: `Restore session ${source.id}` });

  it.each(["complete", "restore"] as const)(
    "protects pending %s through three scheduled five-second polls",
    async (action) => {
      if (action === "restore") useSessionLinkPrInfoMock.mockReturnValue({ state: null });
      vi.useFakeTimers();
      render(<Dashboard />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const button = screen.getByRole("button", {
        name: action === "complete" ? `Mark ${source.id} as done` : `Restore session ${source.id}`,
      });
      fireEvent.click(button);
      for (let index = 0; index < 3; index += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(action === "complete" ? doneButton() : restoreButton()).not.toBeInTheDocument();
      }
      const fetchMock = vi.mocked(global.fetch);
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/sessions").length,
      ).toBeGreaterThanOrEqual(4);
    },
  );

  it("holds complete intent across matching, absent and old polls until POST and fresh confirmation", async () => {
    const { client } = render(<Dashboard />);
    await clickDone();
    for (const sessions of [
      [{ ...source, status: "completed" as const }],
      [],
      [source],
      [source],
    ]) {
      list = { ...list, sessions };
      await refetch(client);
      expect(doneButton()).not.toBeInTheDocument();
    }
    current.set(source.id, { ...source, status: "completed" });
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ completedIds: [source.id] })));
    });
    await refetch(client);
    expect(doneButton()).not.toBeInTheDocument();
    list = { ...list, sessions: [] };
    await refetch(client);
    list = { ...list, sessions: [source] };
    await refetch(client);
    expect(doneButton()).toBeInTheDocument();
  });

  it("retains omitted restores and uses returned Waiting before accepting a current stop", async () => {
    useSessionLinkPrInfoMock.mockReturnValue({ state: null });
    const { client } = render(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: `Restore session ${source.id}` }));
    for (const sessions of [[source], [source], [], [source]]) {
      list = { ...list, sessions };
      await refetch(client);
      expect(restoreButton()).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Open web terminal for ${source.id}` }),
      ).toBeInTheDocument();
    }
    const waiting: SpurSessionView = {
      ...source,
      status: "running",
      state: "waiting",
      runtimeAlive: true,
    };
    current.set(source.id, waiting);
    const held = deferredResponse();
    nextList = held;
    await act(async () => {
      post.resolve(new Response(JSON.stringify(waiting)));
    });
    await waitFor(() => expect(screen.getByText("Waiting")).toBeInTheDocument());
    held.resolve(new Response(JSON.stringify(list)));
    await waitFor(() => expect(restoreButton()).not.toBeInTheDocument());
    current.set(source.id, source);
    await refetch(client);
    expect(restoreButton()).toBeInTheDocument();
  });

  it.each(["complete", "restore"] as const)(
    "fences a GET begun before %s settlement",
    async (action) => {
      if (action === "restore") useSessionLinkPrInfoMock.mockReturnValue({ state: null });
      const { client } = render(<Dashboard />);
      const button = await screen.findByRole("button", {
        name: action === "complete" ? `Mark ${source.id} as done` : `Restore session ${source.id}`,
      });
      fireEvent.click(button);
      const stale = deferredResponse();
      nextList = stale;
      let pending!: Promise<void>;
      act(() => {
        pending = client.refetchQueries({ queryKey: ["sessions"] });
      });
      const outcome: SpurSessionView = {
        ...source,
        status: action === "complete" ? "completed" : "running",
        state: action === "complete" ? "stopped" : "waiting",
        runtimeAlive: action === "restore",
      };
      list = { ...list, sessions: [outcome] };
      current.set(source.id, outcome);
      await act(async () => {
        post.resolve(
          new Response(
            JSON.stringify(action === "complete" ? { completedIds: [source.id] } : outcome),
          ),
        );
      });
      await refetch(client);
      await act(async () => {
        stale.resolve(new Response(JSON.stringify(sessionsResponse)));
        await pending;
      });
      expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]?.status).toBe(
        outcome.status,
      );
    },
  );

  it("reconciles a partially failed grouped desk without reverting unrelated rows", async () => {
    const anchor: SpurSessionView = { ...source, workspaceId: "desk-partial" };
    const child: SpurSessionView = { ...anchor, id: "api-child", parentSessionId: source.id };
    list = { ...list, sessions: [anchor, child] };
    current.set(child.id, child);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { client } = render(<Dashboard />);
    await clickDone();
    await waitFor(() => expect(screen.queryByText("Cross repo session")).not.toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: `Mark ${child.id} as done` }),
    ).not.toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(
      "Complete this desk? 1 subagent on this checkout will be ended.",
    );
    const addition: SpurSessionView = {
      ...source,
      id: "api-new",
      worktreePath: "/tmp/new",
      slots: { ...source.slots, title: "New row" },
    };
    list = { ...list, sessions: [anchor, child, addition] };
    await refetch(client);
    const failed: SpurSessionView = {
      ...child,
      status: "errored",
      state: "error",
      slots: { ...child.slots, title: "Current failed member" },
    };
    current.set(source.id, { ...anchor, status: "completed" });
    current.set(child.id, failed);
    const reconciliation = deferredResponse();
    nextList = reconciliation;
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ error: "partial failure" }), { status: 500 }));
    });
    await waitFor(() => expect(screen.getByText("partial failure")).toBeInTheDocument());
    expect(doneButton()).not.toBeInTheDocument();
    expect(screen.getByText("New row")).toBeInTheDocument();
    expect(screen.getByText("Current failed member")).toBeInTheDocument();
    expect(
      client
        .getQueryData<SpurSessionsResponse>(["sessions"])
        ?.sessions.find((row) => row.id === child.id)?.status,
    ).toBe("errored");
    reconciliation.resolve(
      new Response(
        JSON.stringify({
          ...list,
          sessions: [{ ...anchor, status: "completed" }, failed, addition],
        }),
      ),
    );
  });

  it("protects returned desk members absent from the initial reservation", async () => {
    const anchor: SpurSessionView = { ...source, workspaceId: "desk-added" };
    const added: SpurSessionView = {
      ...anchor,
      id: "api-member",
      slots: { ...source.slots, title: "Added member" },
    };
    list = { ...list, sessions: [anchor] };
    const { client } = render(<Dashboard />);
    await clickDone();
    list = { ...list, sessions: [anchor, added] };
    await refetch(client);
    expect(screen.getByText("Added member")).toBeInTheDocument();
    current.set(anchor.id, { ...anchor, status: "completed" });
    current.set(added.id, { ...added, status: "completed" });
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ completedIds: [anchor.id, added.id] })));
    });
    await refetch(client);
    expect(screen.queryByText("Added member")).not.toBeInTheDocument();
    expect(doneButton()).not.toBeInTheDocument();
    list = {
      ...list,
      sessions: [
        { ...anchor, status: "completed" },
        { ...added, status: "completed" },
      ],
    };
    await refetch(client);
    list = { ...list, sessions: [anchor, added] };
    await refetch(client);
    expect(doneButton()).toBeInTheDocument();
  });

  it.each(["subset", "empty", "omitted"] as const)(
    "releases every reserved desk ID after a %s success outcome",
    async (outcome) => {
      const anchor: SpurSessionView = { ...source, deskId: "desk-outcome" };
      const child: SpurSessionView = { ...anchor, id: "api-child", parentSessionId: source.id };
      list = { ...list, sessions: [anchor, child] };
      current.set(anchor.id, anchor);
      current.set(child.id, child);
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { client } = render(<Dashboard />);
      await clickDone();
      await waitFor(() => expect(doneButton()).not.toBeInTheDocument());
      if (outcome === "omitted") {
        list = { ...list, sessions: [anchor] };
        await refetch(client);
      }
      const completedIds = outcome === "empty" ? [] : [child.id];
      if (outcome !== "empty") current.set(child.id, { ...child, status: "completed" });
      await act(async () => {
        post.resolve(new Response(JSON.stringify({ completedIds })));
      });
      await refetch(client);
      expect(doneButton()).toBeInTheDocument();
      if (outcome !== "empty") {
        list = { ...list, sessions: [anchor, { ...child, status: "completed" }] };
        await refetch(client);
      }
      list = { ...list, sessions: [anchor, child] };
      await refetch(client);
      post = deferredResponse();
      await clickDone();
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(window.confirm).toHaveBeenLastCalledWith(
        "Complete this desk? 1 subagent on this checkout will be ended.",
      );
    },
  );

  it("rejects intersecting desk actions while reconciliation awaits current detail", async () => {
    const anchor: SpurSessionView = { ...source, workspaceId: "desk-intersection" };
    const child: SpurSessionView = { ...anchor, id: "api-child", parentSessionId: source.id };
    list = { ...list, sessions: [anchor, child] };
    current.set(anchor.id, anchor);
    current.set(child.id, child);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { client } = render(<Dashboard />);
    const anchorButton = await screen.findByRole("button", { name: `Mark ${anchor.id} as done` });
    fireEvent.click(anchorButton);
    const added: SpurSessionView = {
      ...anchor,
      id: "api-new-member",
      lastActivityAt: "2026-08-01T12:00:00.000Z",
    };
    list = { ...list, sessions: [anchor, child, added] };
    await refetch(client);
    const intersecting = screen.getByRole("button", { name: `Mark ${added.id} as done` });
    fireEvent.click(intersecting);
    expect(posts).toHaveLength(1);
    const detail = deferredResponse();
    nextDetail = detail;
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ error: "failed" }), { status: 500 }));
    });
    fireEvent.click(intersecting);
    fireEvent.click(intersecting);
    expect(posts).toHaveLength(1);
    detail.resolve(new Response(JSON.stringify(anchor)));
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
    post = deferredResponse();
    fireEvent.click(screen.getByRole("button", { name: `Mark ${added.id} as done` }));
    await waitFor(() => expect(posts).toHaveLength(2));
  });

  it("keeps a different pending owner when an older completion returns its ID", async () => {
    const other: SpurSessionView = {
      ...source,
      id: "api-other",
      workspaceId: "other-desk",
      slots: { ...source.slots, title: "Other desk" },
    };
    list = { ...list, sessions: [source, other] };
    current.set(other.id, other);
    const { client } = render(<Dashboard />);
    await clickDone();
    fireEvent.click(screen.getByRole("button", { name: `Mark ${other.id} as done` }));
    list = { ...list, sessions: [source, { ...other, status: "completed" }] };
    current.set(source.id, { ...source, status: "completed" });
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ completedIds: [source.id, other.id] })));
    });
    await refetch(client);
    list = { ...list, sessions: [source, other] };
    await refetch(client);
    expect(
      screen.queryByRole("button", { name: `Mark ${other.id} as done` }),
    ).not.toBeInTheDocument();
    await act(async () => {
      otherPost.resolve(new Response(JSON.stringify({ error: "other failed" }), { status: 500 }));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Mark ${other.id} as done` })).toBeInTheDocument(),
    );
  });

  it("rejects repeated attempts and releases failed reconciliation for retry", async () => {
    const { client } = render(<Dashboard />);
    const button = await screen.findByRole("button", { name: `Mark ${source.id} as done` });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(posts).toHaveLength(1));
    detailFailure = true;
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ error: "failed" }), { status: 500 }));
    });
    await waitFor(() => expect(doneButton()).toBeInTheDocument());
    expect(screen.getByText("detail failed")).toBeInTheDocument();
    detailFailure = false;
    post = deferredResponse();
    await clickDone();
    await waitFor(() => expect(posts).toHaveLength(2));
    await refetch(client);
    expect(doneButton()).not.toBeInTheDocument();
  });

  it("preserves a disjoint pending operation when another fails after unrelated polling updates", async () => {
    const other: SpurSessionView = {
      ...source,
      id: "api-other",
      worktreePath: "/tmp/other",
      slots: { ...source.slots, title: "Other desk" },
    };
    list = { ...list, sessions: [source, other] };
    current.set(other.id, other);
    const { client } = render(<Dashboard />);
    await clickDone();
    fireEvent.click(screen.getByRole("button", { name: `Mark ${other.id} as done` }));
    const added: SpurSessionView = {
      ...source,
      id: "api-added",
      worktreePath: "/tmp/added",
      slots: { ...source.slots, title: "Added desk" },
    };
    list = { ...list, sessions: [source, other, added] };
    await refetch(client);
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ error: "first failed" }), { status: 500 }));
    });
    await waitFor(() => expect(doneButton()).toBeInTheDocument());
    expect(screen.getByText("Added desk")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Mark ${other.id} as done` }),
    ).not.toBeInTheDocument();
    await refetch(client);
    expect(
      screen.queryByRole("button", { name: `Mark ${other.id} as done` }),
    ).not.toBeInTheDocument();
  });

  it("accepts a current stopped detail immediately after a successful restore", async () => {
    useSessionLinkPrInfoMock.mockReturnValue({ state: null });
    render(<Dashboard />);
    fireEvent.click(await screen.findByRole("button", { name: `Restore session ${source.id}` }));
    const waiting: SpurSessionView = {
      ...source,
      status: "running",
      state: "waiting",
      runtimeAlive: true,
    };
    await act(async () => {
      post.resolve(new Response(JSON.stringify(waiting)));
    });
    await waitFor(() => expect(restoreButton()).toBeInTheDocument());
  });

  it.each([
    ["running", "stopped"],
    ["errored", "error"],
    ["running", "working"],
    ["running", "stale"],
  ] as const)(
    "does not confirm restore from old %s/%s rows with a dead runtime",
    async (status, state) => {
      useSessionLinkPrInfoMock.mockReturnValue({ state: null });
      const old: SpurSessionView = { ...source, status, state, runtimeAlive: false };
      list = { ...list, sessions: [old] };
      const waiting: SpurSessionView = {
        ...old,
        status: "running",
        state: "waiting",
        runtimeAlive: true,
      };
      current.set(source.id, waiting);
      const detail = deferredResponse();
      nextDetail = detail;
      render(<Dashboard />);
      fireEvent.click(await screen.findByRole("button", { name: `Restore session ${source.id}` }));
      await act(async () => {
        post.resolve(new Response(JSON.stringify(waiting)));
      });
      await waitFor(() => expect(nextDetail).toBeUndefined());
      expect(restoreButton()).not.toBeInTheDocument();
      expect(screen.getByText("Waiting")).toBeInTheDocument();
      list = { ...list, sessions: [waiting] };
      await act(async () => {
        detail.resolve(new Response(JSON.stringify(waiting)));
      });
      expect(restoreButton()).not.toBeInTheDocument();
    },
  );

  it("keeps completion hidden through terminal detail reads, then accepts an actual reopened session", async () => {
    const { client } = render(<Dashboard />);
    await clickDone();
    current.set(source.id, { ...source, status: "completed" });
    await act(async () => {
      post.resolve(new Response(JSON.stringify({ completedIds: [source.id] })));
    });
    await refetch(client);
    expect(doneButton()).not.toBeInTheDocument();
    await refetch(client);
    expect(doneButton()).not.toBeInTheDocument();
    expect(
      vi.mocked(global.fetch).mock.calls.filter(([url]) => url === `/api/sessions/${source.id}`)
        .length,
    ).toBeGreaterThanOrEqual(2);
    const reopened: SpurSessionView = {
      ...source,
      status: "running",
      state: "waiting",
      runtimeAlive: true,
    };
    current.set(source.id, reopened);
    await refetch(client);
    expect(doneButton()).toBeInTheDocument();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(client.getQueryData<SpurSessionsResponse>(["sessions"])?.sessions[0]?.runtimeAlive).toBe(
      true,
    );
  });
});
