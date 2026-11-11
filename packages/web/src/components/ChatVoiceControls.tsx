"use client";

import { useVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceControls, VoiceStatusHint } from "@/components/VoiceInput";

export function ChatVoiceControls({
  contextKey,
  onTranscribed,
  onTakeStart,
}: {
  contextKey: `page-chat:${string}` | `snippet-chat:${string}`;
  onTranscribed: (text: string) => void;
  onTakeStart?: () => void;
}) {
  const voice = useVoiceInput({ contextKey, onTranscribed });
  const active = voice.recording || voice.voiceBusy !== null;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      onClickCapture={() => {
        if (!active && !voice.hasRetainedTake) onTakeStart?.();
      }}
    >
      <VoiceControls
        voice={voice}
        showRecordingCancel
        className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)]"
        groupClassName="flex items-center gap-1"
        recordingActionGroupClassName="inline-flex items-center"
      />
      {!voice.canUseVoice ? (
        <span className="text-[var(--color-text-tertiary)]">Voice unavailable</span>
      ) : null}
      {voice.voiceBusy === "starting" ? <VoiceStatusHint voice={voice} /> : null}
      {voice.voiceError ? (
        <span role="alert" className="text-[var(--color-status-error)]">
          {voice.voiceError}
        </span>
      ) : null}
    </div>
  );
}
