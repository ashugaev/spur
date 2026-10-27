import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { loadInstanceConfigReadOnly, loadProjectConfig } from "./config.js";
import { DEFAULT_EVENT_LOG_CONFIG, eventLogPath, type SpurLogEntry } from "./event-log.js";
import { parseJsonLine } from "./jsonl-log-io.js";
import { scanJsonlLines } from "./jsonl-scan.js";
import { mergeProjects } from "./registry.js";
import type {
  AppConfig,
  CronActionEvent,
  CronActionEventName,
  CronDiskState,
  CronJobsResponse,
  CronOwnerState,
  CronProjectView,
  CronSourceConfig,
  CronSourceView,
  CronTriggerView,
  ProjectConfig,
  TriggerConfig,
} from "./types.js";

const RECENT_LIMIT = 5;
const CRON_TICK_EVENT = "cron:tick";
const SOURCE_EMITTED_EVENT = "source.event.emitted";
const CRON_ACTION_EVENTS: ReadonlySet<string> = new Set<CronActionEventName>([
  "trigger.spawn.completed",
  "trigger.spawn.failed",
  "trigger.spawn.suppressed",
  "trigger.send.ignored",
]);

export class UnknownCronProjectError extends Error {}

export type CronOwnerFile =
  | { state: "loaded"; path: string; revision: string; config: AppConfig }
  | {
      state: "invalid";
      path: string;
      revision: string;
      error: string;
      declaredProjectIds: readonly string[];
    }
  | { state: "parse_error"; path: string; revision: string; error: string }
  | { state: "rejected"; path: string; revision: string; error: string }
  | { state: "missing"; path: string }
  | { state: "unreadable"; path: string; error: string };

export interface CronEventTail {
  events: SpurLogEntry[];
  eventsSince: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function declaredProjectIds(root: unknown): string[] {
  if (typeof root !== "object" || root === null) return [];
  const projects: unknown = (root as Record<string, unknown>)["projects"];
  return typeof projects === "object" && projects !== null ? Object.keys(projects) : [];
}

// The YAML parser's first message line: reason and position, never the file excerpt below it.
function yamlErrorMessage(error: unknown): string {
  return (errorMessage(error).split("\n")[0] ?? "").replace(/:$/, "");
}

// Mirrors ConfigRegistryScanner.scan: the bootstrap file first, registry files
// parsed with the running config as defaults, collision-rejected files own nothing.
export function resolveCronOwnerFiles(
  bootstrapPath: string,
  registryPaths: readonly string[],
  running: AppConfig,
): CronOwnerFile[] {
  const files: CronOwnerFile[] = [];
  const accepted: AppConfig[] = [];
  for (const path of [...new Set([bootstrapPath, ...registryPaths])]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      files.push(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { state: "missing", path }
          : { state: "unreadable", path, error: errorMessage(error) },
      );
      continue;
    }
    const revision = createHash("sha256").update(bytes).digest("hex");
    let root: unknown;
    try {
      root = parseYaml(bytes.toString("utf8"));
    } catch (error) {
      files.push({ state: "parse_error", path, revision, error: yamlErrorMessage(error) });
      continue;
    }
    let config: AppConfig;
    if (path === bootstrapPath) {
      const result = loadInstanceConfigReadOnly(path);
      if (result.status === "absent") {
        files.push({ state: "missing", path });
        continue;
      }
      if (result.status === "invalid") {
        files.push({
          state: "invalid",
          path,
          revision,
          error: result.error,
          declaredProjectIds: declaredProjectIds(root),
        });
        continue;
      }
      config = result.config;
    } else {
      try {
        config = loadProjectConfig(path, running);
      } catch (error) {
        files.push({
          state: "invalid",
          path,
          revision,
          error: errorMessage(error),
          declaredProjectIds: declaredProjectIds(root),
        });
        continue;
      }
      try {
        mergeProjects(running, [...accepted, config]);
      } catch (error) {
        files.push({ state: "rejected", path, revision, error: errorMessage(error) });
        continue;
      }
    }
    accepted.push(config);
    files.push({ state: "loaded", path, revision, config });
  }
  return files;
}

// Last scan only: a repeat open with an unchanged live log skips the rescan.
let tailCache: { key: string; tail: CronEventTail } | null = null;

// Scans the live event log from `maxBytes` before its end. Archives are never read.
export async function readCronEventTail(dataDir: string, maxBytes: number): Promise<CronEventTail> {
  const path = eventLogPath(dataDir);
  let size: number;
  let key: string;
  try {
    const stats = await stat(path);
    size = stats.size;
    key = `${path}\0${size}\0${stats.mtimeMs}\0${maxBytes}`;
  } catch {
    return { events: [], eventsSince: null };
  }
  if (tailCache?.key === key) return tailCache.tail;
  const tail = await scanCronEventTail(path, size, maxBytes);
  tailCache = { key, tail };
  return tail;
}

