import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactAutoPingHandles } from "./auto-ping.js";
import { iterArchivedThenLive, iterLiveLines, parseJsonLine, tryRotate } from "./jsonl-log-io.js";
import type { SessionLogScope } from "./types.js";

export type SpurLogLevel = "info" | "warn" | "error";

export interface SpurLogEntry {
  timestamp: string;
  event: string;
  level: SpurLogLevel;
  message?: string;
  sessionId?: string;
  projectId?: string;
  sourceId?: string;
  triggerId?: string;
  method?: string;
  path?: string;
  details?: Record<string, unknown>;
}

export type UserInputKind =
  | "spawn_prompt"
  | "send_message"
  | "trigger_send_prompt"
  | "respawn_override_prompt";

export interface UserInputAttachment {
  id: string;
  name: string;
}

export interface UserInputLogRequest {
  sessionId: string;
  projectId: string;
  kind: UserInputKind;
  source: string;
  text: string;
  attachments?: UserInputAttachment[];
  sourceId?: string;
  triggerId?: string;
  details?: Record<string, unknown>;
}

const EVENT_LOG_FILE = "events.jsonl";
const SESSIONS_DIR = "sessions";

export const DEFAULT_EVENT_LOG_HOT_BYTES = 128 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_SHARD_HOT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_RETAIN_ARCHIVES = 5;
export const DEFAULT_EVENT_LOG_COLLAPSE_WINDOW_MS = 60_000;

export interface EventLogConfig {
  hotBytes: number;
  shardHotBytes: number;
  retainArchives: number;
  collapseWindowMs: number;
}

export const DEFAULT_EVENT_LOG_CONFIG: EventLogConfig = {
  hotBytes: DEFAULT_EVENT_LOG_HOT_BYTES,
  shardHotBytes: DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
  retainArchives: DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
  collapseWindowMs: DEFAULT_EVENT_LOG_COLLAPSE_WINDOW_MS,
};

let eventLogConfig: EventLogConfig = DEFAULT_EVENT_LOG_CONFIG;

export function setEventLogConfig(config: EventLogConfig): void {
  eventLogConfig = config;
}

type SpurLogEntryInput = Omit<SpurLogEntry, "timestamp"> & { timestamp?: string };

function redactAutoPingLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactAutoPingHandles(value);
  if (Array.isArray(value)) return value.map((entry) => redactAutoPingLogValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactAutoPingLogValue(entry)]),
    );
  }
  return value;
}

interface SessionLogQuery {
  limit?: number;
  scope?: SessionLogScope;
  name?: string;
}

export function eventLogPath(dataDir: string): string {
  return join(dataDir, EVENT_LOG_FILE);
}

function sessionShardDir(dataDir: string, sessionId: string): string {
  return join(dataDir, SESSIONS_DIR, sessionId);
}

export function sessionEventLogPath(dataDir: string, sessionId: string): string {
  return join(sessionShardDir(dataDir, sessionId), EVENT_LOG_FILE);
}

export function appendEventLog(dataDir: string, entry: SpurLogEntryInput): void {
  mkdirSync(dataDir, { recursive: true });
  const record: SpurLogEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  const line = `${JSON.stringify(record)}\n`;
  const globalPath = eventLogPath(dataDir);
  appendFileSync(globalPath, line, { encoding: "utf-8", mode: 0o600 });

  let shardPath: string | undefined;
  if (record.sessionId) {
    mkdirSync(sessionShardDir(dataDir, record.sessionId), { recursive: true });
    shardPath = sessionEventLogPath(dataDir, record.sessionId);
    appendFileSync(shardPath, line, { encoding: "utf-8", mode: 0o600 });
  }

  const cfg = eventLogConfig;
  tryRotate(globalPath, cfg.hotBytes, cfg.retainArchives);
  if (shardPath) {
    tryRotate(shardPath, cfg.shardHotBytes, cfg.retainArchives);
  }
}

// Repeated warn/error events (e.g. a wake-retry loop) can dominate a shard.
// Collapse keeps every occurrence accounted for without writing each one:
// the first occurrence of a key writes immediately, repeats within
// collapseWindowMs are counted but not written, and the first occurrence past
// the window flushes a summary line (details.suppressedCount/suppressedSince)
// before writing itself. info is never routed through this map. Sized for
// ~300 terminal + running sessions x a handful of distinct warn/error events
// each (measured hot set ~600-900 keys) — under FIFO eviction a key
// surviving less than the collapse window degrades the mechanism toward a
// no-op on a busy host.
const EVENT_LOG_COLLAPSE_MAX_KEYS = 4096;

interface CollapseEntry {
  dataDir: string;
  entry: SpurLogEntryInput;
  firstAt: number;
  suppressedCount: number;
}

const collapseState = new Map<string, CollapseEntry>();

function collapseKey(entry: SpurLogEntryInput): string {
  return `${entry.level}\0${entry.event}\0${entry.sessionId ?? ""}`;
}

