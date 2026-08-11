import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Providers from "@/app/providers";
import { FAILURE_THRESHOLD, retryIntervalMs } from "@/lib/backend-connection-context";
import { useVersionSwitch } from "@/lib/version-switch-context";

// Test-only trigger so we can drive the provider's state machine through its
// public hook API while rendering the real app tree.
function StartSwitchTrigger({ version }: { version: string }) {
  const { startSwitch } = useVersionSwitch();
  return (
    <button type="button" onClick={() => startSwitch(version)}>
      trigger-start-switch
    </button>
  );
}

function StatefulControl() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((current) => current + 1)}>
      local-state-{count}
    </button>
  );
}

describe("Providers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // BackendConnectionProvider probes immediately on mount; give every test
    // a default healthy response so tests that aren't exercising the
    // backend gate itself don't leak an uncontrolled real fetch.
    vi.spyOn(global, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 }),
    );
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: vi.fn() },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the app content interactive when idle", () => {
    render(
      <Providers>
        <button type="button">app-control</button>
        <StartSwitchTrigger version="1.5.0" />
      </Providers>,
    );

    expect(screen.getByText("app-control").closest("[inert]")).toBeNull();
  });

  it("marks the background app tree inert once a version switch starts", () => {
    render(
      <Providers>
        <button type="button">app-control</button>
        <StartSwitchTrigger version="1.5.0" />
      </Providers>,
    );

    fireEvent.click(screen.getByText("trigger-start-switch"));

    expect(screen.getByText("app-control").closest("[inert]")).not.toBeNull();
  });

  it("keeps app component state when a blocking overlay makes the tree inert", () => {
    render(
      <Providers>
        <StatefulControl />
        <StartSwitchTrigger version="1.5.0" />
      </Providers>,
    );

    fireEvent.click(screen.getByText("local-state-0"));
    fireEvent.click(screen.getByText("trigger-start-switch"));

    expect(screen.getByText("local-state-1")).toBeInTheDocument();
    expect(screen.getByText("local-state-1").closest("[inert]")).not.toBeNull();
  });

  it("marks the background app tree inert once the backend-connection gate disconnects", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => new Response(null, { status: 500 }));

    vi.useFakeTimers();
    render(
      <Providers>
        <button type="button">app-control</button>
      </Providers>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let f = 1; f < FAILURE_THRESHOLD; f++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryIntervalMs(f));
      });
    }

    expect(screen.getByText("app-control").closest("[inert]")).not.toBeNull();
  });

  it("keeps app component state when the backend-connection gate disconnects", async () => {
    // Sibling of the version-switch case above, driven through the real
    // liveness gate instead: this is the path from the original report,
    // where the reconnect overlay closed an open spawn modal and discarded
    // the typed prompt. Both paths feed the same `blocking` flag, so the
    // value here is covering the whole probe-failure -> overlay sequence.
    vi.spyOn(global, "fetch").mockImplementation(async () => new Response(null, { status: 502 }));

    vi.useFakeTimers();
    render(
      <Providers>
        <StatefulControl />
      </Providers>,
    );

    fireEvent.click(screen.getByText("local-state-0"));

    // Probes fail instantly here, so the grace window is the backoff gaps
    // alone — PROBE_TIMEOUT_MS never enters the timeline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let f = 1; f < FAILURE_THRESHOLD; f++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryIntervalMs(f));
      });
    }

    const stateful = screen.getByText("local-state-1");
    expect(stateful).toBeInTheDocument();
    expect(stateful.closest("[inert]")).not.toBeNull();
  });
});
