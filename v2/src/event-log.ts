import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { gunzipSync, gzipSync } from "node:zlib";
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
const READ_CHUNK = 1 << 16; // 64 KiB — keeps peak memory bounded regardless of file size.

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

function archivePath(path: string, index: number): string {
  return `${path}.${index}.gz`;
}

// Single shared rotation helper. Crash-tolerant; callers wrap in try/catch so a
// rotation failure never breaks the logging hot path.
function maybeRotate(path: string, maxBytes: number, retainArchives: number): void {
  if (!existsSync(path) || statSync(path).size <= maxBytes) {
    return;
  }
  // Shift existing <path>.N.gz upward (descending) and prune beyond retainArchives.
  for (let index = retainArchives; index >= 1; index -= 1) {
    const current = archivePath(path, index);
    if (!existsSync(current)) continue;
    if (index >= retainArchives) {
      unlinkSync(current);
      continue;
    }
    renameSync(current, archivePath(path, index + 1));
  }
  // Move the live file aside, gzip it into .1.gz, drop the temp.
  const temp = `${path}.1`;
  renameSync(path, temp);
  writeFileSync(archivePath(path, 1), gzipSync(readFileBytes(temp)), { mode: 0o600 });
  unlinkSync(temp);
}

function readFileBytes(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, offset, size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

function tryRotate(path: string, maxBytes: number, retainArchives: number): void {
  try {
    maybeRotate(path, maxBytes, retainArchives);
  } catch {
    // Rotation must never block Spur runtime behavior.
  }
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

// Split decoded string chunks into newline-delimited lines. The caller pushes chunks
// via write(); flush() drains the trailing carry. Holds at most one pending line, so
// it adds no memory beyond what the chunk source already keeps resident.
function makeLineSplitter() {
  let carry = "";
  return {
    *write(chunk: string): Generator<string> {
      carry += chunk;
      let idx = carry.indexOf("\n");
      while (idx !== -1) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        idx = carry.indexOf("\n");
      }
    },
    *flush(tail: string): Generator<string> {
      carry += tail;
      if (carry.length > 0) yield carry;
    },
  };
}

// Streams the live (uncompressed) log in 64 KiB readSync chunks — never loads the
// whole file, keeping peak memory bounded regardless of file size.
function* iterEventLogLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(READ_CHUNK);
    const decoder = new StringDecoder("utf8");
    const splitter = makeLineSplitter();
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, size - offset), offset);
      if (n <= 0) break;
      offset += n;
      yield* splitter.write(decoder.write(buf.subarray(0, n)));
    }
    yield* splitter.flush(decoder.end());
  } finally {
    closeSync(fd);
  }
}

// Transparent gzip read: decompress once, then iterate the decompressed buffer in
// 64 KiB chunks. (gunzipSync materializes the full decompressed buffer — tracked as a
// separate streaming-vs-gunzip review item.)
function* iterGzipLogLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  const decompressed = gunzipSync(readFileBytes(path));
  const decoder = new StringDecoder("utf8");
  const splitter = makeLineSplitter();
  let offset = 0;
  while (offset < decompressed.length) {
    const end = Math.min(offset + READ_CHUNK, decompressed.length);
    yield* splitter.write(decoder.write(decompressed.subarray(offset, end)));
    offset = end;
  }
  yield* splitter.flush(decoder.end());
}

// Archived shards oldest-first (highest index down to .1.gz), then the live path.
function* iterArchivedThenLive(path: string, retainArchives: number): Generator<string> {
  for (let index = retainArchives; index >= 1; index -= 1) {
    yield* iterGzipLogLines(archivePath(path, index));
  }
  yield* iterEventLogLines(path);
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
  for (const line of iterArchivedThenLive(eventLogPath(dataDir), eventLogConfig.retainArchives)) {
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
  const collect = (line: string): void => {
    const entry = parseEntry(line);
    if (!entry || entry.sessionId !== sessionId) return;
    if (!matchesSessionLogQuery(entry, query)) return;
    out.push(entry);
    if (cap !== undefined && out.length > cap) out.shift();
  };

  const lines = existsSync(sessionShardDir(dataDir, sessionId))
    ? iterArchivedThenLive(sessionEventLogPath(dataDir, sessionId), eventLogConfig.retainArchives)
    : iterEventLogLines(eventLogPath(dataDir));
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
