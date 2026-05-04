import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VoiceConfirmModal, VoiceStatusHint } from "@/components/VoiceInput";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";

function createVoice(overrides?: Partial<UseVoiceInput>): UseVoiceInput {
  const voice = {
    canUseVoice: true,
    recording: false,
    voiceBusy: null,
    voiceModalOpen: true,
    voiceDraft: "terminal hotkey insert",
    voiceError: null,
    setVoiceDraft: vi.fn(),
    toggleRecording: vi.fn(),
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

    expect(screen.getByRole("button", { name: /Pause and edit voice draft/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /Send voice draft/i })).toHaveTextContent("⌘ + ⏎");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      "Review the transcription before sending... Voice ⌘ + .",
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
});
