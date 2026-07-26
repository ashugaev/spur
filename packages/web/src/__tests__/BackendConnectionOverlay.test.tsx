import { act, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendConnectionOverlay } from "@/components/BackendConnectionOverlay";
import {
  BackendConnectionProvider,
  FAILURE_THRESHOLD,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_INTERVAL_MS,
} from "@/lib/backend-connection-context";
import { VersionSwitchProvider } from "@/lib/version-switch-context";

function renderOverlay(children?: ReactNode) {
  return render(
    <VersionSwitchProvider>
      <BackendConnectionProvider>
        {children}
        <BackendConnectionOverlay />
      </BackendConnectionProvider>
    </VersionSwitchProvider>,
  );
}

describe("BackendConnectionOverlay", () => {
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

  it("renders nothing when connected", () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    });

    renderOverlay();

    expect(screen.queryByTestId("backend-connection-overlay")).not.toBeInTheDocument();
  });

  it("renders a blocking overlay with heading and Reload now button once disconnected", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(null, { status: 500 });
    });

    vi.useFakeTimers();
    renderOverlay();

    // The first probe fires on the slow heartbeat; once it fails the
    // provider swaps to the fast reconnect cadence for the rest of the
    // confirmation window (see backend-connection-context.tsx).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    });
    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RECONNECT_INTERVAL_MS);
      });
    }

    const overlay = screen.getByTestId("backend-connection-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute("role", "alertdialog");
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Reconnecting to Spur…")).toBeInTheDocument();

    const reloadButton = screen.getByRole("button", { name: "Reload now" });
    reloadButton.click();
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});
