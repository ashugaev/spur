import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GITHUB_SIGNAL_KINDS as VALID_GITHUB_SIGNAL_KINDS,
  type AgentName,
  type AppConfig,
  type CronSourceConfig,
  type GitHubSourceConfig,
  type ProjectConfig,
  type ProjectPreflightConfig,
  type ProjectSpawnConfig,
  type SendTriggerConfig,
  type ServiceRuleConfig,
  type ServiceSourceConfig,
  type SidecarConfig,
  type SourceConfig,
  type TriggerConfig,
} from "./types.js";
import { DEFAULT_PROJECT_PREFLIGHT_PROMPT } from "./preflight-contract.js";
import { parseSpawnOverrides } from "./spawn-overrides.js";

const DEFAULT_PROJECT_CONFIG_FILES = ["spur.yaml", "spur.yml"] as const;
const DEFAULT_INSTANCE_CONFIG_PATH = join(homedir(), ".spur", "config.yaml");
const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_SERVER_PORT = 4310;
const DEFAULT_DATA_DIR = "~/.spur";
const DEFAULT_WORKTREE_DIR = "~/.spur/worktrees";
const DEFAULT_UI_PORT = 5555;
const DEFAULT_VOICE_MODEL_PATH = "~/.cache/whisper.cpp/ggml-base.bin";
const DEFAULT_VOICE_PROVIDER = "whisper_cpp";
const DEFAULT_VOICE_LANGUAGE = "auto";
const DEFAULT_VOICE_MODEL = "base";
const VALID_ID_RE = /^[a-zA-Z0-9_-]+$/;

type ConfigMode = "instance" | "project";

interface ConfigDefaults {
  serverHost: string;
  serverPort: number;
  dataDir: string;
  worktreeDir: string;
  defaultAgent: AgentName;
  tmuxSocketName: string;
  uiPort: number;
  voiceProvider: "whisper_cpp" | "faster_whisper" | "azure_openai";
  voiceModelPath?: string;
  voiceLanguage: string;
  voiceModel: string;
}

