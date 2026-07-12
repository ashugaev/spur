import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

const EVENT_LOG_FILE = "events.jsonl";
const SESSIONS_DIR = "sessions";

export const DEFAULT_EVENT_LOG_HOT_BYTES = 500 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_SHARD_HOT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_RETAIN_ARCHIVES = 5;

export interface EventLogConfig {
  hotBytes: number;
  shardHotBytes: number;
  retainArchives: number;
}

export const DEFAULT_EVENT_LOG_CONFIG: EventLogConfig = {
  hotBytes: DEFAULT_EVENT_LOG_HOT_BYTES,
  shardHotBytes: DEFAULT_EVENT_LOG_SHARD_HOT_BYTES,
  retainArchives: DEFAULT_EVENT_LOG_RETAIN_ARCHIVES,
};

let eventLogConfig: EventLogConfig = DEFAULT_EVENT_LOG_CONFIG;

export function setEventLogConfig(config: EventLogConfig): void {
  eventLogConfig = config;
}

type SpurLogEntryInput = Omit<SpurLogEntry, "timestamp"> & { timestamp?: string };

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

export function logSpurEvent(dataDir: string, entry: SpurLogEntryInput): void {
  try {
    appendEventLog(dataDir, entry);
  } catch {
    // Logging must never block Spur runtime behavior.
  }
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
