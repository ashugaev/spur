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
const DEFAULT_SPUR_ENV_PATH = join(homedir(), ".spur", ".env");
const DEFAULT_VOICE_PROVIDER = "whisper_cpp";
const DEFAULT_WHISPER_CPP_MODEL_DIR = join(homedir(), ".cache", "whisper.cpp");
const DEFAULT_VOICE_MODEL_PATH = join(homedir(), ".cache", "whisper.cpp", "ggml-base.bin");
const DEFAULT_VOICE_MODEL = "base";
const DEFAULT_VOICE_LANGUAGE = "auto";
const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21";
const AZURE_TRANSCRIBE_MAX_ATTEMPTS = 5;
const AZURE_TRANSCRIBE_BASE_DELAY_MS = 250;
const AZURE_TRANSCRIBE_MAX_DELAY_MS = 5_000;
const AZURE_TRANSCRIBE_JITTER_MS = 200;
const AZURE_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const LOCAL_WHISPER_CPP_ROOT = join(homedir(), "whisper.cpp");
const LOCAL_WHISPER_CPP_CLI = join(LOCAL_WHISPER_CPP_ROOT, "build", "bin", "whisper-cli");
const LOCAL_WHISPER_CPP_LIBRARY_DIRS = [
  join(LOCAL_WHISPER_CPP_ROOT, "build", "src"),
  join(LOCAL_WHISPER_CPP_ROOT, "build", "ggml", "src"),
];
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
const FASTER_WHISPER_WORKER_PATH = resolve(
  MODULE_DIR,
  "../../server/voice/faster-whisper-worker.py",
);
const VOICE_BENCHMARK_ENV = "SPUR_VOICE_BENCHMARK";

type VoiceProvider = "whisper_cpp" | "faster_whisper" | "azure_openai";
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

interface FasterWorkerMetrics {
  coldStart: boolean;
  startupMs: number;
  requestMs: number;
}

interface VoiceBenchRecord {
  provider: VoiceProvider;
  model: string;
  language: string;
  audioBytes: number;
  audioSeconds?: number;
  secondsPerAudioSecond?: number;
  coldStart?: boolean;
  totalMs: number;
  steps: Record<string, number>;
  status: "ok" | "error";
  error?: string;
}

interface WhisperCliRuntime {
  command: string;
  env: NodeJS.ProcessEnv;
}

interface AzureOpenAICredentials {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
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
  return new Error(
    `voice.provider must be "whisper_cpp", "faster_whisper", or "azure_openai" (received "${value}")`,
  );
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

function resolveWhisperCppModelPath(config: ResolvedVoiceConfig): string {
  return config.modelPath ?? join(DEFAULT_WHISPER_CPP_MODEL_DIR, `ggml-${config.model}.bin`);
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
  if (
    rawProvider &&
    rawProvider !== "whisper_cpp" &&
    rawProvider !== "faster_whisper" &&
    rawProvider !== "azure_openai"
  ) {
    throw invalidProviderError(rawProvider);
  }
  const provider: VoiceProvider =
    rawProvider === "faster_whisper" || rawProvider === "azure_openai"
      ? rawProvider
      : DEFAULT_VOICE_PROVIDER;
  const configuredModelPath = parsed?.voice?.modelPath?.trim();
  const modelPath = configuredModelPath
    ? resolvePathFromConfig(configDir, configuredModelPath)
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

function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (key) {
      entries[key] = value;
    }
  }
  return entries;
}

function readVoiceSecrets(): Record<string, string> {
  if (!existsSync(DEFAULT_SPUR_ENV_PATH)) {
    return {};
  }
  try {
    return parseEnvFile(readFileSync(DEFAULT_SPUR_ENV_PATH, "utf8"));
  } catch {
    return {};
  }
}

function resolveVoiceSecret(
  fileSecrets: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const fileValue = fileSecrets[key]?.trim();
    if (fileValue) {
      return fileValue;
    }
    const envValue = process.env[key]?.trim();
    if (envValue) {
      return envValue;
    }
  }
  return undefined;
}

