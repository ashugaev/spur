import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandHome, loadConfig, loadProjectConfig } from "./config.js";
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

export interface RegistryDiagnostic {
  configPath: string;
  message: string;
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

export function readConfigRegistry(dataDir: string): string[] {
  const configPaths = readConfigRegistryFile(dataDir).configPaths;
  const filtered = configPaths.filter((configPath) => existsSync(configPath));
  if (filtered.length !== configPaths.length) {
    writeConfigRegistry(dataDir, filtered);
  }
  return filtered;
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
  const next = mutateConfigRegistry(dataDir, (current) => ({
    ...current,
    configPaths: current.configPaths.filter((registeredPath) => registeredPath !== configPath),
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

export interface RegistryScanOptions {
  bootstrapConfigPath: string | undefined;
  configPaths: string[];
  protectedPaths: string[];
}

export interface RegistryScanResult {
  config: AppConfig;
  configPaths: string[];
  newDiagnostics: RegistryDiagnostic[];
}

type FileStamp = { mtimeMs: number; size: number };
type ParentState = { kind: "present"; mtimeMs: number } | { kind: "enoent" } | { kind: "error" };
type PathLoad =
  | { kind: "loaded"; stamp: FileStamp; config: AppConfig }
  | { kind: "invalid"; stamp: FileStamp; diagnostic: RegistryDiagnostic }
  | {
      kind: "missing";
      parentPath: string;
      parentState: ParentState;
      diagnostic: RegistryDiagnostic;
    };

interface RegistryScannerFs {
  stat(path: string): FileStamp;
  realpath(path: string): string;
}

const scannerFs: RegistryScannerFs = {
  stat: (path) => {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  },
  realpath: (path) => realpathSync(path),
};

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export class ConfigRegistryScanner {
  private readonly loads = new Map<string, PathLoad>();
  private readonly canonicalPaths = new Map<string, string>();
  private readonly reported = new Set<string>();
  private bootstrapStamp: FileStamp | undefined;

  constructor(private readonly fs: RegistryScannerFs = scannerFs) {}

  canonicalizePath(input: string): string {
    const absolutePath = resolve(process.cwd(), expandHome(input.trim()));
    const cached = this.canonicalPaths.get(absolutePath);
    if (cached) return cached;

    const canonicalPath = this.resolveCanonicalPath(absolutePath);
    this.canonicalPaths.set(absolutePath, canonicalPath);
    return canonicalPath;
  }

  scan(options: RegistryScanOptions): RegistryScanResult {
    const parentStates = new Map<string, ParentState>();
    const newDiagnostics: RegistryDiagnostic[] = [];
    const bootstrapPath = this.canonicalizePath(
      options.bootstrapConfigPath ?? loadConfig(undefined).configPath,
    );
    const protectedPaths = new Set(
      [bootstrapPath, ...options.protectedPaths].map((path) => this.canonicalizePath(path)),
    );
    const baseLoad = this.loadPath(bootstrapPath, undefined, parentStates);
    if (baseLoad.kind !== "loaded") {
      throw new Error(baseLoad.diagnostic.message);
    }

    if (this.bootstrapStamp && !sameStamp(this.bootstrapStamp, baseLoad.stamp)) {
      this.loads.clear();
      this.loads.set(bootstrapPath, baseLoad);
    }
    this.bootstrapStamp = baseLoad.stamp;

    const base = baseLoad.config;
    const mergedConfigs = [base];
    const keptPaths = [bootstrapPath];
    const seen = new Set(keptPaths);

    for (const inputPath of normalizeConfigPaths(options.configPaths)) {
      let canonicalPath = this.canonicalizePath(inputPath);
      let cached = this.loads.get(canonicalPath);
      if (cached?.kind === "missing") {
        const parentState = this.statParent(cached.parentPath, parentStates);
        if (!this.sameParentState(cached.parentState, parentState)) {
          this.canonicalPaths.delete(resolve(process.cwd(), expandHome(inputPath.trim())));
          canonicalPath = this.canonicalizePath(inputPath);
          cached = this.loads.get(canonicalPath);
        }
      }
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);

      const load =
        cached?.kind === "missing" &&
        this.sameParentState(cached.parentState, this.statParent(cached.parentPath, parentStates))
          ? cached
          : this.loadPath(canonicalPath, base, parentStates);

      if (load.kind === "missing" && load.parentState.kind === "enoent") {
        this.loads.delete(canonicalPath);
        if (!protectedPaths.has(canonicalPath)) {
          for (const [rawPath, cachedCanonicalPath] of this.canonicalPaths) {
            if (cachedCanonicalPath === canonicalPath) this.canonicalPaths.delete(rawPath);
          }
          continue;
        }
      }

      keptPaths.push(canonicalPath);
      if (load.kind !== "loaded") {
        this.reportOnce(load.diagnostic, newDiagnostics);
        continue;
      }

      try {
        mergeProjects(base, [...mergedConfigs, load.config]);
        mergedConfigs.push(load.config);
      } catch (error) {
        this.reportOnce(
          {
            configPath: canonicalPath,
            message: `Skipping registered config ${canonicalPath}: ${error instanceof Error ? error.message : String(error)}`,
          },
          newDiagnostics,
        );
      }
    }

    return {
      config: mergeProjects(base, mergedConfigs),
      configPaths: keptPaths,
      newDiagnostics,
    };
  }

  private loadPath(
    path: string,
    base: AppConfig | undefined,
    parentStates: Map<string, ParentState>,
  ): PathLoad {
    let stamp: FileStamp;
    try {
      stamp = this.fs.stat(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return {
          kind: "missing",
          parentPath: dirname(path),
          parentState: { kind: "error" },
          diagnostic: this.diagnostic(path, error),
        };
      }
      const parentPath = dirname(path);
      const parentState = this.statParent(parentPath, parentStates);
      const missing: PathLoad = {
        kind: "missing",
        parentPath,
        parentState,
        diagnostic: this.diagnostic(path, new Error(`Config file not found: ${path}`)),
      };
      if (parentState.kind === "present") this.loads.set(path, missing);
      return missing;
    }

    const cached = this.loads.get(path);
    if (cached && cached.kind !== "missing" && sameStamp(cached.stamp, stamp)) return cached;

    try {
      const config = materializeProjectDefaults(
        base ? loadProjectConfig(path, base) : loadConfig(path),
      );
      const loaded: PathLoad = { kind: "loaded", stamp, config };
      this.loads.set(path, loaded);
      return loaded;
    } catch (error) {
      const invalid: PathLoad = {
        kind: "invalid",
        stamp,
        diagnostic: this.diagnostic(path, error),
      };
      this.loads.set(path, invalid);
      return invalid;
    }
  }

  private resolveCanonicalPath(path: string): string {
    let current = path;
    const unresolved: string[] = [];
    for (;;) {
      try {
        return join(this.fs.realpath(current), ...unresolved.reverse());
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return path;
        const parent = dirname(current);
        if (parent === current) return path;
        unresolved.push(basename(current));
        current = parent;
      }
    }
  }

  private statParent(path: string, states: Map<string, ParentState>): ParentState {
    const cached = states.get(path);
    if (cached) return cached;
    let state: ParentState;
    try {
      state = { kind: "present", mtimeMs: this.fs.stat(path).mtimeMs };
    } catch (error) {
      state = errorCode(error) === "ENOENT" ? { kind: "enoent" } : { kind: "error" };
    }
    states.set(path, state);
    return state;
  }

  private sameParentState(left: ParentState, right: ParentState): boolean {
    return left.kind === "present" && right.kind === "present" && left.mtimeMs === right.mtimeMs;
  }

  private diagnostic(path: string, error: unknown): RegistryDiagnostic {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configPath: path,
      message: `Skipping registered config ${path}: ${message}`,
    };
  }

  private reportOnce(diagnostic: RegistryDiagnostic, into: RegistryDiagnostic[]): void {
    if (this.reported.has(diagnostic.configPath)) return;
    this.reported.add(diagnostic.configPath);
    into.push(diagnostic);
  }
}
