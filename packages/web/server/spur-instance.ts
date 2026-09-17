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
  // Under SPUR_WEB_TEST_ISOLATION the harness config must be what resolved
  // here; landing on the production config means tmux-utils would attach the
  // real spur-4310 socket and the UI would answer for the production instance.
  // Refused before the read, so an isolated run never even parses that file.
  if (process.env["SPUR_WEB_TEST_ISOLATION"] && configPath === DEFAULT_CONFIG_PATH) {
    throw new Error(
      `Test isolation: Spur instance config fell back to the production default (${configPath})`,
    );
  }
  const parsed = existsSync(configPath)
    ? (YAML.parse(readFileSync(configPath, "utf8")) as SpurInstanceShape | null)
    : null;
  const serverHost = readString(parsed?.server?.host, "127.0.0.1");
  const serverPort = readNumber(parsed?.server?.port, 4310);
  const tmuxSocketName = readString(parsed?.tmux?.socketName, `spur-${serverPort}`);
  // Mirrors DEFAULT_UI_PORT in v2/src/ports.ts (no cross-package import).
  const uiPort = readNumber(parsed?.ui?.port, 5555);
  // A config that parsed but still names a production port is the same hole.
  if (process.env["SPUR_WEB_TEST_ISOLATION"] && (serverPort === 4310 || uiPort === 5555)) {
    throw new Error(
      `Test isolation: Spur instance config resolved to a production port (daemon ${serverPort}, ui ${uiPort})`,
    );
  }
  return {
    configPath,
    daemonUrl: `http://${serverHost}:${serverPort}`,
    tmuxSocketName,
    uiPort,
  };
}