// Writes the retained summary (if anything was actually suppressed) and
// removes the entry. Never throws: called from the write hot path, the
// reaper tick, and shutdown alike.
function flushCollapseEntry(key: string, state: CollapseEntry): void {
  collapseState.delete(key);
  if (state.suppressedCount === 0) {
    return;
  }
  const { timestamp: _timestamp, ...rest } = state.entry;
  try {
    appendEventLog(state.dataDir, {
      ...rest,
      details: {
        ...(state.entry.details ?? {}),
        suppressedCount: state.suppressedCount,
        suppressedSince: new Date(state.firstAt).toISOString(),
      },
    });
  } catch {
    // A flush failure must never block the reaper tick or shutdown.
  }
}

function collapseOrAppend(dataDir: string, entry: SpurLogEntryInput): void {
  const windowMs = eventLogConfig.collapseWindowMs;
  if (windowMs <= 0) {
    appendEventLog(dataDir, entry);
    return;
  }
  const key = collapseKey(entry);
  const now = Date.now();
  const existing = collapseState.get(key);
  if (existing && now - existing.firstAt < windowMs) {
    existing.suppressedCount += 1;
    existing.entry = entry;
    return;
  }
  if (existing) {
    flushCollapseEntry(key, existing);
  }
  appendEventLog(dataDir, entry);
  collapseState.set(key, { dataDir, entry, firstAt: now, suppressedCount: 0 });
  if (collapseState.size > EVENT_LOG_COLLAPSE_MAX_KEYS) {
    const oldestKey = collapseState.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestState = collapseState.get(oldestKey);
      if (oldestState) {
        flushCollapseEntry(oldestKey, oldestState);
      }
    }
  }
}

// Flushes every pending collapse summary written against `dataDir` and
// clears those map entries. Called from the reaper tick and from
// `shutdown()` right before the final `daemon.stopped` log, so a
// mid-teardown warn spike is still counted before the process exits.
export function flushEventLogCollapse(dataDir: string): void {
  for (const [key, state] of [...collapseState.entries()]) {
    if (state.dataDir === dataDir) {
      flushCollapseEntry(key, state);
    }
  }
}

// Test-bleed guard only: clears pending collapse state without writing.
export function resetEventLogCollapse(): void {
  collapseState.clear();
}

export function logSpurEvent(dataDir: string, entry: SpurLogEntryInput): void {
  try {
    const redacted = redactAutoPingLogValue(entry) as SpurLogEntryInput;
    if (redacted.level === "warn" || redacted.level === "error") {
      collapseOrAppend(dataDir, redacted);
      return;
    }
    appendEventLog(dataDir, redacted);
  } catch {
    // Logging must never block Spur runtime behavior.
  }
}

export function buildUserInputLogEntry(input: UserInputLogRequest): SpurLogEntryInput | null {
  const text = input.text.trim();
  const attachments = (input.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
  }));
  if (!text && attachments.length === 0) {
    return null;
  }
  return {
    event: "session.input.received",
    level: "info",
    sessionId: input.sessionId,
    projectId: input.projectId,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    message: text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
    details: {
      ...(input.details ?? {}),
      inputKind: input.kind,
      source: input.source,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

export function logUserInputEvent(dataDir: string, input: UserInputLogRequest): void {
  const entry = buildUserInputLogEntry(input);
  if (!entry) return;
  logSpurEvent(dataDir, entry);
}

export function readEventLog(dataDir: string): SpurLogEntry[] {
  const entries: SpurLogEntry[] = [];
  for (const line of iterArchivedThenLive(eventLogPath(dataDir), eventLogConfig.retainArchives)) {
    const entry = parseJsonLine<SpurLogEntry>(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function readSessionEventLog(
  dataDir: string,
  sessionId: string,
  limitOrQuery?: number | SessionLogQuery,
): SpurLogEntry[] {
  const query = typeof limitOrQuery === "number" ? { limit: limitOrQuery } : (limitOrQuery ?? {});
  const cap = query.limit;
  const out: SpurLogEntry[] = [];
  const collect = (line: string): void => {
    const entry = parseJsonLine<SpurLogEntry>(line);
    if (!entry || entry.sessionId !== sessionId) return;
    if (!matchesSessionLogQuery(entry, query)) return;
    out.push(entry);
    if (cap !== undefined && out.length > cap) out.shift();
  };

  const lines = existsSync(sessionShardDir(dataDir, sessionId))
    ? iterArchivedThenLive(sessionEventLogPath(dataDir, sessionId), eventLogConfig.retainArchives)
    : iterLiveLines(eventLogPath(dataDir));
  for (const line of lines) {
    collect(line);
  }
  return out;
}

function matchesSessionLogQuery(entry: SpurLogEntry, query: SessionLogQuery): boolean {
  if (!query.scope || query.scope === "all") {
    return query.name ? matchesRuntimeName(entry, query.name) : true;
  }
  if (query.scope === "runtime") {
    if (entry.event !== "service.output" && entry.event !== "sidecar.output") {
      return false;
    }
    return query.name ? matchesRuntimeName(entry, query.name) : true;
  }
  if (entry.event !== `${query.scope}.output`) {
    return false;
  }
  return query.name ? matchesRuntimeName(entry, query.name) : true;
}

function matchesRuntimeName(entry: SpurLogEntry, name: string): boolean {
  const details = entry.details;
  if (!details) {
    return false;
  }
  return details["serviceId"] === name || details["sidecarName"] === name;
}