function expandHome(value: string): string {
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

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
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

function asOptionalVoiceProvider(
  value: unknown,
  label: string,
): "whisper_cpp" | "faster_whisper" | "azure_openai" | undefined {
  if (value === undefined) return undefined;
  if (value === "whisper_cpp" || value === "faster_whisper" || value === "azure_openai") {
    return value;
  }
  throw new Error(`${label} must be "whisper_cpp", "faster_whisper", or "azure_openai"`);
}

function expectedEventsForSource(source: SourceConfig): string[] {
  if (source.type === "cron") {
    return ["cron:tick"];
  }
  if (source.type === "service") {
    return Object.keys(source.rules).map((ruleId) => `service:${ruleId}`);
  }
  return VALID_GITHUB_SIGNAL_KINDS.map((kind) => `github:${kind}`);
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

function parseGitHubSource(
  projectId: string,
  sourceId: string,
  raw: Record<string, unknown>,
): GitHubSourceConfig {
  const label = `projects.${projectId}.sources.${sourceId}`;
  return {
    type: "github",
    runOnStart: asOptionalBoolean(raw["runOnStart"], `${label}.runOnStart`) ?? false,
    intervalMs: asOptionalNumber(raw["intervalMs"], `${label}.intervalMs`) ?? 60_000,
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

function parseSource(projectId: string, sourceId: string, value: unknown): SourceConfig {
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
  if (type === "github") {
    return parseGitHubSource(projectId, sourceId, raw);
  }
  if (type === "service") {
    return parseServiceSource(projectId, sourceId, raw);
  }

  throw new Error(`${label}.type uses unsupported source type "${type}"`);
}

function parseSendConfig(
  projectId: string,
  triggerId: string,
  raw: Record<string, unknown>,
): SendTriggerConfig["send"] {
  const label = `projects.${projectId}.triggers.${triggerId}.send`;
  const sendRaw = asObject(raw["send"], label);
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

function parseSidecars(projectId: string, value: unknown): Record<string, SidecarConfig> {
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
    const command = asString(entryRaw["command"], `${entryLabel}.command`);
    const autoStart = asOptionalBoolean(entryRaw["autoStart"], `${entryLabel}.autoStart`) ?? false;
    const envRaw = entryRaw["env"];
    let env: Record<string, string> | undefined;
    if (envRaw !== undefined) {
      const envObj = asObject(envRaw, `${entryLabel}.env`);
      env = {};
      for (const [k, v] of Object.entries(envObj)) {
        env[k] = asString(v, `${entryLabel}.env.${k}`);
      }
    }
    const portsRaw = entryRaw["ports"];
    let ports: SidecarConfig["ports"];
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
        ports[portId] = {
          env: asString(portObj["env"], `${portLabel}.env`),
          start,
          end,
        };
      }
    }
    result[name] = { command, autoStart, ...(env ? { env } : {}), ...(ports ? { ports } : {}) };
  }
  return result;
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

  if (hasSend) {
    return { source, event, send: parseSendConfig(projectId, triggerId, raw) };
  }

  const spawnRaw = asObject(raw["spawn"], `${label}.spawn`);
  const prompt = asString(spawnRaw["prompt"], `${label}.spawn.prompt`);
  const steps = asOptionalStringArray(spawnRaw["steps"], `${label}.spawn.steps`);
  const agent = asOptionalAgent(spawnRaw["agent"], `${label}.spawn.agent`);
  const branch = asOptionalString(spawnRaw["branch"], `${label}.spawn.branch`);
  const overrides = parseSpawnOverrides(spawnRaw["overrides"], `${label}.spawn.overrides`);

  return {
    source,
    event,
    spawn: {
      prompt,
      ...(steps !== undefined ? { steps } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
    },
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
  const name = asOptionalString(raw["name"], `${label}.name`);
  const defaultBranch = asOptionalString(raw["defaultBranch"], `${label}.defaultBranch`) ?? "main";
  const sessionPrefix =
    asOptionalString(raw["sessionPrefix"], `${label}.sessionPrefix`) ?? derivePrefix(projectId);
  const worktree = asOptionalBoolean(raw["worktree"], `${label}.worktree`) ?? true;
  const symlinks = asOptionalStringArray(raw["symlinks"], `${label}.symlinks`) ?? [];
  const codexArgs = asOptionalStringArray(raw["codexArgs"], `${label}.codexArgs`);
  const spawn = parseProjectSpawn(projectId, raw["spawn"]);
  const preflight = parseProjectPreflight(projectId, raw["preflight"]);
  const devServer = parseDevServer(projectId, raw["devServer"]);
  const hasDevServerKey = raw["devServer"] !== undefined;
  const hasSidecarsKey = raw["sidecars"] !== undefined;
  if (hasDevServerKey && hasSidecarsKey) {
    throw new Error(`projects.${projectId} defines both "devServer" and "sidecars"; pick one`);
  }
  const sidecars = hasSidecarsKey
    ? parseSidecars(projectId, raw["sidecars"])
    : devServer
      ? parseDevServerAsSidecar(devServer)
      : {};
  const defaultAgent = asOptionalAgent(raw["defaultAgent"], `${label}.defaultAgent`);
  const sourcesRaw = raw["sources"] ? asObject(raw["sources"], `${label}.sources`) : {};
  const sources: Record<string, SourceConfig> = {};
  for (const [sourceId, sourceValue] of Object.entries(sourcesRaw)) {
    sources[sourceId] = parseSource(projectId, sourceId, sourceValue);
  }
  const triggersRaw = raw["triggers"] ? asObject(raw["triggers"], `${label}.triggers`) : {};
  const triggers: Record<string, TriggerConfig> = {};
  for (const [triggerId, triggerValue] of Object.entries(triggersRaw)) {
    triggers[triggerId] = parseTrigger(projectId, triggerId, triggerValue, sources);
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
    symlinks,
    ...(codexArgs !== undefined ? { codexArgs } : {}),
    ...(spawn !== undefined ? { spawn } : {}),
    ...(preflight !== undefined ? { preflight } : {}),
    sidecars,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    sources,
    triggers,
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
  const voice = root["voice"] ? asObject(root["voice"], "voice") : {};
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

  const serverPort =
    mode === "instance"
      ? (asOptionalNumber(server["port"], "server.port") ?? resolvedDefaults.serverPort)
      : resolvedDefaults.serverPort;

  return {
    configPath,
    server: {
      host:
        mode === "instance"
          ? (asOptionalString(server["host"], "server.host") ?? resolvedDefaults.serverHost)
          : resolvedDefaults.serverHost,
      port: serverPort,
    },
    dataDir:
      mode === "instance"
        ? resolveFrom(
            configDir,
            asOptionalString(root["dataDir"], "dataDir") ?? resolvedDefaults.dataDir,
          )
        : resolvedDefaults.dataDir,
    worktreeDir:
      mode === "instance"
        ? resolveFrom(
            configDir,
            asOptionalString(root["worktreeDir"], "worktreeDir") ?? resolvedDefaults.worktreeDir,
          )
        : resolvedDefaults.worktreeDir,
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
    voice: (() => {
      const provider =
        mode === "instance"
          ? (asOptionalVoiceProvider(voice["provider"], "voice.provider") ??
            resolvedDefaults.voiceProvider)
          : resolvedDefaults.voiceProvider;
      const model =
        mode === "instance"
          ? (asOptionalString(voice["model"], "voice.model") ?? resolvedDefaults.voiceModel)
          : resolvedDefaults.voiceModel;
      const configuredModelPath =
        mode === "instance"
          ? asOptionalString(voice["modelPath"], "voice.modelPath")
          : asOptionalString(voice["modelPath"], "voice.modelPath");
      const modelPath = configuredModelPath
        ? resolveFrom(configDir, configuredModelPath)
        : undefined;

      return {
        provider,
        language:
          mode === "instance"
            ? (asOptionalString(voice["language"], "voice.language") ??
              resolvedDefaults.voiceLanguage)
            : resolvedDefaults.voiceLanguage,
        model,
        ...(modelPath !== undefined ? { modelPath } : {}),
      };
    })(),
    projects: normalizedProjects,
  };
}

function findConfigUpwards(startDir: string, filenames: readonly string[]): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    for (const filename of filenames) {
      const candidate = join(current, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
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

export function ensureInstanceConfig(input?: string): { configPath: string; initialized: boolean } {
  const configPath = resolveInstanceConfigPath(input);
  if (existsSync(configPath)) {
    return { configPath, initialized: false };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, defaultInstanceConfigYaml(), "utf-8");
  return { configPath, initialized: true };
}

export function findProjectConfigPath(startDir = process.cwd()): string | undefined {
  return findConfigUpwards(startDir, DEFAULT_PROJECT_CONFIG_FILES);
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
          voiceProvider: defaults.voice.provider,
          voiceLanguage: defaults.voice.language,
          voiceModel: defaults.voice.model,
          ...(defaults.voice.modelPath !== undefined
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
