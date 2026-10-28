import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { Cron } from "croner";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { parseConfigText, parseTriggerSpawnBlock } from "./config.js";
import { ownerFor, resolveCronOwnerFiles } from "./cron-jobs.js";
import { deriveMinimumIntervalMs } from "./event-sources/cron.js";
import type {
  AppConfig,
  CronJobEditBlock,
  CronJobEditDraft,
  CronJobEditResult,
  CronJobEditUpdate,
} from "./types.js";

export class CronJobEditError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export interface CronJobIdentity {
  projectId: string;
  sourceId: string;
  triggerId: string;
}

export interface CronJobEditorContext {
  bootstrapConfigPath: string;
  registryPaths: readonly string[];
  running: AppConfig;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conflict(): never {
  throw new CronJobEditError(409, "config_changed", "Config file changed. Reload before saving.");
}

function unsupported(): never {
  throw new CronJobEditError(
    422,
    "unsupported_yaml",
    "Edit this job in YAML: editor targets must use explicit mappings and scalars without anchors, aliases or merge keys.",
  );
}

function mapping(value: unknown): YAMLMap<unknown, unknown> {
  if (!isMap(value) || value.anchor || value.has("<<")) unsupported();
  return value;
}

function editableScalar(map: YAMLMap<unknown, unknown>, key: string): void {
  if (!map.has(key)) return;
  const node = map.get(key, true);
  if (!isScalar(node) || node.anchor || typeof node.value !== "string") unsupported();
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new CronJobEditError(400, "invalid_body", "Unexpected editor request fields.");
  }
  return value as Record<string, unknown>;
}

export function cronJobIdentity(params: URLSearchParams): CronJobIdentity {
  const projectId = params.get("project")?.trim();
  const sourceId = params.get("source")?.trim();
  const triggerId = params.get("trigger")?.trim();
  if (!projectId || !sourceId || !triggerId) {
    throw new CronJobEditError(
      400,
      "invalid_identity",
      "Project, source and trigger are required.",
    );
  }
  return { projectId, sourceId, triggerId };
}

