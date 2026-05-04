"use client";

import { useRef } from "react";
import { INPUT_CLASS } from "@/design/classes";
import { IMAGE_ACCEPT, type ImageAttachment } from "@/lib/image-attachments";
import { VoiceButton } from "@/components/VoiceInput";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";

function ImageIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="5" width="18" height="14" rx="0" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 15-4.5-4.5L7 20" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="M3 3 13 13M13 3 3 13" />
    </svg>
  );
}

const TOOL_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]";

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
          {attachments.map((attachment, index) => (
            <div
              key={`${attachment.file.name}-${index}`}
              className="relative h-9 w-9 shrink-0 border border-[var(--color-border-default)] bg-[var(--color-bg-base)]"
            >
              <img
                alt={attachment.file.name}
                className="h-full w-full object-cover"
                src={attachment.preview}
              />
              <button
                aria-label={`Remove ${attachment.file.name}`}
                className="absolute right-0 top-0 inline-flex h-4 w-4 items-center justify-center bg-[var(--color-bg-base)] text-[var(--color-text-primary)]"
                onClick={() => onRemoveAttachment(index)}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>

        <div className="pointer-events-auto flex items-center gap-1.5">
          <input
            accept={IMAGE_ACCEPT}
            className="hidden"
            multiple
            onChange={(event) => {
              onAddFiles(event.target.files);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label="Add image"
            className={TOOL_BUTTON_CLASS}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <ImageIcon />
          </button>
          {voice ? (
            <VoiceButton
              className={`${TOOL_BUTTON_CLASS} ${voice.recording || voice.voiceBusy === "transcribing" ? "" : ""}`}
              voice={voice}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
