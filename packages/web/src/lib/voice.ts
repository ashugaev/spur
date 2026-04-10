import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");
const DEFAULT_VOICE_PROVIDER = "whisper_cpp";
const DEFAULT_VOICE_MODEL_PATH = join(homedir(), ".cache", "whisper.cpp", "ggml-base.bin");
const DEFAULT_VOICE_MODEL = "base";
const DEFAULT_VOICE_LANGUAGE = "auto";
const DEFAULT_FASTER_WHISPER_PYTHON = join(
  homedir(),
  ".spur",
  "venvs",
  "faster-whisper",
  "bin",
  "python",
);
const FASTER_WHISPER_STARTUP_TIMEOUT_MS = 10 * 60_000;
const FASTER_WHISPER_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const FASTER_WHISPER_WORKER_PATH = resolve(MODULE_DIR, "../../server/voice/faster-whisper-worker.py");

type VoiceProvider = "whisper_cpp" | "faster_whisper";
type VoiceFailureReason =
  | "missing_model"
  | "missing_whisper_cli"
  | "missing_ffmpeg"
  | "missing_runtime"
  | "startup_failed";

interface VoiceConfigShape {
  voice?: {
    provider?: string;
    modelPath?: string;
    model?: string;
    language?: string;
  };
}

interface ResolvedVoiceConfig {
  provider: VoiceProvider;
  modelPath?: string;
  model: string;
  language: string;
}

interface VoiceTranscription {
  text: string;
  modelPath?: string;
  provider: VoiceProvider;
  model: string;
  language: string;
}

interface FasterWorkerResponse {
  id?: string;
  type?: string;
  text?: string;
  error?: string;
}

export interface VoiceStatus {
  available: boolean;
  modelPath?: string;
  language: string;
  provider: VoiceProvider;
  model: string;
  reason?: VoiceFailureReason;
  detail?: string;
}

function invalidProviderError(value: string): Error {
  return new Error(`voice.provider must be "whisper_cpp" or "faster_whisper" (received "${value}")`);
}

function resolveConfigPath(): string {
  const candidate = process.env["SPUR_CONFIG"]?.trim();
  if (!candidate) {
    return DEFAULT_CONFIG_PATH;
  }
  if (candidate.startsWith("~/")) {
    return join(homedir(), candidate.slice(2));
  }
  return candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
}

function resolvePathFromConfig(configDir: string, value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value.startsWith("/") ? value : resolve(configDir, value);
}

function resolveVoiceConfig(): ResolvedVoiceConfig {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return {
      provider: DEFAULT_VOICE_PROVIDER,
      modelPath: DEFAULT_VOICE_MODEL_PATH,
      model: DEFAULT_VOICE_MODEL,
      language: DEFAULT_VOICE_LANGUAGE,
    };
  }

  const configDir = dirname(configPath);
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as VoiceConfigShape | null;
  const rawProvider = parsed?.voice?.provider?.trim();
  if (rawProvider && rawProvider !== "whisper_cpp" && rawProvider !== "faster_whisper") {
    throw invalidProviderError(rawProvider);
  }
  const provider: VoiceProvider =
    rawProvider === "faster_whisper" ? "faster_whisper" : DEFAULT_VOICE_PROVIDER;
  const configuredModelPath = parsed?.voice?.modelPath?.trim();
  const modelPath = configuredModelPath
    ? resolvePathFromConfig(configDir, configuredModelPath)
    : provider === "whisper_cpp"
      ? DEFAULT_VOICE_MODEL_PATH
      : undefined;
  const model = parsed?.voice?.model?.trim() || DEFAULT_VOICE_MODEL;
  const language = parsed?.voice?.language?.trim() || DEFAULT_VOICE_LANGUAGE;
  return { provider, modelPath, model, language };
}

