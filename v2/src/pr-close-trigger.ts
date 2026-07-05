import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadConfig, resolveConfigPath } from "./config.js";
import type { ProjectConfig, SendTriggerConfig, TriggerConfig } from "./types.js";

export const PR_CLOSE_TRIGGER_EVENT = "github:closed" as const;
export const DEFAULT_PR_CLOSE_TRIGGER_ID = "gh-closed";
export const DEFAULT_PR_CLOSE_TRIGGER_PROMPT =
  "Run $manager. The active PR was closed without merging.";

export interface PrCloseTriggerInfo {
  ok: true;
  projectId: string;
  configPath: string;
  triggerId: string;
  sourceId: string;
  event: typeof PR_CLOSE_TRIGGER_EVENT;
  prompt: string;
  created: boolean;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSendTriggerConfig(value: TriggerConfig): value is SendTriggerConfig {
  return "send" in value;
}

export function findPrCloseTrigger(
  project: ProjectConfig,
): { triggerId: string; config: SendTriggerConfig } | null {
  for (const [triggerId, trigger] of Object.entries(project.triggers)) {
    if (isSendTriggerConfig(trigger) && trigger.event === PR_CLOSE_TRIGGER_EVENT) {
      return { triggerId, config: trigger };
    }
  }
  return null;
}

export function resolveGithubSourceForPrClose(project: ProjectConfig): string | null {
  const existing = findPrCloseTrigger(project);
  if (existing) {
    return existing.config.source;
  }

  for (const trigger of Object.values(project.triggers)) {
    if (!isSendTriggerConfig(trigger) || !trigger.event.startsWith("github:")) {
      continue;
    }
    const source = project.sources[trigger.source];
    if (source?.type === "github") {
      return trigger.source;
    }
  }

  for (const [sourceId, source] of Object.entries(project.sources)) {
    if (source.type === "github") {
      return sourceId;
    }
  }

  return null;
}

function readProjectDocument(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf8");
  const parsed = parseYaml(raw) as unknown;
  if (!isMapping(parsed) || !isMapping(parsed.projects)) {
    throw new Error(`Project config at ${configPath} must define projects`);
  }
  return parsed;
}

function writeProjectDocument(configPath: string, document: Record<string, unknown>): void {
  writeFileSync(configPath, stringifyYaml(document), "utf8");
}

function resolveProjectId(
  projects: Record<string, ProjectConfig>,
  projectId: string | undefined,
): string {
  if (projectId) {
    if (!projects[projectId]) {
      throw new Error(`Unknown project "${projectId}"`);
    }
    return projectId;
  }

  const sessionProject = process.env["SPUR_PROJECT"]?.trim();
  if (sessionProject) {
    if (!projects[sessionProject]) {
      throw new Error(`Unknown project "${sessionProject}" from SPUR_PROJECT`);
    }
    return sessionProject;
  }

  const ids = Object.keys(projects);
  if (ids.length === 1) {
    return ids[0]!;
  }
  if (ids.length === 0) {
    throw new Error("No projects defined in config");
  }
  throw new Error(`Multiple projects in config; pass --project (${ids.join(", ")})`);
}

function promptFromTrigger(trigger: SendTriggerConfig): string {
  return trigger.send.prompt ?? DEFAULT_PR_CLOSE_TRIGGER_PROMPT;
}

export function describePrCloseTrigger(args: {
  configPath: string;
  projectId?: string;
}): PrCloseTriggerInfo {
  const configPath = resolveConfigPath(args.configPath);
  const config = loadConfig(configPath);
  const projectId = resolveProjectId(config.projects, args.projectId);
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project "${projectId}"`);
  }

  const existing = findPrCloseTrigger(project);
  if (!existing) {
    throw new Error(
      `No ${PR_CLOSE_TRIGGER_EVENT} trigger in project "${projectId}"; run spur trigger pr-close to create one`,
    );
  }

  return {
    ok: true,
    projectId,
    configPath,
    triggerId: existing.triggerId,
    sourceId: existing.config.source,
    event: PR_CLOSE_TRIGGER_EVENT,
    prompt: promptFromTrigger(existing.config),
    created: false,
  };
}

export function ensurePrCloseTrigger(args: {
  configPath?: string;
  projectId?: string;
  triggerId?: string;
  prompt?: string;
}): PrCloseTriggerInfo {
  const configPath = resolveConfigPath(args.configPath);
  const config = loadConfig(configPath);
  const projectId = resolveProjectId(config.projects, args.projectId);
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project "${projectId}"`);
  }

  const existing = findPrCloseTrigger(project);
  if (existing) {
    return {
      ok: true,
      projectId,
      configPath,
      triggerId: existing.triggerId,
      sourceId: existing.config.source,
      event: PR_CLOSE_TRIGGER_EVENT,
      prompt: promptFromTrigger(existing.config),
      created: false,
    };
  }

  const sourceId = resolveGithubSourceForPrClose(project);
  if (!sourceId) {
    throw new Error(
      `Project "${projectId}" has no github source; add a github source before creating a PR close trigger`,
    );
  }

  const triggerId = args.triggerId?.trim() || DEFAULT_PR_CLOSE_TRIGGER_ID;
  if (project.triggers[triggerId]) {
    throw new Error(`Trigger "${triggerId}" already exists with a different event`);
  }

  const prompt = args.prompt?.trim() || DEFAULT_PR_CLOSE_TRIGGER_PROMPT;
  const document = readProjectDocument(configPath);
  const projects = document.projects as Record<string, Record<string, unknown>>;
  const projectDoc = projects[projectId];
  if (!isMapping(projectDoc)) {
    throw new Error(`Invalid project entry for "${projectId}"`);
  }

  const triggers = isMapping(projectDoc.triggers) ? { ...projectDoc.triggers } : {};
  triggers[triggerId] = {
    source: sourceId,
    event: PR_CLOSE_TRIGGER_EVENT,
    send: {
      prompt,
    },
  };
  projectDoc.triggers = triggers;
  writeProjectDocument(configPath, document);

  return {
    ok: true,
    projectId,
    configPath,
    triggerId,
    sourceId,
    event: PR_CLOSE_TRIGGER_EVENT,
    prompt,
    created: true,
  };
}

export function formatPrCloseTriggerInfo(info: PrCloseTriggerInfo): string {
  const status = info.created ? "Created" : "Already configured";
  return [
    `${status} ${PR_CLOSE_TRIGGER_EVENT} trigger for project ${info.projectId}.`,
    `  config: ${info.configPath}`,
    `  trigger: ${info.triggerId}`,
    `  source: ${info.sourceId}`,
    `  prompt: ${info.prompt}`,
  ].join("\n");
}
