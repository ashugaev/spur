import { act, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendConnectionProvider,
  FAILURE_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  RECONNECT_INTERVAL_MS,
  retryIntervalMs,
  useBackendConnection,
} from "@/lib/backend-connection-context";
import { useVersionSwitch, VersionSwitchProvider } from "@/lib/version-switch-context";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <VersionSwitchProvider>
      <BackendConnectionProvider>{children}</BackendConnectionProvider>
    </VersionSwitchProvider>
  );
}

function renderProvider() {
  return renderHook(() => useBackendConnection(), { wrapper });
}

function mockFetchResults(okFn: () => boolean, versionFn: () => string = () => "1.4.2") {
  return vi.spyOn(global, "fetch").mockImplementation(async () => {
    if (okFn()) {
      return new Response(JSON.stringify({ version: versionFn() }), { status: 200 });
    }
    return new Response(null, { status: 500 });
  });
}

// Advances fake time by zero ms, which still flushes the microtask queue
// (pending promise resolutions) without moving any timer forward — used to
// let the provider's immediate on-mount probe (finding C) settle.
async function flushMicrotasks() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// The provider fires the very first probe of an activation immediately
// (flushMicrotasks above), and only that first probe is untimed — every
// probe after that (whether still healthy or already failing) waits out
// the currently-active cadence. This steps through exactly one probe per
// call, using the cadence that's active at that point.
function makeProbeStepper() {
  let step = 0;
  return async () => {
    if (step === 0) {
      step++;
      await flushMicrotasks();
      return;
    }
    const n = step++;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(retryIntervalMs(n));
    });
  };
}

