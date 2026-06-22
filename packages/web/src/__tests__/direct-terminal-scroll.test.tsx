import { render, waitFor, act, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let onBinaryCallback: ((data: string) => void) | null = null;

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
  onData: vi.fn(() => ({ dispose: vi.fn() })),
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
    send: vi.fn((payload: unknown) => {
      wsSend(payload);
      if (typeof payload !== "string" || !payload.startsWith("{")) return;
      try {
        const parsed = JSON.parse(payload) as { type?: string; id?: string };
        if (parsed.type === "input" && typeof parsed.id === "string") {
          queueMicrotask(() => {
            (ws.onmessage as ((event: { data: string }) => void) | null)?.({
              data: JSON.stringify({ type: "ack", id: parsed.id }),
            });
          });
        }
      } catch {
        // Ignore malformed payloads in tests.
      }
    }),
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

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function isInputPayload(value: unknown): value is { type: "input"; data: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "data" in value &&
    value.type === "input" &&
    typeof value.data === "string"
  );
}

function sentInputPayloads(): string[] {
  return wsSend.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is string => typeof payload === "string" && payload.startsWith("{"))
    .map(parsePayload)
    .filter(isInputPayload)
    .map((payload) => payload.data);
}

beforeEach(() => {
  onBinaryCallback = null;
  wsSend.mockClear();
  wsInstances.length = 0;
  MockWebSocket.mockClear();
  mockTerminal.onBinary.mockClear();
  mockTerminal.onData.mockClear();
  mockTerminal.open.mockClear();
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "/api/runtime/voice") {
      return new Response(JSON.stringify({ available: true, language: "auto" }), { status: 200 });
    }
    if (url.endsWith("/slash-commands")) {
      return new Response(
        JSON.stringify({
          agent: url.includes("codex") ? "codex" : "claude",
          commands: [
            {
              id: "cmd-1",
              label: url.includes("codex") ? "/permissions" : "/compact",
              insertText: url.includes("codex") ? "/permissions" : "/compact",
              detail: "Slash command",
              source: "built-in",
              kind: "command",
            },
          ],
          skills: [],
          agents: [],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
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

async function mountTerminal({
  sessionId = "test-session",
  agent = "claude",
  activity,
  title,
  onClose,
}: {
  sessionId?: string;
  agent?: "claude" | "codex" | "cursor";
  activity?: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
  title?: string;
  onClose?: () => void;
} = {}) {
  const { DirectTerminal } = await import("@/components/DirectTerminal");
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <DirectTerminal
        activity={activity}
        agent={agent}
        onClose={onClose}
        sessionId={sessionId}
        title={title}
      />,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return result;
}

describe("DirectTerminal scroll integration", () => {
  it("opens the websocket on the same origin at /ws", async () => {
    await mountTerminal({ sessionId: "port-test" });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    expect(MockWebSocket).toHaveBeenCalledWith(
      `ws://${window.location.host}/ws?session=port-test`,
    );
    expect(fetch).not.toHaveBeenCalledWith("/api/runtime/terminal", { cache: "no-store" });
  });

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

  it("maps touch swipe direction to native terminal scroll direction", async () => {
    const { container } = await mountTerminal({ sessionId: "test-touch" });

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
    await mountTerminal({ sessionId: "test-hotkeys", agent: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Open claude shortcuts" }));
    expect(screen.getByRole("menu", { name: "claude shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Esc /i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Switch mode/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Switch mode/i }));
    expect(wsSend).toHaveBeenCalledWith("\x1b[Z");
    expect(screen.queryByRole("menu", { name: "claude shortcuts" })).not.toBeInTheDocument();
  });

  it("opens arrow controls above the toggle and keeps them open after sending input", async () => {
    await mountTerminal({ sessionId: "test-arrow-controls" });

    expect(screen.queryByRole("menu", { name: "Arrow controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Arrow Left" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open arrow controls" }));
    expect(screen.getByRole("menu", { name: "Arrow controls" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Arrow Left" }));
    expect(wsSend).toHaveBeenCalledWith("\x1b[D");
    expect(screen.getByRole("menu", { name: "Arrow controls" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open arrow controls" }));
    expect(screen.queryByRole("menu", { name: "Arrow controls" })).not.toBeInTheDocument();
  });

  it("renders codex-specific hotkeys menu label", async () => {
    await mountTerminal({ sessionId: "test-codex-hotkeys", agent: "codex" });

    fireEvent.click(screen.getByRole("button", { name: "Open codex shortcuts" }));
    expect(screen.getByRole("menu", { name: "codex shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /^Esc /i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Switch mode/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Start file picker/i })).toBeInTheDocument();
  });

  it("submits codex slash suggestions as bracketed paste plus enter", async () => {
    await mountTerminal({ sessionId: "test-codex-hotkey-submit", agent: "codex" });

    const slashButton = screen.getByRole("button", { name: "Slash" });
    expect(slashButton).toHaveTextContent("/");
    fireEvent.click(slashButton);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /\/permissions/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /\/permissions/i }));

    await waitFor(() => {
      expect(sentInputPayloads()).toEqual(["\u001b[200~/permissions\u001b[201~", "\r"]);
      expect(sentInputPayloads()).not.toContain("/permissions\r");
    });
  });

  it("submits claude slash suggestions as bracketed paste plus enter", async () => {
    await mountTerminal({ sessionId: "test-claude-hotkey-submit", agent: "claude" });

    fireEvent.click(screen.getByRole("button", { name: "Slash" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /\/compact/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /\/compact/i }));

    await waitFor(() => {
      expect(sentInputPayloads()).toEqual(["\u001b[200~/compact\u001b[201~", "\r"]);
      expect(sentInputPayloads()).not.toContain("/compact\r");
    });
  });

  it("shows a visible error when codex slash suggestion submit fails", async () => {
    await mountTerminal({ sessionId: "test-codex-hotkey-submit-error", agent: "codex" });

    wsInstances[0].readyState = 3;
    fireEvent.click(screen.getByRole("button", { name: "Slash" }));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /\/permissions/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /\/permissions/i }));

    await waitFor(() => {
      expect(screen.getByText("Failed to insert transcription")).toBeInTheDocument();
    });
  });

  it("reconnects after an unexpected websocket close", async () => {
    await mountTerminal({ sessionId: "test-reconnect" });

    const firstSocket = wsInstances[0];
    act(() => {
      firstSocket.readyState = 3;
      (firstSocket.onclose as (ev: { code: number; reason: string }) => void)({
        code: 1006,
        reason: "",
      });
    });

    const statusDot = screen.getByTestId("direct-terminal-header-status-dot");
    expect(statusDot).toHaveAttribute("data-ws-status", "reconnecting");
    expect(statusDot).toHaveAttribute("title", "Terminal disconnected. Retrying…");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(2);
    });
    expect(statusDot).toHaveAttribute("data-ws-status", "connected");
    expect(statusDot).toHaveAttribute("title", "connected");
  });

  it("does not reconnect after returning from a hidden tab when the websocket is still open", async () => {
    await mountTerminal({ sessionId: "test-visibility" });

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

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });
  });

  it("reconnects after returning from a hidden tab when the websocket is already closed", async () => {
    await mountTerminal({ sessionId: "test-visibility-closed" });

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

    act(() => {
      wsInstances[0].readyState = 3;
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

    await mountTerminal({ sessionId: "test-voice-insert" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit voice transcript" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Send voice to queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop and send voice" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel voice recording" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop voice recording" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit voice transcript" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Confirm voice input" })).toBeInTheDocument();
    });

    wsInstances[0].readyState = 3;
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => {
      expect(screen.getAllByText("Failed to insert transcription")).toHaveLength(2);
    });
    expect(screen.getByRole("dialog", { name: "Confirm voice input" })).toBeInTheDocument();
  });

  it("cancels active terminal recording without transcribing or opening a modal", async () => {
    await mountTerminal({ sessionId: "test-voice-cancel" });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel voice recording" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    const fetchMock = vi.mocked(fetch);
    const transcribeCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input.url;
      return url === "/api/runtime/voice/transcribe";
    });
    expect(transcribeCalls).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Confirm voice input" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Voice recording captured no audio. Check your microphone input and try again.",
      ),
    ).not.toBeInTheDocument();
  });

  it("queues active terminal recording text without inserting into the terminal", async () => {
    let sendPayload: unknown = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: true, language: "auto" }), {
          status: 200,
        });
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "queued voice text" }), { status: 200 });
      }
      if (url === "/api/sessions/test-voice-queue/send" && init?.method === "POST") {
        sendPayload = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/slash-commands")) {
        return new Response(
          JSON.stringify({ agent: "claude", commands: [], skills: [], agents: [] }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await mountTerminal({ sessionId: "test-voice-queue" });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send voice to queue" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Send voice to queue" }));

    await waitFor(() => {
      expect(sendPayload).toEqual({ message: "queued voice text", queue: true });
    });
    expect(screen.queryByRole("dialog", { name: "Confirm voice input" })).not.toBeInTheDocument();
    expect(sentInputPayloads()).toHaveLength(0);
  });

  it("queues edited terminal voice drafts from the confirmation modal", async () => {
    let sendPayload: unknown = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: true, language: "auto" }), {
          status: 200,
        });
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "draft voice text" }), { status: 200 });
      }
      if (url === "/api/sessions/test-voice-modal-queue/send" && init?.method === "POST") {
        sendPayload = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/slash-commands")) {
        return new Response(
          JSON.stringify({ agent: "claude", commands: [], skills: [], agents: [] }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await mountTerminal({ sessionId: "test-voice-modal-queue" });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit voice transcript" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit voice transcript" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Confirm voice input" })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "edited terminal queue text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    await waitFor(() => {
      expect(sendPayload).toEqual({ message: "edited terminal queue text", queue: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Confirm voice input" })).not.toBeInTheDocument();
    });
    expect(sentInputPayloads()).toHaveLength(0);
  });

  it("does not show a primary voice hint in the terminal toolbar before the popup opens", async () => {
    await mountTerminal({ sessionId: "test-terminal-voice-hint" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    expect(screen.queryByText("Voice ⌘ + .")).not.toBeInTheDocument();
  });

  it("clamps terminal header title to two lines with CSS", async () => {
    const title = "Very long terminal header title for isolated sidecar sessions";

    await mountTerminal({
      onClose: vi.fn(),
      title,
    });

    const statusDot = screen.getByTestId("direct-terminal-header-status-dot");
    await waitFor(() => {
      expect(statusDot).toHaveAttribute("data-ws-status", "connected");
    });

    const titleElement = screen.getByTestId("direct-terminal-header-title");
    expect(titleElement.className).toContain("whitespace-normal");
    expect(titleElement.className).toContain("[display:-webkit-box]");
    expect(titleElement.className).toContain("[-webkit-line-clamp:2]");
    expect(titleElement.className).toContain("[overflow-wrap:anywhere]");
    expect(titleElement.className).toContain("overflow-hidden");
    expect(screen.getByTestId("direct-terminal-header").className).toContain("items-center");
  });
});
