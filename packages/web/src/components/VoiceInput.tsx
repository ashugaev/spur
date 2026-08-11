"use client";

import { useEffect, useRef } from "react";
import { CloseIcon } from "@/components/icons/CloseIcon";
import { BusyContent } from "@/components/BusyContent";
import { Spinner } from "@/components/icons/Spinner";
import { InputHistoryButton } from "@/components/InputHistory";
import {
  FileAttachmentPreviewStrip,
  FilePickerButton,
  COMPOSER_TOOL_BUTTON_CLASS,
} from "@/components/FileAttachmentControls";
import { INPUT_CLASS } from "@/design/classes";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import type { InputHistoryEntry } from "@/hooks/useInputHistory";
import { imageFilesFromDataTransfer, type FileAttachment } from "@/lib/file-attachments";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
  VOICE_TOGGLE_HINT,
} from "@/lib/submit-hotkeys";

const MicIcon = () => (
  <svg
    aria-hidden="true"
    className="h-4 w-4"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    viewBox="0 0 24 24"
  >
    <path d="M12 4a3 3 0 0 1 3 3v4a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z" />
    <path d="M19 11a7 7 0 0 1-14 0" />
    <path d="M12 18v3" />
    <path d="M8 21h8" />
  </svg>
);

export const StopSquareIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg aria-hidden="true" className={className} fill="currentColor" viewBox="0 0 16 16">
    <path d="M4 4h8v8H4z" />
  </svg>
);

const PlayIcon = () => (
  <svg aria-hidden="true" className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
    <path d="M4 3.5v9l8-4.5-8-4.5Z" />
  </svg>
);

const RetryIcon = () => (
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
    <path d="M20 11a8 8 0 1 0-2.34 5.66" />
    <path d="M20 4v7h-7" />
  </svg>
);

const DiscardIcon = () => (
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
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 12h10l1-12" />
    <path d="M9 7V4h6v3" />
  </svg>
);

function MicOrSpinner({ voice }: { voice: UseVoiceInput }) {
  if (voice.voiceBusy === "transcribing") return <Spinner />;
  if (voice.recording) return <StopSquareIcon />;
  return <MicIcon />;
}

const ACTIVE_STYLE =
  "border-[var(--color-status-error)] bg-[var(--color-status-error)]/12 text-[var(--color-status-error)]";
const ACTIVE_STYLE_BORDERLESS =
  "border-0 bg-[var(--color-status-error)]/12 text-[var(--color-status-error)]";
const IDLE_STYLE =
  "border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-primary)]";
const IDLE_STYLE_BORDERLESS =
  "border-0 bg-transparent hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-primary)]";

