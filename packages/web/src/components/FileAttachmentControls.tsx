"use client";

import { useRef } from "react";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { type FileAttachment } from "@/lib/file-attachments";

function FolderIcon() {
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
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FileIcon() {
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
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  );
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

export const COMPOSER_TOOL_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]";

export function FileAttachmentPreviewStrip({
  attachments,
  onRemoveAttachment,
}: {
  attachments: FileAttachment[];
  onRemoveAttachment: (index: number) => void;
}) {
  return (
    <>
      {attachments.map((attachment, index) => {
        const isImage = attachment.file.type.startsWith("image/");
        if (isImage) {
          return (
            <div
              key={`${attachment.file.name}-${index}`}
              className="relative h-12 w-12 shrink-0 border border-[var(--color-border-default)] bg-[var(--color-bg-base)]"
              title={attachment.file.name}
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
          );
        }
        return (
          <div
            key={`${attachment.file.name}-${index}`}
            className="relative inline-flex h-12 max-w-[12rem] shrink-0 items-center gap-2 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2 pr-8 text-[var(--color-text-primary)]"
            title={attachment.file.name}
          >
            <span className="shrink-0">
              <FileIcon />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate leading-tight">{attachment.file.name}</span>
              <span className="text-[10px] leading-tight text-[var(--color-text-secondary)]">
                {formatFileSize(attachment.file.size)}
              </span>
            </div>
            <button
              aria-label={`Remove ${attachment.file.name}`}
              className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-bg-base)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
              onClick={() => onRemoveAttachment(index)}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </>
  );
}

export function FilePickerButton({
  className = COMPOSER_TOOL_BUTTON_CLASS,
  onAddFiles,
}: {
  className?: string;
  onAddFiles: (files: FileList | File[] | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
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
        aria-label="Attach file"
        className={className}
        onClick={() => fileInputRef.current?.click()}
        type="button"
      >
        <FolderIcon />
      </button>
    </>
  );
}