async function scanCronEventTail(
  path: string,
  size: number,
  maxBytes: number,
): Promise<CronEventTail> {
  const offset = Math.max(0, size - maxBytes);
  const events: SpurLogEntry[] = [];
  let eventsSince: string | null = null;
  let dropPartial = offset > 0;
  await scanJsonlLines(
    path,
    offset,
    (line) => {
      if (dropPartial) {
        dropPartial = false;
        return true;
      }
      if (eventsSince === null) {
        const entry = parseJsonLine<SpurLogEntry>(line);
        if (typeof entry?.timestamp === "string") eventsSince = entry.timestamp;
      }
      if (!line.includes(SOURCE_EMITTED_EVENT) && !line.includes("trigger.")) return true;
      const entry = parseJsonLine<SpurLogEntry>(line);
      if (!entry || typeof entry.timestamp !== "string") return true;
      if (isCronTick(entry) || CRON_ACTION_EVENTS.has(entry.event)) events.push(entry);
      return true;
    },
    size,
  );
  return { events, eventsSince };
}

function isCronTick(entry: SpurLogEntry): boolean {
  return entry.event === SOURCE_EMITTED_EVENT && entry.details?.["eventName"] === CRON_TICK_EVENT;
}

function pushCapped<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  if (list.length > RECENT_LIMIT) list.shift();
  map.set(key, list);
}

function newestFirst<T>(list: readonly T[] | undefined): T[] {
  return [...(list ?? [])].reverse();
}

function cronSources(project: ProjectConfig | undefined): Map<string, CronSourceConfig> {
  const sources = new Map<string, CronSourceConfig>();
  for (const [sourceId, source] of Object.entries(project?.sources ?? {})) {
    if (source.type === "cron") sources.set(sourceId, source);
  }
  return sources;
}

function cronTriggers(
  project: ProjectConfig | undefined,
  sources: ReadonlyMap<string, CronSourceConfig>,
): Map<string, TriggerConfig> {
  const triggers = new Map<string, TriggerConfig>();
  for (const [triggerId, trigger] of Object.entries(project?.triggers ?? {})) {
    if (sources.has(trigger.source)) triggers.set(triggerId, trigger);
  }
  return triggers;
}

function diskState(
  loaded: unknown,
  disk: unknown,
  compare: boolean,
): Exclude<CronDiskState, "added"> {
  if (!compare) return "unknown";
  if (disk === undefined) return "removed";
  return JSON.stringify(loaded) === JSON.stringify(disk) ? "same" : "changed";
}

function triggerAction(trigger: TriggerConfig): CronTriggerView["action"] {
  if (!("spawn" in trigger)) return { kind: "send", prompt: trigger.send.prompt ?? null };
  return {
    kind: "spawn",
    blocks: trigger.spawn.blocks.map((block) => ({
      prompt: block.prompt,
      agent: block.agent ?? null,
      model: block.model ?? null,
      reasoningEffort: block.reasoningEffort ?? null,
      mode: block.mode ?? null,
    })),
  };
}

function actionEvent(entry: SpurLogEntry): CronActionEvent {
  const event = entry.event as CronActionEventName;
  return {
    at: entry.timestamp,
    event,
    sessionId: entry.sessionId ?? null,
    message: event === "trigger.spawn.failed" ? (entry.message ?? null) : null,
  };
}

// The first file declaring the project; else the first file that cannot be read
// or parsed, since it may hold the project; else the project left every file.
function ownerFor(
  projectId: string,
  files: readonly CronOwnerFile[],
): CronOwnerFile | { state: "project_removed" } {
  return (
    files.find(
      (file) =>
        file.state === "loaded" &&
        Object.prototype.hasOwnProperty.call(file.config.projects, projectId),
    ) ??
    files.find((file) => file.state === "invalid" && file.declaredProjectIds.includes(projectId)) ??
    files.find(
      (file) =>
        file.state === "parse_error" || file.state === "missing" || file.state === "unreadable",
    ) ?? { state: "project_removed" }
  );
}

function ownerState(
  owner: ReturnType<typeof ownerFor>,
  sources: readonly CronSourceView[],
): CronOwnerState {
  switch (owner.state) {
    case "loaded":
      return {
        state: "loaded",
        path: owner.path,
        revision: owner.revision,
        changed: sources.some(
          (source) =>
            source.disk !== "same" || source.triggers.some((trigger) => trigger.disk !== "same"),
        ),
      };
    case "invalid":
    case "parse_error":
      return { state: owner.state, path: owner.path, revision: owner.revision, error: owner.error };
    case "missing":
      return { state: "missing", path: owner.path };
    case "unreadable":
      return { state: "unreadable", path: owner.path, error: owner.error };
    case "rejected":
    case "project_removed":
      return { state: "project_removed" };
  }
}

