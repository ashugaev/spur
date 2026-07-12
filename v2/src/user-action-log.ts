import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { gunzipSync, gzipSync } from "node:zlib";

export type UserActionOrigin = "cli" | "ui" | "unknown";

export interface UserActionRecord {
  ts: string;
  actor: "user";
  origin: UserActionOrigin;
  action: string;
  method: string;
  path: string;
  sessionId?: string;
  projectId?: string;
  params?: Record<string, unknown>;
  outcome: { status: number; ok: boolean };
  latencyMs: number;
  error?: string;
}

export interface BuildUserActionInput {
  method: string;
  path: string;
  origin: UserActionOrigin;
  body: unknown;
  statusCode: number;
  error?: string;
  latencyMs: number;
}

const USER_ACTION_LOG_FILE = "user-actions.jsonl";
const SESSIONS_DIR = "sessions";
const READ_CHUNK = 1 << 16; // 64 KiB — keeps peak memory bounded regardless of file size.

export const DEFAULT_USER_ACTION_LOG_HOT_BYTES = 500 * 1024 * 1024;
export const DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES = 5;

export interface UserActionLogConfig {
  hotBytes: number;
  shardHotBytes: number;
  retainArchives: number;
}

export const DEFAULT_USER_ACTION_LOG_CONFIG: UserActionLogConfig = {
  hotBytes: DEFAULT_USER_ACTION_LOG_HOT_BYTES,
  shardHotBytes: DEFAULT_USER_ACTION_LOG_SHARD_HOT_BYTES,
  retainArchives: DEFAULT_USER_ACTION_LOG_RETAIN_ARCHIVES,
};

let userActionLogConfig: UserActionLogConfig = DEFAULT_USER_ACTION_LOG_CONFIG;

export function setUserActionLogConfig(config: UserActionLogConfig): void {
  userActionLogConfig = config;
}

interface UserActionQuery {
  limit?: number;
}

export function userActionLogPath(dataDir: string): string {
  return join(dataDir, USER_ACTION_LOG_FILE);
}

function sessionShardDir(dataDir: string, sessionId: string): string {
  return join(dataDir, SESSIONS_DIR, sessionId);
}

export function sessionUserActionLogPath(dataDir: string, sessionId: string): string {
  return join(sessionShardDir(dataDir, sessionId), USER_ACTION_LOG_FILE);
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

export function appendUserAction(dataDir: string, record: UserActionRecord): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    const globalPath = userActionLogPath(dataDir);
    appendFileSync(globalPath, line, { encoding: "utf-8", mode: 0o600 });

    let shardPath: string | undefined;
    if (record.sessionId) {
      mkdirSync(sessionShardDir(dataDir, record.sessionId), { recursive: true });
      shardPath = sessionUserActionLogPath(dataDir, record.sessionId);
      appendFileSync(shardPath, line, { encoding: "utf-8", mode: 0o600 });
    }

    const cfg = userActionLogConfig;
    tryRotate(globalPath, cfg.hotBytes, cfg.retainArchives);
    if (shardPath) {
      tryRotate(shardPath, cfg.shardHotBytes, cfg.retainArchives);
    }
  } catch {
    // User-action logging must never block Spur runtime behavior.
  }
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
function* iterUserActionLogLines(path: string): Generator<string> {
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
// 64 KiB chunks.
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
  yield* iterUserActionLogLines(path);
}

function parseEntry(line: string): UserActionRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as UserActionRecord;
  } catch {
    return null;
  }
}

