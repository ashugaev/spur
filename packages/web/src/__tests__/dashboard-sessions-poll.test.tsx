import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));
vi.mock("@/components/DirectTerminal", () => ({ DirectTerminal: () => <div /> }));
vi.mock("@/components/SessionLinkBadge", () => ({
  useSessionLinkPrInfo: () => ({ state: null }),
  SessionLinkBadge: () => null,
}));

const backend = vi.hoisted(() => ({ phase: "connected" as "connected" | "disconnected" }));
vi.mock("@/lib/backend-connection-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend-connection-context")>()),
  useBackendConnection: () => ({ phase: backend.phase, attempts: 0, version: null }),
}));

const BASE_MS = 5_000;

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  // Real visibilitychange bubbles to window, where React Query's focusManager listens.
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Dashboard sessions poll", () => {
  let sessionsOk: boolean;
  let sessionsReadMs: number;
  let sessionsCalls: number[];
  let t0: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    setVisibility("visible");
    backend.phase = "connected";
    sessionsOk = true;
    sessionsReadMs = 0;
    sessionsCalls = [];
    t0 = Date.now();
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/sessions") {
        sessionsCalls.push(Date.now() - t0);
        if (sessionsReadMs > 0) await new Promise((resolve) => setTimeout(resolve, sessionsReadMs));
        if (!sessionsOk) return new Response("{}", { status: 500 });
        return new Response(
          JSON.stringify({
            sessions: [],
            projects: [],
            backlog: [],
            daemonAlive: true,
            lifecycleInstanceId: "epoch-one",
          }),
        );
      }
      if (url === "/api/tags") return new Response('{"tags":[]}');
      if (url.startsWith("/api/runtime/")) return new Response('{"available":false}');
      return new Response("{}");
    });
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  function tree(client: QueryClient) {
    return (
      <QueryClientProvider client={client}>
        <Dashboard />
      </QueryClientProvider>
    );
  }

  function mount() {
    // Mirrors the app defaults (providers.tsx): staleTime 5s, retry once.
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, retry: 1, retryDelay: 10 } },
    });
    return render(
      <QueryClientProvider client={client}>
        <Dashboard />
      </QueryClientProvider>,
    );
  }

  it("sends no sessions request while hidden and one immediately on visible", async () => {
    const view = mount();
    await advance(0);
    expect(sessionsCalls).toHaveLength(1);

    act(() => setVisibility("hidden"));
    await advance(60_000);
    expect(sessionsCalls).toHaveLength(1);

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sessionsCalls).toHaveLength(2);
    view.unmount();
  });

  it("backs off 2x, 4x, 8x across failed polls and returns to base after a success", async () => {
    sessionsOk = false;
    const view = mount();
    // Each failed poll makes two requests (retry: 1) but counts as one failure.
    await advance(120_000);
    const starts = sessionsCalls.filter((_, index) => index % 2 === 0);
    const gaps = starts.slice(1, 5).map((start, index) => start - (starts[index] ?? 0));
    const expected = [2, 4, 8, 8].map((factor) => factor * BASE_MS);
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(expected[index] ?? 0);
      expect(gap).toBeLessThan((expected[index] ?? 0) + 100);
    });
    expect(gaps).toHaveLength(4);

    sessionsOk = true;
    await advance(8 * BASE_MS + 100);
    const lastAt = sessionsCalls.at(-1) ?? 0;
    const count = sessionsCalls.length;
    // After a success the next poll is one base interval later, not 8x.
    await advance(lastAt + BASE_MS - (Date.now() - t0) - 1);
    expect(sessionsCalls).toHaveLength(count);
    await advance(1);
    expect(sessionsCalls).toHaveLength(count + 1);
    view.unmount();
  });

  it("spaces the next poll by a slow read's duration", async () => {
    sessionsReadMs = 20_000;
    const view = mount();
    await advance(0);
    expect(sessionsCalls).toHaveLength(1);
    // The read settles at 20s; the next one starts 20s later (read time > 5s base).
    await advance(39_999);
    expect(sessionsCalls).toHaveLength(1);
    await advance(1);
    expect(sessionsCalls).toHaveLength(2);
    view.unmount();
  });

  it("does not refetch on focus while polls are failing", async () => {
    sessionsOk = false;
    const view = mount();
    await advance(100);
    const afterFailure = sessionsCalls.length;
    expect(afterFailure).toBe(2);

    act(() => setVisibility("hidden"));
    await advance(1_000);
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sessionsCalls).toHaveLength(afterFailure);
    view.unmount();
  });

  it("refetches at once on backend reconnect and returns to the base delay", async () => {
    sessionsOk = false;
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, retry: 1, retryDelay: 10 } },
    });
    const view = render(tree(client));
    // Fail until the delay has backed off to 8x.
    await advance(100_000);
    const failedCalls = sessionsCalls.length;

    backend.phase = "disconnected";
    view.rerender(tree(client));
    await advance(1);
    expect(sessionsCalls).toHaveLength(failedCalls);

    sessionsOk = true;
    backend.phase = "connected";
    view.rerender(tree(client));
    await advance(0);
    expect(sessionsCalls).toHaveLength(failedCalls + 1);

    const reconnectAt = sessionsCalls.at(-1) ?? 0;
    await advance(reconnectAt + BASE_MS - (Date.now() - t0) - 1);
    expect(sessionsCalls).toHaveLength(failedCalls + 1);
    await advance(1);
    expect(sessionsCalls).toHaveLength(failedCalls + 2);
    view.unmount();
  });
});