function resolveAzureOpenAICredentials(): AzureOpenAICredentials | null {
  const fileSecrets = readVoiceSecrets();
  const endpoint = resolveVoiceSecret(fileSecrets, "AZURE_OPENAI_ENDPOINT");
  const apiKey = resolveVoiceSecret(fileSecrets, "AZURE_OPENAI_API_KEY");
  if (!endpoint || !apiKey) {
    return null;
  }
  const apiVersion =
    resolveVoiceSecret(fileSecrets, "AZURE_OPENAI_API_VERSION") ?? DEFAULT_AZURE_OPENAI_API_VERSION;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    apiVersion,
  };
}

function benchmarkLoggingEnabled(): boolean {
  const value = process.env[VOICE_BENCHMARK_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}

function pushStep(steps: Record<string, number>, key: string, value: number): void {
  steps[key] = roundMetric(value);
}

function emitVoiceBenchmark(record: VoiceBenchRecord): void {
  if (!benchmarkLoggingEnabled()) {
    return;
  }
  process.stderr.write(`[voice-bench] ${JSON.stringify(record)}\n`);
}

async function readAudioDurationSeconds(audioPath: string): Promise<number | undefined> {
  if (!commandExists("ffprobe")) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audioPath,
      ],
      { timeout: 15_000 },
    );
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? roundMetric(duration) : undefined;
  } catch {
    return undefined;
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

function canRunCommand(command: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  try {
    return spawnSync(command, args, { stdio: "ignore", env }).status === 0;
  } catch {
    return false;
  }
}

function withLibraryPath(env: NodeJS.ProcessEnv, libraryDirs: string[]): NodeJS.ProcessEnv {
  const ldLibraryPath = [...libraryDirs, env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
  return ldLibraryPath ? { ...env, LD_LIBRARY_PATH: ldLibraryPath } : env;
}

function resolveWhisperCliRuntime(): WhisperCliRuntime | null {
  const baseEnv = { ...process.env };
  if (existsSync(LOCAL_WHISPER_CPP_CLI)) {
    const env = withLibraryPath(baseEnv, LOCAL_WHISPER_CPP_LIBRARY_DIRS);
    if (canRunCommand(LOCAL_WHISPER_CPP_CLI, ["--help"], env)) {
      return { command: LOCAL_WHISPER_CPP_CLI, env };
    }
  }

  if (commandExists("whisper-cli") && canRunCommand("whisper-cli", ["--help"], baseEnv)) {
    return { command: "whisper-cli", env: baseEnv };
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
  private pending = new Map<
    string,
    {
      resolve: (response: FasterWorkerResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(pythonCommand: string) {
    this.pythonCommand = pythonCommand;
  }

  async transcribe(
    config: ResolvedVoiceConfig,
    audioPath: string,
  ): Promise<{ transcription: VoiceTranscription; metrics: FasterWorkerMetrics }> {
    const run = async (): Promise<{
      transcription: VoiceTranscription;
      metrics: FasterWorkerMetrics;
    }> => {
      const startup = await this.ensureStarted(config);
      const requestId = String(this.nextRequestId++);
      const requestStartedAt = process.hrtime.bigint();
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
        transcription: {
          text: response.text.trim(),
          ...(config.modelPath !== undefined ? { modelPath: config.modelPath } : {}),
          provider: "faster_whisper",
          model: config.model,
          language: config.language,
        },
        metrics: {
          ...startup,
          requestMs: roundMetric(elapsedMs(requestStartedAt)),
        },
      };
    };

    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next.then(() => undefined);
    return next;
  }

  private createWorkerKey(config: ResolvedVoiceConfig): string {
    return `${config.modelPath ?? ""}|${config.model}`;
  }

  private async ensureStarted(config: ResolvedVoiceConfig): Promise<{
    coldStart: boolean;
    startupMs: number;
  }> {
    const key = this.createWorkerKey(config);
    if (this.workerKey !== key) {
      this.stop();
    }
    if (this.child && this.startupPromise === null) {
      return { coldStart: false, startupMs: 0 };
    }
    if (this.startupPromise) {
      const waitingStartedAt = process.hrtime.bigint();
      await this.startupPromise;
      return { coldStart: true, startupMs: roundMetric(elapsedMs(waitingStartedAt)) };
    }

    this.workerKey = key;
    const startupStartedAt = process.hrtime.bigint();
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
      if (this.child !== child) {
        return;
      }
      this.failPending(new Error("faster_whisper worker exited"));
      if (this.startupReject) {
        this.startupReject(new Error("faster_whisper worker failed to start"));
      }
      this.cleanupWorkerHandles();
    });

    child.on("error", (error: Error) => {
      if (this.child !== child) {
        return;
      }
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

    return { coldStart: true, startupMs: roundMetric(elapsedMs(startupStartedAt)) };
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
  const modelPath = resolveWhisperCppModelPath(config);
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
  if (!resolveWhisperCliRuntime()) {
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

async function readAzureOpenAIStatus(config: ResolvedVoiceConfig): Promise<VoiceStatus> {
  const credentials = resolveAzureOpenAICredentials();
  if (!credentials) {
    return {
      available: false,
      provider: "azure_openai",
      model: config.model,
      language: config.language,
      reason: "missing_runtime",
      detail: `Azure OpenAI credentials are missing; set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in ${DEFAULT_SPUR_ENV_PATH}`,
    };
  }

  return {
    available: true,
    provider: "azure_openai",
    model: config.model,
    language: config.language,
  };
}

export async function readVoiceStatus(): Promise<VoiceStatus> {
  try {
    const config = resolveVoiceConfig();
    if (config.provider === "faster_whisper") {
      return readFasterWhisperStatus(config);
    }
    if (config.provider === "azure_openai") {
      return readAzureOpenAIStatus(config);
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

function extractAzureOpenAIError(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body["error"] &&
    typeof body["error"] === "object" &&
    "message" in body["error"] &&
    typeof body["error"]["message"] === "string"
  ) {
    return body["error"]["message"];
  }
  return fallback;
}

function isRetryableAzureStatus(status: number): boolean {
  return AZURE_RETRYABLE_STATUS_CODES.has(status);
}

function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const resetAt = Date.parse(retryAfter);
  if (!Number.isFinite(resetAt)) {
    return null;
  }
  return Math.max(0, resetAt - Date.now());
}

function isRetryableAzureError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error instanceof TypeError) {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    message.includes("timeout") ||
    message.includes("temporar")
  );
}

function resolveAzureRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.max(0, retryAfterMs);
  }
  const exponential = AZURE_TRANSCRIBE_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * AZURE_TRANSCRIBE_JITTER_MS);
  return Math.min(exponential + jitter, AZURE_TRANSCRIBE_MAX_DELAY_MS);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

async function parseAzureTranscriptionPayload(
  response: Response,
): Promise<{ text?: string; error?: { message?: string } }> {
  try {
    return (await response.json()) as { text?: string; error?: { message?: string } };
  } catch {
    return {};
  }
}

async function transcribeWithWhisperCpp(
  config: ResolvedVoiceConfig,
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const startedAt = process.hrtime.bigint();
  const steps: Record<string, number> = {};
  let audioSeconds: number | undefined;
  let failure: Error | undefined;
  const status = await readWhisperCppStatus(config);
  if (!status.available) {
    throw new Error(status.reason ?? "voice input is unavailable");
  }
  const runtime = resolveWhisperCliRuntime();
  if (!runtime) {
    throw new Error("missing_whisper_cli");
  }
  const modelPath = status.modelPath ?? resolveWhisperCppModelPath(config);

  const tempDir = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "spur-voice-"));
  const inputExt = extname(originalFilename) || ".webm";
  const inputPath = join(tempDir, `input${inputExt}`);
  const wavPath = join(tempDir, "input.wav");
  const outputBasePath = join(tempDir, "transcript");

  try {
    const writeStartedAt = process.hrtime.bigint();
    await writeFile(inputPath, audio);
    pushStep(steps, "writeInputMs", elapsedMs(writeStartedAt));

    const probeStartedAt = process.hrtime.bigint();
    audioSeconds = await readAudioDurationSeconds(inputPath);
    pushStep(steps, "probeAudioMs", elapsedMs(probeStartedAt));

    const ffmpegStartedAt = process.hrtime.bigint();
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeout: 120_000 },
    );
    pushStep(steps, "ffmpegMs", elapsedMs(ffmpegStartedAt));

    const whisperStartedAt = process.hrtime.bigint();
    await execFileAsync(
      runtime.command,
      ["-m", modelPath, "-l", status.language, "-f", wavPath, "-otxt", "-of", outputBasePath],
      { timeout: 120_000, env: runtime.env },
    );
    pushStep(steps, "transcribeMs", elapsedMs(whisperStartedAt));

    const readStartedAt = process.hrtime.bigint();
    const text = (await readFile(`${outputBasePath}.txt`, "utf8")).trim();
    pushStep(steps, "readOutputMs", elapsedMs(readStartedAt));
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
  } catch (error) {
    failure = error instanceof Error ? error : new Error("startup_failed");
    throw failure;
  } finally {
    const cleanupStartedAt = process.hrtime.bigint();
    await rm(tempDir, { recursive: true, force: true });
    pushStep(steps, "cleanupMs", elapsedMs(cleanupStartedAt));
    const totalMs = roundMetric(elapsedMs(startedAt));
    emitVoiceBenchmark({
      provider: status.provider,
      model: status.model,
      language: status.language,
      audioBytes: audio.byteLength,
      ...(audioSeconds !== undefined ? { audioSeconds } : {}),
      ...(audioSeconds && audioSeconds > 0
        ? { secondsPerAudioSecond: roundMetric(totalMs / 1000 / audioSeconds) }
        : {}),
      totalMs,
      steps,
      status: failure ? "error" : "ok",
      ...(failure ? { error: failure.message } : {}),
    });
  }
}

