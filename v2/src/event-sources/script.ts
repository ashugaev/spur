import { mkdirSync } from "node:fs";
import { Cron } from "croner";
import { logSpurEvent } from "../event-log.js";
import { readWorkItemRegistry, scriptSourceStateDir } from "../metadata.js";
import {
  SCRIPT_ITEM_NEW_EVENT,
  type ScriptSourceConfig,
  type WorkItemEventData,
} from "../types.js";
import { deriveMinimumIntervalMs } from "./cron.js";
import { runScriptProcess } from "./script-process.js";
import type { SourceHandle, SourceModule, SourceStartDeps } from "./types.js";
import { emitWorkItemBacklog, WORK_ITEM_FIRST_POLL_EMIT_CAP } from "./work-item-backlog.js";

type ScriptItem = WorkItemEventData & { id: string } & Record<string, string | number | boolean>;
type ParsedOutput =
  | { status: "ok"; items: ScriptItem[]; dropped: string[] }
  | { status: "failed"; reason: "invalid_json" | "not_array" | "too_many_items" };
const ITEM_STRING_LIMIT = 2048;
const RESERVED_KEYS = new Set(["externalId", "repo", "sessionId"]);

function parseItem(value: unknown, sourceId: string): ScriptItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const { id, title, url = "", number = 0 } = raw;
  if (
    typeof id !== "string" ||
    !id.trim() ||
    id.length > 256 ||
    typeof title !== "string" ||
    !title.trim() ||
    Buffer.byteLength(title) > ITEM_STRING_LIMIT ||
    typeof url !== "string" ||
    Buffer.byteLength(url) > ITEM_STRING_LIMIT ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 0
  )
    return null;
  let normalizedUrl = "";
  if (url !== "") {
    try {
      normalizedUrl = new URL(url.trim()).toString();
    } catch {
      return null;
    }
  }
  const extras: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (["id", "title", "url", "number"].includes(key)) continue;
    if (RESERVED_KEYS.has(key) || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return null;
    if (typeof field === "string") {
      if (Buffer.byteLength(field) > ITEM_STRING_LIMIT) return null;
    } else if (typeof field === "number") {
      if (!Number.isFinite(field)) return null;
    } else if (typeof field !== "boolean") return null;
    Object.defineProperty(extras, key, { value: field, enumerable: true });
  }
  const repo = `script:${sourceId}`;
  return { ...extras, id, title, url: normalizedUrl, number, repo, externalId: `${repo}#${id}` };
}

/** Script source contract:
 * command is argv (a string is one executable, never shell-split); cwd is project.path.
 * schedule uses host-local cron time, minimum gap 60000 ms; runOnStart defaults false.
 * timeoutMs defaults 60000, inclusive integer range 1..2147483647.
 * stdout: empty or JSON array <=500 items. id: nonblank <=256 chars; title: nonblank
 * <=2048 UTF-8 bytes. url: optional <=2048 bytes, empty/absent means no session link;
 * otherwise absolute URL, normalized. number: optional nonnegative integer, default 0.
 * Extras: keys matching /^[a-zA-Z][a-zA-Z0-9_]*$/, string <=2048 bytes, finite number,
 * or boolean; externalId/repo/sessionId reserved. Invalid items dropped; first ID wins.
 * script:item.new data contains id/title/url/number/extras, repo script:<sourceId>,
 * externalId script:<sourceId>#<id>; all keys available in {{key}} spawn templates.
 * Spawn-only triggers; autoComplete supported. No thread target.
 * emitExisting defaults false: first nonempty run records baseline without spawning.
 * Conditional scripts set emitExisting:true to spawn on first positive result.
 * At most 10 emits/run; deferred IDs remain unseen. Replay bounded snapshots, never
 * advance a cursor on stdout: stdout is not acknowledgement. Seen IDs persist across
 * restarts. Admission failure/crash can consume IDs; no guaranteed agent work or retry.
 * Use a new ID for each occurrence. State dir persists; scripts own producer replay.
 * Nonzero exit/signal/timeout/spawn/output_limit/invalid_json/not_array/too_many_items
 * fail without recording IDs. source.script.run.failed in events.jsonl includes stderr
 * tail; never print secrets there. Invalid items log source.script.items.dropped.
 * Runs never overlap; timeout/stop/completion kill process group. SIGKILL of daemon or
 * descendants escaping group can leave orphans: producer state must tolerate overlap.
 */
