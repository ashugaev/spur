import { access, readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAudioTranscriber,
  downloadTelegramVoiceFileBytes,
  transcribeAudioBytes,
} from "../audio-transcriber.js";
import type { AudioTranscriber, TranscribeLocalFileInput } from "../types.js";

describe("createAudioTranscriber", () => {
  const envBackup = {
    whisperPath: process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"],
    modelPath: process.env["AO_TRANSCRIBER_MODEL_PATH"],
  };

  beforeEach(() => {
    delete process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"];
    delete process.env["AO_TRANSCRIBER_MODEL_PATH"];
  });

  afterEach(() => {
    if (envBackup.whisperPath === undefined) {
      delete process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"];
    } else {
      process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"] = envBackup.whisperPath;
    }
    if (envBackup.modelPath === undefined) {
      delete process.env["AO_TRANSCRIBER_MODEL_PATH"];
    } else {
      process.env["AO_TRANSCRIBER_MODEL_PATH"] = envBackup.modelPath;
    }
  });

  it("returns null when transcriber service is not configured", () => {
    const transcriber = createAudioTranscriber({ services: undefined });
    expect(transcriber).toBeNull();
  });

  it("creates transcriber from environment paths without explicit services config", () => {
    process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"] = "/opt/whisper.cpp/build/bin/whisper-cli";
    process.env["AO_TRANSCRIBER_MODEL_PATH"] = "/opt/whisper.cpp/models/ggml-base.bin";

    const transcriber = createAudioTranscriber({ services: undefined });
    expect(transcriber?.name).toBe("whisper-cpp");
  });

  it("throws when environment enables transcriber with partial paths", () => {
    process.env["AO_TRANSCRIBER_WHISPER_CPP_PATH"] = "/opt/whisper.cpp/build/bin/whisper-cli";
    delete process.env["AO_TRANSCRIBER_MODEL_PATH"];

    expect(() => createAudioTranscriber({ services: undefined })).toThrow(
      "Transcriber is enabled but binary/model paths are missing",
    );
  });

  it("returns whisper-cpp transcriber when required paths are provided", () => {
    const transcriber = createAudioTranscriber({
      services: {
        transcriber: {
          plugin: "whisper-cpp",
          binaryPath: "/opt/whisper.cpp/build/bin/whisper-cli",
          modelPath: "/opt/whisper.cpp/models/ggml-base.bin",
        },
      },
    });

    expect(transcriber).not.toBeNull();
    expect(transcriber?.name).toBe("whisper-cpp");
  });

  it("throws for unsupported transcriber plugin", () => {
    expect(() =>
      createAudioTranscriber({
        services: {
          transcriber: {
            plugin: "custom-transcriber",
            binaryPath: "/tmp/bin",
            modelPath: "/tmp/model",
          },
        },
      }),
    ).toThrow('Unsupported transcriber plugin "custom-transcriber"');
  });

  it("throws when transcriber is enabled but required paths are missing", () => {
    expect(() =>
      createAudioTranscriber({
        services: {
          transcriber: {
            plugin: "whisper-cpp",
          },
        },
      }),
    ).toThrow("Transcriber is enabled but binary/model paths are missing");
  });
});

describe("downloadTelegramVoiceFileBytes", () => {
  it("downloads voice bytes and reports extension and size", async () => {
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_1.oga", file_size: 11 },
            }),
        };
      }
      if (url.includes("/file/bot")) {
        const bytes = new TextEncoder().encode("voice-bytes");
        return {
          ok: true,
          arrayBuffer: () => Promise.resolve(bytes.buffer),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await downloadTelegramVoiceFileBytes({
      botToken: "token-1",
      fileId: "voice-file-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAudioBytes: 100,
    });

    expect(result.fileExtension).toBe(".oga");
    expect(result.fileSizeBytes).toBe(11);
    expect(new TextDecoder().decode(result.bytes)).toBe("voice-bytes");
  });

  it("fails before file download when Telegram reports oversized file", async () => {
    const fetchImpl = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0] ?? "");
      if (url.includes("/getFile")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              result: { file_path: "voice/file_oversized.oga", file_size: 128 },
            }),
        };
      }
      if (url.includes("/file/bot")) {
        throw new Error("file download should not be attempted for oversized voice");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      downloadTelegramVoiceFileBytes({
        botToken: "token-1",
        fileId: "voice-file-oversized",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxAudioBytes: 16,
      }),
    ).rejects.toThrow("Audio is too large");

    expect(
      fetchImpl.mock.calls.some((call) => String(call[0]).includes("/file/bot")),
    ).toBe(false);
  });
});

describe("transcribeAudioBytes", () => {
  it("writes bytes to a temp file, delegates to transcribeLocalFile, and cleans up", async () => {
    let capturedInput: TranscribeLocalFileInput | undefined;
    const transcriber: AudioTranscriber = {
      name: "test-transcriber",
      transcribeLocalFile: vi.fn(async (input) => {
        capturedInput = input;
        const content = await readFile(input.filePath, "utf-8");
        expect(content).toBe("voice-bytes");
        return {
          text: "ok",
          language: "auto",
          durationMs: 5,
          backend: "test-transcriber",
        };
      }),
    };

    const result = await transcribeAudioBytes({
      transcriber,
      bytes: new TextEncoder().encode("voice-bytes"),
      fileExtension: ".oga",
      durationSec: 4,
    });

    expect(result.text).toBe("ok");
    expect(capturedInput?.durationSec).toBe(4);
    expect(capturedInput?.fileSizeBytes).toBe("voice-bytes".length);
    expect(capturedInput?.filePath.endsWith(".oga")).toBe(true);
    await expect(access(capturedInput!.filePath)).rejects.toThrow();
  });
});
