"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface VoiceStatus {
  available: boolean;
  modelPath?: string;
  language: string;
  reason?: string;
}

type VoiceInputContextKey =
  | "spawn"
  | "dashboard-search"
  | `session:${string}`
  | `terminal:${string}`
  | `desk-spawn:${string}`
  | `agent-switch:${string}`
  | `respawn:${string}`;
type RetainedVoiceTakeMode = "insert" | "modal" | "send";

interface RetainedVoiceTake {
  blob: Blob;
  mode: RetainedVoiceTakeMode;
}

interface PersistedRetainedVoiceTake extends RetainedVoiceTake {
  contextKey: VoiceInputContextKey;
  updatedAt: number;
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
const VOICE_RETENTION_DB_NAME = "spur-voice-input";
const VOICE_RETENTION_STORE_NAME = "retained-takes";

class RetryableTranscriptionError extends Error {}

function hasIndexedDbSupport(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function isRetainedVoiceTakeMode(value: unknown): value is RetainedVoiceTakeMode {
  return value === "insert" || value === "modal" || value === "send";
}

function isPersistedRetainedVoiceTake(value: unknown): value is PersistedRetainedVoiceTake {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<PersistedRetainedVoiceTake>;
  return (
    typeof candidate.contextKey === "string" &&
    candidate.blob instanceof Blob &&
    isRetainedVoiceTakeMode(candidate.mode) &&
    typeof candidate.updatedAt === "number"
  );
}

function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openVoiceRetentionDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDbSupport()) {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(VOICE_RETENTION_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VOICE_RETENTION_STORE_NAME)) {
        database.createObjectStore(VOICE_RETENTION_STORE_NAME, { keyPath: "contextKey" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

async function readPersistedRetainedTake(
  contextKey: VoiceInputContextKey,
): Promise<RetainedVoiceTake | null> {
  const database = await openVoiceRetentionDatabase();
  try {
    const transaction = database.transaction(VOICE_RETENTION_STORE_NAME, "readonly");
    const store = transaction.objectStore(VOICE_RETENTION_STORE_NAME);
    const result = await waitForRequest(store.get(contextKey));
    await waitForTransaction(transaction);
    if (!isPersistedRetainedVoiceTake(result)) {
      return null;
    }
    return {
      blob: result.blob,
      mode: result.mode,
    };
  } finally {
    database.close();
  }
}

async function persistRetainedTake(
  contextKey: VoiceInputContextKey,
  retainedTake: RetainedVoiceTake,
): Promise<void> {
  const database = await openVoiceRetentionDatabase();
  try {
    const transaction = database.transaction(VOICE_RETENTION_STORE_NAME, "readwrite");
    const store = transaction.objectStore(VOICE_RETENTION_STORE_NAME);
    store.put({
      ...retainedTake,
      contextKey,
      updatedAt: Date.now(),
    } satisfies PersistedRetainedVoiceTake);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

async function clearPersistedRetainedTake(contextKey: VoiceInputContextKey): Promise<void> {
  const database = await openVoiceRetentionDatabase();
  try {
    const transaction = database.transaction(VOICE_RETENTION_STORE_NAME, "readwrite");
    transaction.objectStore(VOICE_RETENTION_STORE_NAME).delete(contextKey);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
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
  hasRetainedTake: boolean;
  retainedTakePlaying: boolean;
  voiceBusy: "starting" | "transcribing" | null;
  voiceModalOpen: boolean;
  voiceDraft: string;
  setVoiceDraft: (value: string) => void;
  openDraft: (value?: string) => void;
  toggleRecording: () => void;
  playRetainedTake: () => void;
  discardRetainedTake: () => void;
  retryRetainedTake: (onSend?: (text: string) => void | Promise<void>) => Promise<void>;
  stopAndSend: (onSend: (text: string) => void | Promise<void>) => void;
  cancelRecording: () => void;
  confirmDraft: (
    onInsert: (text: string) => unknown,
    options?: { allowEmpty?: boolean },
  ) => Promise<void>;
  dismissModal: () => void;
  voiceError: string | null;
  clearVoiceError: () => void;
}

export function useVoiceInput(options: {
  contextKey: VoiceInputContextKey;
  onTranscribed?: (text: string) => void;
}): UseVoiceInput {
  const onTranscribedRef = useRef(options.onTranscribed);
  onTranscribedRef.current = options.onTranscribed;
  const contextKeyRef = useRef<VoiceInputContextKey>(options.contextKey);
  contextKeyRef.current = options.contextKey;
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [hasRetainedTake, setHasRetainedTake] = useState(false);
  const [retainedTakePlaying, setRetainedTakePlaying] = useState(false);
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
  const retainedTakeRef = useRef<RetainedVoiceTake | null>(null);
  const retainedAudioRef = useRef<HTMLAudioElement | null>(null);
  const retainedAudioUrlRef = useRef<string | null>(null);
  const pendingSendCallbackRef = useRef<((text: string) => void | Promise<void>) | null>(null);
  const stopRetainedPlayback = useCallback(() => {
    retainedAudioRef.current?.pause();
    retainedAudioRef.current = null;
    if (retainedAudioUrlRef.current) {
      URL.revokeObjectURL(retainedAudioUrlRef.current);
      retainedAudioUrlRef.current = null;
    }
    setRetainedTakePlaying(false);
  }, []);

  const discardRetainedTake = useCallback(async () => {
    retainedTakeRef.current = null;
    setHasRetainedTake(false);
    stopRetainedPlayback();
    if (!hasIndexedDbSupport()) {
      return;
    }
    try {
      await clearPersistedRetainedTake(contextKeyRef.current);
    } catch {
      // Ignore persistence cleanup failures and keep the in-memory state cleared.
    }
  }, [stopRetainedPlayback]);

  const setRetainedTake = useCallback(
    async (retainedTake: RetainedVoiceTake) => {
      retainedTakeRef.current = retainedTake;
      setHasRetainedTake(true);
      stopRetainedPlayback();
      if (!hasIndexedDbSupport()) {
        return;
      }
      try {
        await persistRetainedTake(contextKeyRef.current, retainedTake);
      } catch {
        // Keep the in-memory take even if persistence fails.
      }
    },
    [stopRetainedPlayback],
  );

  const applyTranscription = useCallback(
    async (
      text: string,
      mode: RetainedVoiceTakeMode,
      onSend?: (value: string) => void | Promise<void>,
    ) => {
      if (mode === "send") {
        if (!onSend) {
          throw new Error(INSERT_ERROR);
        }
        await onSend(text);
        return;
      }

      if (mode === "insert" && onTranscribedRef.current) {
        onTranscribedRef.current(text);
        return;
      }

      if (voiceModalOpenRef.current) {
        setVoiceDraft((prev) => {
          const base = prev.trimEnd();
          return base ? `${base} ${text}` : text;
        });
      } else {
        setVoiceDraft(text);
        setVoiceModalOpen(true);
      }
    },
    [],
  );

  const transcribeAndApply = useCallback(
    async (
      audio: Blob,
      mode: RetainedVoiceTakeMode,
      onSend?: (value: string) => void | Promise<void>,
    ) => {
      setVoiceError(null);
      setVoiceBusy("transcribing");
      try {
        const text = await transcribeRecording(audio);
        await applyTranscription(text, mode, onSend);
        await discardRetainedTake();
      } catch (error) {
        await setRetainedTake({
          blob: audio,
          mode,
        });
        setVoiceError(error instanceof Error ? error.message : TRANSCRIBE_ERROR);
      } finally {
        setVoiceBusy(null);
      }
    },
    [applyTranscription, discardRetainedTake, setRetainedTake],
  );

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
      pendingSendCallbackRef.current = null;
      stopRetainedPlayback();
    };
  }, [stopRetainedPlayback]);

  useEffect(() => {
    let cancelled = false;
    stopRetainedPlayback();
    setHasRetainedTake(false);
    retainedTakeRef.current = null;

    if (hasIndexedDbSupport()) {
      void (async () => {
        try {
          const retainedTake = await readPersistedRetainedTake(options.contextKey);
          if (!retainedTake || cancelled) {
            return;
          }
          retainedTakeRef.current = retainedTake;
          setHasRetainedTake(true);
        } catch {
          if (!cancelled) {
            retainedTakeRef.current = null;
            setHasRetainedTake(false);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [options.contextKey, stopRetainedPlayback]);

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
    if (!voiceStatus?.available || hasRetainedTake) return;

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
          pendingSendCallbackRef.current = null;
          stopStream();
          setVoiceBusy(null);
          setVoiceError(recorderError);
        });

        recorder.addEventListener("stop", () => {
          const chunks = [...mediaChunksRef.current];
          const wasDismissed = dismissedRef.current;
          const pendingSend = pendingSendCallbackRef.current;
          const mode: RetainedVoiceTakeMode = pendingSend
            ? "send"
            : onTranscribedRef.current
              ? "insert"
              : "modal";
          dismissedRef.current = false;
          stopStream();
          if (wasDismissed) {
            pendingSendCallbackRef.current = null;
            return;
          }
          if (chunks.length === 0) {
            pendingSendCallbackRef.current = null;
            setVoiceError(EMPTY_AUDIO_ERROR);
            return;
          }
          pendingSendCallbackRef.current = null;
          void transcribeAndApply(
            new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
            mode,
            pendingSend ?? undefined,
          );
        });

        recorder.start();
        setRecording(true);
      } catch (err) {
        pendingSendCallbackRef.current = null;
        stopStream();
        setVoiceError(readRecordingStartError(err));
      } finally {
        setVoiceBusy((current) => (current === "starting" ? null : current));
      }
    })();
  }, [hasRetainedTake, recording, stopStream, transcribeAndApply, voiceStatus]);

  const playRetainedTake = useCallback(() => {
    const retainedTake = retainedTakeRef.current;
    if (!retainedTake || typeof window === "undefined") {
      return;
    }
    if (retainedTakePlaying) {
      stopRetainedPlayback();
      return;
    }

    stopRetainedPlayback();
    const audioUrl = URL.createObjectURL(retainedTake.blob);
    retainedAudioUrlRef.current = audioUrl;
    const audio = new Audio(audioUrl);
    retainedAudioRef.current = audio;
    const finishPlayback = () => {
      stopRetainedPlayback();
    };
    audio.addEventListener("ended", finishPlayback, { once: true });
    audio.addEventListener("error", finishPlayback, { once: true });
    setRetainedTakePlaying(true);
    void audio.play().catch(() => {
      finishPlayback();
    });
  }, [retainedTakePlaying, stopRetainedPlayback]);

  const retryRetainedTake = useCallback(
    async (onSend?: (text: string) => void | Promise<void>) => {
      const retainedTake = retainedTakeRef.current;
      if (!retainedTake || recording || voiceBusy) {
        return;
      }
      await transcribeAndApply(retainedTake.blob, retainedTake.mode, onSend);
    },
    [recording, transcribeAndApply, voiceBusy],
  );

  const confirmDraft = useCallback(
    async (onInsert: (text: string) => unknown, options?: { allowEmpty?: boolean }) => {
      const trimmed = voiceDraft.trim();
      if (!trimmed && !options?.allowEmpty) return;
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

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      dismissedRef.current = true;
      mediaRecorderRef.current.stop();
    }
    pendingSendCallbackRef.current = null;
    stopStream();
    setVoiceBusy(null);
  }, [stopStream]);

  const dismissModal = useCallback(() => {
    cancelRecording();
    setVoiceModalOpen(false);
    setVoiceDraft("");
  }, [cancelRecording]);

  const stopAndSend = useCallback((onSend: (text: string) => void | Promise<void>) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    pendingSendCallbackRef.current = onSend;
    recorder.stop();
  }, []);

  return {
    canUseVoice: Boolean(voiceStatus?.available),
    recording,
    hasRetainedTake,
    retainedTakePlaying,
    voiceBusy,
    voiceModalOpen,
    voiceDraft,
    setVoiceDraft,
    openDraft: useCallback((value = "") => {
      setVoiceError(null);
      setVoiceDraft(value);
      setVoiceModalOpen(true);
    }, []),
    toggleRecording,
    playRetainedTake,
    discardRetainedTake,
    retryRetainedTake,
    stopAndSend,
    cancelRecording,
    confirmDraft,
    dismissModal,
    voiceError,
    clearVoiceError: useCallback(() => setVoiceError(null), []),
  };
}
