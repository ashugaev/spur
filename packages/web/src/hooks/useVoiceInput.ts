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
const WAVEFORM_BAR_COUNT = 20;

type VoiceStopIntent = "default" | "draft" | "send";

function buildIdleWaveformBars(): number[] {
  return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => 0.2 + (index % 4) * 0.05);
}

function buildFallbackWaveformBars(timestamp: number): number[] {
  return Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => {
    const wave = Math.sin(timestamp / 180 + index * 0.55);
    return 0.24 + ((wave + 1) / 2) * 0.52;
  });
}

class RetryableTranscriptionError extends Error {}

function formatRecordingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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
  recordingDurationLabel: string;
  recordingDurationMs: number;
  waveformBars: number[];
  voiceBusy: "starting" | "transcribing" | null;
  voiceModalOpen: boolean;
  voiceDraft: string;
  setVoiceDraft: (value: string) => void;
  startRecording: () => void;
  stopRecording: (intent?: VoiceStopIntent) => void;
  cancelRecording: () => void;
  toggleRecording: () => void;
  confirmDraft: (onInsert: (text: string) => unknown) => Promise<void>;
  dismissModal: () => void;
  voiceError: string | null;
  clearVoiceError: () => void;
}

export function useVoiceInput(options?: {
  onTranscribed?: (text: string) => void;
  onQuickSend?: (text: string) => Promise<unknown> | unknown;
}): UseVoiceInput {
  const onTranscribedRef = useRef(options?.onTranscribed);
  onTranscribedRef.current = options?.onTranscribed;
  const onQuickSendRef = useRef(options?.onQuickSend);
  onQuickSendRef.current = options?.onQuickSend;
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => buildIdleWaveformBars());
  const [voiceBusy, setVoiceBusy] = useState<"starting" | "transcribing" | null>(null);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const voiceModalOpenRef = useRef(false);
  const dismissedRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const stopIntentRef = useRef<VoiceStopIntent>("default");

  useEffect(() => {
    voiceModalOpenRef.current = voiceModalOpen;
  }, [voiceModalOpen]);
  const [voiceDraft, setVoiceDraft] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

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
      if (audioSourceRef.current) {
        audioSourceRef.current.disconnect();
      }
      if (analyserRef.current) {
        analyserRef.current.disconnect();
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      mediaChunksRef.current = [];
      audioContextRef.current = null;
      audioSourceRef.current = null;
      analyserRef.current = null;
      analyserDataRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!recording) {
      setRecordingDurationMs(0);
      return;
    }

    const updateDuration = () => {
      const startedAt = recordingStartedAtRef.current;
      setRecordingDurationMs(startedAt === null ? 0 : Date.now() - startedAt);
    };

    updateDuration();
    const timerId = window.setInterval(updateDuration, 1_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [recording]);

  useEffect(() => {
    if (!recording) {
      setWaveformBars(buildIdleWaveformBars());
      return;
    }

    const updateWaveform = () => {
      const analyser = analyserRef.current;
      const analyserData = analyserDataRef.current;
      if (!analyser || !analyserData) {
        setWaveformBars(buildFallbackWaveformBars(Date.now()));
        return;
      }

      analyser.getByteFrequencyData(analyserData);
      const bucketSize = Math.max(1, Math.floor(analyserData.length / WAVEFORM_BAR_COUNT));
      const nextBars = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => {
        const start = index * bucketSize;
        const end = Math.min(analyserData.length, start + bucketSize);
        let total = 0;
        for (let cursor = start; cursor < end; cursor += 1) {
          total += analyserData[cursor] ?? 0;
        }
        const average = total / Math.max(1, end - start);
        return 0.16 + (average / 255) * 0.84;
      });

      setWaveformBars(nextBars);
    };

    updateWaveform();
    const waveformId = window.setInterval(updateWaveform, 120);
    return () => {
      window.clearInterval(waveformId);
    };
  }, [recording]);

  const resetAudioAnalysis = useCallback(() => {
    if (audioSourceRef.current) {
      audioSourceRef.current.disconnect();
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
    }
    audioContextRef.current = null;
    audioSourceRef.current = null;
    analyserRef.current = null;
    analyserDataRef.current = null;
    setWaveformBars(buildIdleWaveformBars());
  }, []);

  const stopStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    mediaChunksRef.current = [];
    recordingStartedAtRef.current = null;
    stopIntentRef.current = "default";
    resetAudioAnalysis();
    setRecordingDurationMs(0);
    setRecording(false);
  }, [resetAudioAnalysis]);

  const applyTranscription = useCallback(async (text: string, intent: VoiceStopIntent) => {
    if (intent === "send" && onQuickSendRef.current) {
      try {
        const inserted = await onQuickSendRef.current(text);
        if (inserted === false) {
          throw new Error(INSERT_ERROR);
        }
        setVoiceError(null);
        setVoiceDraft("");
        setVoiceModalOpen(false);
        return;
      } catch (error) {
        setVoiceDraft(text);
        setVoiceModalOpen(true);
        throw error instanceof Error ? error : new Error(INSERT_ERROR);
      }
    }

    if (voiceModalOpenRef.current || intent === "draft") {
      setVoiceDraft((prev) => {
        const base = prev.trimEnd();
        return base ? `${base} ${text}` : text;
      });
      setVoiceModalOpen(true);
      return;
    }

    if (onTranscribedRef.current) {
      try {
        onTranscribedRef.current(text);
      } catch (error) {
        throw error instanceof Error ? error : new Error(INSERT_ERROR);
      }
      return;
    }

    setVoiceDraft(text);
    setVoiceModalOpen(true);
  }, []);

  const startRecording = useCallback(() => {
    if (recording) return;
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
        stopIntentRef.current = "default";

        const AudioContextCtor =
          window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioContextCtor) {
          let audioContext: AudioContext | null = null;
          try {
            audioContext = new AudioContextCtor();
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 128;
            analyser.smoothingTimeConstant = 0.72;
            const source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser);
            audioContextRef.current = audioContext;
            audioSourceRef.current = source;
            analyserRef.current = analyser;
            analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);
          } catch {
            if (audioContext) {
              void audioContext.close().catch(() => undefined);
            }
            resetAudioAnalysis();
          }
        } else {
          resetAudioAnalysis();
        }

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
          window.setTimeout(() => {
            const chunks = [...mediaChunksRef.current];
            const wasDismissed = dismissedRef.current;
            dismissedRef.current = false;
            const stopIntent = stopIntentRef.current;
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
                await applyTranscription(text, stopIntent);
              } catch (err) {
                setVoiceError(err instanceof Error ? err.message : TRANSCRIBE_ERROR);
              } finally {
                setVoiceBusy(null);
              }
            })();
          }, 0);
        });

        recorder.start();
        recordingStartedAtRef.current = Date.now();
        setRecordingDurationMs(0);
        setRecording(true);
      } catch (err) {
        stopStream();
        setVoiceError(readRecordingStartError(err));
      } finally {
        setVoiceBusy((current) => (current === "starting" ? null : current));
      }
    })();
  }, [applyTranscription, recording, resetAudioAnalysis, stopStream, voiceStatus]);

  const stopRecording = useCallback(
    (intent: VoiceStopIntent = "default") => {
      if (!recording) return;
      stopIntentRef.current = intent;
      if (mediaRecorderRef.current && "requestData" in mediaRecorderRef.current) {
        mediaRecorderRef.current.requestData();
      }
      mediaRecorderRef.current?.stop();
    },
    [recording],
  );

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      dismissedRef.current = true;
      mediaRecorderRef.current.stop();
    }
    stopStream();
    setVoiceBusy(null);
  }, [stopStream]);

  const toggleRecording = useCallback(() => {
    if (recording) {
      stopRecording();
      return;
    }
    startRecording();
  }, [recording, startRecording, stopRecording]);

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
    recordingDurationLabel: formatRecordingDuration(recordingDurationMs),
    recordingDurationMs,
    waveformBars,
    voiceBusy,
    voiceModalOpen,
    voiceDraft,
    setVoiceDraft,
    startRecording,
    stopRecording,
    cancelRecording,
    toggleRecording,
    confirmDraft,
    dismissModal,
    voiceError,
    clearVoiceError: useCallback(() => setVoiceError(null), []),
  };
}
