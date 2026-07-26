import { act, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendConnectionProvider,
  FAILURE_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_INTERVAL_MS,
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

function mockFetchResults(results: () => boolean) {
  vi.spyOn(global, "fetch").mockImplementation(async () => {
    if (results()) {
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    }
    return new Response(null, { status: 500 });
  });
}

// The first probe fires on the slow heartbeat; the moment it fails, the
// provider swaps to the fast reconnect cadence for the remaining probes in
// the confirmation window (see backend-connection-context.tsx). Returns a
// stepper that advances exactly one probe interval per call, tracking which
// cadence is active across calls so tests can assert on intermediate state.
function makeFailureStepper() {
  let first = true;
  return async () => {
    const intervalMs = first ? HEARTBEAT_INTERVAL_MS : RECONNECT_INTERVAL_MS;
    first = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(intervalMs);
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

  it("stays connected after a single transient failure (below threshold)", async () => {
    let ok = true;
    mockFetchResults(() => ok);

    vi.useFakeTimers();
    const { result } = renderProvider();
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
    const stepFailure = makeFailureStepper();

    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await stepFailure();
    }
    expect(result.current.phase).toBe("connected");

    await stepFailure();
    expect(result.current.phase).toBe("disconnected");
  });

  it("reloads exactly once on recovery while disconnected", async () => {
    let ok = false;
    mockFetchResults(() => ok);

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepFailure = makeFailureStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepFailure();
    }
    expect(result.current.phase).toBe("disconnected");

    ok = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS * 5);
    });
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("increments attempts while disconnected", async () => {
    mockFetchResults(() => false);

    vi.useFakeTimers();
    const { result } = renderProvider();
    const stepFailure = makeFailureStepper();

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await stepFailure();
    }
    expect(result.current.phase).toBe("disconnected");
    expect(result.current.attempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
    });
    expect(result.current.attempts).toBe(2);
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
