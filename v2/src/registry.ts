import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, loadProjectConfig } from "./config.js";
import type { AppConfig, ProjectConfig } from "./types.js";

const REGISTRY_FILE = "config-registry.json";

interface ConfigRegistryFile {
  configPaths: string[];
}

interface MergeOptions {
  skipInvalid?: boolean;
  warn?: (message: string) => void;
}

function registryPath(dataDir: string): string {
  return join(dataDir, REGISTRY_FILE);
}

function normalizeConfigPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

function materializeProjectDefaults(config: AppConfig): AppConfig {
  const projects: Record<string, ProjectConfig> = {};
  for (const [projectId, project] of Object.entries(config.projects)) {
    projects[projectId] = {
      ...project,
      defaultAgent: project.defaultAgent ?? config.defaultAgent,
    };
  }
  return {
    ...config,
    projects,
  };
}

function mergeProjects(base: AppConfig, configs: AppConfig[]): AppConfig {
  const projects: Record<string, ProjectConfig> = {};
  const projectOwners = new Map<string, string>();
  const prefixOwners = new Map<string, string>();

  for (const config of configs) {
    for (const [projectId, project] of Object.entries(config.projects)) {
      const existingProjectOwner = projectOwners.get(projectId);
      if (existingProjectOwner) {
        throw new Error(
          `Project "${projectId}" is duplicated in ${existingProjectOwner} and ${config.configPath}`,
        );
      }
      const existingPrefixOwner = prefixOwners.get(project.sessionPrefix);
      if (existingPrefixOwner) {
        throw new Error(
          `sessionPrefix "${project.sessionPrefix}" is duplicated in ${existingPrefixOwner} and ${config.configPath}`,
        );
      }
      projectOwners.set(projectId, config.configPath);
      prefixOwners.set(project.sessionPrefix, config.configPath);
      projects[projectId] = project;
    }
  }

  return {
    ...base,
    projects,
  };
}

export function readConfigRegistry(dataDir: string): string[] {
  const path = registryPath(dataDir);
  if (!existsSync(path)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ConfigRegistryFile>;
  const normalized = Array.isArray(parsed.configPaths)
    ? normalizeConfigPaths(
        parsed.configPaths.filter((value): value is string => typeof value === "string"),
      )
    : [];
  const filtered = normalized.filter((configPath) => existsSync(configPath));
  if (filtered.length !== normalized.length) {
    writeConfigRegistry(dataDir, filtered);
  }
  return filtered;
}

export function writeConfigRegistry(dataDir: string, configPaths: string[]): void {
  writeJsonFile(registryPath(dataDir), {
    configPaths: normalizeConfigPaths(configPaths),
  } satisfies ConfigRegistryFile);
}

export function upsertConfigRegistryPath(dataDir: string, configPath: string): string[] {
  const next = normalizeConfigPaths([...readConfigRegistry(dataDir), configPath]);
  writeConfigRegistry(dataDir, next);
  return next;
}

export function removeConfigRegistryPath(dataDir: string, configPath: string): string[] {
  const next = normalizeConfigPaths(
    readConfigRegistry(dataDir).filter((registeredPath) => registeredPath !== configPath),
  );
  writeConfigRegistry(dataDir, next);
  return next;
}

export function buildMergedConfig(
  bootstrapConfigPath: string | undefined,
  configPaths: string[],
  options: MergeOptions = {},
): { config: AppConfig; configPaths: string[] } {
  const base = materializeProjectDefaults(loadConfig(bootstrapConfigPath));
  const mergedConfigs = [base];
  const normalizedPaths = normalizeConfigPaths([base.configPath, ...configPaths]);

  for (const path of normalizedPaths) {
    if (path === base.configPath) {
      continue;
    }
    try {
      const candidate = materializeProjectDefaults(loadProjectConfig(path, base));
      mergeProjects(base, [...mergedConfigs, candidate]);
      mergedConfigs.push(candidate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.skipInvalid) {
        throw error;
      }
      options.warn?.(`Skipping registered config ${path}: ${message}`);
    }
  }

  return {
    config: mergeProjects(base, mergedConfigs),
    configPaths: normalizedPaths,
  };
}
