import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVoiceState = {
  canUseVoice: true,
  recording: false,
  voiceBusy: null as "starting" | "transcribing" | null,
  voiceModalOpen: true,
  voiceDraft: "git status",
  setVoiceDraft: vi.fn(),
  openDraft: vi.fn((value = "") => {
    mockVoiceState.voiceDraft = value;
    mockVoiceState.voiceModalOpen = true;
  }),
  toggleRecording: vi.fn(),
  stopAndSend: vi.fn(),
  confirmDraft: vi.fn((onInsert: (text: string) => void, options?: { allowEmpty?: boolean }) => {
    if (!mockVoiceState.voiceDraft.trim() && !options?.allowEmpty) return;
    onInsert(mockVoiceState.voiceDraft);
  }),
  dismissModal: vi.fn(),
  voiceError: null,
  clearVoiceError: vi.fn(),
};

const mockTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  focus: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onBinary: vi.fn(() => ({ dispose: vi.fn() })),
  cols: 80,
  rows: 24,
  parser: {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
  },
};

const mockFit = { fit: vi.fn(), dispose: vi.fn() };
const wsSend = vi.fn();

vi.mock("xterm", () => ({
  Terminal: vi.fn(() => mockTerminal),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => mockFit),
}));

vi.mock("@/hooks/useVoiceInput", () => ({
  useVoiceInput: () => mockVoiceState,
}));

vi.mock("@/components/VoiceInput", () => ({
  VoiceButton: () => <button type="button">Voice</button>,
  VoiceConfirmModal: ({
    attachments = [],
    onAddFiles,
    onInsert,
    voice,
  }: {
    attachments?: Array<{ file: File; preview: string }>;
    onAddFiles?: (files: FileList | null) => void;
    onInsert: (text: string) => void;
    voice: typeof mockVoiceState;
  }) =>
    voice.voiceModalOpen ? (
      <div role="dialog" aria-label="Confirm voice input">
        {onAddFiles ? <button type="button">Add image</button> : null}
        {attachments.map((attachment) => (
          <img alt={attachment.file.name} key={attachment.file.name} src={attachment.preview} />
        ))}
        <button
          onClick={() => voice.confirmDraft(onInsert, { allowEmpty: attachments.length > 0 })}
          type="button"
        >
          Confirm voice input
        </button>
      </div>
    ) : null,
}));

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
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  queueMicrotask(() => {
    ws.readyState = 1;
    (ws.onopen as (event: unknown) => void)?.({});
  });
  return ws;
});

(MockWebSocket as unknown as Record<string, number>).CONNECTING = 0;
(MockWebSocket as unknown as Record<string, number>).OPEN = 1;
(MockWebSocket as unknown as Record<string, number>).CLOSING = 2;
(MockWebSocket as unknown as Record<string, number>).CLOSED = 3;

vi.stubGlobal("WebSocket", MockWebSocket);

function sentInputPayloads(): string[] {
  return wsSend.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is string => typeof payload === "string" && payload.startsWith("{"))
    .map((payload) => JSON.parse(payload) as { type?: string; data?: string })
    .filter(
      (payload): payload is { type: "input"; data: string } =>
        payload.type === "input" && typeof payload.data === "string",
    )
    .map((payload) => payload.data);
}

