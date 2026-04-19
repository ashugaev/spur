"use client";

import { InputHistoryButton } from "@/components/InputHistory";
import { INPUT_CLASS } from "@/design/classes";
import type { UseVoiceInput } from "@/hooks/useVoiceInput";
import type { InputHistoryEntry } from "@/hooks/useInputHistory";

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

const Spinner = () => (
  <svg
    aria-hidden="true"
    className="voice-spinner h-4 w-4"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

function MicOrSpinner({ voice }: { voice: UseVoiceInput }) {
  if (voice.voiceBusy === "transcribing") return <Spinner />;
  return <MicIcon />;
}

const ACTIVE_STYLE =
  "border-[var(--color-status-error)] bg-[var(--color-status-error)]/12 text-[var(--color-status-error)]";
const IDLE_STYLE =
  "border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-hover-overlay)] text-[var(--color-text-primary)]";

export function VoiceButton({ voice, className }: { voice: UseVoiceInput; className?: string }) {
  if (!voice.canUseVoice) return null;
  const active = voice.recording || voice.voiceBusy === "transcribing";
  const baseClass =
    className ??
    `absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center border ${active ? "" : IDLE_STYLE}`;
  return (
    <button
      aria-label={voice.recording ? "Stop voice recording" : "Start voice recording"}
      className={`${baseClass} transition ${active ? ACTIVE_STYLE : ""} disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={voice.voiceBusy === "transcribing"}
      onClick={voice.toggleRecording}
      type="button"
    >
      <MicOrSpinner voice={voice} />
    </button>
  );
}

export function VoiceStatusHint({ voice }: { voice: UseVoiceInput }) {
  if (voice.voiceBusy === "starting") return <>Starting microphone...</>;
  if (voice.voiceBusy === "transcribing") return <>Transcribing audio...</>;
  if (voice.recording) return <>Recording... click the mic to stop</>;
  return null;
}

export function VoiceConfirmModal({
  voice,
  onInsert,
  historyEntries = [],
}: {
  voice: UseVoiceInput;
  onInsert: (text: string) => void;
  historyEntries?: InputHistoryEntry[];
}) {
  if (!voice.voiceModalOpen) return null;
  return (
    <div
      aria-label="Confirm voice input"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] p-4"
      role="dialog"
    >
      <div className="w-full max-w-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-4 py-2">
          <span className="font-bold uppercase text-[var(--color-text-primary)]">
            Confirm voice input
          </span>
          <button
            type="button"
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            onClick={voice.dismissModal}
          >
            ✕
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <p className="text-[var(--color-text-secondary)]">
            Review the transcription before inserting it into the message box.
          </p>
          <div className="relative">
            <textarea
              className={`min-h-40 w-full resize-y ${INPUT_CLASS}`}
              onChange={(event) => voice.setVoiceDraft(event.target.value)}
              value={voice.voiceDraft}
            />
            <VoiceButton
              voice={voice}
              className={`absolute bottom-2 right-2 inline-flex h-8 w-8 items-center justify-center border ${
                voice.recording || voice.voiceBusy === "transcribing" ? "" : IDLE_STYLE
              }`}
            />
          </div>
          {(voice.recording || voice.voiceBusy) && (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              <VoiceStatusHint voice={voice} />
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <InputHistoryButton entries={historyEntries} onSelect={voice.setVoiceDraft} />
            <button
              type="button"
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)]"
              onClick={voice.dismissModal}
            >
              Cancel
            </button>
            <button
              type="button"
              className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              disabled={!voice.voiceDraft.trim() || voice.recording || !!voice.voiceBusy}
              onClick={() => voice.confirmDraft(onInsert)}
            >
              Insert
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
