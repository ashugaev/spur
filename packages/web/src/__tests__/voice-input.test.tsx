import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceConfirmModal, VoiceControls, VoiceStatusHint } from "@/components/VoiceInput";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";

function createVoice(overrides?: Partial<UseVoiceInput>): UseVoiceInput {
  const voice = {
    canUseVoice: true,
    recording: false,
    hasRetainedTake: false,
    retainedTakePlaying: false,
    voiceBusy: null,
    voiceModalOpen: true,
    voiceDraft: "terminal hotkey insert",
    voiceError: null,
    setVoiceDraft: vi.fn(),
    toggleRecording: vi.fn(),
    playRetainedTake: vi.fn(),
    discardRetainedTake: vi.fn(),
    retryRetainedTake: vi.fn(),
    confirmDraft: vi.fn((onInsert: (text: string) => void) => {
      onInsert(voice.voiceDraft);
    }),
    dismissModal: vi.fn(),
    clearVoiceError: vi.fn(),
    ...overrides,
  } satisfies UseVoiceInput;

  return voice;
}

describe("VoiceInput", () => {
  it("hides the idle status line when voice is available", () => {
    const { container } = render(
      <VoiceStatusHint voice={createVoice({ voiceModalOpen: false })} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("submits the confirmation modal with Cmd+Enter", () => {
    const voice = createVoice();
    const onInsert = vi.fn();

    render(<VoiceConfirmModal historyEntries={[]} onInsert={onInsert} voice={voice} />);

    expect(screen.getByRole("button", { name: /Cancel/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /Insert/i })).toHaveTextContent("⌘ + ⏎");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Review the transcription before inserting... Voice ⌘ + .",
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Confirm voice input" }), {
      key: "Enter",
      metaKey: true,
    });

    expect(voice.confirmDraft).toHaveBeenCalledWith(onInsert);
    expect(onInsert).toHaveBeenCalledWith("terminal hotkey insert");
  });

  it("toggles recording from the confirmation modal with Cmd+.", () => {
    const voice = createVoice();

    render(<VoiceConfirmModal historyEntries={[]} onInsert={vi.fn()} voice={voice} />);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Confirm voice input" }), {
      key: ".",
      metaKey: true,
    });

    expect(voice.toggleRecording).toHaveBeenCalledOnce();
  });

  it("keeps retained take group spacing on the container instead of each button", () => {
    const voice = createVoice({ hasRetainedTake: true, voiceModalOpen: false });

    render(
      <VoiceControls
        className="terminal-button"
        groupClassName="ml-2 flex items-center gap-1"
        voice={voice}
      />,
    );

    const playButton = screen.getByRole("button", { name: "Play failed voice recording" });
    const retryButton = screen.getByRole("button", { name: "Retry failed voice recording" });
    const discardButton = screen.getByRole("button", { name: "Discard failed voice recording" });

    expect(playButton.parentElement).toHaveClass("ml-2");
    expect(playButton).toHaveClass("terminal-button");
    expect(retryButton).toHaveClass("terminal-button");
    expect(discardButton).toHaveClass("terminal-button");
    expect(playButton).not.toHaveClass("ml-2");
    expect(retryButton).not.toHaveClass("ml-2");
    expect(discardButton).not.toHaveClass("ml-2");
  });
});
