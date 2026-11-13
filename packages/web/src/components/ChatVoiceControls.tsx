"use client";

import { useEffect } from "react";
import { useVoiceInput, type UseVoiceInput } from "@/hooks/useVoiceInput";
import { VoiceControls } from "@/components/VoiceInput";
import { COMPOSER_TOOL_BUTTON_CLASS } from "@/components/FileAttachmentControls";

export interface ChatVoiceState {
  starting: boolean;
  unavailable: boolean;
  error: string | null;
}

export function ChatVoiceControls({
  contextKey,
  onTranscribed,
  onState,
}: {
  contextKey: `page-chat:${string}` | `snippet-chat:${string}`;
  onTranscribed: (text: string) => void;
  onState: (state: ChatVoiceState) => void;
}) {
  const voice = useVoiceInput({ contextKey, onTranscribed });
  useEffect(() => {
    onState({
      starting: voice.voiceBusy === "starting",
      unavailable: !voice.canUseVoice,
      error: voice.voiceError?.slice(0, 2000) ?? null,
    });
  }, [onState, voice.voiceBusy, voice.canUseVoice, voice.voiceError]);
  return <ChatVoiceView voice={voice} />;
}

export function ChatVoiceView({ voice }: { voice: UseVoiceInput }) {
  return (
    <div className="pointer-events-none flex h-[108px] w-8 flex-col items-center justify-end gap-1.5 [&_button]:pointer-events-auto">
      <VoiceControls
        voice={voice}
        showRecordingCancel
        className={COMPOSER_TOOL_BUTTON_CLASS}
        groupClassName="flex flex-col items-center gap-1.5"
        recordingActionGroupClassName="flex flex-col items-center"
        slotClassName="flex flex-col items-center gap-1.5"
      />
    </div>
  );
}