async function transcribeWithFasterWhisper(
  config: ResolvedVoiceConfig,
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const startedAt = process.hrtime.bigint();
  const steps: Record<string, number> = {};
  let audioSeconds: number | undefined;
  let failure: Error | undefined;
  const tempDir = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "spur-voice-"));
  const inputExt = extname(originalFilename) || ".webm";
  const inputPath = join(tempDir, `input${inputExt}`);
  try {
    const writeStartedAt = process.hrtime.bigint();
    await writeFile(inputPath, audio);
    pushStep(steps, "writeInputMs", elapsedMs(writeStartedAt));

    const probeStartedAt = process.hrtime.bigint();
    audioSeconds = await readAudioDurationSeconds(inputPath);
    pushStep(steps, "probeAudioMs", elapsedMs(probeStartedAt));

    const worker = getFasterWhisperWorker();
    const { transcription, metrics } = await worker.transcribe(config, inputPath);
    pushStep(steps, "workerStartupMs", metrics.startupMs);
    pushStep(steps, "workerRequestMs", metrics.requestMs);
    return transcription;
  } catch (error) {
    failure = error instanceof Error ? error : new Error("startup_failed");
    throw failure;
  } finally {
    const cleanupStartedAt = process.hrtime.bigint();
    await rm(tempDir, { recursive: true, force: true });
    pushStep(steps, "cleanupMs", elapsedMs(cleanupStartedAt));
    const totalMs = roundMetric(elapsedMs(startedAt));
    emitVoiceBenchmark({
      provider: "faster_whisper",
      model: config.model,
      language: config.language,
      audioBytes: audio.byteLength,
      ...(audioSeconds !== undefined ? { audioSeconds } : {}),
      ...(audioSeconds && audioSeconds > 0
        ? { secondsPerAudioSecond: roundMetric(totalMs / 1000 / audioSeconds) }
        : {}),
      ...(steps["workerStartupMs"] !== undefined
        ? { coldStart: steps["workerStartupMs"] > 0 }
        : {}),
      totalMs,
      steps,
      status: failure ? "error" : "ok",
      ...(failure ? { error: failure.message } : {}),
    });
  }
}

