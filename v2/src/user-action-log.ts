import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { iterArchivedThenLive, iterLiveLines, parseJsonLine, tryRotate } from "./jsonl-log-io.js";

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

export function readUserActionLog(
  dataDir: string,
  query: UserActionQuery = {},
): UserActionRecord[] {
  const cap = query.limit;
  const entries: UserActionRecord[] = [];
  for (const line of iterArchivedThenLive(
    userActionLogPath(dataDir),
    userActionLogConfig.retainArchives,
  )) {
    const entry = parseJsonLine<UserActionRecord>(line);
    if (!entry) continue;
    entries.push(entry);
    if (cap !== undefined && entries.length > cap) entries.shift();
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
    const entry = parseJsonLine<UserActionRecord>(line);
    if (!entry || entry.sessionId !== sessionId) return;
    out.push(entry);
    if (cap !== undefined && out.length > cap) out.shift();
  };

  const lines = existsSync(sessionShardDir(dataDir, sessionId))
    ? iterArchivedThenLive(
        sessionUserActionLogPath(dataDir, sessionId),
        userActionLogConfig.retainArchives,
      )
    : iterLiveLines(userActionLogPath(dataDir));
  for (const line of lines) {
    collect(line);
  }
  return out;
}

export function hasRecentSessionUserAction(
  dataDir: string,
  sessionId: string,
  actions: ReadonlySet<string>,
  sinceMs: number,
): boolean {
  if (!existsSync(sessionShardDir(dataDir, sessionId))) return false;

  for (const line of iterArchivedThenLive(
    sessionUserActionLogPath(dataDir, sessionId),
    userActionLogConfig.retainArchives,
  )) {
    const entry = parseJsonLine<UserActionRecord>(line);
    if (!entry || entry.sessionId !== sessionId || !actions.has(entry.action)) continue;
    if (Date.parse(entry.ts) >= sinceMs) return true;
  }
  return false;
}

export function deleteSessionUserActions(dataDir: string, sessionId: string): void {
  // Enumerate the shard dir instead of looping to the current retainArchives: a config
  // that was lowered since the archives were written would otherwise leak the higher-
  // indexed .gz files forever. Only user-action files are removed; the co-located
  // events.jsonl shard is left untouched.
  const dir = sessionShardDir(dataDir, sessionId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === USER_ACTION_LOG_FILE || name.startsWith(`${USER_ACTION_LOG_FILE}.`)) {
      rmSync(join(dir, name), { force: true });
    }
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
    if (path === "/projects/connect") return { action: "project.connect" };
    if (path === "/projects/disconnect") return { action: "project.disconnect" };
    const preflight = path.match(/^\/projects\/([^/]+)\/preflight$/);
    if (preflight?.[1]) return { action: "project.preflight", projectId: preflight[1] };
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
    const sharedMemorySet = path.match(/^\/sessions\/([^/]+)\/shared-memory\/[^/]+\/[^/]+$/);
    if (sharedMemorySet?.[1]) return { action: "shared.memory_set", sessionId: sharedMemorySet[1] };

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
    const reopen = path.match(/^\/sessions\/([^/]+)\/reopen$/);
    if (reopen?.[1]) return { action: "session.reopen", sessionId: reopen[1] };
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
    const sharedMemoryRemove = path.match(/^\/sessions\/([^/]+)\/shared-memory\/[^/]+\/[^/]+$/);
    if (sharedMemoryRemove?.[1]) {
      return { action: "shared.memory_remove", sessionId: sharedMemoryRemove[1] };
    }
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

// Params are whitelisted: only a length, a sha256 hash, a truncated cleartext preview
// (first 120 chars) of the message/prompt, and known-safe project fields are persisted.
// The preview is a truncation, NOT redaction — a secret in the first 120 chars of a
// message is written verbatim. Non-whitelisted top-level body fields (api keys, tokens)
// are never stored. Full text beyond the preview never reaches disk.
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
