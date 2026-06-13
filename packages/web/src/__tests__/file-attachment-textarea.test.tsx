import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import type * as fileAttachmentsModule from "@/lib/file-attachments";

const filesFromDataTransferMock = vi.fn<(dt: DataTransfer | null) => File[]>(() => []);

vi.mock("@/lib/file-attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof fileAttachmentsModule>();
  return {
    ...actual,
    filesFromDataTransfer: (dt: DataTransfer | null) => filesFromDataTransferMock(dt),
  };
});

import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";

function HostedTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  onAddFiles?: (files: FileList | File[] | null) => void;
  voice?: UseVoiceInput;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <FileAttachmentTextarea
      ariaLabel="composer"
      attachments={[]}
      onAddFiles={props.onAddFiles ?? vi.fn()}
      onChange={props.onChange}
      onRemoveAttachment={vi.fn()}
      placeholder="Write..."
      textareaRef={ref}
      value={props.value}
      voice={props.voice}
    />
  );
}

function makeVoiceInput(overrides: Partial<UseVoiceInput> = {}): UseVoiceInput {
  return {
    canUseVoice: true,
    clearVoiceError: vi.fn(),
    confirmDraft: vi.fn(),
    discardRetainedTake: vi.fn(),
    dismissModal: vi.fn(),
    hasRetainedTake: false,
    openDraft: vi.fn(),
    playRetainedTake: vi.fn(),
    recording: false,
    retainedTakePlaying: false,
    retryRetainedTake: vi.fn(),
    setVoiceDraft: vi.fn(),
    stopAndSend: vi.fn(),
    toggleRecording: vi.fn(),
    voiceBusy: null,
    voiceDraft: "",
    voiceError: null,
    voiceModalOpen: false,
    ...overrides,
  };
}

describe("FileAttachmentTextarea", () => {
  beforeEach(() => {
    filesFromDataTransferMock.mockReset();
  });

  it.each([
    { action: "paste", fire: fireEvent.paste },
    { action: "drop", fire: fireEvent.drop },
  ])("$action with files calls onAddFiles", ({ fire }) => {
    const files = [new File(["x"], "a.png", { type: "image/png" })];
    filesFromDataTransferMock.mockReturnValueOnce(files);
    const onAddFiles = vi.fn();
    render(<HostedTextarea onAddFiles={onAddFiles} onChange={vi.fn()} value="" />);
    fire(screen.getByRole("textbox", { name: "composer" }));
    expect(onAddFiles).toHaveBeenCalledWith(files);
  });

  it("textarea change calls onChange with new value", () => {
    const onChange = vi.fn();
    render(<HostedTextarea onChange={onChange} value="" />);
    fireEvent.change(screen.getByRole("textbox", { name: "composer" }), {
      target: { value: "hello" },
    });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("renders clear button when value.length > 0", () => {
    render(<HostedTextarea onChange={vi.fn()} value="text" />);
    expect(screen.getByRole("button", { name: "Clear composer" })).toBeVisible();
  });

  it("clear button calls onChange('') and focuses textarea", () => {
    const onChange = vi.fn();
    render(<HostedTextarea onChange={onChange} value="text" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear composer" }));
    expect(onChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus();
  });

  it("shows retained voice controls instead of the mic button", () => {
    render(
      <HostedTextarea
        onChange={vi.fn()}
        value=""
        voice={makeVoiceInput({ hasRetainedTake: true })}
      />,
    );

    expect(screen.getByRole("button", { name: "Play failed voice recording" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry failed voice recording" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard failed voice recording" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start voice recording" })).not.toBeInTheDocument();
  });
});