export function buildCronJobsView(input: {
  running: AppConfig;
  ownerFiles: readonly CronOwnerFile[];
  events: readonly SpurLogEntry[];
  eventsSince: string | null;
  projectId?: string;
}): CronJobsResponse {
  const ticks = new Map<string, string[]>();
  const actions = new Map<string, CronActionEvent[]>();
  for (const entry of input.events) {
    if (!entry.projectId) continue;
    if (isCronTick(entry) && entry.sourceId) {
      pushCapped(ticks, `${entry.projectId}\0${entry.sourceId}`, entry.timestamp);
    } else if (CRON_ACTION_EVENTS.has(entry.event) && entry.triggerId) {
      pushCapped(actions, `${entry.projectId}\0${entry.triggerId}`, actionEvent(entry));
    }
  }

  const projectIds = new Set(Object.keys(input.running.projects));
  for (const file of input.ownerFiles) {
    if (file.state === "loaded")
      for (const id of Object.keys(file.config.projects)) projectIds.add(id);
  }

  const projects: CronProjectView[] = [];
  for (const projectId of [...projectIds].sort()) {
    if (input.projectId !== undefined && projectId !== input.projectId) continue;
    const running = input.running.projects[projectId];
    const ownerFile = ownerFor(projectId, input.ownerFiles);
    const diskProject =
      ownerFile.state === "loaded" ? ownerFile.config.projects[projectId] : undefined;
    if (!running && !diskProject) continue;
    // A removed project compares against nothing, so every loaded row reads "removed".
    const compare = ownerFile.state === "loaded" || ownerFile.state === "project_removed";

    const loadedSources = cronSources(running);
    const diskSources = compare ? cronSources(diskProject) : new Map<string, CronSourceConfig>();
    const loadedTriggers = cronTriggers(running, loadedSources);
    const diskTriggers = cronTriggers(diskProject, diskSources);

    const sourceViews = new Map<string, CronSourceView>();
    const sourceView = (
      sourceId: string,
      source: CronSourceConfig,
      disk: CronDiskState,
    ): CronSourceView => ({
      sourceId,
      schedule: source.schedule,
      runOnStart: source.runOnStart,
      disk,
      recentTicks: newestFirst(ticks.get(`${projectId}\0${sourceId}`)),
      triggers: [],
    });
    for (const [sourceId, source] of loadedSources) {
      const disk = diskState(source, diskSources.get(sourceId), compare);
      sourceViews.set(sourceId, sourceView(sourceId, source, disk));
    }
    for (const [sourceId, source] of diskSources) {
      if (!loadedSources.has(sourceId))
        sourceViews.set(sourceId, sourceView(sourceId, source, "added"));
    }

    const triggerView = (
      triggerId: string,
      trigger: TriggerConfig,
      disk: CronDiskState,
    ): CronTriggerView => ({
      triggerId,
      event: trigger.event,
      disk,
      action: triggerAction(trigger),
      recentActions: newestFirst(actions.get(`${projectId}\0${triggerId}`)),
    });
    for (const [triggerId, trigger] of loadedTriggers) {
      const disk = diskState(trigger, diskTriggers.get(triggerId), compare);
      sourceViews.get(trigger.source)?.triggers.push(triggerView(triggerId, trigger, disk));
    }
    for (const [triggerId, trigger] of diskTriggers) {
      if (loadedTriggers.has(triggerId)) continue;
      sourceViews.get(trigger.source)?.triggers.push(triggerView(triggerId, trigger, "added"));
    }

    const sources = [...sourceViews.values()];
    if (sources.length === 0) continue;

    projects.push({
      projectId,
      projectName: (running ?? diskProject)?.name ?? projectId,
      owner: ownerState(ownerFile, sources),
      sources,
    });
  }
  return { projects, eventsSince: input.eventsSince };
}

export async function readCronJobs(input: {
  config: AppConfig;
  bootstrapConfigPath: string;
  registryPaths: readonly string[];
  knownProjectIds: ReadonlySet<string>;
  projectId?: string;
}): Promise<CronJobsResponse> {
  const ownerFiles = resolveCronOwnerFiles(
    input.bootstrapConfigPath,
    input.registryPaths,
    input.config,
  );
  const { projectId } = input;
  if (
    projectId !== undefined &&
    !input.knownProjectIds.has(projectId) &&
    !ownerFiles.some(
      (file) =>
        (file.state === "loaded" &&
          Object.prototype.hasOwnProperty.call(file.config.projects, projectId)) ||
        (file.state === "invalid" && file.declaredProjectIds.includes(projectId)),
    )
  ) {
    throw new UnknownCronProjectError(`Unknown project: ${projectId}`);
  }
  const tail = await readCronEventTail(
    input.config.dataDir,
    (input.config.eventLog ?? DEFAULT_EVENT_LOG_CONFIG).hotBytes,
  );
  return buildCronJobsView({
    running: input.config,
    ownerFiles,
    events: tail.events,
    eventsSince: tail.eventsSince,
    ...(projectId !== undefined ? { projectId } : {}),
  });
}
