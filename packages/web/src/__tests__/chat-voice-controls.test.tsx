import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatVoiceControls } from "@/components/ChatVoiceControls";
import { useVoiceInput, type UseVoiceInput } from "@/hooks/useVoiceInput";

vi.mock("@/hooks/useVoiceInput", () => ({ useVoiceInput: vi.fn() }));
function controls(overrides: Partial<UseVoiceInput> = {}): UseVoiceInput {
  return {
    canUseVoice: true,
    recording: false,
    hasRetainedTake: false,
    retainedTakePlaying: false,
    voiceBusy: null,
    voiceModalOpen: false,
    voiceDraft: "",
    voiceError: null,
    setVoiceDraft: vi.fn(),
    openDraft: vi.fn(),
    toggleRecording: vi.fn(),
    playRetainedTake: vi.fn(),
    discardRetainedTake: vi.fn(),
    retryRetainedTake: vi.fn().mockResolvedValue(undefined),
    stopAndSend: vi.fn(),
    cancelRecording: vi.fn(),
    confirmDraft: vi.fn().mockResolvedValue(undefined),
    dismissModal: vi.fn(),
    clearVoiceError: vi.fn(),
    ...overrides,
  };
}
beforeEach(() => vi.mocked(useVoiceInput).mockReset());
describe("shared insert-only chat voice controls", () => {
  it("starts the existing recorder from host controls and inserts directly", () => {
    const voice = controls();
    vi.mocked(useVoiceInput).mockReturnValue(voice);
    const insert = vi.fn();
    const begin = vi.fn();
    render(
      <ChatVoiceControls contextKey="page-chat:one" onTranscribed={insert} onTakeStart={begin} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    expect(begin).toHaveBeenCalledOnce();
    expect(voice.toggleRecording).toHaveBeenCalledOnce();
    vi.mocked(useVoiceInput).mock.calls[0]?.[0].onTranscribed?.("dictated");
    expect(insert).toHaveBeenCalledWith("dictated");
    expect(voice.stopAndSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows cancellation/error and reuses failed-take recovery", () => {
    const voice = controls({ recording: true, voiceError: "Permission denied" });
    vi.mocked(useVoiceInput).mockReturnValue(voice);
    const { rerender } = render(
      <ChatVoiceControls contextKey="snippet-chat:one" onTranscribed={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice recording" }));
    expect(voice.cancelRecording).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
    vi.mocked(useVoiceInput).mockReturnValue(controls({ hasRetainedTake: true }));
    rerender(<ChatVoiceControls contextKey="snippet-chat:one" onTranscribed={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Retry failed voice recording" }),
    ).toBeInTheDocument();
  });
  it("reports unavailable voice without a send action", () => {
    vi.mocked(useVoiceInput).mockReturnValue(controls({ canUseVoice: false }));
    render(<ChatVoiceControls contextKey="page-chat:one" onTranscribed={vi.fn()} />);
    expect(screen.getByText("Voice unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
