"use client";

import { INPUT_CLASS } from "@/design/classes";
import { filesFromDataTransfer, type FileAttachment } from "@/lib/file-attachments";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { VoiceControls } from "@/components/VoiceInput";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import {
  FileAttachmentPreviewStrip,
  FilePickerButton,
  COMPOSER_TOOL_BUTTON_CLASS,
} from "@/components/FileAttachmentControls";

export function FileAttachmentTextarea({
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
  clearLabel,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  attachments: FileAttachment[];
  onAddFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (index: number) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  voice?: UseVoiceInput;
  minHeightClass?: string;
  ariaLabel?: string;
  clearLabel?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const hasVoice = Boolean(voice?.canUseVoice);
  const effectiveClearLabel = clearLabel ?? (ariaLabel ? `Clear ${ariaLabel}` : "Clear text");

  return (
    <div className="relative">
      <textarea
        aria-label={ariaLabel}
        className={`w-full resize-y ${minHeightClass} ${INPUT_CLASS} pb-14 ${hasVoice ? "pr-[6rem]" : "pr-[3.25rem]"}`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = filesFromDataTransfer(event.clipboardData);
          if (files.length > 0) {
            event.preventDefault();
            onAddFiles(files);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          onAddFiles(filesFromDataTransfer(event.dataTransfer));
        }}
        onDragOver={(event) => event.preventDefault()}
        placeholder={placeholder}
        ref={textareaRef}
        value={value}
      />
      {value.length > 0 ? (
        <button
          aria-label={effectiveClearLabel}
          className={`${COMPOSER_TOOL_BUTTON_CLASS} absolute right-2 top-2`}
          onClick={() => {
            onChange("");
            textareaRef?.current?.focus();
          }}
          title={effectiveClearLabel}
          type="button"
        >
          <CloseIcon />
        </button>
      ) : null}

      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <div className="pointer-events-auto flex min-w-0 max-w-[calc(100%-6rem)] gap-1.5 overflow-x-auto">
          <FileAttachmentPreviewStrip
            attachments={attachments}
            onRemoveAttachment={onRemoveAttachment}
          />
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          <FilePickerButton onAddFiles={onAddFiles} />
          {voice ? (
            <VoiceControls
              className={COMPOSER_TOOL_BUTTON_CLASS}
              groupClassName="absolute bottom-0 right-0 z-10 flex flex-col items-center gap-1.5"
              recordingActionGroupClassName="absolute bottom-9 right-0 z-10 flex flex-col items-center gap-1.5"
              showRecordingCancel
              slotClassName="relative inline-flex h-8 w-8 items-end justify-end"
              voice={voice}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
