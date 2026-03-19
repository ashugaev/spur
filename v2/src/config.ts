import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GITHUB_SIGNAL_KINDS as VALID_GITHUB_SIGNAL_KINDS,
  type AgentName,
  AgentName,
  AppConfig,
  CronSourceConfig,
  GitHubSourceConfig,
  ProjectConfig,
  SendTriggerConfig,
  SourceConfig,
  TriggerConfig,
} from "./types.js";

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

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

function asOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function asOptionalAgent(value: unknown, label: string): AgentName | undefined {
  if (value === undefined) return undefined;
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(`${label} must be "claude" or "codex"`);
}

function expectedEventsForSource(source: SourceConfig): string[] {
  if (source.type === "cron") {
    return ["cron:tick"];
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

function parseSource(projectId: string, sourceId: string, value: unknown): SourceConfig {
  if (!VALID_ID.test(sourceId)) {
    throw new Error(
      `projects.${projectId}.sources.${sourceId} is invalid: source ids must match ${VALID_ID.source}`,
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

  throw new Error(`${label}.type uses unsupported source type "${type}"`);
}

function parseSendConfig(
  projectId: string,
  triggerId: string,
  raw: Record<string, unknown>,
): SendTriggerConfig["send"] {
  const label = `projects.${projectId}.triggers.${triggerId}.send`;
  const sendRaw = asObject(raw["send"], label);
  return {
    interrupt: asOptionalBoolean(sendRaw["interrupt"], `${label}.interrupt`) ?? false,
  };
}

function parseTrigger(
  projectId: string,
  triggerId: string,
  value: unknown,
  sources: Record<string, SourceConfig>,
): TriggerConfig {
  if (!VALID_ID.test(triggerId)) {
    throw new Error(
      `projects.${projectId}.triggers.${triggerId} is invalid: trigger ids must match ${VALID_ID.source}`,
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
  const agent = asOptionalAgent(spawnRaw["agent"], `${label}.spawn.agent`);
  const branch = asOptionalString(spawnRaw["branch"], `${label}.spawn.branch`);

  return {
    source,
    event,
    spawn: {
      prompt,
      ...(agent !== undefined ? { agent } : {}),
      ...(branch !== undefined ? { branch } : {}),
    },
  };
}

function parseProject(
  configDir: string,
  projectId: string,
  value: unknown,
): ProjectConfig {
  if (!VALID_ID.test(projectId)) {
    throw new Error(
      `projects.${projectId} is invalid: project ids must match ${VALID_ID.source}`,
    );
  }

  const raw = asObject(value, `projects.${projectId}`);
  const path = resolveFrom(configDir, asString(raw["path"], `projects.${projectId}.path`));
  const defaultBranch =
    asOptionalString(raw["defaultBranch"], `projects.${projectId}.defaultBranch`) ?? "main";
  const sessionPrefix =
    asOptionalString(raw["sessionPrefix"], `projects.${projectId}.sessionPrefix`) ??
    derivePrefix(projectId);
  const symlinks = asOptionalStringArray(raw["symlinks"], `projects.${projectId}.symlinks`) ?? [];
  const defaultAgent = asOptionalAgent(
    raw["defaultAgent"],
    `projects.${projectId}.defaultAgent`,
  );
  const sourcesRaw = raw["sources"]
    ? asObject(raw["sources"], `projects.${projectId}.sources`)
    : {};
  const sources: Record<string, SourceConfig> = {};
  for (const [sourceId, sourceValue] of Object.entries(sourcesRaw)) {
    const parsedSource = parseSource(projectId, sourceId, sourceValue);
    sources[sourceId] = parsedSource;
  }
  const triggersRaw = raw["triggers"]
    ? asObject(raw["triggers"], `projects.${projectId}.triggers`)
    : {};
  const triggers: Record<string, TriggerConfig> = {};
  for (const [triggerId, triggerValue] of Object.entries(triggersRaw)) {
    triggers[triggerId] = parseTrigger(projectId, triggerId, triggerValue, sources);
  }

  if (!VALID_ID.test(sessionPrefix)) {
    throw new Error(
      `projects.${projectId}.sessionPrefix must match ${VALID_ID.source}`,
    );
  }

  return {
    path,
    defaultBranch,
    sessionPrefix,
    symlinks,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    sources,
    triggers,
  };
}

export function resolveConfigPath(input?: string): string {
  const candidate = input ?? process.env["SPUR_CONFIG"] ?? "spur.yaml";
  const resolved = resolveFrom(process.cwd(), candidate);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  return resolved;
}

export function loadConfig(input?: string): AppConfig {
  const configPath = resolveConfigPath(input);
  const configDir = dirname(configPath);
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as unknown;
  const root = asObject(raw, "config");
  const server = root["server"] ? asObject(root["server"], "server") : {};
  const projects = asObject(root["projects"], "projects");
  const defaultAgent = asOptionalAgent(root["defaultAgent"], "defaultAgent") ?? "claude";
  const dataDir = resolveFrom(
    configDir,
    asOptionalString(root["dataDir"], "dataDir") ?? "~/.spur",
  );
  const worktreeDir = resolveFrom(
    configDir,
    asOptionalString(root["worktreeDir"], "worktreeDir") ?? "~/.spur-worktrees",
  );

  const normalizedProjects: Record<string, ProjectConfig> = {};
  const prefixOwners = new Map<string, string>();
  for (const [projectId, projectValue] of Object.entries(projects)) {
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

  return {
    configPath,
    server: {
      host: asOptionalString(server["host"], "server.host") ?? "127.0.0.1",
      port: asOptionalNumber(server["port"], "server.port") ?? 4310,
    },
    dataDir,
    worktreeDir,
    defaultAgent,
    projects: normalizedProjects,
  };
}
