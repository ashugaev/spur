import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AudioTranscriber,
  OrchestratorConfig,
  TranscribeLocalFileInput,
  TranscribeResult,
  WhisperCppTranscriberConfig,
} from "./types.js";

const execFile = promisify(execFileCallback);

const DEFAULT_LANGUAGE = "auto";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_AUDIO_BYTES = 25_000_000;
const DEFAULT_MAX_DURATION_SEC = 600;
const DEFAULT_FFMPEG_PATH = "ffmpeg";
const MAX_COMMAND_ERROR_DETAILS = 600;
const DEFAULT_INPUT_EXTENSION = ".ogg";
const DEFAULT_TELEGRAM_FETCH_TIMEOUT_MS = 30_000;

export interface TranscribeAudioBytesInput {
  transcriber: AudioTranscriber;
  bytes: Uint8Array;
  fileExtension?: string;
  language?: string;
  durationSec?: number;
  fileSizeBytes?: number;
}

export interface DownloadTelegramVoiceFileBytesInput {
  botToken: string;
  fileId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

export interface DownloadTelegramVoiceFileBytesResult {
  bytes: Uint8Array;
  fileExtension: string;
  fileSizeBytes: number;
}

interface ResolvedWhisperCppConfig {
  binaryPath: string;
  modelPath: string;
  ffmpegPath: string;
  language: string;
  timeoutMs: number;
  maxAudioBytes: number;
  maxDurationSec: number;
}

function env(...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed > 0) return parsed;
  }

  return undefined;
}

function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeCommandErrorDetails(value: string): string {
  const sanitized = stripControlChars(value).replace(/\s+/g, " ").trim();
  if (!sanitized) return "unknown error";
  return truncateText(sanitized, MAX_COMMAND_ERROR_DETAILS);
}

function resolveWhisperCppConfig(raw?: WhisperCppTranscriberConfig): ResolvedWhisperCppConfig | null {
  if (raw?.enabled === false) return null;
  const hasExplicitConfig = raw !== undefined;
  const binaryPathFromEnv = env(
    "AO_TRANSCRIBER_WHISPER_CPP_PATH",
    "AO_WHISPER_CPP_PATH",
    "AO_WHISPER_BIN",
  );
  const modelPathFromEnv = env("AO_TRANSCRIBER_MODEL_PATH", "AO_WHISPER_MODEL_PATH");

  const plugin = toNonEmptyString(raw?.plugin) ?? "whisper-cpp";
  if (plugin !== "whisper-cpp") {
    throw new Error(
      `Unsupported transcriber plugin "${plugin}". Only "whisper-cpp" is currently supported.`,
    );
  }

  const binaryPath =
    toNonEmptyString(raw?.binaryPath) ??
    binaryPathFromEnv;
  const modelPath =
    toNonEmptyString(raw?.modelPath) ??
    modelPathFromEnv;

  if (!binaryPath || !modelPath) {
    if (!hasExplicitConfig) {
      const hasAnyEnvPath = Boolean(binaryPathFromEnv || modelPathFromEnv);
      if (!hasAnyEnvPath) return null;
    }
    throw new Error(
      "Transcriber is enabled but binary/model paths are missing. Set services.transcriber.binaryPath and services.transcriber.modelPath (or AO_TRANSCRIBER_WHISPER_CPP_PATH/AO_TRANSCRIBER_MODEL_PATH).",
    );
  }

  return {
    binaryPath,
    modelPath,
    ffmpegPath:
      toNonEmptyString(raw?.ffmpegPath) ??
      env("AO_TRANSCRIBER_FFMPEG_PATH", "AO_FFMPEG_PATH") ??
      DEFAULT_FFMPEG_PATH,
    language:
      toNonEmptyString(raw?.language) ??
      env("AO_TRANSCRIBER_LANGUAGE", "AO_WHISPER_LANGUAGE") ??
      DEFAULT_LANGUAGE,
    timeoutMs:
      toPositiveNumber(raw?.timeoutMs) ??
      toPositiveNumber(env("AO_TRANSCRIBER_TIMEOUT_MS", "AO_WHISPER_TIMEOUT_MS")) ??
      DEFAULT_TIMEOUT_MS,
    maxAudioBytes:
      toPositiveNumber(raw?.maxAudioBytes) ??
      toPositiveNumber(env("AO_TRANSCRIBER_MAX_AUDIO_BYTES", "AO_WHISPER_MAX_AUDIO_BYTES")) ??
      DEFAULT_MAX_AUDIO_BYTES,
    maxDurationSec:
      toPositiveNumber(raw?.maxDurationSec) ??
      toPositiveNumber(env("AO_TRANSCRIBER_MAX_DURATION_SEC", "AO_WHISPER_MAX_DURATION_SEC")) ??
      DEFAULT_MAX_DURATION_SEC,
  };
}