export function VoiceButton({
  voice,
  className,
  borderless = false,
}: {
  voice: UseVoiceInput;
  className?: string;
  borderless?: boolean;
}) {
  if (!voice.canUseVoice) return null;
  const active = voice.recording || voice.voiceBusy === "transcribing";
  const baseClass =
    className ??
    (borderless
      ? `inline-flex h-7 w-7 items-center justify-center ${IDLE_STYLE_BORDERLESS}`
      : `absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center border ${active ? "" : IDLE_STYLE}`);
  const activeStyle = borderless ? ACTIVE_STYLE_BORDERLESS : ACTIVE_STYLE;
  const label = voice.recording ? "Stop voice recording" : "Start voice recording";

  return (
    <button
      aria-label={label}
      aria-keyshortcuts="Meta+."
      className={`${baseClass} transition ${active ? activeStyle : ""} disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={voice.voiceBusy === "starting" || voice.voiceBusy === "transcribing"}
      onClick={voice.toggleRecording}
      title={`${label} (${VOICE_TOGGLE_HINT})`}
      type="button"
    >
      <MicOrSpinner voice={voice} />
    </button>
  );
}

function VoiceControlButton({
  ariaLabel,
  children,
  className,
  disabled = false,
  onClick,
}: {
  ariaLabel: string;
  children: React.ReactNode;
  className: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function VoiceControls({
  voice,
  className,
  groupClassName,
  recordingActionGroupClassName,
  showRecordingCancel = false,
  slotClassName,
  onRetrySend,
  borderless = false,
}: {
  voice: UseVoiceInput;
  className?: string;
  groupClassName?: string;
  recordingActionGroupClassName?: string;
  showRecordingCancel?: boolean;
  slotClassName?: string;
  onRetrySend?: (text: string) => void | Promise<void>;
  borderless?: boolean;
}) {
  const retainedActiveStyle = borderless ? ACTIVE_STYLE_BORDERLESS : ACTIVE_STYLE;
  const retainedButtonClass = className
    ? `${className} ${retainedActiveStyle}`
    : borderless
      ? `inline-flex h-7 w-7 items-center justify-center ${retainedActiveStyle}`
      : `inline-flex h-8 w-8 items-center justify-center border border-[var(--color-status-error)] bg-[var(--color-status-error)]/12 text-[var(--color-status-error)] transition hover:bg-[var(--color-status-error)]/18`;

  if (voice.recording && showRecordingCancel) {
    const controls = (
      <>
        <div
          className={
            recordingActionGroupClassName ??
            "absolute bottom-9 right-0 z-20 flex flex-col items-center gap-1"
          }
        >
          <VoiceButton className={className} borderless={borderless} voice={voice} />
        </div>
        <VoiceControlButton
          ariaLabel="Cancel voice recording"
          className={retainedButtonClass}
          onClick={voice.cancelRecording}
        >
          <CloseIcon />
        </VoiceControlButton>
      </>
    );

    if (slotClassName) {
      return <div className={slotClassName}>{controls}</div>;
    }

    return <div className="relative inline-flex">{controls}</div>;
  }

  if (!voice.hasRetainedTake) {
    const button = <VoiceButton borderless={borderless} className={className} voice={voice} />;
    return slotClassName ? <div className={slotClassName}>{button}</div> : button;
  }

  const disabled = voice.recording || !!voice.voiceBusy;

  const controls = (
    <div className={groupClassName ?? "flex flex-col items-center gap-1"}>
      <VoiceControlButton
        ariaLabel={
          voice.retainedTakePlaying ? "Stop failed voice playback" : "Play failed voice recording"
        }
        className={retainedButtonClass}
        disabled={disabled}
        onClick={voice.playRetainedTake}
      >
        <PlayIcon />
      </VoiceControlButton>
      <VoiceControlButton
        ariaLabel="Retry failed voice recording"
        className={retainedButtonClass}
        disabled={disabled}
        onClick={() => void voice.retryRetainedTake(onRetrySend)}
      >
        {voice.voiceBusy === "transcribing" ? <Spinner /> : <RetryIcon />}
      </VoiceControlButton>
      <VoiceControlButton
        ariaLabel="Discard failed voice recording"
        className={retainedButtonClass}
        disabled={disabled}
        onClick={() => void voice.discardRetainedTake()}
      >
        <DiscardIcon />
      </VoiceControlButton>
    </div>
  );

  return slotClassName ? <div className={slotClassName}>{controls}</div> : controls;
}

export function VoiceStatusHint({ voice }: { voice: UseVoiceInput }) {
  if (voice.voiceBusy === "starting") return <>Starting microphone...</>;
  if (voice.voiceBusy === "transcribing") return <>Transcribing audio...</>;
  if (voice.recording) return <>Recording — {VOICE_TOGGLE_HINT} to stop</>;
  return null;
}

export function voicePlaceholder(base: string, voice: UseVoiceInput) {
  if (voice.canUseVoice && !voice.recording && !voice.voiceBusy) {
    return `${base} Voice ${VOICE_TOGGLE_HINT}`;
  }
  return base;
}

export function VoiceConfirmModal({
  voice,
  onInsert,
  onQueue,
  historyEntries = [],
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  onDismiss,
}: {
  voice: UseVoiceInput;
  onInsert: (text: string) => void | Promise<void>;
  onQueue?: (text: string) => void | Promise<void>;
  historyEntries?: InputHistoryEntry[];
  attachments?: FileAttachment[];
  onAddFiles?: (files: FileList | File[] | null) => void;
  onRemoveAttachment?: (index: number) => void;
  onDismiss?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasAttachments = attachments.length > 0;
  const dismiss = () => {
    if (voice.voiceBusy === "sending") return;
    onDismiss?.();
    voice.dismissModal();
  };
  const confirmDraft = () => {
    if (hasAttachments) {
      void voice.confirmDraft(onInsert, { allowEmpty: true });
      return;
    }
    void voice.confirmDraft(onInsert);
  };
  const queueDraft = () => {
    if (!onQueue) return;
    if (hasAttachments) {
      void voice.confirmDraft(onQueue, { allowEmpty: true });
      return;
    }
    void voice.confirmDraft(onQueue);
  };

  useEffect(() => {
    if (voice.voiceModalOpen) {
      textareaRef.current?.focus();
    }
  }, [voice.voiceModalOpen]);

  if (!voice.voiceModalOpen) return null;

  return (
    <div
      aria-label="Confirm voice input"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss();
          return;
        }
        if (isVoiceToggleHotkey(event)) {
          event.preventDefault();
          voice.toggleRecording();
          return;
        }
        if (isPrimarySubmitHotkey(event)) {
          event.preventDefault();
          if (voice.voiceBusy || voice.recording) return;
          confirmDraft();
        }
      }}
      role="dialog"
    >
      <div className="w-full max-w-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-4 py-2">
          <span className="font-bold uppercase text-[var(--color-text-primary)]">
            Confirm voice input
          </span>
          <button
            aria-label="Close voice draft"
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
            disabled={voice.voiceBusy === "sending"}
            onClick={dismiss}
            title="Close voice draft"
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div className="relative">
            <textarea
              className={`min-h-40 w-full resize-y ${INPUT_CLASS} pb-14 ${
                onAddFiles ? "pr-[6rem]" : "pr-[3.25rem]"
              }`}
              onChange={(event) => voice.setVoiceDraft(event.target.value)}
              onDragOver={(event) => {
                if (onAddFiles) event.preventDefault();
              }}
              onDrop={(event) => {
                if (!onAddFiles) return;
                event.preventDefault();
                onAddFiles(imageFilesFromDataTransfer(event.dataTransfer));
              }}
              onPaste={(event) => {
                if (!onAddFiles) return;
                const files = imageFilesFromDataTransfer(event.clipboardData);
                if (files.length === 0) return;
                event.preventDefault();
                onAddFiles(files);
              }}
              placeholder={voicePlaceholder("Edit transcription...", voice)}
              ref={textareaRef}
              value={voice.voiceDraft}
            />
            {voice.voiceDraft.length > 0 ? (
              <button
                aria-label="Clear voice draft"
                className={`${COMPOSER_TOOL_BUTTON_CLASS} absolute right-2 top-2`}
                onClick={() => {
                  voice.setVoiceDraft("");
                  textareaRef.current?.focus();
                }}
                title="Clear voice draft"
                type="button"
              >
                <CloseIcon />
              </button>
            ) : null}
            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
              <div className="pointer-events-auto flex min-w-0 max-w-[calc(100%-6rem)] gap-1.5 overflow-x-auto">
                <FileAttachmentPreviewStrip
                  attachments={attachments}
                  onRemoveAttachment={onRemoveAttachment ?? (() => {})}
                />
              </div>
              <div className="pointer-events-auto flex items-center gap-1.5">
                {onAddFiles ? <FilePickerButton onAddFiles={onAddFiles} /> : null}
                <VoiceControls
                  className={`${onAddFiles ? COMPOSER_TOOL_BUTTON_CLASS : "inline-flex h-8 w-8 items-center justify-center border"} ${
                    voice.recording || voice.voiceBusy === "transcribing" ? "" : IDLE_STYLE
                  }`}
                  groupClassName="absolute bottom-0 right-0 z-10 flex flex-col items-center gap-1.5"
                  onRetrySend={onInsert}
                  recordingActionGroupClassName="absolute bottom-9 right-0 z-10 flex flex-col items-center gap-1.5"
                  showRecordingCancel
                  slotClassName="relative inline-flex h-8 w-8 items-end justify-end"
                  voice={voice}
                />
              </div>
            </div>
          </div>
          {(voice.recording ||
            voice.voiceBusy === "starting" ||
            voice.voiceBusy === "transcribing") && (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              <VoiceStatusHint voice={voice} />
            </p>
          )}
          {voice.voiceError ? (
            <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-[var(--color-chip-error-text)]">
              {voice.voiceError}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <InputHistoryButton entries={historyEntries} onSelect={voice.setVoiceDraft} />
            <button
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              disabled={voice.voiceBusy === "sending"}
              onClick={dismiss}
              type="button"
            >
              Cancel
            </button>
            {onQueue ? (
              <button
                aria-busy={voice.voiceBusy === "sending" || undefined}
                aria-label={voice.voiceBusy === "sending" ? "Queueing voice input" : "Add to queue"}
                className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                disabled={
                  (!voice.voiceDraft.trim() && !hasAttachments) ||
                  voice.recording ||
                  !!voice.voiceBusy
                }
                onClick={queueDraft}
                type="button"
              >
                <BusyContent busy={voice.voiceBusy === "sending"}>Queue</BusyContent>
              </button>
            ) : null}
            <button
              aria-busy={voice.voiceBusy === "sending" || undefined}
              aria-label={voice.voiceBusy === "sending" ? "Inserting voice input" : undefined}
              className="inline-flex items-center gap-2 bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              disabled={
                (!voice.voiceDraft.trim() && !hasAttachments) ||
                voice.recording ||
                !!voice.voiceBusy
              }
              onClick={confirmDraft}
              type="button"
            >
              <BusyContent busy={voice.voiceBusy === "sending"}>
                <span>Insert</span>
                <span
                  aria-hidden="true"
                  className="whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-inverse)]/72"
                >
                  {PRIMARY_SUBMIT_HINT}
                </span>
              </BusyContent>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
