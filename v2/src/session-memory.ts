import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionMemoryKind, SessionMemoryRecord } from "./types.js";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MEMORY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface SessionMemoryFile {
  records: SessionMemoryRecord[];
}

export function validateSessionMemorySessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("session id must match ^[A-Za-z0-9_-]+$");
  }
}

export function validateSessionMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new Error("session memory key must match ^[a-z0-9][a-z0-9._-]{0,63}$");
  }
}

function sessionMemoryFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "session-memory", `${sessionId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionMemoryKind(value: unknown): value is SessionMemoryKind {
  return value === "note";
}

function isSessionMemoryRecord(value: unknown): value is SessionMemoryRecord {
  if (!isRecord(value)) {
    return false;
  }
  const resolvedAt = value["resolvedAt"];
  return (
    typeof value["key"] === "string" &&
    MEMORY_KEY_PATTERN.test(value["key"]) &&
    isSessionMemoryKind(value["kind"]) &&
    typeof value["body"] === "string" &&
    (value["status"] === "active" || value["status"] === "resolved") &&
    Array.isArray(value["tags"]) &&
    value["tags"].every((tag) => typeof tag === "string" && MEMORY_KEY_PATTERN.test(tag)) &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string" &&
    (resolvedAt === undefined || typeof resolvedAt === "string")
  );
}

function readSessionMemoryFile(path: string): SessionMemoryFile {
  if (!existsSync(path)) {
    return { records: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid session memory JSON at ${path}: ${message}`, { cause: error });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed["records"])) {
    throw new Error(`Invalid session memory shape at ${path}`);
  }
  const records = parsed["records"];
  if (!records.every(isSessionMemoryRecord)) {
    throw new Error(`Invalid session memory record shape at ${path}`);
  }
  return { records: records.sort((left, right) => left.key.localeCompare(right.key)) };
}

function writeSessionMemoryFile(path: string, file: SessionMemoryFile): void {
  const records = [...file.records].sort((left, right) => left.key.localeCompare(right.key));
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify({ records }, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, path);
}

export function normalizeSessionMemoryTags(tags: unknown): string[] {
  if (tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw new Error("tags must be an array of strings");
  }
  const normalized = tags.map((tag) => {
    if (typeof tag !== "string") {
      throw new Error("tags must be an array of strings");
    }
    const value = tag.trim().toLowerCase();
    if (!MEMORY_KEY_PATTERN.test(value)) {
      throw new Error("tags must be lowercase labels");
    }
    return value;
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export function listSessionMemoryRecords(
  dataDir: string,
  sessionId: string,
): SessionMemoryRecord[] {
  validateSessionMemorySessionId(sessionId);
  return readSessionMemoryFile(sessionMemoryFilePath(dataDir, sessionId)).records;
}

export function getSessionMemoryRecord(
  dataDir: string,
  sessionId: string,
  key: string,
): SessionMemoryRecord | null {
  validateSessionMemorySessionId(sessionId);
  validateSessionMemoryKey(key);
  return (
    readSessionMemoryFile(sessionMemoryFilePath(dataDir, sessionId)).records.find(
      (record) => record.key === key,
    ) ?? null
  );
}

export function setSessionMemoryRecord(
  dataDir: string,
  sessionId: string,
  input: {
    key: string;
    body: string;
    kind?: unknown;
    tags?: unknown;
    now?: string;
  },
): SessionMemoryRecord {
  validateSessionMemorySessionId(sessionId);
  validateSessionMemoryKey(input.key);
  if (typeof input.body !== "string") {
    throw new Error("body must be a string");
  }
  if (input.kind !== undefined && input.kind !== "note") {
    throw new Error("kind must be note");
  }

  const path = sessionMemoryFilePath(dataDir, sessionId);
  const file = readSessionMemoryFile(path);
  const now = input.now ?? new Date().toISOString();
  const existing = file.records.find((record) => record.key === input.key);
  const record: SessionMemoryRecord = {
    key: input.key,
    kind: input.kind ?? "note",
    body: input.body,
    status: "active",
    tags: normalizeSessionMemoryTags(input.tags),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const records = file.records.filter((candidate) => candidate.key !== input.key);
  records.push(record);
  writeSessionMemoryFile(path, { records });
  return record;
}

export function resolveSessionMemoryRecord(
  dataDir: string,
  sessionId: string,
  key: string,
  now = new Date().toISOString(),
): SessionMemoryRecord | null {
  validateSessionMemorySessionId(sessionId);
  validateSessionMemoryKey(key);
  const path = sessionMemoryFilePath(dataDir, sessionId);
  const file = readSessionMemoryFile(path);
  const existing = file.records.find((record) => record.key === key);
  if (!existing) {
    return null;
  }
  const record: SessionMemoryRecord = {
    ...existing,
    status: "resolved",
    updatedAt: now,
    resolvedAt: now,
  };
  writeSessionMemoryFile(path, {
    records: file.records.map((candidate) => (candidate.key === key ? record : candidate)),
  });
  return record;
}
