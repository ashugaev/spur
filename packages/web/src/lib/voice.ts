import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");
const DEFAULT_VOICE_MODEL_PATH = join(homedir(), ".cache", "whisper.cpp", "ggml-base.bin");
const DEFAULT_VOICE_LANGUAGE = "auto";

interface SpurInstanceShape {
  voice?: {
    modelPath?: string;
    language?: string;
  };
}

export interface VoiceStatus {
  available: boolean;
  modelPath: string;
  language: string;
  reason?: "missing_model" | "missing_whisper_cli" | "missing_ffmpeg";
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

function resolveVoiceConfig(): { modelPath: string; language: string } {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return { modelPath: DEFAULT_VOICE_MODEL_PATH, language: DEFAULT_VOICE_LANGUAGE };
  }
  const configDir = dirname(configPath);
  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as SpurInstanceShape | null;
  const configured = parsed?.voice?.modelPath?.trim();
  let modelPath = DEFAULT_VOICE_MODEL_PATH;
  if (configured) {
    modelPath = configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : configured.startsWith("/")
        ? configured
        : resolve(configDir, configured);
  }
  const language = parsed?.voice?.language?.trim() || DEFAULT_VOICE_LANGUAGE;
  return { modelPath, language };
}

function commandExists(command: string): boolean {
  try {
    return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function readVoiceStatus(): VoiceStatus {
  const { modelPath, language } = resolveVoiceConfig();
  if (!existsSync(modelPath)) {
    return { available: false, modelPath, language, reason: "missing_model" };
  }
  if (!commandExists("whisper-cli")) {
    return { available: false, modelPath, language, reason: "missing_whisper_cli" };
  }
  if (!commandExists("ffmpeg")) {
    return { available: false, modelPath, language, reason: "missing_ffmpeg" };
  }
  return { available: true, modelPath, language };
}

export async function transcribeAudio(
  audio: Buffer,
  originalFilename: string,
): Promise<{ text: string; modelPath: string }> {
  const status = readVoiceStatus();
  if (!status.available) {
    throw new Error(status.reason ?? "voice input is unavailable");
  }

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
      ["-m", status.modelPath, "-l", status.language, "-f", wavPath, "-otxt", "-of", outputBasePath],
      { timeout: 120_000 },
    );

    const text = (await readFile(`${outputBasePath}.txt`, "utf8")).trim();
    if (!text) {
      throw new Error("transcription returned empty text");
    }
    return { text, modelPath: status.modelPath };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
