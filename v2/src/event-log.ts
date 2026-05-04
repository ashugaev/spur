import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
const READ_CHUNK = 1 << 16; // 64 KiB — keeps peak memory bounded regardless of file size.
type SpurLogEntryInput = Omit<SpurLogEntry, "timestamp"> & { timestamp?: string };

interface SessionLogQuery {
  limit?: number;
  scope?: SessionLogScope;
  name?: string;
}

export function eventLogPath(dataDir: string): string {
  return join(dataDir, EVENT_LOG_FILE);
}

export function appendEventLog(dataDir: string, entry: SpurLogEntryInput): void {
  mkdirSync(dataDir, { recursive: true });
  const record: SpurLogEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };
  appendFileSync(eventLogPath(dataDir), `${JSON.stringify(record)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function logSpurEvent(dataDir: string, entry: SpurLogEntryInput): void {
  try {
    appendEventLog(dataDir, entry);
  } catch {
    // Logging must never block Spur runtime behavior.
  }
}

function* iterEventLogLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(READ_CHUNK);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    let carry = "";
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, size - offset), offset);
      if (n <= 0) break;
      offset += n;
      carry += decoder.write(buf.subarray(0, n));
      let idx = carry.indexOf("\n");
      while (idx !== -1) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        idx = carry.indexOf("\n");
      }
    }
    carry += decoder.end();
    if (carry.length > 0) yield carry;
  } finally {
    closeSync(fd);
  }
}

function parseEntry(line: string): SpurLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as SpurLogEntry;
  } catch {
    return null;
  }
}

export function readEventLog(dataDir: string): SpurLogEntry[] {
  const entries: SpurLogEntry[] = [];
  for (const line of iterEventLogLines(eventLogPath(dataDir))) {
    const entry = parseEntry(line);
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
  for (const line of iterEventLogLines(eventLogPath(dataDir))) {
    const entry = parseEntry(line);
    if (!entry || entry.sessionId !== sessionId) continue;
    if (!matchesSessionLogQuery(entry, query)) continue;
    out.push(entry);
    if (cap !== undefined && out.length > cap) out.shift();
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
