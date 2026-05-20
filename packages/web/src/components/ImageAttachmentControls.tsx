"use client";

import { useRef } from "react";
import { IMAGE_ACCEPT, type ImageAttachment } from "@/lib/image-attachments";

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

export const IMAGE_TOOL_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]";

export function ImageAttachmentPreviewStrip({
  attachments,
  onRemoveAttachment,
}: {
  attachments: ImageAttachment[];
  onRemoveAttachment: (index: number) => void;
}) {
  return (
    <>
      {attachments.map((attachment, index) => (
        <div
          key={`${attachment.file.name}-${index}`}
          className="relative h-12 w-12 shrink-0 border border-[var(--color-border-default)] bg-[var(--color-bg-base)]"
        >
          <img
            alt={attachment.file.name}
            className="h-full w-full object-cover"
            src={attachment.preview}
          />
          <button
            aria-label={`Remove ${attachment.file.name}`}
            className="absolute right-0 top-0 inline-flex h-8 w-8 items-center justify-center border-b border-l border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
            onClick={() => onRemoveAttachment(index)}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </>
  );
}

export function ImagePickerButton({
  className = IMAGE_TOOL_BUTTON_CLASS,
  onAddFiles,
}: {
  className?: string;
  onAddFiles: (files: FileList | File[] | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
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
        className={className}
        onClick={() => fileInputRef.current?.click()}
        type="button"
      >
        <ImageIcon />
      </button>
    </>
  );
}
