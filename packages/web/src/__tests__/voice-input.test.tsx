import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceButton,
  VoiceConfirmModal,
  VoiceControls,
  VoiceStatusHint,
} from "@/components/VoiceInput";
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
    openDraft: vi.fn(),
    toggleRecording: vi.fn(),
    playRetainedTake: vi.fn(),
    discardRetainedTake: vi.fn(),
    retryRetainedTake: vi.fn(),
    confirmDraft: vi.fn((onInsert: (text: string) => void, _options?: { allowEmpty?: boolean }) => {
      onInsert(voice.voiceDraft);
    }),
    cancelRecording: vi.fn(),
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
      "Edit transcription... Voice ⌘ + .",
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Confirm voice input" }), {
      key: "Enter",
      metaKey: true,
    });

    expect(voice.confirmDraft).toHaveBeenCalledWith(onInsert);
    expect(onInsert).toHaveBeenCalledWith("terminal hotkey insert");
  });

  it("shows a spinner and disables Insert/Queue/Cancel while a send is in flight", () => {
    const voice = createVoice({ voiceBusy: "sending" });

    render(
      <VoiceConfirmModal historyEntries={[]} onInsert={vi.fn()} onQueue={vi.fn()} voice={voice} />,
    );

    const insertButton = screen.getByRole("button", { name: "Inserting..." });
    const queueButton = screen.getByRole("button", { name: "Add to queue" });
    const cancelButton = screen.getByRole("button", { name: "Cancel" });

    expect(insertButton.querySelector(".voice-spinner")).not.toBeNull();
    expect(insertButton).toBeDisabled();
    expect(queueButton).toHaveTextContent("Queueing...");
    expect(queueButton.querySelector(".voice-spinner")).not.toBeNull();
    expect(queueButton).toBeDisabled();
    expect(cancelButton).toBeDisabled();
  });

  it("clears the voice draft from the corner button", () => {
    const voice = createVoice();

    render(<VoiceConfirmModal historyEntries={[]} onInsert={vi.fn()} voice={voice} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear voice draft" }));

    expect(voice.setVoiceDraft).toHaveBeenCalledWith("");
    expect(screen.getByRole("textbox")).toHaveFocus();
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

  it("keeps retained take group spacing on the container instead of each button", () => {
    const voice = createVoice({ hasRetainedTake: true, voiceModalOpen: false });

    render(
      <VoiceControls
        className="terminal-button"
        groupClassName="absolute bottom-0 right-0 flex flex-col gap-1"
        slotClassName="relative h-8 w-8"
        voice={voice}
      />,
    );

    const playButton = screen.getByRole("button", { name: "Play failed voice recording" });
    const retryButton = screen.getByRole("button", { name: "Retry failed voice recording" });
    const discardButton = screen.getByRole("button", { name: "Discard failed voice recording" });

    expect(playButton.parentElement).toHaveClass("flex-col");
    expect(playButton.parentElement?.parentElement).toHaveClass("relative");
    expect(playButton).toHaveClass("terminal-button");
    expect(retryButton).toHaveClass("terminal-button");
    expect(discardButton).toHaveClass("terminal-button");
    expect(playButton).not.toHaveClass("flex-col");
    expect(retryButton).not.toHaveClass("ml-2");
    expect(discardButton).not.toHaveClass("ml-2");
  });

  it("renders shared recording cancel in the mic slot with stop above it", () => {
    const voice = createVoice({ recording: true, voiceModalOpen: false });

    render(
      <VoiceControls
        className="voice-button"
        groupClassName="absolute bottom-0 right-0 flex flex-col gap-1"
        recordingActionGroupClassName="absolute bottom-9 right-0 flex flex-col gap-1"
        showRecordingCancel
        slotClassName="relative h-8 w-8"
        voice={voice}
      />,
    );

    const stop = screen.getByRole("button", { name: "Stop voice recording" });
    const cancel = screen.getByRole("button", { name: "Cancel voice recording" });
    expect(stop).toHaveClass("voice-button");
    expect(cancel).toHaveClass("voice-button");
    expect(stop.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(cancel);
    expect(voice.cancelRecording).toHaveBeenCalledOnce();
    expect(voice.dismissModal).not.toHaveBeenCalled();
  });

  it("renders stop-square icon when used as the recording action", () => {
    const voice = createVoice({ recording: true, voiceModalOpen: false });

    render(<VoiceButton voice={voice} />);

    const button = screen.getByRole("button", { name: "Stop voice recording" });
    expect(button.querySelector("path")?.getAttribute("d")).toBe("M4 4h8v8H4z");
  });
});
