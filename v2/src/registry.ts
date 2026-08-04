import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig, loadProjectConfig } from "./config.js";
import type { AppConfig, ProjectConfig } from "./types.js";

const REGISTRY_FILE = "config-registry.json";

export interface UnconfiguredProjectEntry {
  id: string;
  displayName?: string;
  prefix: string;
  path: string;
}

export interface ConfigRegistryFile {
  configPaths: string[];
  unconfiguredProjects: UnconfiguredProjectEntry[];
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

function normalizeUnconfiguredProjects(entries: unknown[]): UnconfiguredProjectEntry[] {
  const seen = new Set<string>();
  const normalized: UnconfiguredProjectEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<UnconfiguredProjectEntry>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const prefix = typeof entry.prefix === "string" ? entry.prefix.trim() : "";
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!id || !prefix || !path || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof entry.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : undefined;
    normalized.push({
      id,
      ...(displayName !== undefined ? { displayName } : {}),
      prefix,
      path,
    });
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

// Comparison/dedupe key only — never stored. Falls back to the resolved
// (non-realpath'd) path when the file does not exist, so a dead or
// not-yet-created path still gets a stable key.
export function canonicalConfigKey(configPath: string): string {
  const resolved = resolve(configPath.trim());
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Separator-terminated containment: `<worktreeDir>-backup/spur.yaml` shares
// the worktreeDir string prefix but is not inside it.
export function isInsideWorktreeDir(configPath: string, worktreeDir: string): boolean {
  const key = canonicalConfigKey(configPath);
  const wt = canonicalConfigKey(worktreeDir);
  return key === wt || key.startsWith(wt + sep);
}

function isMissingErrno(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

// "file": exists and is a regular file. "absent": confirmed unusable — a
// directory, or a definitive ENOENT/ENOTDIR. "unknown": any other stat
// failure (EACCES, EIO, ELOOP, an autofs mount not yet up, ...) — existence
// could not be determined, so it must not be treated the same as "gone".
function statOutcome(path: string): "file" | "absent" | "unknown" {
  try {
    return statSync(path).isFile() ? "file" : "absent";
  } catch (error) {
    return isMissingErrno(error) ? "absent" : "unknown";
  }
}

// Shared existing-file check for read-only/in-memory filtering (doctor's
// report, previews, CLI reads). Treating an "unknown" stat failure the same
// as "missing" only skips the path for this round — nothing is persisted.
export function isExistingFile(path: string): boolean {
  return statOutcome(path) === "file";
}

// Pure, read-only filter: drops blank entries, entries that are not an
// existing FILE (a nonexistent path or a directory, e.g. a bare project dir
// `existsSync` would keep but `parseConfigFile` would only reject later),
// and entries inside `worktreeDir`. Dedupes by `canonicalConfigKey`, keeping
// the original string in first-seen order. Never touches the filesystem for
// writes.
//
// `persistedPrune`: set only by the boot path, whose result is written back
// to the registry file. There, a stat failure with an "unknown" outcome (see
// `statOutcome`) is NOT dropped — a transient EACCES/EIO/ELOOP, or an autofs
// mount not yet up when the daemon starts, must not permanently unregister a
// live project. Read-only callers (previews, CLI) leave this off and keep
// the strict any-failure-means-drop behavior, since nothing they compute is
// persisted.
export function activeConfigPaths(
  paths: string[],
  worktreeDir: string,
  options: { persistedPrune?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const active: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const outcome = statOutcome(trimmed);
    if (outcome === "absent") continue;
    if (outcome === "unknown" && !options.persistedPrune) continue;
    if (isInsideWorktreeDir(trimmed, worktreeDir)) continue;
    const key = canonicalConfigKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    active.push(trimmed);
  }
  return active;
}

export function readConfigRegistryFile(dataDir: string): ConfigRegistryFile {
  const path = registryPath(dataDir);
  if (!existsSync(path)) {
    return { configPaths: [], unconfiguredProjects: [] };
  }

  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    // Treat unreadable/invalid registry as empty; callers rewrite on next mutation.
  }

  const rawConfigPaths = parsed["configPaths"];
  const rawUnconfigured = parsed["unconfiguredProjects"];
  return {
    configPaths: Array.isArray(rawConfigPaths)
      ? normalizeConfigPaths(
          rawConfigPaths.filter((value): value is string => typeof value === "string"),
        )
      : [],
    unconfiguredProjects: Array.isArray(rawUnconfigured)
      ? normalizeUnconfiguredProjects(rawUnconfigured)
      : [],
  };
}

export function writeConfigRegistryFile(dataDir: string, file: ConfigRegistryFile): void {
  writeJsonFile(registryPath(dataDir), {
    configPaths: normalizeConfigPaths(file.configPaths),
    unconfiguredProjects: normalizeUnconfiguredProjects(file.unconfiguredProjects),
  } satisfies ConfigRegistryFile);
}

export function writeConfigRegistry(dataDir: string, configPaths: string[]): void {
  mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    configPaths,
  }));
}

export function mutateConfigRegistry(
  dataDir: string,
  mutate: (current: ConfigRegistryFile) => ConfigRegistryFile,
): ConfigRegistryFile {
  const current = readConfigRegistryFile(dataDir);
  const next = mutate(current);
  writeConfigRegistryFile(dataDir, next);
  return {
    configPaths: normalizeConfigPaths(next.configPaths),
    unconfiguredProjects: normalizeUnconfiguredProjects(next.unconfiguredProjects),
  };
}

export function upsertConfigRegistryPath(dataDir: string, configPath: string): string[] {
  const next = mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    configPaths: [...current.configPaths, configPath],
  }));
  return next.configPaths;
}

export function removeConfigRegistryPath(dataDir: string, configPath: string): string[] {
  const targetKey = canonicalConfigKey(configPath);
  const next = mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    configPaths: current.configPaths.filter(
      (registeredPath) => canonicalConfigKey(registeredPath) !== targetKey,
    ),
  }));
  return next.configPaths;
}

export function addUnconfiguredProject(
  dataDir: string,
  entry: UnconfiguredProjectEntry,
): UnconfiguredProjectEntry[] {
  const next = mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    unconfiguredProjects: [
      ...current.unconfiguredProjects.filter((existing) => existing.id !== entry.id),
      entry,
    ],
  }));
  return next.unconfiguredProjects;
}

export function removeUnconfiguredProject(dataDir: string, id: string): UnconfiguredProjectEntry[] {
  const next = mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    unconfiguredProjects: current.unconfiguredProjects.filter((existing) => existing.id !== id),
  }));
  return next.unconfiguredProjects;
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
