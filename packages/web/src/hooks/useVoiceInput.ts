"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface VoiceStatus {
  available: boolean;
  modelPath?: string;
  language: string;
  reason?: string;
}

const EMPTY_AUDIO_ERROR =
  "Voice recording captured no audio. Check your microphone input and try again.";
const TRANSCRIBE_ERROR = "Failed to transcribe audio";
const TRANSCRIBE_TIMEOUT_ERROR = "Voice transcription timed out. Try again.";
const INSERT_ERROR = "Failed to insert transcription";
const MICROPHONE_HTTPS_ERROR =
  "Microphone access requires HTTPS. Connect via Tailscale HTTPS or localhost.";
const MICROPHONE_PERMISSION_ERROR =
  "Microphone access is blocked. Allow microphone permission in your browser and try again.";
const MICROPHONE_NOT_FOUND_ERROR = "No microphone was found. Connect a microphone and try again.";
const TRANSCRIBE_MAX_ATTEMPTS = 3;
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 45_000;
const TRANSCRIBE_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

class RetryableTranscriptionError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function readVoiceError(response: Response, fallback: string): Promise<string> {
  const text = await response.text();
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Fall back to the raw response body when it is not JSON.
  }

  return text;
}

function isRetryableTranscriptionError(error: unknown): boolean {
  if (error instanceof RetryableTranscriptionError) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof TypeError;
}

function formatTranscriptionFailure(message: string): string {
  return `Failed to transcribe audio after ${TRANSCRIBE_MAX_ATTEMPTS} attempts: ${message}`;
}

async function transcribeRecording(audio: Blob): Promise<string> {
  let lastError = TRANSCRIBE_ERROR;

  for (let attempt = 1; attempt <= TRANSCRIBE_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), TRANSCRIBE_REQUEST_TIMEOUT_MS);

    try {
      const formData = new FormData();
      formData.append("audio", audio, "voice-input.webm");
      const response = await fetch("/api/runtime/voice/transcribe", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = await readVoiceError(response, TRANSCRIBE_ERROR);
        if (!TRANSCRIBE_RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new Error(message);
        }
        lastError = message;
        if (attempt === TRANSCRIBE_MAX_ATTEMPTS) {
          throw new Error(formatTranscriptionFailure(message));
        }
        await sleep(400 * attempt);
        continue;
      }

      const payload = (await response.json()) as { text?: string };
      const text = payload.text?.trim() ?? "";
      if (!text) {
        throw new RetryableTranscriptionError("Transcription returned empty text");
      }
      return text;
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? TRANSCRIBE_TIMEOUT_ERROR
          : error instanceof Error
            ? error.message
            : TRANSCRIBE_ERROR;

      if (!isRetryableTranscriptionError(error)) {
        throw new Error(message, error instanceof Error ? { cause: error } : undefined);
      }

      lastError = message;
      if (attempt === TRANSCRIBE_MAX_ATTEMPTS) {
        throw new Error(
          formatTranscriptionFailure(message),
          error instanceof Error ? { cause: error } : undefined,
        );
      }

      await sleep(400 * attempt);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw new Error(formatTranscriptionFailure(lastError));
}

function readRecordingStartError(error: unknown): string {
  if (!(error instanceof Error)) return "Failed to start recording";
  const message = error.message.trim();
  const secureContext = typeof window === "undefined" ? true : window.isSecureContext;
  if (!secureContext) return MICROPHONE_HTTPS_ERROR;

  const normalizedName = error.name.toLowerCase();
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedName === "notallowederror" ||
    normalizedName === "securityerror" ||
    normalizedMessage.includes("request is not allowed by the user agent") ||
    normalizedMessage.includes("permission denied") ||
    normalizedMessage.includes("user denied permission") ||
    normalizedMessage.includes("permission dismissed")
  ) {
    return MICROPHONE_PERMISSION_ERROR;
  }

  if (
    normalizedName === "notfounderror" ||
    normalizedName === "devicesnotfounderror" ||
    normalizedMessage.includes("requested device not found") ||
    normalizedMessage.includes("no microphone")
  ) {
    return MICROPHONE_NOT_FOUND_ERROR;
  }

  return message || "Failed to start recording";
}

export interface UseVoiceInput {
  canUseVoice: boolean;
  recording: boolean;
  voiceBusy: "starting" | "transcribing" | null;
  voiceModalOpen: boolean;
  voiceDraft: string;
  setVoiceDraft: (value: string) => void;
  toggleRecording: () => void;
  confirmDraft: (onInsert: (text: string) => unknown) => Promise<void>;
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
  const voiceModalOpenRef = useRef(false);
  const dismissedRef = useRef(false);

  useEffect(() => {
    voiceModalOpenRef.current = voiceModalOpen;
  }, [voiceModalOpen]);
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
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      if ("requestData" in recorder && typeof recorder.requestData === "function") {
        try {
          recorder.requestData();
        } catch {
          // Ignore recorder flush failures and still stop the recording.
        }
      }
      recorder.stop();
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
          throw new Error(MICROPHONE_HTTPS_ERROR);
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        mediaStreamRef.current = stream;
        mediaRecorderRef.current = recorder;
        mediaChunksRef.current = [];

        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) mediaChunksRef.current.push(event.data);
        });
        recorder.addEventListener("error", (event) => {
          const recorderError =
            ("error" in (event ?? {}) && (event as { error?: DOMException }).error?.message) ||
            "Voice recording failed before transcription";
          dismissedRef.current = false;
          stopStream();
          setVoiceBusy(null);
          setVoiceError(recorderError);
        });

        recorder.addEventListener("stop", () => {
          const chunks = [...mediaChunksRef.current];
          const wasDismissed = dismissedRef.current;
          dismissedRef.current = false;
          stopStream();
          if (wasDismissed) return;
          if (chunks.length === 0) {
            setVoiceError(EMPTY_AUDIO_ERROR);
            return;
          }
          void (async () => {
            setVoiceBusy("transcribing");
            try {
              const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const text = await transcribeRecording(audio);
              if (onTranscribedRef.current) {
                try {
                  onTranscribedRef.current(text);
                } catch (error) {
                  throw error instanceof Error ? error : new Error(INSERT_ERROR);
                }
              } else if (voiceModalOpenRef.current) {
                setVoiceDraft((prev) => {
                  const base = prev.trimEnd();
                  return base ? base + " " + text : text;
                });
              } else {
                setVoiceDraft(text);
                setVoiceModalOpen(true);
              }
            } catch (err) {
              setVoiceError(err instanceof Error ? err.message : TRANSCRIBE_ERROR);
            } finally {
              setVoiceBusy(null);
            }
          })();
        });

        recorder.start();
        setRecording(true);
      } catch (err) {
        stopStream();
        setVoiceError(readRecordingStartError(err));
      } finally {
        setVoiceBusy((current) => (current === "starting" ? null : current));
      }
    })();
  }, [recording, stopStream, voiceStatus]);

  const confirmDraft = useCallback(
    async (onInsert: (text: string) => unknown) => {
      const trimmed = voiceDraft.trim();
      if (!trimmed) return;
      try {
        const inserted = await onInsert(trimmed);
        if (inserted === false) {
          throw new Error(INSERT_ERROR);
        }
        setVoiceError(null);
        setVoiceModalOpen(false);
        setVoiceDraft("");
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : INSERT_ERROR);
      }
    },
    [voiceDraft],
  );

  const dismissModal = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      dismissedRef.current = true;
      mediaRecorderRef.current.stop();
    }
    stopStream();
    setVoiceBusy(null);
    setVoiceModalOpen(false);
    setVoiceDraft("");
  }, [stopStream]);

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
