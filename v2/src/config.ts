import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GITHUB_CI_RUN_COMPLETED_EVENT,
  GITHUB_PR_LIFECYCLE_KINDS,
  SENTRY_ISSUE_NEW_EVENT,
  TELEGRAM_MESSAGE_EVENT,
  WORK_ITEM_NEW_EVENT_NAMES,
  REVIEW_SIGNAL_KINDS as VALID_REVIEW_SIGNAL_KINDS,
  type AdmissionCapSource,
  type AdmissionConfig,
  type AgentReasoningEffortConfig,
  type AgentName,
  type AppConfig,
  type BacklogConfig,
  type CronSourceConfig,
  type GitHubCiSourceConfig,
  type GitHubAdaptivePollConfig,
  type GitHubSourceConfig,
  type GitLabSourceConfig,
  type JiraSourceConfig,
  type ProjectBranchNamingConfig,
  type ProjectConfig,
  type ProjectPreflightConfig,
  type ProjectSpawnConfig,
  type ReviewProviderId,
  type SelfDestructConfig,
  type SentrySourceConfig,
  type WorkspaceAccessItemConfig,
  type WorkspaceAccessConfig,
  type SendTriggerConfig,
  type ServiceRuleConfig,
  type ServiceSourceConfig,
  type SidecarConfig,
  type SourceConfig,
  type TagDefinition,
  type TelegramSourceConfig,
  type TriggerSpawnConfig,
  type TriggerSpawnBlockConfig,
  type TriggerConfig,
} from "./types.js";
import {
  DEFAULT_EVENT_LOG_COLLAPSE_WINDOW_MS,
  DEFAULT_EVENT_LOG_CONFIG,
  DEFAULT_EVENT_LOG_HOT_BYTES,
  DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
  DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
} from "./event-log.js";
import {
  DEFAULT_USER_ACTION_LOG_CONFIG,
  DEFAULT_USER_ACTION_LOG_HOT_BYTES,
  DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES,
  DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES,
} from "./user-action-log.js";
import { DEFAULT_UI_PORT } from "./ports.js";
import { DEFAULT_PROJECT_PREFLIGHT_PROMPT } from "./preflight-contract.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";
import { SLOT_LABEL_RE } from "./session-slots.js";
import { assertBranchNameMatches, compileBranchNamingRegex } from "./branch-name.js";
import { normalizeSelfDestructConfig } from "./self-destruct.js";
import { BUILTIN_SIDECARS } from "./sidecars/builtins.js";

export const DEFAULT_PROJECT_CONFIG_FILES = ["spur.yaml", "spur.yml"] as const;
const DEFAULT_INSTANCE_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 4310;
const DEFAULT_DATA_DIR = "~/.spur";
const DEFAULT_WORKTREE_DIR = "~/.spur/worktrees";
const DEFAULT_VOICE_MODEL_PATH = "~/.cache/whisper.cpp/ggml-base.bin";
const DEFAULT_VOICE_PROVIDER = "whisper_cpp";
const DEFAULT_VOICE_LANGUAGE = "auto";
const DEFAULT_VOICE_MODEL = "base";
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ENV_NAME_RE = /\b([A-Z_][A-Z0-9_]*)\b/g;
const VALID_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PROJECT_ENV_FILE = ".env";
const MISSING_ENV_SENTINEL = "__SPUR_MISSING_ENV__";

type ConfigMode = "instance" | "project";

interface ConfigDefaults {
  serverHost: string;
  serverPort: number;
  dataDir: string;
  worktreeDir: string;
  defaultAgent: AgentName;
  tmuxSocketName: string;
  uiPort: number;
  codexHome: string;
  voiceProvider:
    | "whisper_cpp"
    | "faster_whisper"
    | "azure_openai"
    | "openai_compatible"
    | "openai_realtime";
  voiceModelPath?: string;
  voiceLanguage: string;
  voiceModel: string;
  voiceBaseUrl?: string;
  voiceApiKey?: string;
  voiceEndpoint?: string;
  voiceApiVersion?: string;
}

export interface ProjectConfigScaffold {
  configPath: string;
  content: string;
  defaultBranch: string;
  projectId: string;
  sessionPrefix: string;
}

const projectEnvCache = new Map<string, Record<string, string>>();

export function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveFrom(baseDir: string, value: string): string {
  const expanded = expandHome(value);
  return expanded.startsWith("/") ? expanded : resolve(baseDir, expanded);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asUrlString(value: unknown, label: string): string {
  const text = asString(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return url.toString();
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asOptionalArray<T>(
  value: unknown,
  label: string,
  itemLabel: string,
  parse: (entry: unknown, label: string) => T,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of ${itemLabel}`);
  }
  return value.map((entry, index) => parse(entry, `${label}[${index}]`));
}

function asOptionalStringArray(value: unknown, label: string): string[] | undefined {
  return asOptionalArray(value, label, "strings", asString);
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

// Used for ratio fields (e.g. admission.reserveFraction) that scale a byte
// count: zero would derive a cap of always-zero, above 1 would reserve more
// than the host has.
function asOptionalFraction(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} must be a positive number no greater than 1`);
  }
  return value;
}

function asOptionalPercent(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100`);
  }
  return value;
}

// Used for values consumed as loop bounds / archive indices, where a fractional value
// would produce unreadable, never-cleaned-up filenames (e.g. `...jsonl.2.5.gz`).
function asOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function asOptionalIntegerArray(value: unknown, label: string): number[] | undefined {
  const values = asOptionalArray(value, label, "integers", (entry, entryLabel) => {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw new Error(`${entryLabel} must be an integer`);
    }
    return entry;
  });
  if (values === undefined) return undefined;
  if (values.length === 0) {
    throw new Error(`${label} must include at least one integer`);
  }
  return values;
}

function asNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function asPortNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function asOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function asOptionalAgent(value: unknown, label: string): AgentName | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "codex" || value === "cursor") {
    return value;
  }
  throw new Error(`${label} must be "claude", "codex", or "cursor"`);
}

function parseDefaultModels(
  value: unknown,
  label: string,
): Partial<Record<AgentName, string>> | undefined {
  if (value === undefined) return undefined;
  const raw = asObject(value, `${label}.defaultModels`);
  const models: Partial<Record<AgentName, string>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (key !== "claude" && key !== "codex" && key !== "cursor") {
      throw new Error(`${label}.defaultModels has unknown agent "${key}"`);
    }
    models[key] = asString(entry, `${label}.defaultModels.${key}`);
  }
  return models;
}

function parseProjectReasoningEffort(
  projectId: string,
  value: unknown,
): AgentReasoningEffortConfig | undefined {
  if (value === undefined) return undefined;
  const raw = asObject(value, `projects.${projectId}.reasoningEffort`);
  const effort: AgentReasoningEffortConfig = {};
  for (const [agent, entry] of Object.entries(raw)) {
    if (agent !== "claude" && agent !== "codex") {
      throw new Error(`projects.${projectId}.reasoningEffort has unknown agent "${agent}"`);
    }
    if (entry !== "low" && entry !== "medium" && entry !== "high") {
      throw new Error(
        `projects.${projectId}.reasoningEffort.${agent} must be "low", "medium", or "high"`,
      );
    }
    effort[agent] = entry;
  }
  return effort;
}

function parseTriggerSpawnBlock(
  raw: Record<string, unknown>,
  label: string,
): TriggerSpawnBlockConfig {
  if (raw["agents"] !== undefined) {
    throw new Error(`${label}.agents is not supported; use flat spawn blocks`);
  }
  const prompt = asString(raw["prompt"], `${label}.prompt`);
  const steps = asOptionalStringArray(raw["steps"], `${label}.steps`);
  const agent = asOptionalAgent(raw["agent"], `${label}.agent`);
  const model = asOptionalString(raw["model"], `${label}.model`);
  if (model !== undefined && agent === undefined) {
    throw new Error(`${label}.model requires ${label}.agent`);
  }
  const branch = asOptionalString(raw["branch"], `${label}.branch`);
  const overrides = parseSpawnOverrides(raw["overrides"], `${label}.overrides`);
  let selfDestruct: SelfDestructConfig | undefined;
  try {
    selfDestruct = normalizeSelfDestructConfig(raw["selfDestruct"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}.${message}`, { cause: error });
  }

  return {
    prompt,
    ...(steps !== undefined ? { steps } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
    ...(selfDestruct !== undefined ? { selfDestruct } : {}),
  };
}

function parseTriggerSpawn(value: unknown, label: string): TriggerSpawnConfig {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`${label} must be a non-empty array of spawn blocks`);
    }
    return {
      blocks: value.map((entry, index) => {
        const block = asObject(entry, `${label}[${index}]`);
        return parseTriggerSpawnBlock(block, `${label}[${index}]`);
      }),
    };
  }

  const raw = asObject(value, label);
  if (raw["autoClose"] !== undefined) {
    throw new Error(`${label}.autoClose is not supported; use autoComplete: true`);
  }
  if (raw["deskGroup"] !== undefined) {
    throw new Error(`${label}.deskGroup is not supported; use trigger-level spawnDeskGroup`);
  }
  const autoComplete = asOptionalBoolean(raw["autoComplete"], `${label}.autoComplete`);
  const restrictWrites = asOptionalBoolean(raw["restrictWrites"], `${label}.restrictWrites`);
  const allowedTriggers = asOptionalStringArray(raw["allowedTriggers"], `${label}.allowedTriggers`);

  if (raw["blocks"] !== undefined) {
    for (const field of [
      "prompt",
      "steps",
      "agent",
      "model",
      "branch",
      "overrides",
      "selfDestruct",
    ]) {
      if (raw[field] !== undefined) {
        throw new Error(`${label}: put per-block fields inside blocks[]`);
      }
    }
    if (!Array.isArray(raw["blocks"]) || raw["blocks"].length === 0) {
      throw new Error(`${label}.blocks must be a non-empty array of spawn blocks`);
    }
    if (autoComplete !== undefined && raw["blocks"].length > 1) {
      throw new Error(`${label}.autoComplete is not supported with multiple spawn blocks`);
    }
    return {
      blocks: raw["blocks"].map((entry, index) => {
        const block = asObject(entry, `${label}.blocks[${index}]`);
        return parseTriggerSpawnBlock(block, `${label}.blocks[${index}]`);
      }),
      ...(autoComplete !== undefined ? { autoComplete } : {}),
      ...(restrictWrites !== undefined ? { restrictWrites } : {}),
      ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
    };
  }

  return {
    blocks: [parseTriggerSpawnBlock(raw, label)],
    ...(autoComplete !== undefined ? { autoComplete } : {}),
    ...(restrictWrites !== undefined ? { restrictWrites } : {}),
    ...(allowedTriggers !== undefined ? { allowedTriggers } : {}),
  };
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

