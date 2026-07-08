import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SPUR_ENV_PATH = join(homedir(), ".spur", ".env");
export const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function assertValidEnvVarName(name: string, label: string): void {
  if (!ENV_VAR_NAME_RE.test(name)) {
    throw new Error(`${label} must match ${ENV_VAR_NAME_RE} (received "${name}")`);
  }
}

export function parseEnvFile(content: string): Record<string, string> {
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

export function readSpurEnv(path: string = DEFAULT_SPUR_ENV_PATH): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function resolveEnvSecret(
  name: string,
  fileSecrets: Record<string, string> = readSpurEnv(),
): string | undefined {
  const fileValue = fileSecrets[name]?.trim();
  if (fileValue) {
    return fileValue;
  }
  const envValue = process.env[name]?.trim();
  if (envValue) {
    return envValue;
  }
  return undefined;
}
