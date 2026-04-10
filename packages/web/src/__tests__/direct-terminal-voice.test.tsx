import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVoiceState = {
  canUseVoice: true,
  recording: false,
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
  VoiceButton: () => <button type="button">Voice</button>,
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
    send: wsSend,
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

describe("DirectTerminal voice confirm", () => {
  beforeEach(() => {
    wsSend.mockClear();
    mockVoiceState.confirmDraft.mockClear();
    MockWebSocket.mockClear();
  });

  it("submits confirmed voice input with enter", async () => {
    const { DirectTerminal } = await import("@/components/DirectTerminal");

    await act(async () => {
      render(<DirectTerminal sessionId="voice-session" />);
    });

    await waitFor(() => {
      expect(MockWebSocket).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm voice input" }));

    expect(mockVoiceState.confirmDraft).toHaveBeenCalledOnce();
    expect(wsSend).toHaveBeenCalledWith("git status\r");
  });
});
