// Browser persistence for the snippet interaction gates: one record per snippet
// (instance, last mounted revision, revision of the last unconfirmed send) and the
// per-session unconfirmed-send budget. App state and actions live in the store
// (`_state`, `_actions`), never here. Fail closed: a throw, quota error or invalid
// record is reported as `ok: false`; nothing is ever served from memory.

import { isRecord, SNIPPET_RECORD_TTL_MS } from "./snippet-protocol";
import type { JsonValue } from "./snippet-schema";

export const SNIPPET_RECORD_PREFIX = "spur:snippet:v2:";
// Pre-store records (state and action in localStorage); pruned on sight.
export const SNIPPET_V1_RECORD_PREFIX = "spur:snippet:v1:";
export const SNIPPET_BUDGET_PREFIX = "spur:snippet-budget:v1:";

export interface SnippetControlValue {
  id: string;
  value: JsonValue;
}

export interface SnippetRecord {
  instanceId: string;
  lastRevision: number;
  unconfirmedRevision: number | null;
  updatedAt: number;
}

export interface SnippetBudget {
  unconfirmed: number;
  updatedAt: number;
}

export type StoreRead<T> = { ok: true; value: T } | { ok: false };

export interface SnippetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseControls(value: unknown): SnippetControlValue[] | null {
  if (!Array.isArray(value)) return null;
  const controls: SnippetControlValue[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.value === undefined) return null;
    controls.push({ id: entry.id, value: entry.value as JsonValue });
  }
  return controls;
}

function parseRecord(raw: string): SnippetRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { instanceId, lastRevision, unconfirmedRevision, updatedAt } = value;
  if (typeof instanceId !== "string" || !isInt(lastRevision) || !isInt(updatedAt)) return null;
  if (unconfirmedRevision !== null && !isInt(unconfirmedRevision)) return null;
  return { instanceId, lastRevision, unconfirmedRevision, updatedAt };
}

function parseBudget(raw: string): SnippetBudget | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isInt(value.unconfirmed) || !isInt(value.updatedAt)) return null;
  return { unconfirmed: value.unconfirmed, updatedAt: value.updatedAt };
}

export const recordKey = (sessionId: string, snippetId: string): string =>
  `${SNIPPET_RECORD_PREFIX}${sessionId}:${snippetId}`;
export const budgetKey = (sessionId: string): string => `${SNIPPET_BUDGET_PREFIX}${sessionId}`;

function readParsed<T>(
  storage: SnippetStorage,
  key: string,
  parse: (raw: string) => T | null,
): StoreRead<T | null> {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { ok: false };
  }
  if (raw === null) return { ok: true, value: null };
  const parsed = parse(raw);
  if (parsed !== null) return { ok: true, value: parsed };
  // Invalid record: discard it. The read still fails once, so the caller
  // confirms instead of trusting a gate it could not read.
  try {
    storage.removeItem(key);
  } catch {
    // key stays; next read fails again
  }
  return { ok: false };
}

function writeJson(storage: SnippetStorage, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readSnippetRecord(
  storage: SnippetStorage,
  sessionId: string,
  snippetId: string,
): StoreRead<SnippetRecord | null> {
  return readParsed(storage, recordKey(sessionId, snippetId), parseRecord);
}

export function writeSnippetRecord(
  storage: SnippetStorage,
  sessionId: string,
  snippetId: string,
  record: SnippetRecord,
): boolean {
  return writeJson(storage, recordKey(sessionId, snippetId), record);
}

export function readSnippetBudget(
  storage: SnippetStorage,
  sessionId: string,
): StoreRead<SnippetBudget> {
  const read = readParsed(storage, budgetKey(sessionId), parseBudget);
  if (!read.ok) return read;
  return { ok: true, value: read.value ?? { unconfirmed: 0, updatedAt: 0 } };
}

export function writeSnippetBudget(
  storage: SnippetStorage,
  sessionId: string,
  unconfirmed: number,
  nowMs: number,
): boolean {
  return writeJson(storage, budgetKey(sessionId), { unconfirmed, updatedAt: nowMs });
}

// Every `spur:snippet:v1:` key, and `spur:snippet:v2:` records older than 7 days.
// Budget keys are never pruned.
export function pruneSnippetRecords(storage: SnippetStorage, nowMs: number): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null) continue;
      if (key.startsWith(SNIPPET_V1_RECORD_PREFIX)) {
        stale.push(key);
        continue;
      }
      if (!key.startsWith(SNIPPET_RECORD_PREFIX)) continue;
      const raw = storage.getItem(key);
      const record = raw === null ? null : parseRecord(raw);
      if (record && nowMs - record.updatedAt > SNIPPET_RECORD_TTL_MS) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // storage unavailable: nothing to prune
  }
}
