import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatVoiceControls, ChatVoiceView } from "@/components/ChatVoiceControls";
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
  it("uses an in-flow 108px rail for the complete retained stack without creating a recorder in views", () => {
    const voice = controls({ hasRetainedTake: true });
    const { container } = render(<ChatVoiceView voice={voice} />);
    expect(useVoiceInput).not.toHaveBeenCalled();
    const rail = container.firstElementChild!;
    expect(rail.className).toContain("h-[108px]");
    const buttons = Array.from(rail.querySelectorAll("button"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Play failed voice recording",
      "Retry failed voice recording",
      "Discard failed voice recording",
    ]);
    expect(rail.querySelector('[class*="absolute"]')).toBeNull();
    expect(buttons.every((button) => button.className.includes("h-8"))).toBe(true);
  });
  it("reports microphone startup to the SDK and disables recording until ready", () => {
    vi.mocked(useVoiceInput).mockReturnValue(controls({ voiceBusy: "starting" }));
    const onState = vi.fn();
    render(
      <ChatVoiceControls contextKey="page-chat:one" onTranscribed={vi.fn()} onState={onState} />,
    );
    expect(onState).toHaveBeenCalledWith({ starting: true, unavailable: false, error: null });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeDisabled();
    expect(screen.queryByText("Starting…")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("starts the existing recorder from host controls and inserts directly", () => {
    const voice = controls();
    vi.mocked(useVoiceInput).mockReturnValue(voice);
    const insert = vi.fn();
    render(
      <ChatVoiceControls contextKey="page-chat:one" onTranscribed={insert} onState={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    expect(voice.toggleRecording).toHaveBeenCalledOnce();
    vi.mocked(useVoiceInput).mock.calls[0]?.[0].onTranscribed?.("dictated");
    expect(insert).toHaveBeenCalledWith("dictated");
    expect(voice.stopAndSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows cancellation/error and reuses failed-take recovery", () => {
    const voice = controls({ recording: true, voiceError: "Permission denied" });
    vi.mocked(useVoiceInput).mockReturnValue(voice);
    const onState = vi.fn();
    const { rerender } = render(
      <ChatVoiceControls contextKey="snippet-chat:one" onTranscribed={vi.fn()} onState={onState} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice recording" }));
    expect(voice.cancelRecording).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith({
      starting: false,
      unavailable: false,
      error: "Permission denied",
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    vi.mocked(useVoiceInput).mockReturnValue(controls({ hasRetainedTake: true }));
    rerender(
      <ChatVoiceControls contextKey="snippet-chat:one" onTranscribed={vi.fn()} onState={onState} />,
    );
    expect(
      screen.getByRole("button", { name: "Retry failed voice recording" }),
    ).toBeInTheDocument();
  });
  it("reports unavailable voice without a send action", () => {
    vi.mocked(useVoiceInput).mockReturnValue(controls({ canUseVoice: false }));
    const onState = vi.fn();
    render(
      <ChatVoiceControls contextKey="page-chat:one" onTranscribed={vi.fn()} onState={onState} />,
    );
    expect(onState).toHaveBeenCalledWith({ starting: false, unavailable: true, error: null });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
