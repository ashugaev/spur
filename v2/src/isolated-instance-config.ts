import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUserYaml(userConfigPath: string): string | null {
  try {
    return readFileSync(userConfigPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as Record<string, unknown>).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function parseUserDocument(userYaml: string, userConfigPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(userYaml);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse user config at ${userConfigPath}: ${message}`, {
      cause: error,
    });
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isMapping(parsed)) {
    throw new Error(`User config root must be a mapping at ${userConfigPath}`);
  }
  return parsed;
}

function resolveVoiceModelPath(
  voice: Record<string, unknown>,
  userConfigDir: string,
): Record<string, unknown> {
  const modelPath = voice.modelPath;
  if (typeof modelPath !== "string" || modelPath.length === 0 || isAbsolute(modelPath)) {
    return voice;
  }
  return { ...voice, modelPath: resolve(userConfigDir, modelPath) };
}

function resolveModelsCodexHome(
  models: Record<string, unknown>,
  userConfigDir: string,
): Record<string, unknown> {
  const codexHome = models.codexHome;
  if (
    typeof codexHome !== "string" ||
    codexHome.length === 0 ||
    codexHome.startsWith("~/") ||
    isAbsolute(codexHome)
  ) {
    return models;
  }
  return { ...models, codexHome: resolve(userConfigDir, codexHome) };
}

export function buildIsolatedInstanceConfig(args: {
  baseYaml: string;
  userYaml: string | null;
  userConfigDir: string;
  userConfigPath: string;
}): string {
  const baseParsed = parseYaml(args.baseYaml) as unknown;
  const baseDoc: Record<string, unknown> = isMapping(baseParsed) ? baseParsed : {};

  if (args.userYaml === null) {
    return stringifyYaml(baseDoc);
  }

  const userDoc = parseUserDocument(args.userYaml, args.userConfigPath);

  const merged: Record<string, unknown> = { ...baseDoc };
  const voice = userDoc.voice;
  if (voice !== undefined) {
    merged.voice = isMapping(voice) ? resolveVoiceModelPath(voice, args.userConfigDir) : voice;
  }
  const models = userDoc.models;
  if (models !== undefined) {
    merged.models = isMapping(models) ? resolveModelsCodexHome(models, args.userConfigDir) : models;
  }
  return stringifyYaml(merged);
}

export function writeIsolatedInstanceConfig(args: {
  userConfigPath: string;
  basePath: string;
  outputPath: string;
}): void {
  const baseYaml = readFileSync(args.basePath, "utf8");
  const userYaml = readUserYaml(args.userConfigPath);
  const userConfigDir = dirname(args.userConfigPath);
  const output = buildIsolatedInstanceConfig({
    baseYaml,
    userYaml,
    userConfigDir,
    userConfigPath: args.userConfigPath,
  });
  writeFileSync(args.outputPath, output, "utf8");
}
