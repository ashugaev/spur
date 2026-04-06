import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const DEFAULT_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");

interface SpurInstanceShape {
  server?: {
    host?: string;
    port?: number;
  };
  tmux?: {
    socketName?: string;
  };
  ui?: {
    port?: number;
  };
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

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export interface SpurInstanceRuntimeConfig {
  configPath: string;
  daemonUrl: string;
  tmuxSocketName: string;
  uiPort: number;
}

export function readSpurInstanceRuntimeConfig(): SpurInstanceRuntimeConfig {
  const configPath = resolveConfigPath();
  const parsed = existsSync(configPath)
    ? (YAML.parse(readFileSync(configPath, "utf8")) as SpurInstanceShape | null)
    : null;
  const serverHost = readString(parsed?.server?.host, "127.0.0.1");
  const serverPort = readNumber(parsed?.server?.port, 4310);
  const tmuxSocketName = readString(parsed?.tmux?.socketName, `spur-${serverPort}`);
  const uiPort = readNumber(parsed?.ui?.port, 5555);
  return {
    configPath,
    daemonUrl: `http://${serverHost}:${serverPort}`,
    tmuxSocketName,
    uiPort,
  };
}
