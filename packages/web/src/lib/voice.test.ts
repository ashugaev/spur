// @vitest-environment node
import { EventEmitter } from "node:events";
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

describe("voice runtime", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env["SPUR_CONFIG"];
    delete process.env["SPUR_VOICE_PYTHON"];
    delete process.env["SPUR_VOICE_BENCHMARK"];
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
    expect(status.detail).toContain('voice.provider must be "whisper_cpp" or "faster_whisper"');
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
        const payload = JSON.parse(chunk.trim()) as { id: string; action: string; audioPath: string; language: string };
        reader.emit(JSON.stringify({ id: payload.id, text: `ok:${payload.language}:${payload.audioPath}` }));
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
          const payload = JSON.parse(chunk.trim()) as { id: string; audioPath: string; language: string };
          reader.emit(JSON.stringify({ id: payload.id, text: `ok:${payload.language}:${payload.audioPath}` }));
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
