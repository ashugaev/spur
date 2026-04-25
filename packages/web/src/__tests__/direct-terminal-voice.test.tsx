import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVoiceState = {
  canUseVoice: true,
  recording: false,
  recordingDurationLabel: "00:00",
  recordingDurationMs: 0,
  voiceBusy: null as "starting" | "transcribing" | null,
  voiceModalOpen: true,
  voiceDraft: "git status",
  setVoiceDraft: vi.fn(),
  toggleRecording: vi.fn(),
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
  isVoiceActive: () => false,
  VoiceButton: () => <button type="button">Voice</button>,
  VoiceRecordingTimer: () => null,
  VoiceConfirmModal: ({
    onInsert,
    voice,
  }: {
    onInsert: (text: string) => void;
    voice: typeof mockVoiceState;
  }) =>
    voice.voiceModalOpen ? (
      <div>
        <button onClick={() => voice.confirmDraft(onInsert)} type="button">
          Send voice draft
        </button>
        <button type="button">Pause and edit voice draft</button>
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

    fireEvent.click(screen.getByRole("button", { name: "Send voice draft" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Send voice draft" }));

    expect(mockVoiceState.confirmDraft).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(sentInputPayloads()).toEqual(["\u001b[200~git status\u001b[201~", "\r"]);
      expect(sentInputPayloads()).not.toContain("git status\r");
    });
  });

  it("stores confirmed terminal voice input in history", async () => {
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal agent="claude" sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send voice draft" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:input-history:terminal-draft")).toContain(
        "git status",
      );
    });
  });
});