function readProjectEnv(projectPath: string): Record<string, string> {
  const cached = projectEnvCache.get(projectPath);
  if (cached) {
    return cached;
  }
  const envPath = join(projectPath, PROJECT_ENV_FILE);
  if (!existsSync(envPath)) {
    projectEnvCache.set(projectPath, {});
    return {};
  }
  try {
    const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
    projectEnvCache.set(projectPath, parsed);
    return parsed;
  } catch {
    projectEnvCache.set(projectPath, {});
    return {};
  }
}

function readEnvValue(name: string, projectEnv: Record<string, string>): string | undefined {
  const processValue = process.env[name]?.trim();
  if (processValue) {
    return processValue;
  }
  const projectValue = projectEnv[name]?.trim();
  return projectValue || undefined;
}

function isEmbeddedInPathSegment(source: string, offset: number): boolean {
  const prefix = source.slice(0, offset);
  const segmentStart = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\t")) + 1;
  return offset > segmentStart && prefix.slice(segmentStart).includes("/");
}

function resolveEnvVars(raw: string, projectEnv: Record<string, string>): string | undefined {
  const withBracedVars = raw.replace(ENV_VAR_RE, (_, name: string) => {
    const value = readEnvValue(name, projectEnv);
    return value ?? MISSING_ENV_SENTINEL;
  });
  if (withBracedVars.includes(MISSING_ENV_SENTINEL)) {
    return undefined;
  }
  const resolved = withBracedVars.replace(ENV_NAME_RE, (token, name: string, offset: number) => {
    if (isEmbeddedInPathSegment(withBracedVars, offset)) {
      return token;
    }
    const value = readEnvValue(name, projectEnv);
    return value ?? `${MISSING_ENV_SENTINEL}:${token}`;
  });
  return resolved.includes(MISSING_ENV_SENTINEL) ? undefined : resolved;
}

function resolveOptionalUrl(
  raw: string,
  label: string,
  projectEnv: Record<string, string>,
): string | undefined {
  const resolved = resolveEnvVars(raw, projectEnv);
  if (resolved === undefined) {
    return undefined;
  }
  return asUrlString(resolved, label);
}

function resolveOptionalTemplate(
  raw: string,
  projectEnv: Record<string, string>,
): string | undefined {
  return resolveEnvVars(raw, projectEnv);
}

function defaultTmuxSocketName(port: number): string {
  return `spur-${port}`;
}

function defaultConfigDefaults(configDir: string): ConfigDefaults {
  return {
    serverHost: DEFAULT_SERVER_HOST,
    serverPort: DEFAULT_SERVER_PORT,
    dataDir: resolveFrom(configDir, DEFAULT_DATA_DIR),
    worktreeDir: resolveFrom(configDir, DEFAULT_WORKTREE_DIR),
    defaultAgent: "claude",
    tmuxSocketName: defaultTmuxSocketName(DEFAULT_SERVER_PORT),
    uiPort: DEFAULT_UI_PORT,
    codexHome: join(homedir(), ".codex"),
    voiceProvider: DEFAULT_VOICE_PROVIDER,
    voiceModelPath: resolveFrom(configDir, DEFAULT_VOICE_MODEL_PATH),
    voiceLanguage: DEFAULT_VOICE_LANGUAGE,
    voiceModel: DEFAULT_VOICE_MODEL,
  };
}

function defaultInstanceConfigYaml(): string {
  return [
    "server:",
    `  host: ${DEFAULT_SERVER_HOST}`,
    `  port: ${DEFAULT_SERVER_PORT}`,
    "",
    `dataDir: ${DEFAULT_DATA_DIR}`,
    `worktreeDir: ${DEFAULT_WORKTREE_DIR}`,
    "defaultAgent: claude",
    "",
    "tmux:",
    `  socketName: ${defaultTmuxSocketName(DEFAULT_SERVER_PORT)}`,
    "",
    "ui:",
    `  port: ${DEFAULT_UI_PORT}`,
    "",
    "voice:",
    `  provider: ${DEFAULT_VOICE_PROVIDER}`,
    `  language: ${DEFAULT_VOICE_LANGUAGE}`,
    `  model: ${DEFAULT_VOICE_MODEL}`,
    "",
  ].join("\n");
}

function deriveScaffoldId(repoPath: string): string {
  return sanitizeProjectId(basename(resolve(repoPath)));
}

function sanitizeProjectId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return sanitized || "project";
}

export function deriveProjectIdFromDisplayName(displayName: string): string {
  return sanitizeProjectId(displayName);
}

export const PROJECT_ID_PATTERN = VALID_ID_RE;

export function createProjectConfigScaffold(
  startDir: string,
  defaultBranch: string,
): ProjectConfigScaffold {
  const repoPath = resolve(startDir);
  const projectId = deriveScaffoldId(repoPath);
  return {
    configPath: join(repoPath, DEFAULT_PROJECT_CONFIG_FILES[0]),
    content: [
      "projects:",
      `  ${projectId}:`,
      "    path: .",
      `    defaultBranch: ${defaultBranch}`,
      `    sessionPrefix: ${projectId}`,
      "",
    ].join("\n"),
    defaultBranch,
    projectId,
    sessionPrefix: projectId,
  };
}

export function writeProjectConfigScaffold(scaffold: ProjectConfigScaffold): void {
  mkdirSync(dirname(scaffold.configPath), { recursive: true });
  writeFileSync(scaffold.configPath, scaffold.content, "utf8");
}

function asOptionalVoiceProvider(
  value: unknown,
  label: string,
):
  | "whisper_cpp"
  | "faster_whisper"
  | "azure_openai"
  | "openai_compatible"
  | "openai_realtime"
  | undefined {
  if (value === undefined) return undefined;
  if (
    value === "whisper_cpp" ||
    value === "faster_whisper" ||
    value === "azure_openai" ||
    value === "openai_compatible" ||
    value === "openai_realtime"
  ) {
    return value;
  }
  throw new Error(
    `${label} must be "whisper_cpp", "faster_whisper", "azure_openai", "openai_compatible", or "openai_realtime"`,
  );
}

function expectedEventsForSource(source: SourceConfig): string[] {
  if (source.type === "cron") {
    return ["cron:tick"];
  }
  if (source.type === "sentry") {
    return [SENTRY_ISSUE_NEW_EVENT];
  }
  if (source.type === "github-ci") {
    return [GITHUB_CI_RUN_COMPLETED_EVENT];
  }
  if (source.type === "service") {
    return Object.keys(source.rules).map((ruleId) => `service:${ruleId}`);
  }
  if (source.type === "telegram") {
    return [TELEGRAM_MESSAGE_EVENT];
  }
  if (source.type === "jira") {
    return [];
  }
  const events = VALID_REVIEW_SIGNAL_KINDS.map((kind) => `${source.type}:${kind}`);
  if (source.type === "github") {
    for (const kind of GITHUB_PR_LIFECYCLE_KINDS) events.push(`github:${kind}`);
    if (source.query !== undefined) {
      events.push("github:work_item.new");
    }
  }
  return events;
}

function derivePrefix(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
  const trimmed = sanitized.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed || "session";
}

function parseCronSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
): CronSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  return {
    type: "cron",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    schedule: asString(raw["schedule"], `${label}.schedule`),
  };
}

function parseGitHubAdaptivePoll(
  value: unknown,
  sourceLabel: string,
  intervalMs: number,
): GitHubAdaptivePollConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `${sourceLabel}.adaptivePoll`;
  const raw = asObject(value, label);
  const slowIntervalMs =
    asOptionalNumber(raw["slowIntervalMs"], `${label}.slowIntervalMs`) ?? intervalMs * 5;
  if (slowIntervalMs <= intervalMs) {
    throw new Error(`${label}.slowIntervalMs must be greater than ${sourceLabel}.intervalMs`);
  }
  const activeGraceMs = asOptionalNumber(raw["activeGraceMs"], `${label}.activeGraceMs`) ?? 600_000;
  return { slowIntervalMs, activeGraceMs };
}

function parseReviewSource<TProvider extends ReviewProviderId>(
  provider: TProvider,
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
): Extract<GitHubSourceConfig | GitLabSourceConfig, { type: TProvider }> {
  const label = `projects.${projectId}.sources.${sourceId}`;
  const query = asOptionalString(raw["query"], `${label}.query`);
  const draft = asOptionalBoolean(raw["draft"], `${label}.draft`);
  const intervalMs = asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 60_000;
  const adaptivePoll =
    provider === "github"
      ? parseGitHubAdaptivePoll(raw["adaptivePoll"], label, intervalMs)
      : undefined;
  return {
    type: provider,
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    intervalMs,
    emitExisting: asOptionalBoolean(raw["emitExisting"], `${label}.emitExisting`) ?? false,
    ...(query !== undefined ? { query } : {}),
    ...(draft !== undefined ? { draft } : {}),
    ...(adaptivePoll !== undefined ? { adaptivePoll } : {}),
  } as Extract<GitHubSourceConfig | GitLabSourceConfig, { type: TProvider }>;
}