interface ExecFileError extends Error {
  code?: string | number;
  stderr?: string;
  stdout?: string;
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  try {
    await execFile(command, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const typed = error as ExecFileError;
    const stderr = typeof typed.stderr === "string" ? typed.stderr.trim() : "";
    const stdout = typeof typed.stdout === "string" ? typed.stdout.trim() : "";
    const details = normalizeCommandErrorDetails(stderr || stdout || typed.message || "unknown error");
    throw new Error(`${label} command failed: ${details}`, { cause: error });
  }
}

function resolveLanguage(input: TranscribeLocalFileInput, defaults: ResolvedWhisperCppConfig): string {
  const fromInput = toNonEmptyString(input.language);
  if (fromInput) return fromInput;
  const fromDefaults = toNonEmptyString(defaults.language);
  if (fromDefaults) return fromDefaults;
  return DEFAULT_LANGUAGE;
}

async function assertReadableFile(filePath: string): Promise<void> {
  await access(filePath, fsConstants.R_OK);
}

class WhisperCppAudioTranscriber implements AudioTranscriber {
  readonly name = "whisper-cpp";

  constructor(private readonly config: ResolvedWhisperCppConfig) {}

  async transcribeLocalFile(input: TranscribeLocalFileInput): Promise<TranscribeResult> {
    const sourcePath = toNonEmptyString(input.filePath);
    if (!sourcePath) {
      throw new Error("Audio transcription requires a non-empty file path");
    }

    await assertReadableFile(sourcePath);

    const sourceStats = await stat(sourcePath);
    const sizeBytes = input.fileSizeBytes ?? sourceStats.size;
    if (sizeBytes > this.config.maxAudioBytes) {
      throw new Error(
        `Audio is too large (${sizeBytes} bytes > ${this.config.maxAudioBytes} byte limit)`,
      );
    }

    const durationSec = toPositiveNumber(input.durationSec);
    if (durationSec !== undefined && durationSec > this.config.maxDurationSec) {
      throw new Error(
        `Audio is too long (${durationSec}s > ${this.config.maxDurationSec}s limit)`,
      );
    }

    const language = resolveLanguage(input, this.config);
    const startedAt = Date.now();
    const tmpDir = await mkdtemp(join(tmpdir(), "ao-transcriber-"));
    const normalizedWavPath = join(tmpDir, "normalized.wav");
    const outputBasePath = join(tmpDir, "transcript");
    const transcriptPath = `${outputBasePath}.txt`;

    try {
      await runCommand(
        this.config.ffmpegPath,
        ["-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", "-vn", "-f", "wav", normalizedWavPath],
        this.config.timeoutMs,
        "ffmpeg",
      );

      const whisperArgs = [
        "-m",
        this.config.modelPath,
        "-f",
        normalizedWavPath,
        "-of",
        outputBasePath,
        "-otxt",
      ];
      if (language !== DEFAULT_LANGUAGE) {
        whisperArgs.push("-l", language);
      }

      await runCommand(this.config.binaryPath, whisperArgs, this.config.timeoutMs, "whisper.cpp");

      const transcriptRaw = await readFile(transcriptPath, "utf-8");
      const text = stripControlChars(transcriptRaw).trim();
      if (!text) {
        throw new Error("Whisper transcription is empty");
      }

      return {
        text,
        language,
        durationMs: Date.now() - startedAt,
        backend: this.name,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
}

function normalizeExtension(extension: string | undefined): string {
  const trimmed = toNonEmptyString(extension);
  if (!trimmed) return DEFAULT_INPUT_EXTENSION;
  const raw = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  if (!/^[a-zA-Z0-9]{1,12}$/.test(raw)) return DEFAULT_INPUT_EXTENSION;
  return `.${raw.toLowerCase()}`;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

interface TelegramGetFileResponse {
  ok?: boolean;
  result?: {
    file_path?: unknown;
    file_size?: unknown;
  };
  description?: unknown;
}

export async function downloadTelegramVoiceFileBytes(
  input: DownloadTelegramVoiceFileBytesInput,
): Promise<DownloadTelegramVoiceFileBytesResult> {
  const botToken = toNonEmptyString(input.botToken);
  const fileId = toNonEmptyString(input.fileId);
  if (!botToken || !fileId) {
    throw new Error("Telegram voice download requires non-empty bot token and file id");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = toPositiveNumber(input.timeoutMs) ?? DEFAULT_TELEGRAM_FETCH_TIMEOUT_MS;
  const maxAudioBytes = toPositiveNumber(input.maxAudioBytes) ?? DEFAULT_MAX_AUDIO_BYTES;

  const getFileResponse = await fetchImpl(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
    signal: timeoutSignal(timeoutMs),
  });

  if (!getFileResponse.ok) {
    throw new Error(`Telegram getFile failed (${getFileResponse.status})`);
  }

  const getFilePayload = (await getFileResponse.json()) as TelegramGetFileResponse;
  const filePath = toNonEmptyString(getFilePayload.result?.file_path);
  const fileSizeBytes = toPositiveNumber(getFilePayload.result?.file_size);

  if (!filePath) {
    const description = toNonEmptyString(getFilePayload.description);
    throw new Error(description ?? "Telegram getFile response did not include file_path");
  }

  if (fileSizeBytes !== undefined && fileSizeBytes > maxAudioBytes) {
    throw new Error(`Audio is too large (${fileSizeBytes} bytes > ${maxAudioBytes} byte limit)`);
  }

  const downloadResponse = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
    method: "GET",
    signal: timeoutSignal(timeoutMs),
  });

  if (!downloadResponse.ok) {
    throw new Error(`Telegram file download failed (${downloadResponse.status})`);
  }

  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const effectiveFileSizeBytes = fileSizeBytes ?? bytes.byteLength;
  if (effectiveFileSizeBytes > maxAudioBytes) {
    throw new Error(
      `Audio is too large (${effectiveFileSizeBytes} bytes > ${maxAudioBytes} byte limit)`,
    );
  }

  return {
    bytes,
    fileExtension: normalizeExtension(extname(filePath)),
    fileSizeBytes: effectiveFileSizeBytes,
  };
}

export async function transcribeAudioBytes(
  input: TranscribeAudioBytesInput,
): Promise<TranscribeResult> {
  if (!input.transcriber) {
    throw new Error("Audio transcription service is not configured");
  }

  const bytes = input.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("Audio transcription requires non-empty audio bytes");
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "ao-transcriber-input-"));
  const inputPath = join(tmpDir, `input${normalizeExtension(input.fileExtension)}`);

  try {
    await writeFile(inputPath, bytes);
    return await input.transcriber.transcribeLocalFile({
      filePath: inputPath,
      language: input.language,
      durationSec: input.durationSec,
      fileSizeBytes: input.fileSizeBytes ?? bytes.byteLength,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export function createAudioTranscriber(
  config: Pick<OrchestratorConfig, "services">,
): AudioTranscriber | null {
  const resolved = resolveWhisperCppConfig(config.services?.transcriber);
  if (!resolved) return null;
  return new WhisperCppAudioTranscriber(resolved);
}