export function readUserActionLog(dataDir: string): UserActionRecord[] {
  const entries: UserActionRecord[] = [];
  for (const line of iterArchivedThenLive(
    userActionLogPath(dataDir),
    userActionLogConfig.retainArchives,
  )) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function readSessionUserActions(
  dataDir: string,
  sessionId: string,
  query: UserActionQuery = {},
): UserActionRecord[] {
  const cap = query.limit;
  const out: UserActionRecord[] = [];
  const collect = (line: string): void => {
    const entry = parseEntry(line);
    if (!entry || entry.sessionId !== sessionId) return;
    out.push(entry);
    if (cap !== undefined && out.length > cap) out.shift();
  };

  const lines = existsSync(sessionShardDir(dataDir, sessionId))
    ? iterArchivedThenLive(
        sessionUserActionLogPath(dataDir, sessionId),
        userActionLogConfig.retainArchives,
      )
    : iterUserActionLogLines(userActionLogPath(dataDir));
  for (const line of lines) {
    collect(line);
  }
  return out;
}

export function deleteSessionUserActions(dataDir: string, sessionId: string): void {
  const shardPath = sessionUserActionLogPath(dataDir, sessionId);
  rmSync(shardPath, { force: true });
  for (let index = 1; index <= userActionLogConfig.retainArchives; index += 1) {
    rmSync(archivePath(shardPath, index), { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface DecodedAction {
  action: string;
  sessionId?: string;
  projectId?: string;
}

function decodeSlotsAction(body: unknown): string {
  const b = isRecord(body) ? body : {};
  const categories: string[] = [];
  if ("tags" in b || "untags" in b) categories.push("session.retag");
  if ("links" in b || "unlinkLabels" in b) categories.push("session.relink");
  if ("title" in b || "clearTitle" in b || "setTitleIfAbsent" in b) {
    categories.push("session.retitle");
  }
  if (categories.length > 1) return "session.update_slots";
  return categories[0] ?? "unknown";
}

// Match order is most-specific-first so nested routes (e.g. /wake/cancel,
// /sidecars/:name/stop, /session-memory/:key/resolve) win over their prefixes.
function decodeAction(method: string, path: string, body: unknown): DecodedAction | null {
  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    return null;
  }

  if (method === "POST") {
    if (path === "/shepherd/spawn") return { action: "session.spawn_shepherd" };
    if (path === "/sessions/background") return { action: "session.spawn_background" };
    if (path === "/sessions") return { action: "session.spawn" };
    if (path === "/backlog/take") return { action: "backlog.take" };
    if (path === "/projects/connect") return { action: "project.connect" };
    if (path === "/projects/disconnect") return { action: "project.disconnect" };
    if (path === "/projects") return { action: "project.create" };
    if (path === "/deploy/switch") return { action: "deploy.switch" };

    const sidecarStart = path.match(/^\/sessions\/([^/]+)\/sidecars\/[^/]+\/start$/);
    if (sidecarStart?.[1]) return { action: "sidecar.start", sessionId: sidecarStart[1] };
    const sidecarStop = path.match(/^\/sessions\/([^/]+)\/sidecars\/[^/]+\/stop$/);
    if (sidecarStop?.[1]) return { action: "sidecar.stop", sessionId: sidecarStop[1] };
    const serviceRun = path.match(/^\/sessions\/([^/]+)\/services\/[^/]+\/run$/);
    if (serviceRun?.[1]) return { action: "service.run", sessionId: serviceRun[1] };
    const memoryResolve = path.match(/^\/sessions\/([^/]+)\/session-memory\/[^/]+\/resolve$/);
    if (memoryResolve?.[1]) {
      return { action: "session.memory_resolve", sessionId: memoryResolve[1] };
    }
    const memorySet = path.match(/^\/sessions\/([^/]+)\/session-memory\/[^/]+$/);
    if (memorySet?.[1]) return { action: "session.memory_set", sessionId: memorySet[1] };

    const cancelWake = path.match(/^\/sessions\/([^/]+)\/wake\/cancel$/);
    if (cancelWake?.[1]) return { action: "session.wake_cancel", sessionId: cancelWake[1] };
    const wake = path.match(/^\/sessions\/([^/]+)\/wake$/);
    if (wake?.[1]) return { action: "session.wake", sessionId: wake[1] };
    const send = path.match(/^\/sessions\/([^/]+)\/send$/);
    if (send?.[1]) return { action: "session.send", sessionId: send[1] };
    const sourceReply = path.match(/^\/sessions\/([^/]+)\/source-reply$/);
    if (sourceReply?.[1]) return { action: "session.source_reply", sessionId: sourceReply[1] };
    const pause = path.match(/^\/sessions\/([^/]+)\/pause$/);
    if (pause?.[1]) return { action: "session.pause", sessionId: pause[1] };
    const complete = path.match(/^\/sessions\/([^/]+)\/complete$/);
    if (complete?.[1]) return { action: "session.complete", sessionId: complete[1] };
    const selfDestruct = path.match(/^\/sessions\/([^/]+)\/self-destruct$/);
    if (selfDestruct?.[1]) return { action: "session.self_destruct", sessionId: selfDestruct[1] };
    const kill = path.match(/^\/sessions\/([^/]+)\/kill$/);
    if (kill?.[1]) return { action: "session.kill", sessionId: kill[1] };
    const restore = path.match(/^\/sessions\/([^/]+)\/restore$/);
    if (restore?.[1]) return { action: "session.restore", sessionId: restore[1] };
    const handoff = path.match(/^\/sessions\/([^/]+)\/handoff$/);
    if (handoff?.[1]) return { action: "session.handoff", sessionId: handoff[1] };
    const respawn = path.match(/^\/sessions\/([^/]+)\/respawn$/);
    if (respawn?.[1]) return { action: "session.respawn", sessionId: respawn[1] };
    const slots = path.match(/^\/sessions\/([^/]+)\/slots$/);
    if (slots?.[1]) return { action: decodeSlotsAction(body), sessionId: slots[1] };
  }

  if (method === "PATCH") {
    const projectUpdate = path.match(/^\/projects\/([^/]+)$/);
    if (projectUpdate?.[1]) return { action: "project.update", projectId: projectUpdate[1] };
  }

  if (method === "DELETE") {
    const projectDelete = path.match(/^\/projects\/([^/]+)$/);
    if (projectDelete?.[1]) return { action: "project.delete", projectId: projectDelete[1] };
  }

  return { action: "unknown" };
}

function textFieldForAction(action: string): "message" | "prompt" | undefined {
  if (action === "session.send" || action === "session.source_reply") return "message";
  if (
    action === "session.spawn" ||
    action === "session.spawn_background" ||
    action === "session.spawn_shepherd" ||
    action === "session.respawn"
  ) {
    return "prompt";
  }
  return undefined;
}

// Params are strictly whitelisted: only hashed/length-capped text and known-safe
// project fields are persisted, so raw secrets in a request body never reach disk.
function buildParams(action: string, body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;

  const textField = textFieldForAction(action);
  if (textField) {
    const text = body[textField];
    const params: Record<string, unknown> = {};
    if (typeof text === "string") {
      params["textLen"] = text.length;
      params["textPreview"] = text.slice(0, 120);
      params["textHash"] = createHash("sha256").update(text).digest("hex");
    }
    params["hasAttachment"] = Array.isArray(body["attachments"]) && body["attachments"].length > 0;
    return params;
  }

  if (action === "project.create" || action === "project.update") {
    const params: Record<string, unknown> = {};
    for (const field of ["displayName", "prefix", "path"] as const) {
      if (typeof body[field] === "string") params[field] = body[field];
    }
    return Object.keys(params).length > 0 ? params : undefined;
  }

  return undefined;
}

export function buildUserActionRecord(input: BuildUserActionInput): UserActionRecord | null {
  const decoded = decodeAction(input.method, input.path, input.body);
  if (!decoded) return null;
  const ok = input.statusCode >= 200 && input.statusCode < 300;
  const params = buildParams(decoded.action, input.body);
  return {
    ts: new Date().toISOString(),
    actor: "user",
    origin: input.origin,
    action: decoded.action,
    method: input.method,
    path: input.path,
    ...(decoded.sessionId ? { sessionId: decoded.sessionId } : {}),
    ...(decoded.projectId ? { projectId: decoded.projectId } : {}),
    ...(params ? { params } : {}),
    outcome: { status: input.statusCode, ok },
    latencyMs: input.latencyMs,
    ...(input.error ? { error: input.error } : {}),
  };
}