function parseSentrySource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
  projectEnv: Record<string, string>,
): SentrySourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  const authTokenRaw = asString(raw["authToken"], `${label}.authToken`);
  const authToken = resolveEnvVars(authTokenRaw, projectEnv);
  if (authToken === undefined) {
    throw new Error(`${label}.authToken could not be resolved from the environment`);
  }
  const baseUrlRaw = asOptionalString(raw["baseUrl"], `${label}.baseUrl`);
  return {
    type: "sentry",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    authToken,
    org: asString(raw["org"], `${label}.org`),
    project: asString(raw["project"], `${label}.project`),
    baseUrl:
      baseUrlRaw !== undefined ? asUrlString(baseUrlRaw, `${label}.baseUrl`) : "https://sentry.io",
    query: asOptionalString(raw["query"], `${label}.query`) ?? "is:unresolved",
    intervalMs: asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 60_000,
    emitExisting: asOptionalBoolean(raw["emitExisting"], `${label}.emitExisting`) ?? false,
  };
}

function resolveRequiredEnvString(
  rawValue: unknown,
  label: string,
  projectEnv: Record<string, string>,
): string {
  const raw = asString(rawValue, label);
  const resolved = resolveEnvVars(raw, projectEnv);
  if (resolved === undefined) {
    throw new Error(`${label} could not be resolved from the environment`);
  }
  return resolved;
}

function parseJiraSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
  projectEnv: Record<string, string>,
): JiraSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  return {
    type: "jira",
    baseUrl: asUrlString(
      resolveRequiredEnvString(raw["baseUrl"], `${label}.baseUrl`, projectEnv),
      `${label}.baseUrl`,
    ),
    email: resolveRequiredEnvString(raw["email"], `${label}.email`, projectEnv),
    token: resolveRequiredEnvString(raw["token"], `${label}.token`, projectEnv),
  };
}

function parseBacklog(
  projectId: string,
  backlogId: string,
  value: unknown,
  sources: Record<string, SourceConfig>,
): BacklogConfig {
  if (!VALID_ID_RE.test(backlogId)) {
    throw new Error(
      `projects.${projectId}.backlog.${backlogId} is invalid: backlog ids must match ${VALID_ID_RE.source}`,
    );
  }

  const label = `projects.${projectId}.backlog.${backlogId}`;
  const raw = asObject(value, label);
  const source = asString(raw["source"], `${label}.source`);
  const conn = sources[source];
  if (!conn) {
    throw new Error(`${label}.source references unknown source "${source}"`);
  }
  if (conn.type !== "jira") {
    throw new Error(
      `${label}.source "${source}" is not a backlog-capable connection (type "${conn.type}")`,
    );
  }

  return {
    source,
    provider: conn.type,
    query: asString(raw["query"], `${label}.query`),
    intervalMs: asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 60_000,
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
  };
}

function parseGitHubCiSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
): GitHubCiSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  const repo = asString(raw["repo"], `${label}.repo`);
  const repoParts = repo.split("/");
  if (repoParts.length !== 2 || repoParts[0] === "" || repoParts[1] === "") {
    throw new Error(`${label}.repo must be "owner/name"`);
  }
  const conclusion = asOptionalString(raw["conclusion"], `${label}.conclusion`) ?? "success";
  if (conclusion !== "success" && conclusion !== "any") {
    throw new Error(`${label}.conclusion must be "success" or "any"`);
  }
  const branch = asOptionalString(raw["branch"], `${label}.branch`);
  return {
    type: "github-ci",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    repo,
    conclusion,
    ...(branch !== undefined ? { branch } : {}),
    intervalMs: asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 60_000,
    emitExisting: asOptionalBoolean(raw["emitExisting"], `${label}.emitExisting`) ?? false,
  };
}

function parseServiceRule(
  projectId: string,
  sourceId: string,
  ruleId: string,
  value: unknown,
): ServiceRuleConfig {
  if (!VALID_ID_RE.test(ruleId)) {
    throw new Error(
      `projects.${projectId}.sources.${sourceId}.rules.${ruleId} is invalid: rule ids must match ${VALID_ID_RE.source}`,
    );
  }

  const label = `projects.${projectId}.sources.${sourceId}.rules.${ruleId}`;
  const raw = asObject(value, label);
  const clear = asOptionalString(raw["clear"], `${label}.clear`);
  return {
    match: asString(raw["match"], `${label}.match`),
    ...(clear !== undefined ? { clear } : {}),
    cooldownMs: asOptionalNumber(raw["cooldownMs"], `${label}.cooldownMs`) ?? 60_000,
  };
}

function parseServiceSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
): ServiceSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  const rulesRaw = asObject(raw["rules"], `${label}.rules`);
  const rules: Record<string, ServiceRuleConfig> = {};
  for (const [ruleId, ruleValue] of Object.entries(rulesRaw)) {
    rules[ruleId] = parseServiceRule(projectId, sourceId, ruleId, ruleValue);
  }
  if (Object.keys(rules).length === 0) {
    throw new Error(`${label}.rules must define at least one rule`);
  }

  return {
    type: "service",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    service: asString(raw["service"], `${label}.service`),
    intervalMs: asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 2_000,
    tailLines: asOptionalNumber(raw["tailLines"], `${label}.tailLines`) ?? 200,
    rules,
  };
}

function parseTelegramSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
  projectEnv: Record<string, string>,
): TelegramSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  const tokenRaw = asString(raw["token"], `${label}.token`);
  const token = resolveEnvVars(tokenRaw, projectEnv);
  if (token === undefined) {
    throw new Error(`${label}.token could not be resolved from the environment`);
  }
  const allowedUsers = asOptionalIntegerArray(raw["allowedUsers"], `${label}.allowedUsers`);
  const allowedChats = asOptionalIntegerArray(raw["allowedChats"], `${label}.allowedChats`);
  if ((allowedUsers?.length ?? 0) === 0) {
    throw new Error(`${label} must define allowedUsers`);
  }
  return {
    type: "telegram",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    token,
    ...(allowedUsers !== undefined ? { allowedUsers } : {}),
    ...(allowedChats !== undefined ? { allowedChats } : {}),
  };
}

function parseSource(
  projectId: string,
  sourceId: string,
  value: unknown,
  projectEnv: Record<string, string>,
): SourceConfig {
  if (!VALID_ID_RE.test(sourceId)) {
    throw new Error(
      `projects.${projectId}.sources.${sourceId} is invalid: source ids must match ${VALID_ID_RE.source}`,
    );
  }

  const label = `projects.${projectId}.sources.${sourceId}`;
  const raw = asObject(value, label);
  const type = asString(raw["type"], `${label}.type`);
  if (type === "cron") {
    return parseCronSource(projectId, sourceId, raw);
  }
  if (type === "github" || type === "gitlab") {
    return parseReviewSource(type, projectId, sourceId, raw);
  }
  if (type === "sentry") {
    return parseSentrySource(projectId, sourceId, raw, projectEnv);
  }
  if (type === "jira") {
    return parseJiraSource(projectId, sourceId, raw, projectEnv);
  }
  if (type === "service") {
    return parseServiceSource(projectId, sourceId, raw);
  }
  if (type === "telegram") {
    return parseTelegramSource(projectId, sourceId, raw, projectEnv);
  }
  if (type === "github-ci") {
    return parseGitHubCiSource(projectId, sourceId, raw);
  }

  throw new Error(`${label}.type uses unsupported source type "${type}"`);
}

function validateTelegramBotTokens(projects: Record<string, ProjectConfig>): void {
  const owners = new Map<string, string>();
  for (const [projectId, project] of Object.entries(projects)) {
    for (const [sourceId, source] of Object.entries(project.sources)) {
      if (source.type !== "telegram") continue;
      const owner = `projects.${projectId}.sources.${sourceId}`;
      const existingOwner = owners.get(source.token);
      if (existingOwner) {
        throw new Error(
          `${owner}.token duplicates ${existingOwner}.token; each telegram source must use a dedicated bot token`,
        );
      }
      owners.set(source.token, owner);
    }
  }
}

function parseSendConfig(
  projectId: string,
  triggerId: string,
  raw: Record<string, unknown>,
): SendTriggerConfig["send"] {
  const label = `projects.${projectId}.triggers.${triggerId}.send`;
  const sendRaw = asObject(raw["send"], label);
  if (sendRaw["autoClose"] !== undefined) {
    throw new Error(`${label}.autoClose is not supported; use spawn.autoComplete`);
  }
  if (sendRaw["autoComplete"] !== undefined) {
    throw new Error(`${label}.autoComplete is only supported on spawn triggers`);
  }
  const prompt = asOptionalString(sendRaw["prompt"], `${label}.prompt`);
  return {
    interrupt: asOptionalBoolean(sendRaw["interrupt"], `${label}.interrupt`) ?? false,
    ...(prompt !== undefined ? { prompt } : {}),
  };
}

function parseProjectPreflight(
  projectId: string,
  value: unknown,
): ProjectPreflightConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `projects.${projectId}.preflight`;
  const raw = asObject(value, label);
  return {
    prompt: asOptionalString(raw["prompt"], `${label}.prompt`) ?? DEFAULT_PROJECT_PREFLIGHT_PROMPT,
  };
}

function parseProjectBranchNaming(
  projectId: string,
  value: unknown,
): ProjectBranchNamingConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `projects.${projectId}.branchNaming`;
  const raw = asObject(value, label);
  const regex = asString(raw["regex"], `${label}.regex`);
  compileBranchNamingRegex(regex, label);
  return { regex };
}

/** Backward-compat shape for the legacy `devServer` YAML key. */
interface DevServerConfig {
  command: string;
  autoStart: boolean;
}

function parseDevServer(projectId: string, value: unknown): DevServerConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `projects.${projectId}.devServer`;
  const raw = asObject(value, label);
  return {
    command: asString(raw["command"], `${label}.command`),
    autoStart: asOptionalBoolean(raw["autoStart"], `${label}.autoStart`) ?? false,
  };
}

