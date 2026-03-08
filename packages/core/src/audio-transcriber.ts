/**
 * Audio Transcription Service
 *
 * Provides a whisper.cpp-backed audio transcription implementation.
 * Used by the Telegram integration to transcribe voice messages.
 */

import { execFile } from "node:child_process";
import { readFile, mkdir, unlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  AudioTranscriber,
  TranscribeRequest,
  TranscribeResult,
  TranscriberConfig,
} from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_AUDIO_BYTES = 25_000_000;
const DEFAULT_MAX_DURATION_SEC = 600;
const DEFAULT_FFMPEG_PATH = "ffmpeg";
const DEFAULT_LANGUAGE = "auto";

/**
 * Create a whisper.cpp-backed AudioTranscriber.
 *
 * Workflow per call:
 *   1. Validate file size against maxAudioBytes
 *   2. Create a temp directory
 *   3. Use ffmpeg to normalize audio to 16kHz mono WAV
 *   4. Run whisper-cli on the WAV file
 *   5. Read the .txt output
 *   6. Clean up temp files
 */
export function createWhisperCppTranscriber(config: TranscriberConfig): AudioTranscriber {
  const binaryPath = config.binaryPath;
  const modelPath = config.modelPath;
  const ffmpegPath = config.ffmpegPath ?? DEFAULT_FFMPEG_PATH;
  const language = config.language ?? DEFAULT_LANGUAGE;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAudioBytes = config.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const maxDurationSec = config.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;

  return {
    async transcribeLocalFile(request: TranscribeRequest): Promise<TranscribeResult> {
      const startTime = Date.now();
      const inputPath = request.filePath;
      const lang = request.language ?? language;

      // Validate input file size
      const fileStat = await stat(inputPath);
      if (fileStat.size > maxAudioBytes) {
        throw new Error(
          `Audio file too large: ${fileStat.size} bytes (max ${maxAudioBytes} bytes)`,
        );
      }

      // Create temp working directory
      const tempDir = join(tmpdir(), `ao-whisper-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });

      const wavPath = join(tempDir, "audio.wav");
      const outputBasePath = join(tempDir, "audio");

      try {
        // Step 1: ffmpeg normalize to 16kHz mono WAV
        const ffmpegArgs = [
          "-i", inputPath,
          "-ar", "16000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          "-t", String(maxDurationSec),
          "-y",
          wavPath,
        ];

        await execFileAsync(ffmpegPath, ffmpegArgs, { timeout: timeoutMs });

        // Step 2: Run whisper-cli
        const whisperArgs = [
          "-m", modelPath,
          "-f", wavPath,
          "--output-txt",
          "--output-file", outputBasePath,
          "--no-timestamps",
        ];

        if (lang !== "auto") {
          whisperArgs.push("-l", lang);
        }

        await execFileAsync(binaryPath, whisperArgs, { timeout: timeoutMs });

        // Step 3: Read result
        const txtPath = `${outputBasePath}.txt`;
        const rawText = await readFile(txtPath, "utf-8");
        const text = rawText.trim();

        if (text.length === 0) {
          throw new Error("Transcription produced empty result");
        }

        const durationMs = Date.now() - startTime;

        return {
          text,
          durationMs,
          language: lang !== "auto" ? lang : undefined,
        };
      } finally {
        // Cleanup temp files — best effort
        const filesToClean = [wavPath, `${outputBasePath}.txt`];
        for (const file of filesToClean) {
          try {
            await unlink(file);
          } catch {
            // Ignore cleanup errors
          }
        }
        try {
          const { rmdir } = await import("node:fs/promises");
          await rmdir(tempDir);
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

/**
 * Create an AudioTranscriber from config, or return null if not configured/enabled.
 */
export function createAudioTranscriber(
  config: TranscriberConfig | undefined,
): AudioTranscriber | null {
  if (!config) return null;
  if (config.enabled === false) return null;
  if (!config.binaryPath || !config.modelPath) return null;

  if (config.plugin === "whisper-cpp") {
    return createWhisperCppTranscriber(config);
  }

  return null;
}

/**
 * Download a file from a URL to a local path using fetch.
 * Used to download Telegram voice files.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(destPath, Buffer.from(buffer));
}

/**
 * Download a Telegram voice file using the Bot API.
 *
 * Steps:
 *   1. Call getFile to get the file_path
 *   2. Download from https://api.telegram.org/file/bot<token>/<file_path>
 *
 * Returns the local path where the file was saved.
 */
export async function downloadTelegramVoiceFile(
  botToken: string,
  fileId: string,
  destDir: string,
): Promise<string> {
  // Get file info
  const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile`;
  const getFileResponse = await fetch(getFileUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!getFileResponse.ok) {
    const body = await getFileResponse.text();
    throw new Error(`Telegram getFile failed (${getFileResponse.status}): ${body}`);
  }

  const getFilePayload = (await getFileResponse.json()) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };

  if (!getFilePayload.ok || !getFilePayload.result?.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }

  const filePath = getFilePayload.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  // Determine extension from file_path
  const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : ".ogg";
  const localPath = join(destDir, `voice-${randomUUID()}${ext}`);

  await downloadFile(fileUrl, localPath);
  return localPath;
}