function parseUpdate(value: unknown): CronJobEditUpdate {
  const body = exactObject(value, ["revision", "schedule", "blocks"]);
  if (
    typeof body["revision"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(body["revision"]) ||
    typeof body["schedule"] !== "string" ||
    !Array.isArray(body["blocks"]) ||
    body["blocks"].length === 0
  ) {
    throw new CronJobEditError(
      400,
      "invalid_body",
      "Revision, schedule and existing blocks are required.",
    );
  }
  const blocks = body["blocks"].map((value: unknown, index: number): CronJobEditBlock => {
    const raw = exactObject(value, ["prompt", "agent", "model", "reasoningEffort"]);
    if (
      typeof raw["prompt"] !== "string" ||
      ["agent", "model", "reasoningEffort"].some(
        (key) => raw[key] !== null && typeof raw[key] !== "string",
      )
    ) {
      throw new CronJobEditError(
        400,
        "invalid_body",
        "Block fields must be strings or null overrides.",
      );
    }
    try {
      const parsed = parseTriggerSpawnBlock(
        Object.fromEntries(Object.entries(raw).filter(([, field]) => field !== null)),
        `blocks[${index}]`,
      );
      return {
        prompt: raw["prompt"],
        agent: parsed.agent ?? null,
        model: raw["model"] as string | null,
        reasoningEffort: parsed.reasoningEffort ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid spawn block.";
      const field = message.match(/^blocks\[\d+\]\.(prompt|agent|model|reasoningEffort)/)?.[0];
      throw new CronJobEditError(422, "invalid_block", message, field);
    }
  });
  return { revision: body["revision"], schedule: body["schedule"], blocks };
}

function validateSchedule(schedule: string): void {
  let cron: Cron | undefined;
  try {
    cron = new Cron(schedule, { paused: true });
    deriveMinimumIntervalMs(cron, schedule);
  } catch {
    throw new CronJobEditError(422, "invalid_schedule", "Invalid cron schedule.", "schedule");
  } finally {
    cron?.stop();
  }
}

function snapshot(context: CronJobEditorContext, identity: CronJobIdentity) {
  const { projectId, sourceId, triggerId } = identity;
  const owner = ownerFor(
    projectId,
    resolveCronOwnerFiles(context.bootstrapConfigPath, context.registryPaths, context.running),
  );
  if (owner.state === "ambiguous") {
    throw new CronJobEditError(
      409,
      "owner_ambiguous",
      "Cannot identify a valid owning config file.",
    );
  }
  if (owner.state === "project_removed") {
    throw new CronJobEditError(404, "not_found", "Project no longer exists on disk.");
  }
  if (owner.state === "invalid") {
    throw new CronJobEditError(
      422,
      "config_invalid",
      "Owning config is invalid. Fix YAML before editing.",
    );
  }
  const physicalPath = realpathSync(owner.path);
  const bytes = readFileSync(physicalPath);
  const revision = hash(bytes);
  if (revision !== owner.revision) conflict();
  const text = bytes.toString("utf8");
  const projectDefaults = owner.path === context.bootstrapConfigPath ? undefined : context.running;
  let config: AppConfig;
  try {
    config = parseConfigText(owner.path, text, projectDefaults);
  } catch {
    throw new CronJobEditError(
      422,
      "config_invalid",
      "Owning config is invalid. Fix YAML before editing.",
    );
  }
  const project = Object.hasOwn(config.projects, projectId)
    ? config.projects[projectId]
    : undefined;
  if (!project) {
    throw new CronJobEditError(404, "not_found", "Project no longer exists on disk.");
  }
  const source = project.sources?.[sourceId];
  const trigger = project.triggers?.[triggerId];
  if (!source || !trigger || trigger.source !== sourceId) {
    throw new CronJobEditError(
      404,
      "not_found",
      "Cron source or trigger no longer exists on disk.",
    );
  }
  if (source.type !== "cron" || !("spawn" in trigger)) {
    throw new CronJobEditError(
      422,
      "unsupported_action",
      "Only Cron spawn triggers can be edited.",
    );
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new CronJobEditError(422, "config_invalid", "Owning YAML could not be parsed.");
  }
  const root = mapping(doc.contents);
  const projects = mapping(root.get("projects", true));
  const projectNode = mapping(projects.get(projectId, true));
  const sources = mapping(projectNode.get("sources", true));
  const sourceNode = mapping(sources.get(sourceId, true));
  const triggers = mapping(projectNode.get("triggers", true));
  const triggerNode = mapping(triggers.get(triggerId, true));
  editableScalar(sourceNode, "schedule");
  const spawn = triggerNode.get("spawn", true);
  const blockContainer = isSeq(spawn) ? spawn : mapping(spawn).get("blocks", true);
  let blockNodes: YAMLMap<unknown, unknown>[];
  if (isSeq(blockContainer)) {
    if (blockContainer.anchor) unsupported();
    blockNodes = blockContainer.items.map(mapping);
  } else {
    if (blockContainer !== undefined) unsupported();
    blockNodes = [mapping(spawn)];
  }
  for (const block of blockNodes) {
    for (const key of ["prompt", "agent", "model", "reasoningEffort"]) editableScalar(block, key);
  }
  const draft: CronJobEditDraft = {
    ...identity,
    ownerPath: owner.path,
    revision,
    schedule: sourceNode.get("schedule") as string,
    sourceTriggerIds: Object.entries(project.triggers ?? {})
      .filter(([, entry]) => entry.source === sourceId)
      .map(([id]) => id),
    blocks: trigger.spawn.blocks.map((block, index) => ({
      prompt: blockNodes[index]!.get("prompt") as string,
      agent: block.agent ?? null,
      model: blockNodes[index]!.has("model") ? (blockNodes[index]!.get("model") as string) : null,
      reasoningEffort: block.reasoningEffort ?? null,
    })),
  };
  return { draft, physicalPath, doc, sourceNode, blockNodes, projectDefaults };
}

function ioError(error: unknown): never {
  if (error instanceof CronJobEditError) throw error;
  throw new CronJobEditError(500, "config_io", "Could not read or save the owning config file.");
}

export function readCronJobDraft(
  context: CronJobEditorContext,
  identity: CronJobIdentity,
): CronJobEditDraft {
  try {
    return snapshot(context, identity).draft;
  } catch (error) {
    return ioError(error);
  }
}

// Synchronous transaction serializes writes in this daemon. Content revisions
// detect stale edits; rename is not cross-process compare-and-swap.
export function saveCronJobDraft(
  context: CronJobEditorContext,
  identity: CronJobIdentity,
  value: unknown,
): CronJobEditResult {
  const update = parseUpdate(value);
  validateSchedule(update.schedule);
  let tempPath: string | undefined;
  try {
    const current = snapshot(context, identity);
    const { draft } = current;
    if (update.revision !== draft.revision) conflict();
    if (update.blocks.length !== current.blockNodes.length) conflict();
    if (
      update.schedule === draft.schedule &&
      JSON.stringify(update.blocks) === JSON.stringify(draft.blocks)
    ) {
      return { ...draft, saved: true, activation: "pending" };
    }
    current.sourceNode.set("schedule", update.schedule);
    update.blocks.forEach((block, index) => {
      const node = current.blockNodes[index]!;
      for (const key of ["prompt", "agent", "model", "reasoningEffort"] as const) {
        if (block[key] === null) node.delete(key);
        else node.set(key, block[key]);
      }
    });
    const candidate = current.doc.toString();
    try {
      parseConfigText(draft.ownerPath, candidate, current.projectDefaults);
    } catch {
      throw new CronJobEditError(
        422,
        "config_invalid",
        "Config validation failed. Check the owning YAML.",
      );
    }
    const mode = statSync(current.physicalPath).mode & 0o7777;
    const candidatePath = `${current.physicalPath}.tmp.${randomUUID()}`;
    const fd = openSync(candidatePath, "wx", mode);
    tempPath = candidatePath;
    try {
      writeFileSync(fd, candidate, "utf8");
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    if (
      realpathSync(draft.ownerPath) !== current.physicalPath ||
      hash(readFileSync(current.physicalPath)) !== draft.revision
    )
      conflict();
    renameSync(tempPath, current.physicalPath);
    tempPath = undefined;
    return {
      ...draft,
      revision: hash(candidate),
      schedule: update.schedule,
      blocks: update.blocks,
      saved: true,
      activation: "pending",
    };
  } catch (error) {
    return ioError(error);
  } finally {
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Cleanup cannot replace the original write failure.
      }
    }
  }
}
