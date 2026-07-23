import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVoiceState = {
  canUseVoice: true,
  recording: false,
  hasRetainedTake: false,
  retainedTakePlaying: false,
  voiceBusy: null as "starting" | "transcribing" | null,
  voiceModalOpen: true,
  voiceDraft: "hello session",
  setVoiceDraft: vi.fn(),
  toggleRecording: vi.fn(),
  playRetainedTake: vi.fn(),
  discardRetainedTake: vi.fn(),
  retryRetainedTake: vi.fn(),
  stopAndSend: vi.fn(),
  cancelRecording: vi.fn(),
  confirmDraft: vi.fn(async (onSubmit: (text: string) => void | Promise<void>) => {
    try {
      await onSubmit(mockVoiceState.voiceDraft);
    } catch {
      // Mirrors the real hook's confirmDraft, which swallows send failures
      // into voiceError instead of letting them reject.
    }
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
    onQueue,
    voice,
  }: {
    onQueue: (text: string) => void | Promise<void>;
    voice: typeof mockVoiceState;
  }) =>
    voice.voiceModalOpen ? (
      <button onClick={() => void voice.confirmDraft(onQueue)} type="button">
        Queue voice input
      </button>
    ) : null,
}));

const MockWebSocket = vi.fn(() => {
  const ws: Record<string, unknown> = {
    readyState: 0,
    binaryType: "arraybuffer",
    send: vi.fn(),
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

const RATE_LIMITED_TOAST_TEXT = "Message not sent — this session is currently rate limited";

describe("DirectTerminal send failures", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockVoiceState.confirmDraft.mockClear();
    mockVoiceState.recording = false;
    mockVoiceState.voiceModalOpen = true;
    MockWebSocket.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("shows a rate-limited toast when the send endpoint returns 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Session api-a1 is rate limited" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="rate-limited-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Queue voice input" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(RATE_LIMITED_TOAST_TEXT);
    });
  });

  it("does not show the rate-limited toast for a non-409 failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="server-error-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Queue voice input" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/send"),
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(() => {
      expect(mockVoiceState.confirmDraft).toHaveResolved();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
