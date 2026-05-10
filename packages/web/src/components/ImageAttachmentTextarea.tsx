"use client";

import { INPUT_CLASS } from "@/design/classes";
import type { ImageAttachment } from "@/lib/image-attachments";
import { VoiceButton } from "@/components/VoiceInput";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import {
  ImageAttachmentPreviewStrip,
  ImagePickerButton,
  IMAGE_TOOL_BUTTON_CLASS,
} from "@/components/ImageAttachmentControls";

export function ImageAttachmentTextarea({
  value,
  onChange,
  placeholder,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onKeyDown,
  voice,
  minHeightClass = "min-h-24",
  ariaLabel,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  attachments: ImageAttachment[];
  onAddFiles: (files: FileList | null) => void;
  onRemoveAttachment: (index: number) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  voice?: UseVoiceInput;
  minHeightClass?: string;
  ariaLabel?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const hasVoice = Boolean(voice?.canUseVoice);

  return (
    <div className="relative">
      <textarea
        aria-label={ariaLabel}
        className={`w-full resize-y ${minHeightClass} ${INPUT_CLASS} pb-14 ${hasVoice ? "pr-[6rem]" : "pr-[3.25rem]"}`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = event.clipboardData.files;
          if (files.length > 0) {
            event.preventDefault();
            onAddFiles(files);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          onAddFiles(event.dataTransfer.files);
        }}
        onDragOver={(event) => event.preventDefault()}
        placeholder={placeholder}
        ref={textareaRef}
        value={value}
      />

      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <div className="pointer-events-auto flex min-w-0 max-w-[calc(100%-6rem)] gap-1.5 overflow-x-auto">
          <ImageAttachmentPreviewStrip
            attachments={attachments}
            onRemoveAttachment={onRemoveAttachment}
          />
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          <ImagePickerButton onAddFiles={onAddFiles} />
          {voice ? (
            <VoiceButton
              className={`${IMAGE_TOOL_BUTTON_CLASS} ${
                voice.recording || voice.voiceBusy === "transcribing" ? "" : ""
              }`}
              voice={voice}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
