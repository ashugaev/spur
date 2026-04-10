"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface VoiceStatus {
  available: boolean;
  modelPath?: string;
  language: string;
  reason?: string;
}

export interface UseVoiceInput {
  canUseVoice: boolean;
  recording: boolean;
  voiceBusy: "starting" | "transcribing" | null;
  voiceModalOpen: boolean;
  voiceDraft: string;
  setVoiceDraft: (value: string) => void;
  toggleRecording: () => void;
  confirmDraft: (onInsert: (text: string) => void) => void;
  dismissModal: () => void;
  voiceError: string | null;
  clearVoiceError: () => void;
}

export function useVoiceInput(options?: { onTranscribed?: (text: string) => void }): UseVoiceInput {
  const onTranscribedRef = useRef(options?.onTranscribed);
  onTranscribedRef.current = options?.onTranscribed;
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState<"starting" | "transcribing" | null>(null);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/runtime/voice", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as VoiceStatus;
        if (!cancelled) setVoiceStatus(payload);
      } catch {
        if (!cancelled) setVoiceStatus({ available: false, language: "", reason: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      mediaChunksRef.current = [];
    };
  }, []);

  const stopStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    mediaChunksRef.current = [];
    setRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (!voiceStatus?.available) return;

    setVoiceError(null);
    setVoiceBusy("starting");

    void (async () => {
      try {
        if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
          throw new Error("Voice recording is not supported in this browser");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Microphone access requires HTTPS. Connect via Tailscale HTTPS or localhost.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaStreamRef.current = stream;
        mediaRecorderRef.current = recorder;
        mediaChunksRef.current = [];

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) mediaChunksRef.current.push(event.data);
        });

        recorder.addEventListener("stop", () => {
          const chunks = [...mediaChunksRef.current];
          stopStream();
          if (chunks.length === 0) return;
          void (async () => {
            setVoiceBusy("transcribing");
            try {
              const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const formData = new FormData();
              formData.append("audio", audio, "voice-input.webm");
              const response = await fetch("/api/runtime/voice/transcribe", {
                method: "POST",
                body: formData,
              });
              if (!response.ok) throw new Error(await response.text());
              const payload = (await response.json()) as { text?: string };
              const text = payload.text?.trim() ?? "";
              if (!text) throw new Error("Transcription returned empty text");
              if (onTranscribedRef.current) {
                onTranscribedRef.current(text);
              } else {
                setVoiceDraft(text);
                setVoiceModalOpen(true);
              }
            } catch (err) {
              setVoiceError(err instanceof Error ? err.message : "Failed to transcribe audio");
            } finally {
              setVoiceBusy(null);
            }
          })();
        });

        recorder.start();
        setRecording(true);
      } catch (err) {
        stopStream();
        setVoiceError(err instanceof Error ? err.message : "Failed to start recording");
      } finally {
        setVoiceBusy((current) => (current === "starting" ? null : current));
      }
    })();
  }, [recording, stopStream, voiceStatus]);

  const confirmDraft = useCallback(
    (onInsert: (text: string) => void) => {
      const trimmed = voiceDraft.trim();
      if (!trimmed) return;
      onInsert(trimmed);
      setVoiceModalOpen(false);
      setVoiceDraft("");
    },
    [voiceDraft],
  );

  const dismissModal = useCallback(() => {
    setVoiceModalOpen(false);
    setVoiceDraft("");
  }, []);

  return {
    canUseVoice: Boolean(voiceStatus?.available),
    recording,
    voiceBusy,
    voiceModalOpen,
    voiceDraft,
    setVoiceDraft,
    toggleRecording,
    confirmDraft,
    dismissModal,
    voiceError,
    clearVoiceError: useCallback(() => setVoiceError(null), []),
  };
}
