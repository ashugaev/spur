// @vitest-environment node
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateInterface = vi.fn();
const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockMkdtemp = vi.fn();
const mockReadFile = vi.fn();
const mockRm = vi.fn();
const mockWriteFile = vi.fn();
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const workerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../server/voice/faster-whisper-worker.py",
);
const localWhisperCliPath = resolve(homedir(), "whisper.cpp/build/bin/whisper-cli");
const localWhisperCppModelPath = resolve(homedir(), ".cache/whisper.cpp/ggml-large-v3-turbo.bin");
const localSpurEnvPath = resolve(homedir(), ".spur/.env");

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  rm: mockRm,
  writeFile: mockWriteFile,
}));

vi.mock("node:readline", () => ({
  createInterface: mockCreateInterface,
}));

class MockLineReader {
  private handlers = new Map<string, Array<(line: string) => void>>();

  close() {
    return undefined;
  }

  emit(line: string) {
    for (const handler of this.handlers.get("line") ?? []) {
      handler(line);
    }
  }

  on(event: string, handler: (line: string) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
}

class MockStdin extends EventEmitter {
  writable = true;

  constructor(private readonly onWrite: (text: string) => void) {
    super();
  }

  write(chunk: string) {
    this.onWrite(chunk);
    return true;
  }
}

function mockExecFileSuccess() {
  mockExecFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "", "");
    },
  );
}

function configureAzureOpenAIConfig(language = "auto") {
  mockExistsSync.mockImplementation((path: string) => {
    if (path === "/tmp/config.yaml") return true;
    if (path === localSpurEnvPath) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (path === "/tmp/config.yaml") {
      return `
voice:
  provider: azure_openai
  model: whisper
  language: ${language}
`;
    }
    if (path === localSpurEnvPath) {
      return `
AZURE_OPENAI_ENDPOINT=https://example.services.ai.azure.com
AZURE_OPENAI_API_KEY=test-key
AZURE_OPENAI_API_VERSION=2024-10-21
`;
    }
    return "";
  });
  process.env["SPUR_CONFIG"] = "/tmp/config.yaml";
}

