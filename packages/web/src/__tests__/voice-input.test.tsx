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
    openDraft: vi.fn(),
    toggleRecording: vi.fn(),
    confirmDraft: vi.fn((onInsert: (text: string) => void, _options?: { allowEmpty?: boolean }) => {
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

  it("shows image controls and allows attachment-only confirmation", () => {
    const voice = createVoice({ voiceDraft: "" });
    const onAddFiles = vi.fn();

    render(
      <VoiceConfirmModal
        attachments={[
          {
            file: new File(["png"], "terminal.png", { type: "image/png" }),
            preview: "data:image/png;base64,cG5n",
          },
        ]}
        historyEntries={[]}
        onAddFiles={onAddFiles}
        onInsert={vi.fn()}
        onRemoveAttachment={vi.fn()}
        voice={voice}
      />,
    );

    expect(screen.getByRole("button", { name: "Attach file" })).toBeVisible();
    expect(screen.getByRole("img", { name: "terminal.png" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Insert/i }));

    expect(voice.confirmDraft).toHaveBeenCalledWith(expect.any(Function), { allowEmpty: true });
  });
});