function parseSidecars(
  projectId: string,
  value: unknown,
  projectEnv: Record<string, string>,
): Record<string, SidecarConfig> {
  if (value === undefined) return {};
  const label = `projects.${projectId}.sidecars`;
  const raw = asObject(value, label);
  const result: Record<string, SidecarConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!VALID_ID_RE.test(name)) {
      throw new Error(
        `${label}.${name} is invalid: sidecar names must match ${VALID_ID_RE.source}`,
      );
    }
    const entryLabel = `${label}.${name}`;
    const entryRaw = asObject(entry, entryLabel);
    const autoStart = asOptionalBoolean(entryRaw["autoStart"], `${entryLabel}.autoStart`) ?? false;
    // Object.hasOwn guards against a sidecar name like "constructor"/"toString"
    // (VALID_ID_RE allows them) resolving to Object.prototype's own members
    // instead of falling through to the normal "unknown built-in" path below.
    const builtin = Object.hasOwn(BUILTIN_SIDECARS, name) ? BUILTIN_SIDECARS[name] : undefined;
    if (builtin) {
      // Built-ins carry a code-only command/ports/mcp/agents (bundle-resolved
      // bin, MCP wiring). YAML only ever overrides "autoStart": MCP sidecars
      // start pre-agent-launch, ahead of the dependency-aware autostart pass,
      // so "dependsOn" (and any other override) can't be honored — reject it
      // at the boundary instead of silently dropping it.
      const extraKeys = Object.keys(entryRaw).filter((key) => key !== "autoStart");
      if (extraKeys.length > 0) {
        throw new Error(
          `${entryLabel} is a built-in sidecar; only "autoStart" may be set here (got: ${extraKeys.join(", ")}). ` +
            `Its command/env/ports/mcp/agents are fixed in code, and "dependsOn" is not supported because MCP ` +
            `sidecars start before the agent launches, ahead of the dependency-aware autostart pass. ` +
            `Use a different sidecar name to define your own.`,
        );
      }
      result[name] = { ...builtin.config, autoStart };
      continue;
    }
    const dependsOn = asOptionalStringArray(entryRaw["dependsOn"], `${entryLabel}.dependsOn`);
    const command = asString(entryRaw["command"], `${entryLabel}.command`);
    const envRaw = entryRaw["env"];
    let env: Record<string, string> | undefined;
    if (envRaw !== undefined) {
      const envObj = asObject(envRaw, `${entryLabel}.env`);
      env = {};
      for (const [k, v] of Object.entries(envObj)) {
        const resolved = resolveEnvVars(asString(v, `${entryLabel}.env.${k}`), projectEnv);
        if (resolved !== undefined) {
          env[k] = resolved;
        }
      }
      if (Object.keys(env).length === 0) env = undefined;
    }
    const portsRaw = entryRaw["ports"];
    let ports: SidecarConfig["ports"];
    let urlEnabledPortCount = 0;
    if (portsRaw !== undefined) {
      const portsObj = asObject(portsRaw, `${entryLabel}.ports`);
      ports = {};
      for (const [portId, portValue] of Object.entries(portsObj)) {
        if (!VALID_ID_RE.test(portId)) {
          throw new Error(
            `${entryLabel}.ports.${portId} is invalid: port ids must match ${VALID_ID_RE.source}`,
          );
        }
        const portLabel = `${entryLabel}.ports.${portId}`;
        const portObj = asObject(portValue, portLabel);
        const start = asPortNumber(portObj["start"], `${portLabel}.start`);
        const end = asPortNumber(portObj["end"], `${portLabel}.end`);
        if (end < start) {
          throw new Error(`${portLabel}.end must be greater than or equal to ${portLabel}.start`);
        }
        const rawUrl = asOptionalString(portObj["url"], `${portLabel}.url`);
        let url: string | undefined;
        if (rawUrl !== undefined) {
          const resolvedUrl = resolveOptionalUrl(rawUrl, `${portLabel}.url`, projectEnv);
          if (resolvedUrl !== undefined) {
            const urlForParsing = resolvedUrl.includes("{port}")
              ? resolvedUrl.replaceAll("{port}", "port")
              : resolvedUrl;
            const parsed = new URL(urlForParsing);
            if (parsed.port !== "") {
              throw new Error(`${portLabel}.url must not include an explicit port`);
            }
            if (parsed.pathname !== "/" && parsed.pathname !== "") {
              throw new Error(`${portLabel}.url must not include a path`);
            }
            if (parsed.search !== "") {
              throw new Error(`${portLabel}.url must not include a query string`);
            }
            if (parsed.hash !== "") {
              throw new Error(`${portLabel}.url must not include a fragment`);
            }
            url = resolvedUrl.replace(/\/$/, "");
            urlEnabledPortCount += 1;
          }
        }
        ports[portId] = {
          env: asString(portObj["env"], `${portLabel}.env`),
          start,
          end,
          ...(url !== undefined ? { url } : {}),
        };
      }
    }
    if (urlEnabledPortCount > 0) {
      if (urlEnabledPortCount > 1) {
        throw new Error(`${entryLabel}.ports: at most one port may define "url"`);
      }
      if (!SLOT_LABEL_RE.test(name)) {
        throw new Error(
          `${entryLabel}: sidecar name must match ${SLOT_LABEL_RE.source} when any port defines "url"`,
        );
      }
    }
    const idleTtlMinutes = asOptionalPositiveInteger(
      entryRaw["idleTtlMinutes"],
      `${entryLabel}.idleTtlMinutes`,
    );
    result[name] = {
      command,
      autoStart,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
      ...(env ? { env } : {}),
      ...(ports ? { ports } : {}),
      ...(idleTtlMinutes !== undefined ? { idleTtlMinutes } : {}),
    };
  }
  validateSidecarDependencies(label, result);
  return result;
}

function validateSidecarDependencies(label: string, sidecars: Record<string, SidecarConfig>): void {
  for (const [name, sidecar] of Object.entries(sidecars)) {
    const dependencies = sidecar.dependsOn ?? [];
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      const dependencyLabel = `${label}.${name}.dependsOn`;
      if (dependency === name) {
        throw new Error(`${dependencyLabel} must not include the sidecar itself`);
      }
      if (seen.has(dependency)) {
        throw new Error(`${dependencyLabel} must not include duplicate sidecar "${dependency}"`);
      }
      if (!sidecars[dependency]) {
        throw new Error(`${dependencyLabel} references unknown sidecar "${dependency}"`);
      }
      // startSidecarWithDependencies recurses over the raw project sidecars, so
      // a dependency on an agent-scoped built-in would start it for an agent it
      // is not scoped to (and regardless of its own autoStart). Built-in MCP
      // sidecars also start before the agent launches, ahead of this
      // dependency-aware pass, so the ordering could not be honored anyway.
      if (Object.hasOwn(BUILTIN_SIDECARS, dependency)) {
        throw new Error(
          `${dependencyLabel} must not reference the built-in sidecar "${dependency}": ` +
            `built-in MCP sidecars start before the agent launches and are agent-scoped, ` +
            `so they cannot be used as a dependency. Enable it with ` +
            `sidecars.${dependency}.autoStart instead.`,
        );
      }
      seen.add(dependency);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      const cycle = [...path.slice(start), name].join(" -> ");
      throw new Error(`${label} dependency cycle: ${cycle}`);
    }

    visiting.add(name);
    path.push(name);
    for (const dependency of sidecars[name]?.dependsOn ?? []) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of Object.keys(sidecars)) {
    visit(name);
  }
}

function parseDevServerAsSidecar(devServer: DevServerConfig): Record<string, SidecarConfig> {
  return {
    dev: {
      command: devServer.command,
      autoStart: devServer.autoStart,
    },
  };
}

function parseProjectSpawn(projectId: string, value: unknown): ProjectSpawnConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `projects.${projectId}.spawn`;
  const raw = asObject(value, label);
  const steps = asOptionalStringArray(raw["steps"], `${label}.steps`);
  return steps !== undefined ? { steps } : {};
}

function parseWorkspaceAccess(
  projectId: string,
  value: unknown,
  projectEnv: Record<string, string>,
): WorkspaceAccessConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const label = `projects.${projectId}.workspaceAccess`;
  const raw = asObject(value, label);
  const itemsRaw = raw["items"];
  if (itemsRaw === undefined) {
    throw new Error(`${label}.items must be an array`);
  }
  if (!Array.isArray(itemsRaw)) {
    throw new Error(`${label}.items must be an array`);
  }

  const items: WorkspaceAccessItemConfig[] = [];
  for (const [index, itemRaw] of itemsRaw.entries()) {
    const itemLabel = `${label}.items[${index}]`;
    const item = asObject(itemRaw, itemLabel);
    const kind = asString(item["kind"], `${itemLabel}.kind`);
    if (kind !== "copy" && kind !== "link") {
      throw new Error(`${itemLabel}.kind must be "copy" or "link"`);
    }
    const resolvedValue = resolveOptionalTemplate(
      asString(item["value"], `${itemLabel}.value`),
      projectEnv,
    );
    if (resolvedValue === undefined) {
      continue;
    }
    items.push({
      label: asString(item["label"], `${itemLabel}.label`),
      kind,
      value: resolvedValue,
    });
  }

  return items.length > 0 ? { items } : undefined;
}

