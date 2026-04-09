import { render, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

let onBinaryCallback: ((data: string) => void) | null = null;
let onDataCallback: ((data: string) => void) | null = null;

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  focus: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn((cb: (data: string) => void) => {
    onDataCallback = cb;
    return { dispose: vi.fn() };
  }),
  onBinary: vi.fn((cb: (data: string) => void) => {
    onBinaryCallback = cb;
    return { dispose: vi.fn() };
  }),
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

// Shared send spy — persists across WebSocket instances within a test.
const wsSend = vi.fn();

const MockWebSocket = vi.fn(() => {
  const ws: Record<string, unknown> = {
    readyState: 1,
    binaryType: "arraybuffer",
    send: wsSend,
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  queueMicrotask(() => {
    (ws.onopen as (ev: unknown) => void)?.({});
  });
  return ws;
});
// Component checks websocket.readyState === WebSocket.OPEN.
(MockWebSocket as unknown as Record<string, number>).OPEN = 1;

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  onBinaryCallback = null;
  onDataCallback = null;
  wsSend.mockClear();
  mockTerminal.onBinary.mockClear();
  mockTerminal.onData.mockClear();
  mockTerminal.open.mockClear();
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ directTerminalPort: 14801 })),
  );
});

async function mountTerminal(sessionId = "test-session") {
  const { DirectTerminal } = await import("@/components/DirectTerminal");
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<DirectTerminal sessionId={sessionId} label="test" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return result;
}

describe("DirectTerminal scroll integration", () => {
  it("registers onBinary to forward mouse/scroll sequences to WebSocket", async () => {
    await mountTerminal();

    await waitFor(() => {
      expect(mockTerminal.onBinary).toHaveBeenCalled();
    });

    // Simulate xterm.js emitting an SGR mouse scroll-up sequence via onBinary.
    const sgrMouseUp = "\x1b[<65;10;5M";
    onBinaryCallback?.(sgrMouseUp);

    // send is called first with resize JSON on open, then with our binary data.
    expect(wsSend).toHaveBeenCalledWith(sgrMouseUp);
  });

  it("forwards keyboard input via onData to WebSocket", async () => {
    await mountTerminal("test-data");

    await waitFor(() => {
      expect(onDataCallback).not.toBeNull();
    });

    onDataCallback?.("hello");
    expect(wsSend).toHaveBeenCalledWith("hello");
  });

  it("does not prevent wheel events (lets xterm.js handle them natively)", async () => {
    const { container } = await mountTerminal("test-wheel");

    const terminalDiv = container.querySelector("div > div:nth-child(2) > div");

    const wheelEvent = new WheelEvent("wheel", {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    terminalDiv!.dispatchEvent(wheelEvent);
    expect(wheelEvent.defaultPrevented).toBe(false);
  });
});
