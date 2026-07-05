import { readFileSync, writeFileSync } from "node:fs";
import { isMap, parseDocument } from "yaml";
import { loadProjectConfig, resolveConfigPath } from "./config.js";
import { reviewProvider } from "./review-providers/index.js";
import { isSendTrigger } from "./triggers.js";
import type { ProjectConfig, SendTriggerConfig, TriggerConfig } from "./types.js";

export const PR_CLOSE_TRIGGER_EVENT = "github:closed" as const;
export const DEFAULT_PR_CLOSE_TRIGGER_ID = "gh-closed";
export const DEFAULT_PR_CLOSE_TRIGGER_PROMPT =
  "Run $manager. The active PR was closed without merging.";

export interface PrCloseTriggerMatch {
  triggerId: string;
  sourceId: string;
  kind: "send" | "spawn";
  config: TriggerConfig;
}

export interface PrCloseTriggerInfo {
  ok: true;
  projectId: string;
  configPath: string;
  triggerId: string;
  sourceId: string;
  event: typeof PR_CLOSE_TRIGGER_EVENT;
  kind: "send" | "spawn";
  prompt: string;
  created: boolean;
}

export function findPrCloseTrigger(project: ProjectConfig): PrCloseTriggerMatch | null {
  for (const [triggerId, trigger] of Object.entries(project.triggers)) {
    if (trigger.event !== PR_CLOSE_TRIGGER_EVENT) {
      continue;
    }
    return {
      triggerId,
      sourceId: trigger.source,
      kind: isSendTrigger(trigger) ? "send" : "spawn",
      config: trigger,
    };
  }
  return null;
}

export function resolveGithubSourceForPrClose(project: ProjectConfig): string | null {
  for (const trigger of Object.values(project.triggers)) {
    if (!isSendTrigger(trigger) || !trigger.event.startsWith("github:")) {
      continue;
    }
    if (project.sources[trigger.source]?.type === "github") {
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
    const onlyProjectId = ids[0];
    if (onlyProjectId !== undefined) {
      return onlyProjectId;
    }
  }
  if (ids.length === 0) {
    throw new Error("No projects defined in config");
  }
  throw new Error(`Multiple projects in config; pass --project (${ids.join(", ")})`);
}

function runtimeDefaultClosedPrompt(): string {
  const provider = reviewProvider("github");
  return [
    provider.instructionsLine,
    `The ${provider.requestLabel} was closed without merging.`,
    provider.commandLine,
  ].join("\n");
}

function promptFromMatch(match: PrCloseTriggerMatch): string {
  if (match.kind === "spawn") {
    return "(spawn trigger)";
  }
  const trigger = match.config as SendTriggerConfig;
  if (trigger.send.prompt !== undefined) {
    return trigger.send.prompt;
  }
  return runtimeDefaultClosedPrompt();
}

function appendPrCloseSendTrigger(
  configPath: string,
  projectId: string,
  triggerId: string,
  sourceId: string,
  prompt: string,
): void {
  const source = readFileSync(configPath, "utf8");
  const doc = parseDocument(source);
  const projects = doc.get("projects", true);
  if (!isMap(projects)) {
    throw new Error(`Project config at ${configPath} must define projects`);
  }
  const project = projects.get(projectId, true);
  if (!isMap(project)) {
    throw new Error(`Unknown project "${projectId}" in ${configPath}`);
  }
  let triggers = project.get("triggers");
  if (!triggers) {
    project.set("triggers", doc.createNode({}));
    triggers = project.get("triggers");
  }
  if (!isMap(triggers)) {
    throw new Error(`Invalid triggers entry for project "${projectId}"`);
  }
  if (triggers.has(triggerId)) {
    throw new Error(`Trigger "${triggerId}" already exists`);
  }
  triggers.set(
    triggerId,
    doc.createNode({
      source: sourceId,
      event: PR_CLOSE_TRIGGER_EVENT,
      send: {
        prompt,
      },
    }),
  );
  writeFileSync(configPath, String(doc));
}

function toInfo(
  args: {
    projectId: string;
    configPath: string;
    created: boolean;
  },
  match: PrCloseTriggerMatch,
): PrCloseTriggerInfo {
  return {
    ok: true,
    projectId: args.projectId,
    configPath: args.configPath,
    triggerId: match.triggerId,
    sourceId: match.sourceId,
    event: PR_CLOSE_TRIGGER_EVENT,
    kind: match.kind,
    prompt: promptFromMatch(match),
    created: args.created,
  };
}

export function describePrCloseTrigger(args: {
  configPath: string;
  projectId?: string;
}): PrCloseTriggerInfo {
  const configPath = resolveConfigPath(args.configPath);
  const config = loadProjectConfig(configPath);
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

  return toInfo({ projectId, configPath, created: false }, existing);
}

export function ensurePrCloseTrigger(args: {
  configPath?: string;
  projectId?: string;
}): PrCloseTriggerInfo {
  const configPath = resolveConfigPath(args.configPath);
  const config = loadProjectConfig(configPath);
  const projectId = resolveProjectId(config.projects, args.projectId);
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project "${projectId}"`);
  }

  const existing = findPrCloseTrigger(project);
  if (existing) {
    return toInfo({ projectId, configPath, created: false }, existing);
  }

  const sourceId = resolveGithubSourceForPrClose(project);
  if (!sourceId) {
    throw new Error(
      `Project "${projectId}" has no github source; add a github source before creating a PR close trigger`,
    );
  }

  const triggerId = DEFAULT_PR_CLOSE_TRIGGER_ID;
  if (project.triggers[triggerId]) {
    throw new Error(`Trigger "${triggerId}" already exists with a different event`);
  }

  const prompt = DEFAULT_PR_CLOSE_TRIGGER_PROMPT;
  appendPrCloseSendTrigger(configPath, projectId, triggerId, sourceId, prompt);

  return {
    ok: true,
    projectId,
    configPath,
    triggerId,
    sourceId,
    event: PR_CLOSE_TRIGGER_EVENT,
    kind: "send",
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
    `  kind: ${info.kind}`,
    `  prompt: ${info.prompt}`,
  ].join("\n");
}