function parseTrigger(
  projectId: string,
  triggerId: string,
  value: unknown,
  sources: Record<string, SourceConfig>,
): TriggerConfig {
  if (!VALID_ID_RE.test(triggerId)) {
    throw new Error(
      `projects.${projectId}.triggers.${triggerId} is invalid: trigger ids must match ${VALID_ID_RE.source}`,
    );
  }

  const label = `projects.${projectId}.triggers.${triggerId}`;
  const raw = asObject(value, label);
  const source = asString(raw["source"], `${label}.source`);
  const event = asString(raw["event"], `${label}.event`);

  const sourceConfig = sources[source];
  if (!sourceConfig) {
    throw new Error(`${label}.source references unknown source "${source}"`);
  }
  const expectedEvents = expectedEventsForSource(sourceConfig);
  if (!expectedEvents.includes(event)) {
    throw new Error(
      `${label}.event uses unsupported event "${event}" for source "${source}"; expected one of ${expectedEvents.join(", ")}`,
    );
  }

  const hasSpawn = raw["spawn"] !== undefined;
  const hasSend = raw["send"] !== undefined;
  if (hasSpawn === hasSend) {
    throw new Error(`${label} must define exactly one of "spawn" or "send"`);
  }
  const spawnDeskGroup = asOptionalBoolean(raw["spawnDeskGroup"], `${label}.spawnDeskGroup`);

  if (hasSend) {
    if (spawnDeskGroup !== undefined) {
      throw new Error(`${label}.spawnDeskGroup is only supported on spawn triggers`);
    }
    return { source, event, send: parseSendConfig(projectId, triggerId, raw) };
  }

  const spawn = parseTriggerSpawn(raw["spawn"], `${label}.spawn`);
  if (spawn.blocks.length > 1 && spawn.blocks.some((block) => block.branch !== undefined)) {
    throw new Error(`${label}.spawn.branch is not supported with multiple spawn blocks`);
  }
  if (spawn.autoComplete !== undefined && !WORK_ITEM_NEW_EVENT_NAMES.has(event)) {
    throw new Error(
      `${label}.spawn.autoComplete is only supported for ${[...WORK_ITEM_NEW_EVENT_NAMES].join(" or ")}`,
    );
  }
  if (spawnDeskGroup === true && spawn.autoComplete === true) {
    throw new Error(`${label}.spawnDeskGroup is not supported with autoComplete: true`);
  }
  if (spawnDeskGroup === true && spawn.blocks.length < 2) {
    throw new Error(`${label}.spawnDeskGroup requires at least two spawn blocks`);
  }

  return {
    source,
    event,
    ...(spawnDeskGroup !== undefined ? { spawnDeskGroup } : {}),
    spawn,
  };
}

