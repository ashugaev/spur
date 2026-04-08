import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  cols: 80,
  rows: 24,
  buffer: { active: { type: "alternate", baseY: 0 } },
  element: document.createElement("div"),
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
};

const mockFit = { fit: vi.fn(), dispose: vi.fn() };

vi.mock("xterm", () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => mockFit),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

describe("DirectTerminal scroll", () => {
  it("does not register a capture-phase wheel handler (lets xterm.js forward to tmux)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ directTerminalPort: 14801 })),
    );

    const { DirectTerminal } = await import("@/components/DirectTerminal");

    const { container } = render(
      <DirectTerminal sessionId="test-session" label="test" />,
    );

    const terminalDiv = container.querySelector("div > div:nth-child(2) > div");

    await waitFor(() => {
      expect(mockTerminal.open).toHaveBeenCalled();
    });

    // Verify no capture-phase wheel handler blocks xterm.js from forwarding scroll to tmux.
    // Dispatch a wheel event and confirm it is NOT prevented (xterm.js gets to handle it).
    const wheelEvent = new WheelEvent("wheel", {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    terminalDiv!.dispatchEvent(wheelEvent);
    expect(wheelEvent.defaultPrevented).toBe(false);
  });
});
