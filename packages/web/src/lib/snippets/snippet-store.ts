// Browser persistence for snippet records and the unconfirmed-send budget.
// Fail closed: a throw, quota error or invalid record on a G3/G4 key is
// reported as `ok: false`; nothing is ever served from memory.

import {
  isRecord,
  SNIPPET_MAX_RECORD_BYTES,
  SNIPPET_RECORD_TTL_MS,
  snippetByteLength,
  type SnippetActionRecord,
  type SnippetActionStatus,
  type SnippetConfirmReason,
} from "./snippet-protocol";
import type { JsonValue } from "./snippet-schema";

export const SNIPPET_RECORD_PREFIX = "spur:snippet:v1:";
export const SNIPPET_BUDGET_PREFIX = "spur:snippet-budget:v1:";

export interface SnippetControlValue {
  id: string;
  value: JsonValue;
}

export interface SnippetRecord {
  instanceId: string;
  lastRevision: number;
  unconfirmedRevision: number | null;
  state: { app: JsonValue | null; controls: SnippetControlValue[] };
  action: SnippetActionRecord | null;
  updatedAt: number;
}

export interface SnippetBudget {
  unconfirmed: number;
  updatedAt: number;
}

export type StoreRead<T> = { ok: true; value: T } | { ok: false };
export type StoreWrite = { ok: true; shrunk: boolean } | { ok: false };

export interface SnippetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const ACTION_STATUSES: readonly SnippetActionStatus[] = [
  "awaiting_confirm",
  "submitting",
  "accepted",
  "queued",
  "processing",
  "completed",
  "replaced",
  "error",
  "delivery_unknown",
  "timeout",
];
const CONFIRM_REASONS: readonly SnippetConfirmReason[] = [
  "declared",
  "no_focus",
  "repeat_in_revision",
  "budget",
  "storage_unavailable",
];

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseAction(value: unknown): SnippetActionRecord | null {
  if (!isRecord(value)) return null;
  const { requestId, actionId, status, prompt, instanceId, baseRevision, dispatchedAt } = value;
  if (typeof requestId !== "string" || typeof actionId !== "string") return null;
  if (typeof prompt !== "string" || typeof instanceId !== "string") return null;
  if (typeof status !== "string" || !ACTION_STATUSES.includes(status as SnippetActionStatus))
    return null;
  if (!isInt(baseRevision) || !isInt(dispatchedAt)) return null;
  const action: SnippetActionRecord = {
    requestId,
    actionId,
    status: status as SnippetActionStatus,
    prompt,
    instanceId,
    baseRevision,
    dispatchedAt,
  };
  if (value.acceptedAt !== undefined) {
    if (!isInt(value.acceptedAt)) return null;
    action.acceptedAt = value.acceptedAt;
  }
  if (value.retryOf !== undefined) {
    if (typeof value.retryOf !== "string") return null;
    action.retryOf = value.retryOf;
  }
  if (value.httpStatus !== undefined) {
    if (!isInt(value.httpStatus)) return null;
    action.httpStatus = value.httpStatus;
  }
  if (value.confirmReason !== undefined) {
    if (!CONFIRM_REASONS.includes(value.confirmReason as SnippetConfirmReason)) return null;
    action.confirmReason = value.confirmReason as SnippetConfirmReason;
  }
  return action;
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
  if (!isRecord(value) || !isRecord(value.state)) return null;
  const { instanceId, lastRevision, unconfirmedRevision, updatedAt } = value;
  const { app, controls } = value.state;
  if (typeof instanceId !== "string" || !isInt(lastRevision) || !isInt(updatedAt)) return null;
  if (unconfirmedRevision !== null && !isInt(unconfirmedRevision)) return null;
  const parsedControls = parseControls(controls);
  if (!parsedControls) return null;
  let action: SnippetActionRecord | null = null;
  if (value.action !== null) {
    action = parseAction(value.action);
    if (!action) return null;
  }
  return {
    instanceId,
    lastRevision,
    unconfirmedRevision,
    state: { app: (app ?? null) as JsonValue | null, controls: parsedControls },
    action,
    updatedAt,
  };
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

// Oversize or quota failure: rewrite without app state and controls, keeping
// the G3 fields (instanceId, lastRevision, unconfirmedRevision) and the action.
export function writeSnippetRecord(
  storage: SnippetStorage,
  sessionId: string,
  snippetId: string,
  record: SnippetRecord,
): StoreWrite {
  const key = recordKey(sessionId, snippetId);
  if (snippetByteLength(record) <= SNIPPET_MAX_RECORD_BYTES && writeJson(storage, key, record)) {
    return { ok: true, shrunk: false };
  }
  const shrunk: SnippetRecord = { ...record, state: { app: null, controls: [] } };
  return writeJson(storage, key, shrunk) ? { ok: true, shrunk: true } : { ok: false };
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

// Only `spur:snippet:v1:` records older than 7 days. Budget keys are never pruned.
export function pruneSnippetRecords(storage: SnippetStorage, nowMs: number): void {
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(SNIPPET_RECORD_PREFIX)) continue;
      const raw = storage.getItem(key);
      const record = raw === null ? null : parseRecord(raw);
      if (record && nowMs - record.updatedAt > SNIPPET_RECORD_TTL_MS) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // storage unavailable: nothing to prune
  }
}