function parseProject(configDir: string, projectId: string, value: unknown): ProjectConfig {
  if (!VALID_ID_RE.test(projectId)) {
    throw new Error(
      `projects.${projectId} is invalid: project ids must match ${VALID_ID_RE.source}`,
    );
  }

  const label = `projects.${projectId}`;
  const raw = asObject(value, label);
  const path = resolveFrom(configDir, asString(raw["path"], `${label}.path`));
  const projectEnv = readProjectEnv(path);
  const name = asOptionalString(raw["name"], `${label}.name`);
  const defaultBranch = asOptionalString(raw["defaultBranch"], `${label}.defaultBranch`) ?? "main";
  const sessionPrefix =
    asOptionalString(raw["sessionPrefix"], `${label}.sessionPrefix`) ?? derivePrefix(projectId);
  const worktree = asOptionalBoolean(raw["worktree"], `${label}.worktree`) ?? true;
  const restoreAfterReboot =
    asOptionalBoolean(raw["restoreAfterReboot"], `${label}.restoreAfterReboot`) ?? false;
  const symlinks = asOptionalStringArray(raw["symlinks"], `${label}.symlinks`) ?? [];
  const codexArgs = asOptionalStringArray(raw["codexArgs"], `${label}.codexArgs`);
  const reasoningEffort = parseProjectReasoningEffort(projectId, raw["reasoningEffort"]);
  const spawn = parseProjectSpawn(projectId, raw["spawn"]);
  const preflight = parseProjectPreflight(projectId, raw["preflight"]);
  const branchNaming = parseProjectBranchNaming(projectId, raw["branchNaming"]);
  const workspaceAccess = parseWorkspaceAccess(projectId, raw["workspaceAccess"], projectEnv);
  const devServer = parseDevServer(projectId, raw["devServer"]);
  const hasDevServerKey = raw["devServer"] !== undefined;
  const hasSidecarsKey = raw["sidecars"] !== undefined;
  if (hasDevServerKey && hasSidecarsKey) {
    throw new Error(`projects.${projectId} defines both "devServer" and "sidecars"; pick one`);
  }
  const sidecars = hasSidecarsKey
    ? parseSidecars(projectId, raw["sidecars"], projectEnv)
    : devServer
      ? parseDevServerAsSidecar(devServer)
      : {};
  const defaultAgent = asOptionalAgent(raw["defaultAgent"], `${label}.defaultAgent`);
  const defaultModels = parseDefaultModels(raw["defaultModels"], label);
  const maxLiveSessions = asOptionalPositiveInteger(
    raw["maxLiveSessions"],
    `${label}.maxLiveSessions`,
  );
  const sourcesRaw = raw["sources"] ? asObject(raw["sources"], `${label}.sources`) : {};
  const sources: Record<string, SourceConfig> = {};
  for (const [sourceId, sourceValue] of Object.entries(sourcesRaw)) {
    sources[sourceId] = parseSource(projectId, sourceId, sourceValue, projectEnv);
  }
  const backlogRaw = raw["backlog"] ? asObject(raw["backlog"], `${label}.backlog`) : {};
  const backlog: Record<string, BacklogConfig> = {};
  for (const [backlogId, backlogValue] of Object.entries(backlogRaw)) {
    backlog[backlogId] = parseBacklog(projectId, backlogId, backlogValue, sources);
  }
  const triggersRaw = raw["triggers"] ? asObject(raw["triggers"], `${label}.triggers`) : {};
  const triggers: Record<string, TriggerConfig> = {};
  for (const [triggerId, triggerValue] of Object.entries(triggersRaw)) {
    triggers[triggerId] = parseTrigger(projectId, triggerId, triggerValue, sources);
    const trigger = triggers[triggerId];
    if ("spawn" in trigger) {
      const spawnDeskGroupWorktree = trigger.spawn.blocks[0]?.overrides?.worktree ?? worktree;
      const spawnDeskGroupDefaultBranch =
        trigger.spawn.blocks[0]?.overrides?.defaultBranch ?? defaultBranch;
      for (const [blockIndex, block] of trigger.spawn.blocks.entries()) {
        if (
          trigger.spawnDeskGroup === true &&
          ((block.overrides?.worktree ?? worktree) !== spawnDeskGroupWorktree ||
            (block.overrides?.defaultBranch ?? defaultBranch) !== spawnDeskGroupDefaultBranch)
        ) {
          throw new Error(
            `projects.${projectId}.triggers.${triggerId}.spawnDeskGroup requires matching workspace overrides across spawn blocks`,
          );
        }
        if (block.branch !== undefined) {
          const branchLabel =
            trigger.spawn.blocks.length === 1
              ? `projects.${projectId}.triggers.${triggerId}.spawn.branch`
              : `projects.${projectId}.triggers.${triggerId}.spawn[${blockIndex}].branch`;
          assertBranchNameMatches(block.branch, branchNaming, branchLabel);
        }
      }
    }
  }

  const workItemSubs = new Map<string, number>();
  for (const trigger of Object.values(triggers)) {
    if (!WORK_ITEM_NEW_EVENT_NAMES.has(trigger.event)) continue;
    workItemSubs.set(trigger.source, (workItemSubs.get(trigger.source) ?? 0) + 1);
  }
  for (const [src, count] of workItemSubs) {
    if (count > 1) {
      throw new Error(
        `projects.${projectId}: source "${src}" has ${count} triggers subscribed to a work-item event; at most one is allowed`,
      );
    }
  }

  for (const [triggerId, trigger] of Object.entries(triggers)) {
    if (!("spawn" in trigger)) {
      continue;
    }
    const allowedTriggers = trigger.spawn.allowedTriggers;
    if (allowedTriggers === undefined) {
      continue;
    }
    for (const allowedTriggerId of allowedTriggers) {
      if (!triggers[allowedTriggerId]) {
        throw new Error(
          `projects.${projectId}.triggers.${triggerId}.spawn.allowedTriggers references unknown trigger "${allowedTriggerId}"`,
        );
      }
    }
  }

  if (!VALID_ID_RE.test(sessionPrefix)) {
    throw new Error(`projects.${projectId}.sessionPrefix must match ${VALID_ID_RE.source}`);
  }

  return {
    ...(name !== undefined ? { name } : {}),
    path,
    defaultBranch,
    sessionPrefix,
    worktree,
    restoreAfterReboot,
    symlinks,
    ...(codexArgs !== undefined ? { codexArgs } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(spawn !== undefined ? { spawn } : {}),
    ...(preflight !== undefined ? { preflight } : {}),
    ...(branchNaming !== undefined ? { branchNaming } : {}),
    ...(workspaceAccess !== undefined ? { workspaceAccess } : {}),
    sidecars,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    ...(defaultModels !== undefined ? { defaultModels } : {}),
    sources,
    backlog,
    triggers,
    ...(maxLiveSessions !== undefined ? { maxLiveSessions } : {}),
  };
}

// Stable per-name color so a tag keeps the same hue across renders without
// storing one in config. Hash the name, map to a hue, fix saturation/lightness
// for the dark dashboard theme.
export function resolveTagColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 62% 64%)`;
}

function parseTags(value: unknown): TagDefinition[] {
  if (value === undefined) {
    return [];
  }
  const root = asObject(value, "tags");
  const tags: TagDefinition[] = [];
  const seen = new Set<string>();
  for (const [rawName, rawDef] of Object.entries(root)) {
    const name = rawName.trim().toLowerCase();
    if (!SLOT_LABEL_RE.test(name)) {
      throw new Error(`tag names must match ^[a-z0-9][a-z0-9_-]{0,15}$ (got "${rawName}")`);
    }
    if (seen.has(name)) {
      throw new Error(`tag "${name}" is duplicated`);
    }
    seen.add(name);
    const def = asObject(rawDef, `tags.${name}`);
    tags.push({
      name,
      description: asString(def["description"], `tags.${name}.description`),
      color: asOptionalString(def["color"], `tags.${name}.color`) ?? resolveTagColor(name),
    });
  }
  return tags;
}

const DEFAULT_AUTH_ROTATION: AppConfig["authRotation"] = {
  autoRotateOnRateLimit: false,
  cooldownMinutes: 60,
  maxRotationsPerEpisode: 2,
};

// Agent-agnostic rotation policy (applies to any agent that hits a rate limit;
// per-agent account stores plug in separately). Instance-only, same footgun as
// rateLimitReactivation/tags: parsed only when mode === "instance", so a
// per-project authRotation is silently ignored. Config carries only the rotate
// policy; the accounts themselves are a runtime store (claude-accounts.ts).
function parseAuthRotation(value: unknown): AppConfig["authRotation"] {
  if (value === undefined) {
    return DEFAULT_AUTH_ROTATION;
  }
  const root = asObject(value, "authRotation");
  return {
    autoRotateOnRateLimit:
      asOptionalBoolean(root["autoRotateOnRateLimit"], "authRotation.autoRotateOnRateLimit") ??
      DEFAULT_AUTH_ROTATION.autoRotateOnRateLimit,
    cooldownMinutes:
      asNonNegativeNumber(root["cooldownMinutes"], "authRotation.cooldownMinutes") ??
      DEFAULT_AUTH_ROTATION.cooldownMinutes,
    maxRotationsPerEpisode:
      asNonNegativeNumber(root["maxRotationsPerEpisode"], "authRotation.maxRotationsPerEpisode") ??
      DEFAULT_AUTH_ROTATION.maxRotationsPerEpisode,
  };
}

const SESSION_GC_STATUSES = ["completed", "killed", "stopped"] as const;

export const DEFAULT_SESSION_GC: AppConfig["sessionGc"] = {
  enabled: false,
  olderThanDays: 30,
  intervalMinutes: 360,
  maxGroupsPerSweep: 20,
  statuses: [...SESSION_GC_STATUSES],
};

function isSessionGcStatus(value: unknown): value is (typeof SESSION_GC_STATUSES)[number] {
  return typeof value === "string" && (SESSION_GC_STATUSES as readonly string[]).includes(value);
}

function parseSessionGcStatuses(value: unknown): AppConfig["sessionGc"]["statuses"] {
  if (value === undefined) {
    return [...DEFAULT_SESSION_GC.statuses];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("sessionGc.statuses must be a non-empty array of completed|killed|stopped");
  }
  return value.map((entry) => {
    if (!isSessionGcStatus(entry)) {
      throw new Error(
        `sessionGc.statuses must only contain completed|killed|stopped (got ${JSON.stringify(entry)})`,
      );
    }
    return entry;
  });
}

// Instance-only, same footgun as authRotation/rateLimitReactivation: parsed
// only when mode === "instance", so a per-project sessionGc block is
// silently ignored (the daemon sweep and `spur gc` both always read the
// merged instance config, never a project one).
function parseSessionGc(value: unknown): AppConfig["sessionGc"] {
  if (value === undefined) {
    return DEFAULT_SESSION_GC;
  }
  const root = asObject(value, "sessionGc");
  return {
    enabled: asOptionalBoolean(root["enabled"], "sessionGc.enabled") ?? DEFAULT_SESSION_GC.enabled,
    olderThanDays:
      asNonNegativeNumber(root["olderThanDays"], "sessionGc.olderThanDays") ??
      DEFAULT_SESSION_GC.olderThanDays,
    intervalMinutes:
      asNonNegativeNumber(root["intervalMinutes"], "sessionGc.intervalMinutes") ??
      DEFAULT_SESSION_GC.intervalMinutes,
    maxGroupsPerSweep:
      asOptionalPositiveInteger(root["maxGroupsPerSweep"], "sessionGc.maxGroupsPerSweep") ??
      DEFAULT_SESSION_GC.maxGroupsPerSweep,
    statuses: parseSessionGcStatuses(root["statuses"]),
  };
}

// Ship enabled by default (unlike sessionGc): this reaper is a memory-safety
// control that kills a restartable sidecar process, never a worktree or a
// record, so the destructive-by-default caution sessionGc needs does not
// apply here.
export const DEFAULT_SIDECAR_GC: AppConfig["sidecarGc"] = {
  enabled: true,
  idleTtlMinutes: 120,
  maxAgeWarnMinutes: 360,
};

// Instance-only, same footgun as sessionGc/authRotation/rateLimitReactivation:
// parsed only when mode === "instance", so a per-project sidecarGc block is
// silently ignored.
function parseSidecarGc(value: unknown): AppConfig["sidecarGc"] {
  if (value === undefined) {
    return DEFAULT_SIDECAR_GC;
  }
  const root = asObject(value, "sidecarGc");
  return {
    enabled: asOptionalBoolean(root["enabled"], "sidecarGc.enabled") ?? DEFAULT_SIDECAR_GC.enabled,
    idleTtlMinutes:
      asOptionalPositiveInteger(root["idleTtlMinutes"], "sidecarGc.idleTtlMinutes") ??
      DEFAULT_SIDECAR_GC.idleTtlMinutes,
    maxAgeWarnMinutes:
      asOptionalPositiveInteger(root["maxAgeWarnMinutes"], "sidecarGc.maxAgeWarnMinutes") ??
      DEFAULT_SIDECAR_GC.maxAgeWarnMinutes,
  };
}

// Estimated from an agent, Playwright MCP sidecar, and isolated daemon:
// 1.5 GiB per session leaves room above the 1.21 GiB design estimate.
const DEFAULT_ADMISSION_MAX_LIVE_SESSIONS = 100;
const DEFAULT_ADMISSION_PER_SESSION_BYTES = 1_610_612_736;
const DEFAULT_ADMISSION_RESERVE_FRACTION = 0.7;
const DEFAULT_ADMISSION_MIN_AVAILABLE_BYTES = 1_073_741_824;
const DEFAULT_ADMISSION_MIN_FREE_SWAP_BYTES = 0;
const DEFAULT_ADMISSION_PRESSURE_SOME_AVG10_REFUSE = 20;
const DEFAULT_ADMISSION_SHED_SWAP_USED_FRACTION = 0.9;
const ADMISSION_FLOOR_MIN_BYTES = 1_073_741_824;
const SHED_CRITICAL_FLOOR_MIN_BYTES = 536_870_912;

export function deriveMaxLiveSessions(
  totalBytes: number,
  perSessionBytes: number,
  reserveFraction: number,
): number {
  return Math.max(1, Math.floor((totalBytes * reserveFraction) / perSessionBytes));
}

export function deriveAdmissionFloorBytes(totalBytes: number): number {
  return Math.max(ADMISSION_FLOOR_MIN_BYTES, Math.floor(totalBytes / 8));
}

export function deriveShedCriticalFloorBytes(totalBytes: number): number {
  return Math.max(SHED_CRITICAL_FLOOR_MIN_BYTES, Math.floor(totalBytes / 16));
}

// Instance-only, same footgun as rateLimitReactivation/authRotation/tags: a
// per-project `admission` block is ignored before semantic parsing. Only
// projects.<id>.maxLiveSessions works per-project.
function parseAdmission(value: unknown, mode: ConfigMode): AdmissionConfig {
  const perSessionBytes = DEFAULT_ADMISSION_PER_SESSION_BYTES;
  const reserveFraction = DEFAULT_ADMISSION_RESERVE_FRACTION;
  const totalBytes = totalmem();
  const admissionFloorBytes = deriveAdmissionFloorBytes(totalBytes);
  const shedCriticalFloorBytes = deriveShedCriticalFloorBytes(totalBytes);
  if (mode !== "instance" || value === undefined) {
    return {
      enabled: true,
      maxLiveSessions: DEFAULT_ADMISSION_MAX_LIVE_SESSIONS,
      maxLiveSessionsSource: "default",
      perSessionBytes,
      reserveFraction,
      memoryGuard: {
        enforce: false,
        enforceFloors: true,
        shedEnabled: true,
        minAvailableBytes: DEFAULT_ADMISSION_MIN_AVAILABLE_BYTES,
        minFreeSwapBytes: DEFAULT_ADMISSION_MIN_FREE_SWAP_BYTES,
        admissionFloorBytes,
        shedCriticalFloorBytes,
        restoreFloorBytes: admissionFloorBytes + perSessionBytes,
        pressureSomeAvg10Refuse: DEFAULT_ADMISSION_PRESSURE_SOME_AVG10_REFUSE,
        shedSwapUsedFraction: DEFAULT_ADMISSION_SHED_SWAP_USED_FRACTION,
      },
    };
  }
  const root = asObject(value, "admission");
  const resolvedPerSessionBytes =
    asOptionalNumber(root["perSessionBytes"], "admission.perSessionBytes") ?? perSessionBytes;
  const resolvedReserveFraction =
    asOptionalFraction(root["reserveFraction"], "admission.reserveFraction") ?? reserveFraction;
  const memoryGuardRaw = root["memoryGuard"]
    ? asObject(root["memoryGuard"], "admission.memoryGuard")
    : {};
  const configuredMaxLiveSessions = asOptionalPositiveInteger(
    root["maxLiveSessions"],
    "admission.maxLiveSessions",
  );
  const resolvedAdmissionFloorBytes =
    asNonNegativeNumber(
      memoryGuardRaw["admissionFloorBytes"],
      "admission.memoryGuard.admissionFloorBytes",
    ) ?? admissionFloorBytes;
  const resolvedShedCriticalFloorBytes =
    asNonNegativeNumber(
      memoryGuardRaw["shedCriticalFloorBytes"],
      "admission.memoryGuard.shedCriticalFloorBytes",
    ) ?? shedCriticalFloorBytes;
  if (resolvedShedCriticalFloorBytes >= resolvedAdmissionFloorBytes) {
    throw new Error(
      `admission.memoryGuard.shedCriticalFloorBytes (${resolvedShedCriticalFloorBytes}) must be less than admissionFloorBytes (${resolvedAdmissionFloorBytes})`,
    );
  }
  const hasSizingInput =
    root["perSessionBytes"] !== undefined || root["reserveFraction"] !== undefined;
  const maxLiveSessionsSource: AdmissionCapSource =
    configuredMaxLiveSessions !== undefined ? "config" : hasSizingInput ? "derived" : "default";
  const maxLiveSessions =
    configuredMaxLiveSessions ??
    (hasSizingInput
      ? deriveMaxLiveSessions(totalBytes, resolvedPerSessionBytes, resolvedReserveFraction)
      : DEFAULT_ADMISSION_MAX_LIVE_SESSIONS);
  return {
    enabled: asOptionalBoolean(root["enabled"], "admission.enabled") ?? true,
    maxLiveSessions,
    maxLiveSessionsSource,
    perSessionBytes: resolvedPerSessionBytes,
    reserveFraction: resolvedReserveFraction,
    memoryGuard: {
      enforce:
        asOptionalBoolean(memoryGuardRaw["enforce"], "admission.memoryGuard.enforce") ?? false,
      enforceFloors:
        asOptionalBoolean(memoryGuardRaw["enforceFloors"], "admission.memoryGuard.enforceFloors") ??
        true,
      shedEnabled:
        asOptionalBoolean(memoryGuardRaw["shedEnabled"], "admission.memoryGuard.shedEnabled") ??
        true,
      minAvailableBytes:
        asNonNegativeNumber(
          memoryGuardRaw["minAvailableBytes"],
          "admission.memoryGuard.minAvailableBytes",
        ) ?? DEFAULT_ADMISSION_MIN_AVAILABLE_BYTES,
      minFreeSwapBytes:
        asNonNegativeNumber(
          memoryGuardRaw["minFreeSwapBytes"],
          "admission.memoryGuard.minFreeSwapBytes",
        ) ?? DEFAULT_ADMISSION_MIN_FREE_SWAP_BYTES,
      admissionFloorBytes: resolvedAdmissionFloorBytes,
      shedCriticalFloorBytes: resolvedShedCriticalFloorBytes,
      restoreFloorBytes: resolvedAdmissionFloorBytes + resolvedPerSessionBytes,
      pressureSomeAvg10Refuse:
        asOptionalPercent(
          memoryGuardRaw["pressureSomeAvg10Refuse"],
          "admission.memoryGuard.pressureSomeAvg10Refuse",
        ) ?? DEFAULT_ADMISSION_PRESSURE_SOME_AVG10_REFUSE,
      shedSwapUsedFraction:
        asOptionalFraction(
          memoryGuardRaw["shedSwapUsedFraction"],
          "admission.memoryGuard.shedSwapUsedFraction",
        ) ?? DEFAULT_ADMISSION_SHED_SWAP_USED_FRACTION,
    },
  };
}

function parseConfigFile(
  configPath: string,
  mode: ConfigMode,
  defaults?: ConfigDefaults,
): AppConfig {
  const configDir = dirname(configPath);
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as unknown;
  const root = asObject(raw, "config");

  const resolvedDefaults = defaults ?? defaultConfigDefaults(configDir);
  const server = root["server"] ? asObject(root["server"], "server") : {};
  const tmux = root["tmux"] ? asObject(root["tmux"], "tmux") : {};
  const ui = root["ui"] ? asObject(root["ui"], "ui") : {};
  const models = mode === "instance" && root["models"] ? asObject(root["models"], "models") : {};
  const voice = root["voice"] ? asObject(root["voice"], "voice") : {};
  const eventLog = root["eventLog"] ? asObject(root["eventLog"], "eventLog") : {};
  const userActionLog = root["userActionLog"]
    ? asObject(root["userActionLog"], "userActionLog")
    : {};
  const rateLimitReactivation = root["rateLimitReactivation"]
    ? asObject(root["rateLimitReactivation"], "rateLimitReactivation")
    : {};
  const projectsRaw =
    root["projects"] === undefined ? undefined : asObject(root["projects"], "projects");
  if (mode === "project" && projectsRaw === undefined) {
    throw new Error("projects must be an object");
  }

  const normalizedProjects: Record<string, ProjectConfig> = {};
  const prefixOwners = new Map<string, string>();
  for (const [projectId, projectValue] of Object.entries(projectsRaw ?? {})) {
    const parsedProject = parseProject(configDir, projectId, projectValue);
    const existingOwner = prefixOwners.get(parsedProject.sessionPrefix);
    if (existingOwner) {
      throw new Error(
        `sessionPrefix "${parsedProject.sessionPrefix}" is duplicated in projects.${existingOwner} and projects.${projectId}`,
      );
    }
    prefixOwners.set(parsedProject.sessionPrefix, projectId);
    normalizedProjects[projectId] = parsedProject;
  }
  validateTelegramBotTokens(normalizedProjects);

  const tags = parseTags(root["tags"]);

  const projectsRootRaw =
    mode === "instance" ? asOptionalString(root["projectsRoot"], "projectsRoot") : undefined;

  const serverPort =
    mode === "instance"
      ? (asOptionalNumber(server["port"], "server.port") ?? resolvedDefaults.serverPort)
      : resolvedDefaults.serverPort;

  const dataDir =
    mode === "instance"
      ? resolveFrom(
          configDir,
          asOptionalString(root["dataDir"], "dataDir") ?? resolvedDefaults.dataDir,
        )
      : resolvedDefaults.dataDir;

  const projectsRoot =
    projectsRootRaw !== undefined
      ? resolveFrom(configDir, projectsRootRaw)
      : join(dataDir, "projects");

  return {
    configPath,
    server: {
      host:
        mode === "instance"
          ? (asOptionalString(server["host"], "server.host") ?? resolvedDefaults.serverHost)
          : resolvedDefaults.serverHost,
      port: serverPort,
    },
    dataDir,
    worktreeDir:
      mode === "instance"
        ? resolveFrom(
            configDir,
            asOptionalString(root["worktreeDir"], "worktreeDir") ?? resolvedDefaults.worktreeDir,
          )
        : resolvedDefaults.worktreeDir,
    projectsRoot,
    defaultAgent:
      mode === "instance"
        ? (asOptionalAgent(root["defaultAgent"], "defaultAgent") ?? resolvedDefaults.defaultAgent)
        : resolvedDefaults.defaultAgent,
    tmux: {
      socketName:
        mode === "instance"
          ? (asOptionalString(tmux["socketName"], "tmux.socketName") ??
            defaultTmuxSocketName(serverPort))
          : resolvedDefaults.tmuxSocketName,
    },
    ui: {
      port:
        mode === "instance"
          ? (asOptionalNumber(ui["port"], "ui.port") ?? resolvedDefaults.uiPort)
          : resolvedDefaults.uiPort,
    },
    models: {
      codexHome:
        mode === "instance"
          ? resolveFrom(
              configDir,
              asOptionalString(models["codexHome"], "models.codexHome") ??
                resolvedDefaults.codexHome,
            )
          : resolvedDefaults.codexHome,
    },
    voice: (() => {
      if (mode === "project") {
        if (resolvedDefaults.voiceProvider === "openai_compatible") {
          return {
            provider: "openai_compatible" as const,
            language: resolvedDefaults.voiceLanguage,
            model: resolvedDefaults.voiceModel,
            baseUrl: resolvedDefaults.voiceBaseUrl ?? "",
            apiKey: resolvedDefaults.voiceApiKey ?? "",
          };
        }
        if (resolvedDefaults.voiceProvider === "azure_openai") {
          return {
            provider: "azure_openai" as const,
            language: resolvedDefaults.voiceLanguage,
            model: resolvedDefaults.voiceModel,
            ...(resolvedDefaults.voiceEndpoint !== undefined
              ? { endpoint: resolvedDefaults.voiceEndpoint }
              : {}),
            ...(resolvedDefaults.voiceApiKey !== undefined
              ? { apiKey: resolvedDefaults.voiceApiKey }
              : {}),
            ...(resolvedDefaults.voiceApiVersion !== undefined
              ? { apiVersion: resolvedDefaults.voiceApiVersion }
              : {}),
          };
        }
        return {
          provider: resolvedDefaults.voiceProvider,
          language: resolvedDefaults.voiceLanguage,
          model: resolvedDefaults.voiceModel,
          ...(resolvedDefaults.voiceModelPath !== undefined
            ? { modelPath: resolvedDefaults.voiceModelPath }
            : {}),
        };
      }

      const provider =
        asOptionalVoiceProvider(voice["provider"], "voice.provider") ??
        resolvedDefaults.voiceProvider;
      const model = asOptionalString(voice["model"], "voice.model") ?? resolvedDefaults.voiceModel;
      const language =
        asOptionalString(voice["language"], "voice.language") ?? resolvedDefaults.voiceLanguage;

      if (provider === "openai_compatible") {
        const baseUrlRaw = asOptionalString(voice["baseUrl"], "voice.baseUrl");
        const apiKey = asOptionalString(voice["apiKey"], "voice.apiKey");
        if (!baseUrlRaw || !apiKey) {
          throw new Error(
            'voice.provider="openai_compatible" requires voice.baseUrl and voice.apiKey',
          );
        }
        if (!/^[A-Z][A-Z0-9_]*$/.test(apiKey)) {
          throw new Error(`voice.apiKey must match /^[A-Z][A-Z0-9_]*$/ (received "${apiKey}")`);
        }
        const baseUrl = baseUrlRaw.replace(/\/+$/, "");
        return { provider, language, model, baseUrl, apiKey };
      }

      if (provider === "openai_realtime") {
        return { provider, language, model };
      }

      if (provider === "azure_openai") {
        const endpointRaw = asOptionalString(voice["endpoint"], "voice.endpoint");
        const apiKey = asOptionalString(voice["apiKey"], "voice.apiKey");
        const apiVersion = asOptionalString(voice["apiVersion"], "voice.apiVersion");
        if (apiKey && !/^[A-Z][A-Z0-9_]*$/.test(apiKey)) {
          throw new Error(`voice.apiKey must match /^[A-Z][A-Z0-9_]*$/ (received "${apiKey}")`);
        }
        return {
          provider,
          language,
          model,
          ...(endpointRaw ? { endpoint: endpointRaw.replace(/\/+$/, "") } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(apiVersion ? { apiVersion } : {}),
        };
      }

      const configuredModelPath = asOptionalString(voice["modelPath"], "voice.modelPath");
      const modelPath = configuredModelPath
        ? resolveFrom(configDir, configuredModelPath)
        : undefined;
      return {
        provider,
        language,
        model,
        ...(modelPath !== undefined ? { modelPath } : {}),
      };
    })(),
    eventLog:
      mode === "instance"
        ? {
            hotBytes:
              asOptionalNumber(eventLog["hotBytes"], "eventLog.hotBytes") ??
              DEFAULT_EVENT_LOG_HOT_BYTES,
            shardHotBytes:
              asOptionalNumber(eventLog["shardHotBytes"], "eventLog.shardHotBytes") ??
              DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
            retainArchives:
              asOptionalPositiveInteger(eventLog["retainArchives"], "eventLog.retainArchives") ??
              DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
            collapseWindowMs:
              asNonNegativeNumber(eventLog["collapseWindowMs"], "eventLog.collapseWindowMs") ??
              DEFAULT_EVENT_LOG_COLLAPSE_WINDOW_MS,
          }
        : DEFAULT_EVENT_LOG_CONFIG,
    userActionLog:
      mode === "instance"
        ? {
            hotBytes:
              asOptionalNumber(userActionLog["hotBytes"], "userActionLog.hotBytes") ??
              DEFAULT_USER_ACTION_LOG_HOT_BYTES,
            shardHotBytes:
              asOptionalNumber(userActionLog["shardHotBytes"], "userActionLog.shardHotBytes") ??
              DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES,
            retainArchives:
              asOptionalPositiveInteger(
                userActionLog["retainArchives"],
                "userActionLog.retainArchives",
              ) ?? DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES,
          }
        : DEFAULT_USER_ACTION_LOG_CONFIG,
    rateLimitReactivation:
      mode === "instance"
        ? {
            afterHours:
              asNonNegativeNumber(
                rateLimitReactivation["afterHours"],
                "rateLimitReactivation.afterHours",
              ) ?? 0,
          }
        : { afterHours: 0 },
    authRotation:
      mode === "instance" ? parseAuthRotation(root["authRotation"]) : DEFAULT_AUTH_ROTATION,
    sessionGc: mode === "instance" ? parseSessionGc(root["sessionGc"]) : DEFAULT_SESSION_GC,
    sidecarGc: mode === "instance" ? parseSidecarGc(root["sidecarGc"]) : DEFAULT_SIDECAR_GC,
    admission: parseAdmission(root["admission"], mode),
    projects: normalizedProjects,
    tags,
  };
}

function findConfigInDirectory(
  directory: string,
  filenames: readonly string[],
): string | undefined {
  const current = resolve(directory);
  for (const filename of filenames) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findConfigUpwards(startDir: string, filenames: readonly string[]): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const found = findConfigInDirectory(current, filenames);
    if (found) return found;

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function defaultInstanceConfigPath(): string {
  return DEFAULT_INSTANCE_CONFIG_PATH;
}

export function defaultVoiceModelPath(): string {
  return DEFAULT_VOICE_MODEL_PATH;
}

export function resolveInstanceConfigPath(input?: string): string {
  const candidate = input?.trim() || process.env["SPUR_CONFIG"]?.trim();
  return candidate
    ? resolveFrom(process.cwd(), candidate)
    : resolveFrom(process.cwd(), DEFAULT_INSTANCE_CONFIG_PATH);
}

export function instanceConfigExists(input?: string): boolean {
  return existsSync(resolveInstanceConfigPath(input));
}

// Tolerant of a symlinked/bind-mounted $HOME: resolves both paths to their
// real on-disk location before comparing, falling back to a plain resolved
// string compare when either side does not exist (e.g. a config path that is
// about to be bootstrap-created).
function samePathOnDisk(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function isDefaultInstanceConfigPath(configPath: string): boolean {
  return samePathOnDisk(configPath, DEFAULT_INSTANCE_CONFIG_PATH);
}

// Pure guard, no writes: `daemon start`/`stop`/`restart` (and any other
// `startServer` caller) must neither bootstrap a prod-default config
// template at an arbitrary path, nor bind or target the production slot
// (server.port 4310 or dataDir ~/.spur) from a non-default config path —
// that slot belongs only to whatever daemon boots from the default config
// path (see deploy/spur-daemon.service, which has no --config and
// Restart=always). Resolving and (read-only) parsing the config here, before
// any bootstrap write or HTTP call, is what closes both holes at once:
//   - a missing non-default path is refused instead of silently
//     bootstrap-written with prod defaults (port 4310, dataDir ~/.spur);
//   - an existing non-default path that (explicitly or by omission) still
//     resolves to port 4310 or dataDir ~/.spur is refused before `stop`/
//     `restart` can resolve a base URL from it and target production.
// The default instance config path is always exempt, regardless of
// existence or contents: refusing it would crash-loop production on first
// boot or on a legitimate restart.
//
// Known limit: the default path is homedir()-relative, so a child process
// with a temp HOME running `daemon start` with no --config gets a
// default-path config under that HOME and is exempted here, even though it
// can still win the host-global :4310 bind during a restart window. Do not
// "fix" this by re-basing on os.userInfo().homedir() — if the unit's
// Environment=HOME ever diverges from the passwd home, that flips this
// guard fail-closed on the real prod daemon and crash-loops it instead.
export function assertConfigMayUseProdSlot(input?: string): void {
  const configPath = resolveInstanceConfigPath(input);
  if (isDefaultInstanceConfigPath(configPath)) {
    return;
  }
  if (!existsSync(configPath)) {
    throw new Error(
      `Instance config ${configPath} does not exist. ` +
        `'daemon start'/'stop'/'restart' only bootstrap the default instance config (${DEFAULT_INSTANCE_CONFIG_PATH}); ` +
        `create ${configPath} first, or omit --config/SPUR_CONFIG to use the default.`,
    );
  }
  const result = loadInstanceConfigReadOnly(input);
  if (result.status !== "ok") {
    // Unparseable (or, unreachably here, absent): a config that cannot be
    // parsed cannot claim the prod slot either way. Let the real,
    // non-read-only config load surface the parse error right after.
    return;
  }
  const config = result.config;
  const prodDataDir = resolveFrom(dirname(DEFAULT_INSTANCE_CONFIG_PATH), DEFAULT_DATA_DIR);
  const claimsProdPort = config.server.port === DEFAULT_SERVER_PORT;
  const claimsProdDataDir = samePathOnDisk(config.dataDir, prodDataDir);
  if (!claimsProdPort && !claimsProdDataDir) {
    return;
  }
  throw new Error(
    `Instance config ${configPath} may not bind the production slot ` +
      `(server.port ${config.server.port}, dataDir ${config.dataDir}). ` +
      `A non-default config path must not claim port ${DEFAULT_SERVER_PORT} or dataDir ${prodDataDir}. ` +
      `Set server.port and dataDir explicitly in this config, or use scripts/spur-isolated-daemon.sh.`,
  );
}

export function ensureInstanceConfig(input?: string): { configPath: string; initialized: boolean } {
  const configPath = resolveInstanceConfigPath(input);
  if (existsSync(configPath)) {
    return { configPath, initialized: false };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, defaultInstanceConfigYaml(), "utf-8");
  return { configPath, initialized: true };
}

export type InstanceConfigReadResult =
  | { status: "absent" }
  | { status: "invalid"; error: string }
  | { status: "ok"; config: AppConfig };

// Read-only counterpart to `loadConfig`/`ensureInstanceConfig`: never
// bootstrap-writes `~/.spur/config.yaml` when it is missing (that write is a
// deliberate `ensureInstanceConfig` side effect other callers rely on).
// `doctor` needs to distinguish "never initialized" (not an error) from "a
// real, corrupt instance config sitting on disk" (an error) without ever
// creating the file as a side effect of merely checking it.
export function loadInstanceConfigReadOnly(input?: string): InstanceConfigReadResult {
  if (!instanceConfigExists(input)) {
    return { status: "absent" };
  }
  try {
    return { status: "ok", config: parseConfigFile(resolveInstanceConfigPath(input), "instance") };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function findProjectConfigPath(startDir = process.cwd()): string | undefined {
  return findConfigUpwards(startDir, DEFAULT_PROJECT_CONFIG_FILES);
}

export function findProjectConfigPathInDirectory(startDir = process.cwd()): string | undefined {
  return findConfigInDirectory(startDir, DEFAULT_PROJECT_CONFIG_FILES);
}

export function resolveConfigPath(input?: string): string {
  const candidate = input?.trim();
  if (candidate) {
    const resolved = resolveFrom(process.cwd(), candidate);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  const found = findProjectConfigPath(process.cwd());
  if (found) {
    return found;
  }

  throw new Error(
    `Config file not found: ${resolveFrom(process.cwd(), DEFAULT_PROJECT_CONFIG_FILES[0])}`,
  );
}

export function loadProjectConfig(input?: string, defaults?: AppConfig): AppConfig {
  const configPath = resolveConfigPath(input);
  return parseConfigFile(
    configPath,
    "project",
    defaults
      ? {
          serverHost: defaults.server.host,
          serverPort: defaults.server.port,
          dataDir: defaults.dataDir,
          worktreeDir: defaults.worktreeDir,
          defaultAgent: defaults.defaultAgent,
          tmuxSocketName: defaults.tmux.socketName,
          uiPort: defaults.ui.port,
          codexHome: defaults.models.codexHome,
          voiceProvider: defaults.voice.provider,
          voiceLanguage: defaults.voice.language,
          voiceModel: defaults.voice.model,
          ...(defaults.voice.provider === "openai_compatible"
            ? {
                voiceBaseUrl: defaults.voice.baseUrl,
                voiceApiKey: defaults.voice.apiKey,
              }
            : defaults.voice.provider === "azure_openai"
              ? {
                  ...(defaults.voice.endpoint !== undefined
                    ? { voiceEndpoint: defaults.voice.endpoint }
                    : {}),
                  ...(defaults.voice.apiKey !== undefined
                    ? { voiceApiKey: defaults.voice.apiKey }
                    : {}),
                  ...(defaults.voice.apiVersion !== undefined
                    ? { voiceApiVersion: defaults.voice.apiVersion }
                    : {}),
                }
              : (defaults.voice.provider === "whisper_cpp" ||
                    defaults.voice.provider === "faster_whisper") &&
                  defaults.voice.modelPath !== undefined
                ? { voiceModelPath: defaults.voice.modelPath }
                : {}),
        }
      : undefined,
  );
}

export function loadConfig(input?: string): AppConfig {
  const { configPath } = ensureInstanceConfig(input);
  return parseConfigFile(configPath, "instance");
}

export function buildSidecarLinkUrl(template: string, reservedPort: number): string {
  return template.includes("{port}")
    ? template.replaceAll("{port}", String(reservedPort))
    : `${template}:${reservedPort}`;
}