export function parseScriptOutput(stdout: string, sourceId: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return { status: "failed", reason: "invalid_json" };
  }
  if (!Array.isArray(raw)) return { status: "failed", reason: "not_array" };
  if (raw.length > 500) return { status: "failed", reason: "too_many_items" };
  const items: ScriptItem[] = [];
  const dropped: string[] = [];
  const ids = new Set<string>();
  raw.forEach((value: unknown, index: number) => {
    const item = parseItem(value, sourceId);
    if (!item) {
      dropped.push(`${index}: invalid item`);
      return;
    }
    if (ids.has(item.id)) return;
    ids.add(item.id);
    items.push(item);
  });
  return { status: "ok", items, dropped };
}

async function startScriptSource(deps: SourceStartDeps<ScriptSourceConfig>): Promise<SourceHandle> {
  const stateDir = scriptSourceStateDir(deps.dataDir, deps.projectId, deps.sourceId);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const seen = readWorkItemRegistry(deps.dataDir, deps.projectId, deps.sourceId);
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | undefined;
  let lastStartedAt: number | null = null;
  const log = (
    event: string,
    level: "info" | "warn" | "error",
    details: Record<string, unknown>,
  ): void => {
    logSpurEvent(deps.dataDir, {
      event,
      level,
      projectId: deps.projectId,
      sourceId: deps.sourceId,
      message: `Script source ${deps.projectId}/${deps.sourceId}: ${event}`,
      details,
    });
  };
  const sync = async (): Promise<void> => {
    const result = await runScriptProcess({
      ...deps.config,
      env: {
        ...deps.config.env,
        SPUR_SOURCE_ID: deps.sourceId,
        SPUR_PROJECT_ID: deps.projectId,
        SPUR_STATE_DIR: stateDir,
      },
      signal: controller.signal,
    });
    if (stopped || controller.signal.aborted || deps.signal.aborted || result.status === "aborted")
      return;
    if (result.status === "failed") {
      log("source.script.run.failed", "error", { ...result });
      return;
    }
    const output = parseScriptOutput(result.stdout, deps.sourceId);
    if (output.status === "failed") {
      log("source.script.run.failed", "error", {
        reason: output.reason,
        durationMs: result.durationMs,
        stderrTail: result.stderrTail,
      });
      return;
    }
    if (output.dropped.length)
      log("source.script.items.dropped", "warn", {
        count: output.dropped.length,
        items: output.dropped.slice(0, 5),
      });
    const unseen = output.items.filter((item) => !seen.has(item.externalId));
    const selected =
      seen.size === 0 && !deps.config.emitExisting
        ? unseen
        : unseen.slice(0, WORK_ITEM_FIRST_POLL_EMIT_CAP);
    emitWorkItemBacklog(
      deps,
      SCRIPT_ITEM_NEW_EVENT,
      seen,
      selected.map((data) => ({ repo: data.repo, externalId: data.externalId, data })),
    );
  };
  const tick = (): void => {
    if (stopped || deps.signal.aborted) return;
    const now = Date.now();
    if (pending || (lastStartedAt !== null && now - lastStartedAt < minimumIntervalMs)) {
      log("source.script.run.skipped", "info", { reason: pending ? "in_flight" : "cadence" });
      return;
    }
    lastStartedAt = now;
    pending = sync()
      .catch((error: unknown) => {
        if (!stopped && !controller.signal.aborted) {
          deps.logger.warn?.(
            `Script source failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          log("source.script.run.failed", "error", { reason: "spawn" });
        }
      })
      .finally(() => {
        pending = undefined;
      });
  };
  const cron = new Cron(deps.config.schedule, tick);
  const minimumIntervalMs = deriveMinimumIntervalMs(cron, deps.config.schedule);
  const abort = (): void => {
    stopped = true;
    cron.stop();
    controller.abort();
  };
  deps.signal.addEventListener("abort", abort, { once: true });
  if (deps.signal.aborted) abort();
  return {
    async stop(): Promise<void> {
      abort();
      deps.signal.removeEventListener("abort", abort);
      await pending;
    },
    ...(deps.config.runOnStart ? { runOnStart: tick } : {}),
  };
}

export const scriptSourceModule = {
  type: "script",
  start: startScriptSource,
} satisfies SourceModule<ScriptSourceConfig>;