describe("voice runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env["SPUR_CONFIG"];
    delete process.env["SPUR_VOICE_PYTHON"];
    delete process.env["SPUR_VOICE_BENCHMARK"];
    delete process.env["AZURE_OPENAI_ENDPOINT"];
    delete process.env["AZURE_OPENAI_API_KEY"];
    delete process.env["AZURE_OPENAI_API_VERSION"];
    mockMkdtemp.mockResolvedValue("/tmp/spur-voice-test");
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue("transcribed text");
    mockRm.mockResolvedValue(undefined);
  });

  it("surfaces invalid voice.provider instead of silently coercing it", async () => {
    mockExistsSync.mockImplementation((path: string) => path === "/tmp/config.yaml");
    mockReadFileSync.mockReturnValue(`
voice:
  provider: whisperx
`);
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    const { readVoiceStatus } = await import("./voice");
    const status = await readVoiceStatus();

    expect(status.available).toBe(false);
    expect(status.reason).toBe("startup_failed");
    expect(status.detail).toContain(
      'voice.provider must be "whisper_cpp", "faster_whisper", or "azure_openai"',
    );
  });

  it("reports missing runtime for faster_whisper directly from voice.ts", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === workerPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(`
voice:
  provider: faster_whisper
  model: small
`);
    mockSpawnSync.mockReturnValue({ status: 1 });
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    const { readVoiceStatus } = await import("./voice");
    const status = await readVoiceStatus();

    expect(status).toMatchObject({
      available: false,
      provider: "faster_whisper",
      model: "small",
      reason: "missing_runtime",
    });
  });

  it("uses voice.model to resolve the whisper_cpp model path and local whisper.cpp runtime", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === localWhisperCliPath) return true;
      if (path === localWhisperCppModelPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(`
voice:
  provider: whisper_cpp
  model: large-v3-turbo
`);
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === localWhisperCliPath && args[0] === "--help") {
        return { status: 0 };
      }
      if (command === "which" && args[0] === "ffmpeg") {
        return { status: 0 };
      }
      return { status: 1 };
    });
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    const { readVoiceStatus } = await import("./voice");
    const status = await readVoiceStatus();

    expect(status).toMatchObject({
      available: true,
      provider: "whisper_cpp",
      model: "large-v3-turbo",
      modelPath: localWhisperCppModelPath,
      language: "auto",
    });
  });

  it("uses the faster_whisper worker protocol for transcription", async () => {
    const reader = new MockLineReader();
    mockCreateInterface.mockReturnValue(reader);
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === workerPath) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(`
voice:
  provider: faster_whisper
  model: small
  language: uk
`);
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "python3") {
        return { status: 0 };
      }
      return { status: 1 };
    });
    mockExecFileSuccess();
    mockSpawn.mockImplementation(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdin: MockStdin;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => undefined;
      child.stdin = new MockStdin((chunk) => {
        const payload = JSON.parse(chunk.trim()) as {
          id: string;
          action: string;
          audioPath: string;
          language: string;
        };
        reader.emit(
          JSON.stringify({ id: payload.id, text: `ok:${payload.language}:${payload.audioPath}` }),
        );
      });
      queueMicrotask(() => {
        reader.emit(JSON.stringify({ type: "ready" }));
      });
      return child;
    });
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    const { transcribeAudio } = await import("./voice");
    const result = await transcribeAudio(Buffer.from("audio"), "clip.webm");

    expect(result).toMatchObject({
      text: "ok:uk:/tmp/spur-voice-test/input.webm",
      provider: "faster_whisper",
      model: "small",
      language: "uk",
    });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("reads azure_openai credentials from ~/.spur/.env", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === localSpurEnvPath) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") {
        return `
voice:
  provider: azure_openai
  model: whisper
`;
      }
      if (path === localSpurEnvPath) {
        return `
AZURE_OPENAI_ENDPOINT=https://example.services.ai.azure.com
AZURE_OPENAI_API_KEY=test-key
AZURE_OPENAI_API_VERSION=2024-10-21
`;
      }
      return "";
    });
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    const { readVoiceStatus } = await import("./voice");
    const status = await readVoiceStatus();

    expect(status).toMatchObject({
      available: true,
      provider: "azure_openai",
      model: "whisper",
      language: "auto",
    });
  });

  it("uses the azure_openai transcription endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "azure ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === localSpurEnvPath) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") {
        return `
voice:
  provider: azure_openai
  model: whisper
  language: uk
`;
      }
      if (path === localSpurEnvPath) {
        return `
AZURE_OPENAI_ENDPOINT=https://example.services.ai.azure.com
AZURE_OPENAI_API_KEY=test-key
AZURE_OPENAI_API_VERSION=2024-10-21
`;
      }
      return "";
    });
    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";

    try {
      const { transcribeAudio } = await import("./voice");
      const result = await transcribeAudio(Buffer.from("audio"), "clip.webm");

      expect(result).toMatchObject({
        text: "azure ok",
        provider: "azure_openai",
        model: "whisper",
        language: "uk",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.services.ai.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-10-21",
        expect.objectContaining({
          method: "POST",
          headers: { "api-key": "test-key" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries retryable azure errors and succeeds before exhaustion", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "azure ok after retry" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    configureAzureOpenAIConfig("uk");

    try {
      const { transcribeAudio } = await import("./voice");
      const result = await transcribeAudio(Buffer.from("audio"), "clip.webm");
      expect(result).toMatchObject({
        text: "azure ok after retry",
        provider: "azure_openai",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("honors azure Retry-After http-date before retrying", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const retryAt = new Date(now + 15_000).toUTCString();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": retryAt },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "azure ok after date retry" }), {
          status: 200,
        }),
      );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: TimerHandler) => {
        if (typeof handler === "function") {
          handler();
        }
        return { unref() {} } as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", fetchMock);
    configureAzureOpenAIConfig("uk");

    try {
      const { transcribeAudio } = await import("./voice");
      const result = await transcribeAudio(Buffer.from("audio"), "clip.webm");
      expect(result).toMatchObject({
        text: "azure ok after date retry",
        provider: "azure_openai",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    } finally {
      dateNowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("fails with explicit message after exhausting retryable azure errors and still cleans up temp files", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        {
          ok: false,
          status: 503,
          headers: new Headers({ "retry-after": "0" }),
          json: async () => ({ error: { message: "service unavailable" } }),
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    configureAzureOpenAIConfig("uk");

    try {
      const { transcribeAudio } = await import("./voice");
      let thrown: unknown;
      try {
        await transcribeAudio(Buffer.from("audio"), "clip.webm");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        "Azure OpenAI transcription failed after 5 attempts: service unavailable",
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(mockRm).toHaveBeenCalledWith("/tmp/spur-voice-test", { recursive: true, force: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries transient azure network failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "azure ok after network retry" }), {
          status: 200,
        }),
      );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((handler: TimerHandler) => {
        if (typeof handler === "function") {
          handler();
        }
        return { unref() {} } as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    );
    vi.stubGlobal("fetch", fetchMock);
    configureAzureOpenAIConfig("uk");

    try {
      const { transcribeAudio } = await import("./voice");
      const result = await transcribeAudio(Buffer.from("audio"), "clip.webm");
      expect(result).toMatchObject({
        text: "azure ok after network retry",
        provider: "azure_openai",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(setTimeoutSpy).toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not retry non-retryable azure 400 errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      {
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => ({ error: { message: "bad request" } }),
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    configureAzureOpenAIConfig("uk");

    try {
      const { transcribeAudio } = await import("./voice");
      let thrown: unknown;
      try {
        await transcribeAudio(Buffer.from("audio"), "clip.webm");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("bad request");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("switches faster_whisper models without letting the old worker exit fail the new startup", async () => {
    const readers: MockLineReader[] = [];
    const children: Array<
      EventEmitter & {
        stdin: MockStdin;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      }
    > = [];
    mockCreateInterface.mockImplementation(() => {
      const reader = new MockLineReader();
      readers.push(reader);
      return reader;
    });
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/tmp/config.yaml") return true;
      if (path === workerPath) return true;
      return false;
    });
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "which" && args[0] === "python3") {
        return { status: 0 };
      }
      return { status: 1 };
    });
    mockExecFileSuccess();
    mockSpawn.mockImplementation((_command: string, args: string[]) => {
      const modelIndex = args.indexOf("--model");
      const model = modelIndex >= 0 ? String(args[modelIndex + 1]) : "unknown";
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        stdin: MockStdin;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        queueMicrotask(() => {
          child.emit("exit", 0);
        });
      };
      child.stdin = new MockStdin((chunk) => {
        const payload = JSON.parse(chunk.trim()) as { id: string; language: string };
        const reader = readers[children.indexOf(child)];
        reader.emit(JSON.stringify({ id: payload.id, text: `${model}:${payload.language}` }));
      });
      children.push(child);
      queueMicrotask(() => {
        readers[children.indexOf(child)].emit(JSON.stringify({ type: "ready" }));
      });
      return child;
    });

    process.env["SPUR_CONFIG"] = "/tmp/config.yaml";
    mockReadFileSync.mockReturnValue(`
voice:
  provider: faster_whisper
  model: large-v3-turbo
  language: uk
`);

    const { transcribeAudio } = await import("./voice");
    const first = await transcribeAudio(Buffer.from("audio"), "clip.webm");
    expect(first).toMatchObject({ text: "large-v3-turbo:uk", model: "large-v3-turbo" });

    mockReadFileSync.mockReturnValue(`
voice:
  provider: faster_whisper
  model: medium
  language: uk
`);

    const second = await transcribeAudio(Buffer.from("audio"), "clip.webm");
    expect(second).toMatchObject({ text: "medium:uk", model: "medium" });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("emits benchmark logs when voice benchmarking is enabled", async () => {
    const reader = new MockLineReader();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      mockCreateInterface.mockReturnValue(reader);
      mockExistsSync.mockImplementation((path: string) => {
        if (path === "/tmp/config.yaml") return true;
        if (path === workerPath) return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(`
voice:
  provider: faster_whisper
  model: small
  language: uk
`);
      mockSpawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === "which" && args[0] === "python3") {
          return { status: 0 };
        }
        return { status: 1 };
      });
      mockExecFileSuccess();
      mockSpawn.mockImplementation(() => {
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const child = new EventEmitter() as EventEmitter & {
          stdin: MockStdin;
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: () => void;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => undefined;
        child.stdin = new MockStdin((chunk) => {
          const payload = JSON.parse(chunk.trim()) as {
            id: string;
            audioPath: string;
            language: string;
          };
          reader.emit(
            JSON.stringify({ id: payload.id, text: `ok:${payload.language}:${payload.audioPath}` }),
          );
        });
        queueMicrotask(() => {
          reader.emit(JSON.stringify({ type: "ready" }));
        });
        return child;
      });
      process.env["SPUR_CONFIG"] = "/tmp/config.yaml";
      process.env["SPUR_VOICE_BENCHMARK"] = "1";

      const { transcribeAudio } = await import("./voice");
      await transcribeAudio(Buffer.from("audio"), "clip.webm");

      const message = stderrWrite.mock.calls
        .map(([chunk]) => String(chunk))
        .find((chunk) => chunk.startsWith("[voice-bench] "));
      expect(message).toBeDefined();
      expect(message).toContain('"provider":"faster_whisper"');
      expect(message).toContain('"workerRequestMs"');
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