async function transcribeWithAzureOpenAI(
  config: ResolvedVoiceConfig,
  audio: Buffer,
  originalFilename: string,
): Promise<VoiceTranscription> {
  const startedAt = process.hrtime.bigint();
  const steps: Record<string, number> = {};
  let audioSeconds: number | undefined;
  let failure: Error | undefined;
  const credentials = resolveAzureOpenAICredentials();
  if (!credentials) {
    throw new Error("missing_runtime");
  }

  const tempDir = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "spur-voice-"));
  const inputExt = extname(originalFilename) || ".webm";
  const inputPath = join(tempDir, `input${inputExt}`);
  try {
    const writeStartedAt = process.hrtime.bigint();
    await writeFile(inputPath, audio);
    pushStep(steps, "writeInputMs", elapsedMs(writeStartedAt));

    const probeStartedAt = process.hrtime.bigint();
    audioSeconds = await readAudioDurationSeconds(inputPath);
    pushStep(steps, "probeAudioMs", elapsedMs(probeStartedAt));

    let lastRetryableError: string | null = null;
    for (let attempt = 1; attempt <= AZURE_TRANSCRIBE_MAX_ATTEMPTS; attempt += 1) {
      const requestStartedAt = process.hrtime.bigint();
      const attemptMetricKey = `requestAttempt${attempt}Ms`;
      try {
        const formData = new FormData();
        formData.append("file", new Blob([new Uint8Array(audio)]), originalFilename);
        if (config.language !== "auto") {
          formData.append("language", config.language);
        }

        const response = await fetch(
          `${credentials.endpoint}/openai/deployments/${encodeURIComponent(config.model)}/audio/transcriptions?api-version=${encodeURIComponent(credentials.apiVersion)}`,
          {
            method: "POST",
            headers: {
              "api-key": credentials.apiKey,
            },
            body: formData,
          },
        );
        pushStep(steps, attemptMetricKey, elapsedMs(requestStartedAt));
        if (attempt === 1) {
          pushStep(steps, "requestMs", steps[attemptMetricKey] ?? 0);
        }

        const payload = await parseAzureTranscriptionPayload(response);
        if (response.ok) {
          if (!payload.text?.trim()) {
            throw new Error("transcription returned empty text");
          }
          return {
            text: payload.text.trim(),
            provider: "azure_openai",
            model: config.model,
            language: config.language,
          };
        }

        const message = extractAzureOpenAIError(payload, "Azure OpenAI transcription failed");
        if (!isRetryableAzureStatus(response.status)) {
          throw new Error(message);
        }
        lastRetryableError = message;
        if (attempt >= AZURE_TRANSCRIBE_MAX_ATTEMPTS) {
          throw new Error(
            `Azure OpenAI transcription failed after ${AZURE_TRANSCRIBE_MAX_ATTEMPTS} attempts: ${message}`,
          );
        }
        await sleep(resolveAzureRetryDelayMs(attempt, parseRetryAfterMs(response.headers)));
      } catch (error) {
        pushStep(steps, attemptMetricKey, elapsedMs(requestStartedAt));
        if (attempt === 1) {
          pushStep(steps, "requestMs", steps[attemptMetricKey] ?? 0);
        }
        if (!isRetryableAzureError(error)) {
          throw error;
        }
        lastRetryableError =
          error instanceof Error ? error.message : "Azure OpenAI transcription request failed";
        if (attempt >= AZURE_TRANSCRIBE_MAX_ATTEMPTS) {
          throw new Error(
            `Azure OpenAI transcription failed after ${AZURE_TRANSCRIBE_MAX_ATTEMPTS} attempts: ${lastRetryableError}`,
            error instanceof Error ? { cause: error } : undefined,
          );
        }
        await sleep(resolveAzureRetryDelayMs(attempt, null));
      }
    }
    throw new Error(
      `Azure OpenAI transcription failed after ${AZURE_TRANSCRIBE_MAX_ATTEMPTS} attempts: ${lastRetryableError ?? "unknown error"}`,
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error("startup_failed");
    throw failure;
  } finally {
    const cleanupStartedAt = process.hrtime.bigint();
    await rm(tempDir, { recursive: true, force: true });
    pushStep(steps, "cleanupMs", elapsedMs(cleanupStartedAt));
    const totalMs = roundMetric(elapsedMs(startedAt));
    emitVoiceBenchmark({
      provider: "azure_openai",
      model: config.model,
      language: config.language,
      audioBytes: audio.byteLength,
      ...(audioSeconds !== undefined ? { audioSeconds } : {}),
      ...(audioSeconds && audioSeconds > 0
        ? { secondsPerAudioSecond: roundMetric(totalMs / 1000 / audioSeconds) }
        : {}),
      totalMs,
      steps,
      status: failure ? "error" : "ok",
      ...(failure ? { error: failure.message } : {}),
    });
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
  if (config.provider === "azure_openai") {
    return transcribeWithAzureOpenAI(config, audio, originalFilename);
  }
  return transcribeWithWhisperCpp(config, audio, originalFilename);
}
