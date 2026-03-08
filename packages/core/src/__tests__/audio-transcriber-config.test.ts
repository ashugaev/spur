import { describe, expect, it } from "vitest";
import { validateConfig } from "../config.js";

describe("config services.transcriber", () => {
  it("keeps transcriber config minimal and preserves explicit overrides only", () => {
    const config = validateConfig({
      projects: {
        app: {
          repo: "acme/app",
          path: "/tmp/app",
        },
      },
      services: {
        transcriber: {
          binaryPath: "/opt/whisper.cpp/build/bin/whisper-cli",
          modelPath: "/opt/whisper.cpp/models/ggml-base.bin",
        },
      },
    });

    expect(config.services?.transcriber?.binaryPath).toBe(
      "/opt/whisper.cpp/build/bin/whisper-cli",
    );
    expect(config.services?.transcriber?.modelPath).toBe(
      "/opt/whisper.cpp/models/ggml-base.bin",
    );
    expect(config.services?.transcriber?.plugin).toBeUndefined();
    expect(config.services?.transcriber?.enabled).toBeUndefined();
    expect(config.services?.transcriber?.ffmpegPath).toBeUndefined();
    expect(config.services?.transcriber?.language).toBeUndefined();
    expect(config.services?.transcriber?.timeoutMs).toBeUndefined();
    expect(config.services?.transcriber?.maxAudioBytes).toBeUndefined();
    expect(config.services?.transcriber?.maxDurationSec).toBeUndefined();
  });
});
