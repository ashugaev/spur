import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionSwitchOverlay } from "@/components/VersionSwitchOverlay";
import { useVersionSwitch, VersionSwitchProvider } from "@/lib/version-switch-context";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
    },
  });
}

// Test-only trigger so we can drive the provider's state machine through its
// public hook API while rendering the real overlay component.
function StartSwitchTrigger({ version }: { version: string }) {
  const { startSwitch } = useVersionSwitch();
  return (
    <button type="button" onClick={() => startSwitch(version)}>
      trigger-start-switch
    </button>
  );
}

function renderOverlay(children?: ReactNode) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <VersionSwitchProvider>
        {children}
        <VersionSwitchOverlay />
      </VersionSwitchProvider>
    </QueryClientProvider>,
  );
}

describe("VersionSwitchOverlay", () => {
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

  it("renders nothing when phase is idle", () => {
    renderOverlay();

    expect(screen.queryByTestId("version-switch-overlay")).not.toBeInTheDocument();
  });

  it("renders a blocking, non-dismissible overlay while switching", () => {
    renderOverlay(<StartSwitchTrigger version="1.5.0" />);

    fireEvent.click(screen.getByText("trigger-start-switch"));

    const overlay = screen.getByTestId("version-switch-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute("role", "alertdialog");
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(within(overlay).getByLabelText("Updating Spur")).toHaveAttribute("aria-busy", "true");
    expect(overlay.querySelector(".voice-spinner")).not.toBeNull();
    expect(within(overlay).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows Reload now and Dismiss actions on failure, and Dismiss clears the overlay", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    });

    renderOverlay(<StartSwitchTrigger version="1.5.0" />);

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("trigger-start-switch"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });

    expect(screen.getByTestId("version-switch-overlay")).toBeInTheDocument();
    const dismissButton = screen.getByRole("button", { name: "Dismiss" });
    expect(screen.getByRole("button", { name: "Reload now" })).toBeInTheDocument();

    fireEvent.click(dismissButton);

    expect(screen.queryByTestId("version-switch-overlay")).not.toBeInTheDocument();
  });

  it("shows a Diagnose update button on failure that spawns an agent and disables once spawned", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/diagnose-update") {
          return new Response(JSON.stringify({ id: "sess-1" }), { status: 201 });
        }
        return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
      });

    renderOverlay(<StartSwitchTrigger version="1.5.0" />);

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("trigger-start-switch"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    vi.useRealTimers();

    const diagnoseButton = screen.getByRole("button", { name: "Diagnose update" });
    expect(diagnoseButton).toBeInTheDocument();
    expect(diagnoseButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(diagnoseButton);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diagnose-update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target: "1.5.0" }),
      }),
    );

    const spawnedButton = await screen.findByRole("button", { name: "Agent spawned" });
    expect(spawnedButton).toBeDisabled();

    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload now" })).toBeInTheDocument();
  });

  it("shows Retry diagnose and re-enables the button when the spawn request fails", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/diagnose-update") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
    });

    renderOverlay(<StartSwitchTrigger version="1.5.0" />);

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("trigger-start-switch"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    vi.useRealTimers();

    const diagnoseButton = screen.getByRole("button", { name: "Diagnose update" });

    await act(async () => {
      fireEvent.click(diagnoseButton);
    });

    const retryButton = await screen.findByRole("button", { name: "Retry diagnose" });
    expect(retryButton).not.toBeDisabled();
  });

  it("resets the Diagnose button to idle on a fresh failure after a prior spawn", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/diagnose-update") {
          return new Response(JSON.stringify({ id: "sess-1" }), { status: 201 });
        }
        return new Response(JSON.stringify({ version: "1.4.2" }), { status: 200 });
      });

    renderOverlay(<StartSwitchTrigger version="1.5.0" />);

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("trigger-start-switch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    vi.useRealTimers();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Diagnose update" }));
    });
    expect(await screen.findByRole("button", { name: "Agent spawned" })).toBeDisabled();

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("version-switch-overlay")).not.toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.click(screen.getByText("trigger-start-switch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000 * 30 + 100);
    });
    vi.useRealTimers();

    const diagnoseButton = await screen.findByRole("button", { name: "Diagnose update" });
    expect(diagnoseButton).not.toBeDisabled();
  });
});
