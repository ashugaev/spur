import { render, waitFor, act, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let onBinaryCallback: ((data: string) => void) | null = null;
let onDataCallback: ((data: string) => void) | null = null;

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn((element: HTMLElement) => {
    element.replaceChildren();
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    element.appendChild(screen);
  }),
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

class MockMediaRecorder {
  mimeType = "audio/webm";
  state = "inactive";
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.emit(
      "dataavailable",
      new Blob(["voice-audio"], {
        type: this.mimeType,
      }),
    );
    this.emit("stop");
  }

  private emit(type: string, data?: Blob) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data ? { data } : undefined);
    }
  }
}

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
const wsInstances: Array<Record<string, unknown>> = [];

const MockWebSocket = vi.fn(() => {
  const ws: Record<string, unknown> = {
    readyState: 0,
    binaryType: "arraybuffer",
    send: wsSend,
    close: vi.fn(() => {
      ws.readyState = 3;
      (ws.onclose as (ev: { code: number; reason: string }) => void)?.({
        code: 1000,
        reason: "Closed",
      });
    }),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  wsInstances.push(ws);
  queueMicrotask(() => {
    ws.readyState = 1;
    (ws.onopen as (ev: unknown) => void)?.({});
  });
  return ws;
});
// Component checks websocket.readyState === WebSocket.OPEN.
(MockWebSocket as unknown as Record<string, number>).CONNECTING = 0;
(MockWebSocket as unknown as Record<string, number>).OPEN = 1;
(MockWebSocket as unknown as Record<string, number>).CLOSING = 2;
(MockWebSocket as unknown as Record<string, number>).CLOSED = 3;

vi.stubGlobal("WebSocket", MockWebSocket);

beforeEach(() => {
  onBinaryCallback = null;
  onDataCallback = null;
  wsSend.mockClear();
  wsInstances.length = 0;
  MockWebSocket.mockClear();
  mockTerminal.onBinary.mockClear();
  mockTerminal.onData.mockClear();
  mockTerminal.open.mockClear();
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ directTerminalPort: 14801 })),
  );
  vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountTerminal(sessionId = "test-session", agent: "claude" | "codex" = "claude") {
  const { DirectTerminal } = await import("@/components/DirectTerminal");
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<DirectTerminal agent={agent} sessionId={sessionId} label="test" />);
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

  it("maps touch swipe direction to native terminal scroll direction", async () => {
    const { container } = await mountTerminal("test-touch");

    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", {
      configurable: true,
      value: [{ clientY: 200 }],
    });
    touchTarget!.dispatchEvent(touchStart);

    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(touchMove, "touches", {
      configurable: true,
      value: [{ clientY: 160 }],
    });
    touchTarget!.dispatchEvent(touchMove);

    expect(wsSend).toHaveBeenCalledWith("\x1b[<65;1;1M");
  });

  it("opens agent hotkeys menu and sends a selected shortcut", async () => {
    await mountTerminal("test-hotkeys", "claude");

    fireEvent.click(screen.getByRole("button", { name: "Open claude shortcuts" }));
    expect(screen.getByRole("menu", { name: "claude shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Slash/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Esc /i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Switch mode/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Switch mode/i }));
    expect(wsSend).toHaveBeenCalledWith("\x1b[Z");
    expect(screen.queryByRole("menu", { name: "claude shortcuts" })).not.toBeInTheDocument();
  });

  it("renders codex-specific hotkeys menu label", async () => {
    await mountTerminal("test-codex-hotkeys", "codex");

    fireEvent.click(screen.getByRole("button", { name: "Open codex shortcuts" }));
    expect(screen.getByRole("menu", { name: "codex shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Slash/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Esc /i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Switch mode/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Start file picker/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /\/permissions/i })).toBeInTheDocument();
  });

  it("does not render a standalone esc button in the control bar", async () => {
    await mountTerminal("test-no-esc", "claude");

    expect(screen.queryByRole("button", { name: "Esc" })).not.toBeInTheDocument();
  });

  it("reconnects after an unexpected websocket close", async () => {
    await mountTerminal("test-reconnect");

    const firstSocket = wsInstances[0];
    act(() => {
      firstSocket.readyState = 3;
      (firstSocket.onclose as (ev: { code: number; reason: string }) => void)({
        code: 1006,
        reason: "",
      });
    });

    expect(screen.getByText("Terminal disconnected. Retrying…")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("refreshes the websocket after returning from a hidden tab", async () => {
    await mountTerminal("test-visibility");

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(2);
    });
  });

  it("shows a visible error when terminal voice text cannot be inserted", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: true, language: "auto" }), { status: 200 });
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "terminal voice text" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await mountTerminal("test-voice-insert");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Confirm voice input" })).toBeInTheDocument();
    });

    wsInstances[0].readyState = 3;
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to insert transcription")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog", { name: "Confirm voice input" })).toBeInTheDocument();
  });
});