function commandExists(command: string): boolean {
  try {
    return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function resolvePythonCommand(): string | null {
  const override = process.env["SPUR_VOICE_PYTHON"]?.trim();
  if (override) {
    return override;
  }
  if (existsSync(DEFAULT_FASTER_WHISPER_PYTHON)) {
    return DEFAULT_FASTER_WHISPER_PYTHON;
  }
  if (commandExists("python3")) {
    return "python3";
  }
  if (commandExists("python")) {
    return "python";
  }
  return null;
}

class FasterWhisperWorker {
  private readonly pythonCommand: string;
  private workerKey: string | null = null;
  private child: ChildProcess | null = null;
  private reader: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private startupPromise: Promise<void> | null = null;
  private startupResolve: (() => void) | null = null;
  private startupReject: ((reason: Error) => void) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<string, {
    resolve: (response: FasterWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(pythonCommand: string) {
    this.pythonCommand = pythonCommand;
  }

  async transcribe(
    config: ResolvedVoiceConfig,
    audioPath: string,
  ): Promise<VoiceTranscription> {
    const run = async (): Promise<VoiceTranscription> => {
      await this.ensureStarted(config);
      const requestId = String(this.nextRequestId++);
      const response = await this.send({
        id: requestId,
        action: "transcribe",
        audioPath,
        language: config.language,
      });
      if (!response.text?.trim()) {
        throw new Error(response.error || "transcription returned empty text");
      }
      return {
        text: response.text.trim(),
        ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
        provider: "faster_whisper",
        model: config.model,
        language: config.language,
      };
    };

    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next.then(() => undefined);
    return next;
  }

  private createWorkerKey(config: ResolvedVoiceConfig): string {
    return `${config.modelPath ?? ""}|${config.model}`;
  }

  private async ensureStarted(config: ResolvedVoiceConfig): Promise<void> {
    const key = this.createWorkerKey(config);
    if (this.workerKey !== key) {
      this.stop();
    }
    if (this.child && this.startupPromise === null) {
      return;
    }
    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.workerKey = key;
    this.startupPromise = new Promise<void>((resolveStart, rejectStart) => {
      this.startupResolve = resolveStart;
      this.startupReject = rejectStart;
    });

    const args = [FASTER_WHISPER_WORKER_PATH, "--model", config.model];
    if (config.modelPath) {
      args.push("--model-path", config.modelPath);
    }
    const child = spawn(this.pythonCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout as NodeJS.ReadableStream });

    this.reader.on("line", (line: string) => {
      this.handleWorkerLine(line);
    });

    child.on("exit", () => {
      this.failPending(new Error("faster_whisper worker exited"));
      if (this.startupReject) {
        this.startupReject(new Error("faster_whisper worker failed to start"));
      }
      this.cleanupWorkerHandles();
    });

    child.on("error", (error: Error) => {
      this.failPending(error);
      if (this.startupReject) {
        this.startupReject(error);
      }
      this.cleanupWorkerHandles();
    });

    child.stderr?.on("data", () => {
      // stderr is intentionally ignored to keep protocol stdout-only.
    });

    const startupTimer = setTimeout(() => {
      if (this.startupReject) {
        this.startupReject(new Error("faster_whisper worker startup timed out"));
      }
      this.stop();
    }, FASTER_WHISPER_STARTUP_TIMEOUT_MS);
    startupTimer.unref();

    try {
      await this.startupPromise;
    } finally {
      clearTimeout(startupTimer);
      this.startupPromise = null;
      this.startupResolve = null;
      this.startupReject = null;
    }
  }

  private cleanupWorkerHandles(): void {
    this.reader?.close();
    this.reader = null;
    this.child = null;
    this.workerKey = null;
  }

  private handleWorkerLine(line: string): void {
    let payload: FasterWorkerResponse;
    try {
      payload = JSON.parse(line) as FasterWorkerResponse;
    } catch {
      return;
    }

    if (payload.type === "ready") {
      this.startupResolve?.();
      return;
    }
    if (payload.type === "fatal") {
      this.startupReject?.(new Error(payload.error || "faster_whisper worker failed"));
      return;
    }
    if (!payload.id) {
      return;
    }
    const request = this.pending.get(payload.id);
    if (!request) {
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(payload.id);
    request.resolve(payload);
  }

  private send(payload: Record<string, unknown>): Promise<FasterWorkerResponse> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || !stdin.writable) {
      return Promise.reject(new Error("faster_whisper worker is not writable"));
    }
    const id = String(payload["id"] ?? "");
    return new Promise<FasterWorkerResponse>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error("faster_whisper worker request timed out"));
      }, FASTER_WHISPER_REQUEST_TIMEOUT_MS);
      timer.unref();

      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop(): void {
    this.failPending(new Error("faster_whisper worker stopped"));
    this.reader?.close();
    this.reader = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.workerKey = null;
    this.startupPromise = null;
    this.startupResolve = null;
    this.startupReject = null;
  }
}

let fasterWhisperWorker: FasterWhisperWorker | null = null;

function getFasterWhisperWorker(): FasterWhisperWorker {
  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand) {
    throw new Error("missing_runtime");
  }
  if (!fasterWhisperWorker) {
    fasterWhisperWorker = new FasterWhisperWorker(pythonCommand);
    process.on("exit", () => {
      fasterWhisperWorker?.stop();
    });
  }
  return fasterWhisperWorker;
}

