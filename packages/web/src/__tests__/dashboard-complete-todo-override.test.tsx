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

const todoOpenWorkPayload = {
  code: "todo_open_work",
  sessions: [{ sessionId: "api-c9e9", openItemIds: ["item-1"], heldItemIds: ["item-2"] }],
  error: "Spur ToDo has open or held items.",
};

const todoLedgerEmptyPayload = {
  code: "todo_ledger_empty",
  sessionId: "api-c9e9",
  error: "Spur ToDo ledger is empty.",
};

const openPrActionPayload = {
  code: "open_pr_action_required",
  sessionId: "api-c9e9",
  pr: { number: 3938, title: "Foreign PR", url: "https://github.com/other/web/pull/3938" },
};

function mockFetchOpenWork(completeBodies: unknown[]) {
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
      if (typeof record["todoOverrideReason"] === "string" && record["todoOverrideReason"]) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      return new Response(JSON.stringify(todoOpenWorkPayload), { status: 409 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function mockFetchLedgerEmpty(completeBodies: unknown[]) {
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
      if (typeof record["todoOverrideReason"] === "string" && record["todoOverrideReason"]) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      return new Response(JSON.stringify(todoLedgerEmptyPayload), { status: 409 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

// A second 409 hits after the override reason is sent — the dialog must
// reopen and accept a new reason, not dead-end.
function mockFetchOpenWorkTwice(completeBodies: unknown[]) {
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
      if (completeBodies.length >= 3) {
        return new Response(JSON.stringify({ completedIds: ["api-c9e9"] }));
      }
      return new Response(JSON.stringify(todoOpenWorkPayload), { status: 409 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

// A todo override retry that then trips open_pr_action_required must leave
// only the PR dialog mounted.
function mockFetchOpenWorkThenOpenPrAction(completeBodies: unknown[]) {
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
      if (typeof record["todoOverrideReason"] === "string" && record["todoOverrideReason"]) {
        return new Response(JSON.stringify(openPrActionPayload), { status: 409 });
      }
      return new Response(JSON.stringify(todoOpenWorkPayload), { status: 409 });
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

  // AC1
  it("opens the Unfinished ToDo dialog with the summed open/held counts, no toast", async () => {
    mockFetchOpenWork([]);
    render(<Dashboard />);

    await clickDone();

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Unfinished ToDo" })).toBeInTheDocument(),
    );
    expect(
      screen.getByText("1 open and 1 held items remain.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to complete Spur session")).not.toBeInTheDocument();
  });

  // AC2
  it("re-POSTs complete exactly once with the original body plus a reason, and completes", async () => {
    const completeBodies: unknown[] = [];
    mockFetchOpenWork(completeBodies);
    render(<Dashboard />);

    await clickDone();
    await screen.findByRole("dialog", { name: "Unfinished ToDo" });
    fireEvent.change(screen.getByLabelText("Override reason"), {
      target: { value: "shipping now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete anyway" }));

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    expect(completeBodies).toEqual([
      { scope: "desk" },
      { scope: "desk", todoOverrideReason: "shipping now" },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Unfinished ToDo" })).not.toBeInTheDocument(),
    );
  });

  // AC3
  it("opens the Empty ToDo dialog and the same retry works", async () => {
    const completeBodies: unknown[] = [];
    mockFetchLedgerEmpty(completeBodies);
    render(<Dashboard />);

    await clickDone();
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Empty ToDo" })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Override reason"), {
      target: { value: "empty by design" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete anyway" }));

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    expect(completeBodies[1]).toEqual({ scope: "desk", todoOverrideReason: "empty by design" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Empty ToDo" })).not.toBeInTheDocument(),
    );
  });

  // AC4
  it("cancelling sends no further POST and leaves the row present and enabled", async () => {
    const completeBodies: unknown[] = [];
    mockFetchOpenWork(completeBodies);
    render(<Dashboard />);

    await clickDone();
    await screen.findByRole("dialog", { name: "Unfinished ToDo" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(completeBodies).toHaveLength(1);
    const done = await screen.findByRole("button", { name: "Mark api-c9e9 as done" });
    await waitFor(() => expect(done).not.toBeDisabled());
  });

  // AC5
  it("reopens the dialog on a second 409 after an override and accepts a new reason", async () => {
    const completeBodies: unknown[] = [];
    mockFetchOpenWorkTwice(completeBodies);
    render(<Dashboard />);

    await clickDone();
    await screen.findByRole("dialog", { name: "Unfinished ToDo" });
    fireEvent.change(screen.getByLabelText("Override reason"), {
      target: { value: "first reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete anyway" }));

    await waitFor(() => expect(completeBodies).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Unfinished ToDo" })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Override reason"), {
      target: { value: "second reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete anyway" }));

    await waitFor(() => expect(completeBodies).toHaveLength(3));
    expect(completeBodies[2]).toEqual({ scope: "desk", todoOverrideReason: "second reason" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Unfinished ToDo" })).not.toBeInTheDocument(),
    );
  });

  // AC11
  it("clears the ToDo dialog when the override retry trips a PR dialog instead", async () => {
    const completeBodies: unknown[] = [];
    mockFetchOpenWorkThenOpenPrAction(completeBodies);
    render(<Dashboard />);

    await clickDone();
    await screen.findByRole("dialog", { name: "Unfinished ToDo" });
    fireEvent.change(screen.getByLabelText("Override reason"), {
      target: { value: "shipping now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete anyway" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Open Pull Request" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog", { name: "Unfinished ToDo" })).not.toBeInTheDocument();
  });
});
