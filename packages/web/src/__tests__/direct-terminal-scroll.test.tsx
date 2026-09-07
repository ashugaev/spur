import { render, waitFor, act, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let onBinaryCallback: ((data: string) => void) | null = null;
let parsedWriteCallback: (() => void) | null = null;
let terminalResizeCallback: (() => void) | null = null;
let bufferChangeCallback: (() => void) | null = null;
let activeBuffer: MockBuffer;
let normalBuffer: MockBuffer;
let alternateBuffer: MockBuffer;
const discoveryDisposables = {
  parsed: vi.fn(),
  resize: vi.fn(),
  buffer: vi.fn(),
};

interface MockBufferRow {
  text: string;
  isWrapped?: boolean;
}

interface MockBuffer {
  type: "normal" | "alternate";
  baseY: number;
  rows: Array<MockBufferRow | undefined>;
  length: number;
  getLine: (index: number) => { isWrapped: boolean; translateToString: () => string } | undefined;
}

function createBuffer(
  type: "normal" | "alternate",
  rows: Array<MockBufferRow | undefined> = [],
): MockBuffer {
  return {
    type,
    baseY: 0,
    rows,
    get length() {
      return this.rows.length;
    },
    getLine(index: number) {
      const bufferRow = this.rows[index];
      return bufferRow
        ? {
            isWrapped: bufferRow.isWrapped ?? false,
            translateToString: () => bufferRow.text,
          }
        : undefined;
    },
  };
}

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn((element: HTMLElement) => {
    element.replaceChildren();
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = vi.fn(() => new DOMRect(100, 50, 800, 480));
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
  onWriteParsed: vi.fn((cb: () => void) => {
    parsedWriteCallback = cb;
    return { dispose: discoveryDisposables.parsed };
  }),
  onResize: vi.fn((cb: () => void) => {
    terminalResizeCallback = cb;
    return { dispose: discoveryDisposables.resize };
  }),
  cols: 80,
  rows: 24,
  buffer: {
    get active() {
      return activeBuffer;
    },
    onBufferChange: vi.fn((cb: () => void) => {
      bufferChangeCallback = cb;
      return { dispose: discoveryDisposables.buffer };
    }),
  },
  element: document.createElement("div"),
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
  options: {},
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

function sentRawPayloads(): string[] {
  return wsSend.mock.calls
    .map(([payload]) => payload)
    .filter(
      (payload): payload is string => typeof payload === "string" && !payload.startsWith("{"),
    );
}

beforeEach(() => {
  onBinaryCallback = null;
  parsedWriteCallback = null;
  terminalResizeCallback = null;
  bufferChangeCallback = null;
  normalBuffer = createBuffer("normal");
  alternateBuffer = createBuffer("alternate");
  activeBuffer = normalBuffer;
  discoveryDisposables.parsed.mockClear();
  discoveryDisposables.resize.mockClear();
  discoveryDisposables.buffer.mockClear();
  wsSend.mockClear();
  wsInstances.length = 0;
  MockWebSocket.mockClear();
  mockTerminal.onBinary.mockClear();
  mockTerminal.onData.mockClear();
  mockTerminal.onWriteParsed.mockClear();
  mockTerminal.onResize.mockClear();
  mockTerminal.buffer.onBufferChange.mockClear();
  mockTerminal.open.mockClear();
  mockTerminal.cols = 80;
  mockTerminal.rows = 24;
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
  model,
  title,
  onClose,
}: {
  sessionId?: string;
  agent?: "claude" | "codex" | "cursor";
  activity?: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
  model?: string;
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
        model={model}
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

function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove",
  touches: Array<{ clientX: number; clientY: number }>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: touches,
  });
  target.dispatchEvent(event);
  return event;
}

describe("buildDirectTerminalWsUrl", () => {
  it("uses ws on plain HTTP and preserves the host port", async () => {
    const { buildDirectTerminalWsUrl } = await import("@/components/DirectTerminal");
    expect(buildDirectTerminalWsUrl({ protocol: "http:", host: "localhost:5555" }, "abc")).toBe(
      "ws://localhost:5555/ws?session=abc",
    );
  });

  it("upgrades to wss when the page is served over HTTPS", async () => {
    const { buildDirectTerminalWsUrl } = await import("@/components/DirectTerminal");
    expect(buildDirectTerminalWsUrl({ protocol: "https:", host: "spur.example.com" }, "abc")).toBe(
      "wss://spur.example.com/ws?session=abc",
    );
  });

  it("encodes session ids that contain URL-significant characters", async () => {
    const { buildDirectTerminalWsUrl } = await import("@/components/DirectTerminal");
    expect(buildDirectTerminalWsUrl({ protocol: "http:", host: "h" }, "a b/c?d&e")).toBe(
      "ws://h/ws?session=a%20b%2Fc%3Fd%26e",
    );
  });
});

describe("DirectTerminal scroll integration", () => {
  it("opens the websocket on the same origin at /ws", async () => {
    await mountTerminal({ sessionId: "port-test" });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    expect(MockWebSocket).toHaveBeenCalledWith(`ws://${window.location.host}/ws?session=port-test`);
    expect(fetch).not.toHaveBeenCalledWith("/api/runtime/terminal", { cache: "no-store" });
  });

  it("scans only the newest 100 active-buffer rows during initial setup", async () => {
    normalBuffer.rows = [
      { text: "https://excluded.example" },
      ...Array.from({ length: 99 }, () => ({ text: "" })),
      { text: "https://included.example" },
    ];
    const getLine = vi.spyOn(normalBuffer, "getLine");

    await mountTerminal();

    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );
    expect(getLine).toHaveBeenCalledTimes(100);
    expect(getLine).not.toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    expect(screen.getByRole("link", { name: /included\.example/i })).toHaveAttribute(
      "href",
      "https://included.example",
    );
    expect(screen.queryByText("https://excluded.example")).not.toBeInTheDocument();
  });

  it("refreshes links after parsed writes, resize, and active-buffer changes", async () => {
    await mountTerminal();
    expect(screen.queryByRole("button", { name: "Open terminal links" })).not.toBeInTheDocument();

    normalBuffer.rows = [{ text: "https://parsed.example" }];
    act(() => parsedWriteCallback?.());
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );

    normalBuffer.rows = [{ text: "https://resized.example https://newest.example" }];
    act(() => terminalResizeCallback?.());
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    // Resize is a keep-mode rescan: it shows what is on screen right away,
    // even before these two urls are folded into discovered.
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://newest.example",
      "https://resized.example",
      "https://parsed.example",
    ]);

    act(() => parsedWriteCallback?.());
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://newest.example",
      "https://resized.example",
      "https://parsed.example",
    ]);

    alternateBuffer.rows = [{ text: "https://alternate.example" }];
    activeBuffer = alternateBuffer;
    act(() => bufferChangeCallback?.());
    expect(screen.getByRole("link", { name: /alternate\.example/i })).toBeInTheDocument();
    expect(screen.queryByText("https://newest.example")).not.toBeInTheDocument();

    activeBuffer = normalBuffer;
    act(() => bufferChangeCallback?.());
    expect(screen.getByRole("link", { name: /newest\.example/i })).toBeInTheDocument();
  });

  it("renders an accessible secure disclosure and closes it on activation or Escape", async () => {
    normalBuffer.rows = [{ text: "https://example.com/path?q=1" }];
    await mountTerminal();

    const trigger = await screen.findByRole("button", { name: "Open terminal links" });
    expect(trigger).toHaveAttribute("aria-controls", "terminal-links-panel");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(trigger);

    const panel = screen.getByRole("region", { name: "Terminal links" });
    expect(panel).toHaveAttribute("id", "terminal-links-panel");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /example\.com/i });
    expect(link).toHaveAttribute("href", "https://example.com/path?q=1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("title", "https://example.com/path?q=1");
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Terminal links" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("link", { name: /example\.com/i }));
    expect(screen.queryByRole("region", { name: "Terminal links" })).not.toBeInTheDocument();
  });

  it("keeps discovered links when a scan becomes empty", async () => {
    normalBuffer.rows = [{ text: "https://example.com" }];
    await mountTerminal();
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal links" }));
    expect(screen.getByRole("region", { name: "Terminal links" })).toBeInTheDocument();

    normalBuffer.rows = [];
    act(() => parsedWriteCallback?.());
    expect(screen.getByRole("button", { name: "Open terminal links" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Terminal links" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /example\.com/i })).toBeInTheDocument();
  });

  it("rejoins a URL split across hard-wrapped (isWrapped: false) rows into one link", async () => {
    const COLS = 80;
    const full =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88" +
      "ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com";
    const first = full.slice(0, COLS);
    const second = full.slice(COLS);
    normalBuffer.rows = [
      { text: first, isWrapped: false },
      { text: second, isWrapped: false },
    ];

    await mountTerminal();

    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    expect(screen.getByRole("link")).toHaveAttribute("href", full);
  });

  it("still rejoins a URL split across isWrapped: true rows into one link", async () => {
    const COLS = 80;
    const full =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88" +
      "ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com";
    const first = full.slice(0, COLS);
    const second = full.slice(COLS);
    normalBuffer.rows = [
      { text: first, isWrapped: false },
      { text: second, isWrapped: true },
    ];

    await mountTerminal();

    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    expect(screen.getByRole("link")).toHaveAttribute("href", full);
  });

  it("rejoins a URL split across a TUI's hanging-gutter continuation row into one link", async () => {
    // The component's mock does not pad translateToString output, so the
    // fixtures below are pre-padded to xterm's own cols (80), matching what
    // Terminal.buffer's real translateToString(false, 0, cols) returns.
    const COLS = 80;
    const prefix = "● https://example.com/";
    const first = (prefix + "a".repeat(COLS - prefix.length)).padEnd(COLS, " ");
    const gutter = "  ";
    const tail = "b".repeat(20);
    const second = (gutter + tail).padEnd(COLS, " ");
    const full = prefix.slice(2) + "a".repeat(COLS - prefix.length) + tail;

    normalBuffer.rows = [
      { text: first, isWrapped: false },
      { text: second, isWrapped: false },
    ];

    await mountTerminal();

    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    expect(screen.getByRole("link")).toHaveAttribute("href", full);
  });

  it("keeps a link discovered before its row left the buffer", async () => {
    normalBuffer.rows = [{ text: "https://a.example" }];
    await mountTerminal();
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "1",
    );

    normalBuffer.rows = [{ text: "https://b.example" }];
    act(() => parsedWriteCallback?.());
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "https://b.example",
      "https://a.example",
    ]);
  });

  it("evicts the oldest off-screen discovery when the cap is exceeded", async () => {
    normalBuffer.rows = Array.from({ length: 100 }, (_, index) => ({
      text: `https://cap-${index}.example`,
    }));
    await mountTerminal();
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "100",
    );

    normalBuffer.rows = [{ text: "https://cap-new.example" }];
    act(() => parsedWriteCallback?.());
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toHaveTextContent(
      "100",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal links" }));
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toHaveLength(100);
    expect(hrefs).toContain("https://cap-new.example");
    expect(hrefs).not.toContain("https://cap-0.example");
  });

  it("clears discovered links when the session identity changes", async () => {
    normalBuffer.rows = [{ text: "https://session-a.example" }];
    const result = await mountTerminal({ sessionId: "session-a" });
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toBeInTheDocument();
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    normalBuffer.rows = [];
    await act(async () => {
      result.rerender(<DirectTerminal sessionId="session-b" />);
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open terminal links" })).not.toBeInTheDocument();
    });
  });

  it("resets discovery ownership when the session identity changes", async () => {
    normalBuffer.rows = [{ text: "https://session-a.example" }];
    const result = await mountTerminal({ sessionId: "session-a" });
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal links" }));
    const staleParsedCallback = parsedWriteCallback;
    const staleResizeCallback = terminalResizeCallback;
    const staleBufferCallback = bufferChangeCallback;

    normalBuffer.rows = [];
    const { DirectTerminal } = await import("@/components/DirectTerminal");
    const { Terminal } = await import("xterm");
    const terminalConstructor = vi.mocked(Terminal);
    const constructionCount = terminalConstructor.mock.calls.length;
    terminalConstructor.mockImplementationOnce(() => {
      throw new Error("session B terminal setup failed");
    });
    await act(async () => {
      result.rerender(<DirectTerminal sessionId="session-b" />);
    });
    expect(screen.queryByRole("button", { name: "Open terminal links" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Terminal links" })).not.toBeInTheDocument();
    expect(discoveryDisposables.parsed).toHaveBeenCalledTimes(1);
    expect(discoveryDisposables.resize).toHaveBeenCalledTimes(1);
    expect(discoveryDisposables.buffer).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(terminalConstructor).toHaveBeenCalledTimes(constructionCount + 1);
    });

    normalBuffer.rows = [{ text: "https://session-a.example" }];
    act(() => {
      staleParsedCallback?.();
      staleResizeCallback?.();
      staleBufferCallback?.();
    });
    expect(screen.queryByRole("button", { name: "Open terminal links" })).not.toBeInTheDocument();

    await act(async () => {
      result.rerender(<DirectTerminal sessionId="session-c" />);
    });
    expect(await screen.findByRole("button", { name: "Open terminal links" })).toBeInTheDocument();
  });

  it("disposes every terminal-link listener on unmount", async () => {
    const result = await mountTerminal();
    result.unmount();

    expect(discoveryDisposables.parsed).toHaveBeenCalledTimes(1);
    expect(discoveryDisposables.resize).toHaveBeenCalledTimes(1);
    expect(discoveryDisposables.buffer).toHaveBeenCalledTimes(1);
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

  it("maps touch position and swipe direction to terminal cells", async () => {
    const { container } = await mountTerminal({ sessionId: "test-touch" });

    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();

    dispatchTouch(touchTarget!, "touchstart", [{ clientX: 500, clientY: 250 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 500, clientY: 210 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 700, clientY: 250 }]);

    expect(sentRawPayloads()).toEqual([
      "\x1b[<65;40;8M",
      "\x1b[<65;40;8M",
      "\x1b[<64;60;10M",
      "\x1b[<64;60;10M",
    ]);
  });

  it("accumulates sub-threshold touch movement and emits one event per 20 pixels", async () => {
    const { container } = await mountTerminal({ sessionId: "test-touch-accumulation" });
    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();

    dispatchTouch(touchTarget!, "touchstart", [{ clientX: 300, clientY: 200 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 300, clientY: 190 }]);
    expect(sentRawPayloads()).toEqual([]);

    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 300, clientY: 175 }]);
    expect(sentRawPayloads()).toEqual(["\x1b[<65;20;7M"]);
  });

  it("ignores multi-touch movement", async () => {
    const { container } = await mountTerminal({ sessionId: "test-touch-multiple" });
    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();

    dispatchTouch(touchTarget!, "touchstart", [
      { clientX: 300, clientY: 200 },
      { clientX: 400, clientY: 200 },
    ]);
    dispatchTouch(touchTarget!, "touchmove", [
      { clientX: 300, clientY: 100 },
      { clientX: 400, clientY: 100 },
    ]);

    expect(sentRawPayloads()).toEqual([]);
  });

  it("clamps touch positions outside the screen to valid terminal cells", async () => {
    const { container } = await mountTerminal({ sessionId: "test-touch-clamp" });
    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();

    dispatchTouch(touchTarget!, "touchstart", [{ clientX: -100, clientY: 200 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: -100, clientY: 100 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 1_000, clientY: 700 }]);

    expect(sentRawPayloads()).toEqual([
      ...Array.from({ length: 5 }, () => "\x1b[<65;1;3M"),
      ...Array.from({ length: 30 }, () => "\x1b[<64;80;24M"),
    ]);
  });

  it.each([
    ["zero width", new DOMRect(100, 50, 0, 480), 80, 24],
    ["zero height", new DOMRect(100, 50, 800, 0), 80, 24],
    ["infinite width", { left: 100, top: 50, width: Infinity, height: 480 } as DOMRect, 80, 24],
    ["NaN height", { left: 100, top: 50, width: 800, height: Number.NaN } as DOMRect, 80, 24],
    ["zero columns", new DOMRect(100, 50, 800, 480), 0, 24],
    ["infinite rows", new DOMRect(100, 50, 800, 480), 80, Infinity],
  ])("retains touch movement while %s is invalid", async (_name, rect, cols, rows) => {
    const { container } = await mountTerminal({ sessionId: "test-touch-invalid" });
    const touchTarget = container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();
    touchTarget!.getBoundingClientRect = vi.fn(() => rect as DOMRect);
    mockTerminal.cols = cols;
    mockTerminal.rows = rows;

    dispatchTouch(touchTarget!, "touchstart", [{ clientX: 500, clientY: 250 }]);
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 500, clientY: 210 }]);
    expect(sentRawPayloads()).toEqual([]);

    touchTarget!.getBoundingClientRect = vi.fn(() => new DOMRect(100, 50, 800, 480));
    mockTerminal.cols = 80;
    mockTerminal.rows = 24;
    dispatchTouch(touchTarget!, "touchmove", [{ clientX: 500, clientY: 200 }]);
    expect(sentRawPayloads()).toEqual(["\x1b[<65;40;8M", "\x1b[<65;40;8M"]);
  });

  it("removes touch listeners on unmount", async () => {
    const result = await mountTerminal({ sessionId: "test-touch-cleanup" });
    const touchTarget = result.container.querySelector(".xterm-screen");
    expect(touchTarget).not.toBeNull();
    const removeEventListener = vi.spyOn(touchTarget!, "removeEventListener");

    result.unmount();

    expect(removeEventListener).toHaveBeenCalledWith("touchstart", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("touchmove", expect.any(Function));
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

  it("sends a Tab key from the cursor shortcuts menu", async () => {
    await mountTerminal({ sessionId: "test-cursor-tab", agent: "cursor" });

    fireEvent.click(screen.getByRole("button", { name: "Open cursor shortcuts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Tab /i }));
    expect(wsSend).toHaveBeenCalledWith("\t");
    expect(screen.queryByRole("menu", { name: "cursor shortcuts" })).not.toBeInTheDocument();
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
    expect(titleElement.parentElement?.className).toContain("items-center");
  });

  it("keeps the agent label on the title row, right-aligned and never truncated", async () => {
    await mountTerminal({
      model: "claude-model-id",
      onClose: vi.fn(),
      title: "Very long terminal header title for isolated sidecar sessions",
    });

    const titleElement = screen.getByTestId("direct-terminal-header-title");
    const agentElement = screen.getByTestId("direct-terminal-header-agent");
    // Same row as the title, pushed to the right edge next to the close button.
    expect(agentElement.parentElement).toBe(titleElement.parentElement);
    expect(agentElement.className).toContain("ml-auto");
    // The title clamps instead; the agent label keeps its full width.
    expect(agentElement.className).toContain("shrink-0");
    expect(agentElement.className).toContain("whitespace-nowrap");
    expect(agentElement.className).not.toContain("truncate");
    expect(agentElement.className).toContain("text-[var(--color-text-tertiary)]");
  });
});