describe("BackendConnectionProvider", () => {
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

  it("probes immediately on mount instead of waiting for the first heartbeat", async () => {
    const fetchSpy = mockFetchResults(() => false);

    vi.useFakeTimers();
    const { result } = renderProvider();

    await flushMicrotasks();

    // One failure counted already, purely from the mount-time probe — no
    // timers were advanced.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("connected");
  });

  it("stays connected after a single transient failure (below threshold)", async () => {
    let ok = true;
    mockFetchResults(() => ok);

    vi.useFakeTimers();
    const { result } = renderProvider();
    await flushMicrotasks(); // healthy mount probe; steady state stays on the slow heartbeat
    expect(result.current.phase).toBe("connected");

    ok = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    expect(result.current.phase).toBe("connected");

    // Cadence already swapped to fast after the failure above.
    ok = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });
    expect(result.current.phase).toBe("connected");
  });

  it("flips to disconnected after FAILURE_THRESHOLD consecutive failures", async () => {
    mockFetchResults(() => false);

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await stepProbe();
    }
    expect(result.current.phase).toBe("connected");

    await stepProbe();
    expect(result.current.phase).toBe("disconnected");
  });

  it("counts failures correctly via the functional updater (no stale-closure reads)", async () => {
    // Regression test: incrementing the failure counter from a value read
    // out of the render closure (rather than the setState updater form)
    // could drop a real failure if two probes' async work overlapped,
    // indefinitely deferring FAILURE_THRESHOLD.
    mockFetchResults(() => false);

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepProbe();
    }

    expect(result.current.phase).toBe("disconnected");
    expect(result.current.attempts).toBe(1);
  });

  it("skips a probe tick when the previous probe hasn't resolved yet", async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    vi.useFakeTimers();
    renderProvider();

    // Mount fires the first probe; it never resolves until we do so below.
    await flushMicrotasks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A full heartbeat elapses while that probe is still in flight — the
    // in-flight guard must skip this tick instead of starting a second,
    // concurrent probe on top of it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch?.(new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 }));
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("counts an abort/timeout as a failure like any other probe error", async () => {
    vi.spyOn(global, "fetch").mockImplementation(() =>
      Promise.reject(new DOMException("The operation was aborted.", "TimeoutError")),
    );

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepProbe();
    }

    expect(result.current.phase).toBe("disconnected");
  });

  it("rejects a 200 response with a non-runtime-info body as not alive", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ unrelated: true }), { status: 200 });
    });

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepProbe();
    }

    expect(result.current.phase).toBe("disconnected");
  });

  it("does not reload when the backend recovers to the same version (transient blip)", async () => {
    let ok = true;
    mockFetchResults(
      () => ok,
      () => "1.4.2",
    );

    vi.useFakeTimers();
    const { result } = renderProvider();
    await flushMicrotasks(); // establishes the "1.4.2" baseline via a healthy mount probe

    ok = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    for (let f = 1; f < FAILURE_THRESHOLD; f++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryIntervalMs(f));
      });
    }
    expect(result.current.phase).toBe("disconnected");

    ok = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });

    expect(result.current.phase).toBe("connected");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("reloads exactly once when the backend recovers to a different version (restart/update)", async () => {
    let ok = true;
    let version = "1.4.2";
    mockFetchResults(
      () => ok,
      () => version,
    );

    vi.useFakeTimers();
    const { result } = renderProvider();
    await flushMicrotasks(); // establishes the "1.4.2" baseline via a healthy mount probe

    ok = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    for (let f = 1; f < FAILURE_THRESHOLD; f++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryIntervalMs(f));
      });
    }
    expect(result.current.phase).toBe("disconnected");

    version = "1.5.0";
    ok = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });
    expect(result.current.phase).toBe("connected");
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 5);
    });
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once on recovery when there was no prior healthy baseline (cold start against a dead daemon)", async () => {
    let ok = false;
    mockFetchResults(
      () => ok,
      () => "1.5.0",
    );

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepProbe();
    }
    expect(result.current.phase).toBe("disconnected");

    ok = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });

    expect(result.current.phase).toBe("connected");
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("increments attempts while disconnected", async () => {
    mockFetchResults(() => false);

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepProbe = makeProbeStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepProbe();
    }
    expect(result.current.phase).toBe("disconnected");
    expect(result.current.attempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });
    expect(result.current.attempts).toBe(2);
  });

  it("stays connected through a backend stall shorter than the grace window", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve, reject) => {
          if (Date.now() - start < 16_000) {
            setTimeout(
              () => reject(new DOMException("The operation was aborted.", "TimeoutError")),
              PROBE_TIMEOUT_MS,
            );
          } else {
            resolve(new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 }));
          }
        }),
    );

    const { result } = renderProvider();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.phase).toBe("connected");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("requires the full grace window of continuous failure before disconnecting", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(
            () => reject(new DOMException("The operation was aborted.", "TimeoutError")),
            PROBE_TIMEOUT_MS,
          );
        }),
    );

    const { result } = renderProvider();

    const t0 = Date.now();
    // p1 aborts at t=3_000; step through each probe individually so React
    // commits effect cleanups between timer firings.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    });
    // p2 fires at t=7_000, aborts at t=10_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(retryIntervalMs(1) + PROBE_TIMEOUT_MS);
    });
    // p3 fires at t=18_000, aborts at t=21_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(retryIntervalMs(2) + PROBE_TIMEOUT_MS);
    });
    // p4 fires at t=29_000; not yet aborted — advance to t=31_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(retryIntervalMs(3) + 2_000);
    });
    expect(result.current.phase).toBe("connected");
    expect(Date.now() - t0).toBe(31_000);

    // p4 aborts at t=32_000 — advance past it
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.phase).toBe("disconnected");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(32_000);
  });

  it("stays dormant (connected, no reload) while a version switch is in flight", async () => {
    mockFetchResults(() => false);

    function LocalWrapper({ children }: { children: ReactNode }) {
      return (
        <VersionSwitchProvider>
          <BackendConnectionProvider>{children}</BackendConnectionProvider>
        </VersionSwitchProvider>
      );
    }

    function useCombined() {
      return {
        backend: useBackendConnection(),
        versionSwitch: useVersionSwitch(),
      };
    }

    vi.useFakeTimers();
    const { result } = renderHook(() => useCombined(), { wrapper: LocalWrapper });

    act(() => {
      result.current.versionSwitch.startSwitch("1.5.0");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * (FAILURE_THRESHOLD + 5));
    });

    expect(result.current.backend.phase).toBe("connected");
    expect(window.location.reload).not.toHaveBeenCalled();
  });
});