async function readWhisperCppStatus(config: ResolvedVoiceConfig): Promise<VoiceStatus> {
  const modelPath = config.modelPath ?? DEFAULT_VOICE_MODEL_PATH;
  if (!existsSync(modelPath)) {
    return {
      available: false,
      provider: "whisper_cpp",
      model: config.model,
      modelPath,
      language: config.language,
      reason: "missing_model",
    };
  }
  if (!commandExists("whisper-cli")) {
    return {
      available: false,
      provider: "whisper_cpp",
      model: config.model,
      modelPath,
      language: config.language,
      reason: "missing_whisper_cli",
    };
  }
  if (!commandExists("ffmpeg")) {
    return {
      available: false,
      provider: "whisper_cpp",
      model: config.model,
      modelPath,
      language: config.language,
      reason: "missing_ffmpeg",
    };
  }
  return {
    available: true,
    provider: "whisper_cpp",
    model: config.model,
    modelPath,
    language: config.language,
  };
}

async function readFasterWhisperStatus(config: ResolvedVoiceConfig): Promise<VoiceStatus> {
  if (config.modelPath && !existsSync(config.modelPath)) {
    return {
      available: false,
      provider: "faster_whisper",
      model: config.model,
      modelPath: config.modelPath,
      language: config.language,
      reason: "missing_model",
    };
  }
  if (!existsSync(FASTER_WHISPER_WORKER_PATH)) {
    return {
      available: false,
      provider: "faster_whisper",
      model: config.model,
      language: config.language,
      reason: "startup_failed",
      detail: "The bundled faster-whisper worker script is missing",
      ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
    };
  }
  const pythonCommand = resolvePythonCommand();
  if (!pythonCommand) {
    return {
      available: false,
      provider: "faster_whisper",
      model: config.model,
      language: config.language,
      reason: "missing_runtime",
      detail: "python3 (or python) is not available",
      ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
    };
  }

  try {
    await execFileAsync(pythonCommand, ["-c", "import faster_whisper"], { timeout: 15_000 });
  } catch {
    return {
      available: false,
      provider: "faster_whisper",
      model: config.model,
      language: config.language,
      reason: "missing_runtime",
      detail: "faster-whisper is not installed in the Python environment",
      ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
    };
  }

  return {
    available: true,
    provider: "faster_whisper",
    model: config.model,
    language: config.language,
    ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
  };
}

export async function readVoiceStatus(): Promise<VoiceStatus> {
  try {
    const config = resolveVoiceConfig();
    if (config.provider === "faster_whisper") {
      return readFasterWhisperStatus(config);
    }
    return readWhisperCppStatus(config);
  } catch (error) {
    return {
      available: false,
      provider: DEFAULT_VOICE_PROVIDER,
      model: DEFAULT_VOICE_MODEL,
      modelPath: DEFAULT_VOICE_MODEL_PATH,
      language: DEFAULT_VOICE_LANGUAGE,
      reason: "startup_failed",
      detail: error instanceof Error ? error.message : "Voice input is unavailable",
    };
  }
}

async function transcribeWithWhisperCpp(
  config: ResolvedVoiceConfig,
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const status = await readWhisperCppStatus(config);
  if (!status.available) {
    throw new Error(status.reason ?? "voice input is unavailable");
  }
  const modelPath = status.modelPath ?? config.modelPath ?? DEFAULT_VOICE_MODEL_PATH;

  const tempDir = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "spur-voice-"));
  const inputExt = extname(originalFilename) || ".webm";
  const inputPath = join(tempDir, `input${inputExt}`);
  const wavPath = join(tempDir, "input.wav");
  const outputBasePath = join(tempDir, "transcript");

  try {
    await writeFile(inputPath, audio);
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeout: 120_000 },
    );
    await execFileAsync(
      "whisper-cli",
      ["-m", modelPath, "-l", status.language, "-f", wavPath, "-otxt", "-of", outputBasePath],
      { timeout: 120_000 },
    );

    const text = (await readFile(`${outputBasePath}.txt`, "utf8")).trim();
    if (!text) {
      throw new Error("transcription returned empty text");
    }
    return {
      text,
      modelPath,
      provider: status.provider,
      model: status.model,
      language: status.language,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function transcribeWithFasterWhisper(
  config: ResolvedVoiceConfig,
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const tempDir = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "spur-voice-"));
  const inputExt = extname(originalFilename) || ".webm";
  const inputPath = join(tempDir, `input${inputExt}`);
  try {
    await writeFile(inputPath, audio);
    const worker = getFasterWhisperWorker();
    return await worker.transcribe(config, inputPath);
  } catch (error) {
    throw error instanceof Error ? error : new Error("startup_failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function transcribeAudio(
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const config = resolveVoiceConfig();
  if (config.provider === "faster_whisper") {
    return transcribeWithFasterWhisper(config, audio, originalFilename);
  }
  return transcribeWithWhisperCpp(config, audio, originalFilename);
}
