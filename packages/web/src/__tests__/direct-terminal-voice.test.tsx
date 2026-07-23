import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVoiceState = {
  canUseVoice: true,
  recording: false,
  hasRetainedTake: false,
  retainedTakePlaying: false,
  voiceBusy: null as "starting" | "transcribing" | null,
  voiceModalOpen: true,
  voiceDraft: "git status",
  setVoiceDraft: vi.fn(),
  toggleRecording: vi.fn(),
  playRetainedTake: vi.fn(),
  discardRetainedTake: vi.fn(),
  retryRetainedTake: vi.fn(),
  stopAndSend: vi.fn(),
  cancelRecording: vi.fn(),
  confirmDraft: vi.fn((onInsert: (text: string) => void) => {
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
  options: {},
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
  StopSquareIcon: ({ className = "h-4 w-4" }: { className?: string }) => (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" />
  ),
  VoiceControls: ({ voice }: { voice: typeof mockVoiceState }) => (
    <button type="button">{voice.recording ? "Stop voice recording" : "Voice"}</button>
  ),
  VoiceConfirmModal: ({
    onInsert,
    voice,
  }: {
    onInsert: (text: string) => void;
    voice: typeof mockVoiceState;
  }) =>
    voice.voiceModalOpen ? (
      <button onClick={() => voice.confirmDraft(onInsert)} type="button">
        Confirm voice input
      </button>
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
    mockVoiceState.toggleRecording.mockClear();
    mockVoiceState.playRetainedTake.mockClear();
    mockVoiceState.discardRetainedTake.mockClear();
    mockVoiceState.retryRetainedTake.mockClear();
    mockVoiceState.stopAndSend.mockClear();
    mockVoiceState.cancelRecording.mockClear();
    mockVoiceState.recording = false;
    mockVoiceState.hasRetainedTake = false;
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

  it("renders edit, queue, and stop buttons above cancel while recording", async () => {
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
    const queue = screen.getByRole("button", { name: "Send voice to queue" });
    const stop = screen.getByRole("button", { name: "Stop and send voice" });
    const cancel = screen.getByRole("button", { name: "Cancel voice recording" });
    expect(pencil).toBeInTheDocument();
    expect(queue).toBeInTheDocument();
    expect(stop).toBeInTheDocument();
    expect(cancel).toBeInTheDocument();
    expect(pencil.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queue.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stop.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides footer recording controls while the confirm modal is open", async () => {
    mockVoiceState.recording = true;
    mockVoiceState.voiceModalOpen = true;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByRole("button", { name: "Confirm voice input" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit voice transcript" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send voice to queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel voice recording" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop and send voice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop voice recording" })).toBeNull();
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

  it("cancel click invokes cancelRecording", async () => {
    mockVoiceState.recording = true;
    mockVoiceState.voiceModalOpen = false;
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel voice recording" }));
    expect(mockVoiceState.cancelRecording).toHaveBeenCalledOnce();
    expect(mockVoiceState.dismissModal).not.toHaveBeenCalled();
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
});