describe("DirectTerminal voice confirm", () => {
  beforeEach(() => {
    window.localStorage.clear();
    wsSend.mockClear();
    mockVoiceState.confirmDraft.mockClear();
    mockVoiceState.openDraft.mockClear();
    mockVoiceState.toggleRecording.mockClear();
    mockVoiceState.stopAndSend.mockClear();
    mockVoiceState.recording = false;
    mockVoiceState.voiceModalOpen = true;
    MockWebSocket.mockClear();
  });

  it("submits confirmed voice input as bracketed paste plus enter for claude", async () => {
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm voice input" }));

    expect(mockVoiceState.confirmDraft).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(sentInputPayloads()).toEqual(["\u001b[200~git status\u001b[201~", "\r"]);
      expect(sentInputPayloads()).not.toContain("git status\r");
    });
  });

  it("submits confirmed voice input as bracketed paste plus enter for codex", async () => {
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="codex" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm voice input" }));

    expect(mockVoiceState.confirmDraft).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(sentInputPayloads()).toEqual(["\u001b[200~git status\u001b[201~", "\r"]);
      expect(sentInputPayloads()).not.toContain("git status\r");
    });
  });

  it("renders pencil and stop buttons while recording with stop on the right", async () => {
    mockVoiceState.recording = true;
    mockVoiceState.voiceModalOpen = false;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    const pencil = screen.getByRole("button", { name: "Edit voice transcript" });
    const stop = screen.getByRole("button", { name: "Stop and send voice" });
    expect(pencil).toBeInTheDocument();
    expect(stop).toBeInTheDocument();
    // Source order = visual order with flex-row.
    expect(pencil.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stop click invokes stopAndSend", async () => {
    mockVoiceState.recording = true;
    mockVoiceState.voiceModalOpen = false;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop and send voice" }));
    expect(mockVoiceState.stopAndSend).toHaveBeenCalledOnce();
    expect(typeof mockVoiceState.stopAndSend.mock.calls[0]?.[0]).toBe("function");
  });

  it("pencil click invokes toggleRecording (opens edit flow)", async () => {
    mockVoiceState.recording = true;
    mockVoiceState.voiceModalOpen = false;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit voice transcript" }));
    expect(mockVoiceState.toggleRecording).toHaveBeenCalledOnce();
  });

  it("renders single mic VoiceButton when not recording", async () => {
    mockVoiceState.recording = false;
    mockVoiceState.voiceModalOpen = false;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByRole("button", { name: "Edit voice transcript" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop and send voice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Voice" })).toBeInTheDocument();
  });

  it("stores confirmed terminal voice input in history", async () => {
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm voice input" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:input-history:terminal-draft")).toContain(
        "git status",
      );
    });
  });

  it("opens image paste in the terminal confirm modal and sends attachments through the session API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/runtime/terminal") {
        return new Response(JSON.stringify({ directTerminalPort: 14801 }), { status: 200 });
      }
      if (url === "/api/sessions/canonical-session/send") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockVoiceState.voiceModalOpen = false;
    mockVoiceState.voiceDraft = "";
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal apiSessionId="canonical-session" sessionId="tmux-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    const file = new File(["PNG"], "terminal.png", { type: "image/png" });
    fireEvent.paste(screen.getByTestId("direct-terminal-surface"), {
      clipboardData: {
        files: [file] as unknown as FileList,
      },
    });

    await waitFor(() => {
      expect(mockVoiceState.openDraft).toHaveBeenCalledWith("");
      expect(screen.getByRole("img", { name: "terminal.png" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm voice input" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/canonical-session/send",
        expect.objectContaining({
          body: expect.stringContaining("terminal.png"),
          method: "POST",
        }),
      );
    });
    expect(sentInputPayloads()).toEqual([]);
  });

  it("does not route sidecar terminal image paste to the session API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/runtime/terminal") {
        return new Response(JSON.stringify({ directTerminalPort: 14801 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    mockVoiceState.voiceModalOpen = false;
    mockVoiceState.voiceDraft = "";
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(
        <DirectTerminal
          agentInputEnabled={false}
          apiSessionId="canonical-session"
          sessionId="sidecar-session"
        />,
      );
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.paste(screen.getByTestId("direct-terminal-surface"), {
      clipboardData: {
        files: [new File(["PNG"], "sidecar.png", { type: "image/png" })] as unknown as FileList,
      },
    });

    expect(mockVoiceState.openDraft).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/sessions/canonical-session/send",
      expect.anything(),
    );
  });
});
