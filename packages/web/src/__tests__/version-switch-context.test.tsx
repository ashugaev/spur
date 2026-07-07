import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVersionSwitch, VersionSwitchProvider } from "@/lib/version-switch-context";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
    },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = createTestQueryClient();
  return (
    <QueryClientProvider client={client}>
      <VersionSwitchProvider>{children}</VersionSwitchProvider>
    </QueryClientProvider>
  );
}

function renderProvider() {
  return renderHook(() => useVersionSwitch(), { wrapper });
}

function mockRuntimeInfoFetch(getVersion: () => string) {
  vi.spyOn(global, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify({ version: getVersion() }), { status: 200 });
  });
}

describe("VersionSwitchProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions idle -> switching -> done on a matching poll response and reloads once", async () => {
    let liveVersion = "1.4.2";
    mockRuntimeInfoFetch(() => liveVersion);

    const { result } = renderProvider();
    expect(result.current.phase).toBe("idle");

    vi.useFakeTimers();
    act(() => {
      result.current.startSwitch("1.5.0");
    });
    expect(result.current.phase).toBe("switching");
    expect(result.current.target).toBe("1.5.0");

    liveVersion = "1.5.0";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(result.current.phase).toBe("done");
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on confirmation without gating on query invalidation", async () => {
    // Regression test: reload() used to be gated behind an awaited
    // invalidateQueries() call, which left the "done" phase (and thus a
    // hidden overlay) exposed to the raw, interactive dashboard for however
    // long that network round trip took. The full-page reload discards the
    // query cache anyway, so confirmation must not depend on invalidation.
    let liveVersion = "1.4.2";
    mockRuntimeInfoFetch(() => liveVersion);

    const client = createTestQueryClient();
    const invalidateQueriesSpy = vi.spyOn(client, "invalidateQueries");

    function localWrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={client}>
          <VersionSwitchProvider>{children}</VersionSwitchProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useVersionSwitch(), { wrapper: localWrapper });

    vi.useFakeTimers();
    act(() => {
      result.current.startSwitch("1.5.0");
    });

    liveVersion = "1.5.0";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(result.current.phase).toBe("done");
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(invalidateQueriesSpy).not.toHaveBeenCalled();
  });

  it("transitions idle -> switching -> failed after exhausting attempts and never reloads", async () => {
    mockRuntimeInfoFetch(() => "1.4.2");

    const { result } = renderProvider();

    vi.useFakeTimers();
    act(() => {
      result.current.startSwitch("1.5.0");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });

    expect(result.current.phase).toBe("failed");
    expect(result.current.target).toBe("1.5.0");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("dismiss() resets failed -> idle", async () => {
    mockRuntimeInfoFetch(() => "1.4.2");

    const { result } = renderProvider();

    vi.useFakeTimers();
    act(() => {
      result.current.startSwitch("1.5.0");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    expect(result.current.phase).toBe("failed");

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.target).toBeNull();
  });
});
