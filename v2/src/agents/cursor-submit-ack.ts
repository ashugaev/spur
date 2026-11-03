import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  cursorChatIdFromTranscriptPath,
  findLatestCursorTranscriptFile,
  readCursorStableOffset,
  resolveCursorPinnedTranscriptPath,
} from "../cursor-jsonl-state.js";
import type { SubmitAckFileScanResult } from "./claude-submit-ack.js";
import { findCursorSessionId } from "./cursor.js";

export type CursorSubmitBaseline = CursorPersistedSubmitBaseline & {
  // Mutated in place across polls of the same binding (session-service.ts
  // captures one baseline object and calls scan() repeatedly against it, see
  // waitForSubmitAck). Records the byte offset a rotated chat-id transcript
  // was first seen at, refreshed once before the pane write. Later polls only
  // scan records written after that floor, never the full pre-existing history.
  // Optional: attached lazily by scanCursorJsonlForMessage the first time a
  // rotation is observed, so callers that build a baseline literal (tests)
  // need not know about it up front.
  rotationOffsets?: Map<string, number>;
};

// Persisted form (queuedMessageTyped.ackBaseline): the rotated chat file's
// send-time offset rides along so a restart's scan starts where the live one did.
export interface CursorPersistedSubmitBaseline {
  file: string | null;
  size: number;
  deliveryId?: string;
  rotated?: { file: string; size: number };
}

export function isCursorDeliveryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function cursorDeliveryInput(deliveryId: string, message: string): string {
  return `${cursorDeliveryMarker(deliveryId)}${message}`;
}

function cursorDeliveryMarker(deliveryId: string): string {
  return `[Spur delivery: ${deliveryId}]\n\n`;
}

export function persistCursorSubmitBaseline(
  baseline: CursorSubmitBaseline,
): CursorPersistedSubmitBaseline {
  const rotated = baseline.rotationOffsets?.entries().next().value;
  return {
    file: baseline.file,
    size: baseline.size,
    ...(baseline.deliveryId ? { deliveryId: baseline.deliveryId } : {}),
    ...(rotated ? { rotated: { file: rotated[0], size: rotated[1] } } : {}),
  };
}

export function restoreCursorSubmitBaseline(
  persisted: CursorPersistedSubmitBaseline,
): CursorSubmitBaseline {
  const { rotated } = persisted;
  return {
    file: persisted.file,
    size: persisted.size,
    ...(persisted.deliveryId ? { deliveryId: persisted.deliveryId } : {}),
    ...(rotated ? { rotationOffsets: new Map([[rotated.file, rotated.size]]) } : {}),
  };
}

// Cursor rotates its chat id mid-session; a pinned id's transcript never
// rotates, so re-resolve the current chat id from the session-private config
// dir (never the shared project transcripts dir — see #889/#890).
async function findRotatedCursorTranscript(
  worktreePath: string,
  agentSessionId: string | undefined,
  cursorConfigDir: string,
): Promise<string | null> {
  const resolvedId = await findCursorSessionId(worktreePath, { configDir: cursorConfigDir });
  if (!resolvedId || resolvedId === agentSessionId) return null;
  return findLatestCursorTranscriptFile(worktreePath, resolvedId);
}

export interface CursorSubmitAckScanResult {
  found: boolean;
  scannedFile: string | null;
}

// The pinned id wins; otherwise the newest chat in the session-private config
// dir. Never the shared project transcripts dir (#889): every transcript lookup
// in this file must pass a chat id, or findLatestCursorTranscriptFile falls back
// to newest-by-mtime over that shared dir.
async function resolveCursorChatId(
  worktreePath: string,
  agentSessionId: string | undefined,
  cursorConfigDir: string | undefined,
): Promise<string | null> {
  if (agentSessionId) return agentSessionId;
  return cursorConfigDir ? findCursorSessionId(worktreePath, { configDir: cursorConfigDir }) : null;
}

export async function captureCursorSubmitBaseline(
  worktreePath: string,
  agentSessionId?: string,
  options?: { cursorConfigDir?: string; deliveryId?: string },
): Promise<CursorSubmitBaseline | null> {
  const chatId = await resolveCursorChatId(worktreePath, agentSessionId, options?.cursorConfigDir);
  if (!chatId) {
    return options?.deliveryId
      ? { file: null, size: 0, deliveryId: options.deliveryId }
      : options?.cursorConfigDir
        ? { file: null, size: 0 }
        : null;
  }
  const captured = await capturePinnedCursorBaseline(worktreePath, chatId);
  const baseline: CursorSubmitBaseline = {
    ...captured,
    ...(options?.deliveryId ? { deliveryId: options.deliveryId } : {}),
  };
  if ((!agentSessionId && !baseline.deliveryId) || !options?.cursorConfigDir) return baseline;
  // An already-rotated chat: offset its file at send time, as the pinned one.
  const rotated = await findRotatedCursorTranscript(
    worktreePath,
    agentSessionId,
    options.cursorConfigDir,
  );
  if (!rotated) return baseline;
  const seeded: CursorSubmitBaseline = { ...baseline };
  await seedRotationOffset(seeded, rotated);
  return seeded;
}

async function readSubmitFloor(file: string, previous: number): Promise<number> {
  return Math.max(previous, await readCursorStableOffset(file).catch(() => previous));
}

// Floors `rotated` at its stable size without lowering a remembered offset.
async function seedRotationOffset(
  baseline: CursorSubmitBaseline,
  rotated: string,
): Promise<number> {
  const offset = await readSubmitFloor(rotated, baseline.rotationOffsets?.get(rotated) ?? 0);
  baseline.rotationOffsets ??= new Map();
  baseline.rotationOffsets.set(rotated, offset);
  return offset;
}

// Called once per send, right before the pane write. Refreshes pinned/current
// rotated floors on the live baseline and persisted twin, both mutated in place.
export async function markCursorWriteStart(
  baseline: CursorSubmitBaseline,
  persisted: CursorPersistedSubmitBaseline,
  worktreePath: string,
  agentSessionId?: string,
  options?: { cursorConfigDir?: string },
): Promise<void> {
  if (baseline.file !== null) {
    baseline.size = await readSubmitFloor(baseline.file, baseline.size);
    if (persisted.file !== null) persisted.size = baseline.size;
  }
  if ((!agentSessionId && !baseline.deliveryId) || !options?.cursorConfigDir) return;
  const rotated = await findRotatedCursorTranscript(
    worktreePath,
    agentSessionId,
    options.cursorConfigDir,
  );
  if (!rotated) return;
  persisted.rotated = { file: rotated, size: await seedRotationOffset(baseline, rotated) };
}

async function capturePinnedCursorBaseline(
  worktreePath: string,
  agentSessionId: string,
): Promise<CursorSubmitBaseline> {
  const file = await findLatestCursorTranscriptFile(worktreePath, agentSessionId);
  if (!file) {
    // A pinned id with nothing on disk yet must still yield a WAITING baseline,
    // never null — session-service.ts treats a null binding as an unconditional,
    // un-waited "submitted", so this is the anti-regression path for a send that
    // races cursor's own creation of the transcript file.
    return { file: await resolveCursorPinnedTranscriptPath(worktreePath, agentSessionId), size: 0 };
  }
  try {
    return { file, size: await readCursorStableOffset(file) };
  } catch {
    return { file, size: 0 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractUserMessageText(parsed: Record<string, unknown>): string | null {
  if (parsed["role"] !== "user") {
    return null;
  }
  const message = parsed["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) {
    return null;
  }
  const parts: string[] = [];
  for (const block of message["content"]) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
const SUBMIT_ACK_MATCH_PREFIX_LEN = 512;

function submitAckMatchText(text: string): string {
  const normalized = normalize(text);
  const taskBody =
    normalized.split(/\n\nSession metadata:\n/)[0]?.trim() ??
    normalized.split(/\n\n+/)[0]?.trim() ??
    normalized;
  if (!taskBody) {
    return "";
  }
  if (taskBody.length <= SUBMIT_ACK_MATCH_PREFIX_LEN) {
    return taskBody;
  }
  return taskBody.slice(0, SUBMIT_ACK_MATCH_PREFIX_LEN);
}

// Cursor wraps the submitted message in its own context tags (timestamp,
// user_query), so the recorded user turn contains the sent text rather than
// equalling it. Match by substring against that wrapped record.
async function scanFileForUserText(
  filePath: string,
  startOffset: number,
  normalizedTarget: string,
  deliveryId?: string,
): Promise<boolean> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8", start: startOffset });
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const rawLine of reader) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const parsed = tryParseJson(trimmed);
        if (!parsed) continue;
        const text = extractUserMessageText(parsed);
        if (text === null) continue;
        const normalized = normalize(text);
        const marker = deliveryId ? cursorDeliveryMarker(deliveryId) : null;
        const markerIndex = marker ? normalized.indexOf(marker) : -1;
        const matches = marker
          ? markerIndex >= 0 &&
            normalized.slice(markerIndex + marker.length).includes(normalizedTarget)
          : normalized.includes(normalizedTarget);
        if (matches) {
          reader.close();
          return matches;
        }
      }
    } finally {
      reader.close();
    }
  } catch {
    return false;
  }
  return false;
}

export async function scanCursorJsonlForMessage(
  baseline: CursorSubmitBaseline,
  text: string,
  worktreePath: string,
  agentSessionId?: string,
  options?: { cursorConfigDir?: string },
): Promise<SubmitAckFileScanResult> {
  const normalizedTarget = submitAckMatchText(text);
  if (!normalizedTarget) {
    return { found: false, scannedFile: baseline.file };
  }

  let activeFile = baseline.file;
  if (activeFile === null) {
    // Pending baseline: no chat existed at send time (cursor writes store.db
    // before the first transcript record), so the own chat holds only
    // post-send records and is scanned from 0. Resolved in place so later
    // polls and the rotation floor below treat it as the pinned file.
    const chatId = await resolveCursorChatId(
      worktreePath,
      agentSessionId,
      options?.cursorConfigDir,
    );
    const resolved = chatId ? await findLatestCursorTranscriptFile(worktreePath, chatId) : null;
    if (!resolved) {
      return { found: false, scannedFile: null };
    }
    baseline.file = resolved;
    baseline.size = 0;
    activeFile = resolved;
  }
  const pinnedId = agentSessionId ?? cursorChatIdFromTranscriptPath(activeFile);

  if (await scanFileForUserText(activeFile, baseline.size, normalizedTarget, baseline.deliveryId)) {
    return { found: true, scannedFile: activeFile };
  }

  if (options?.cursorConfigDir) {
    const rotated = await findRotatedCursorTranscript(
      worktreePath,
      pinnedId,
      options.cursorConfigDir,
    );
    if (rotated) {
      // The rotated chat id can carry history from before this send (or
      // even before the rotation was first detected by this binding): a
      // full-history scan from 0 lets a short send like "continue" match an
      // unrelated earlier turn (substring match, see submitAckMatchText).
      // Baseline against the file's size the FIRST time this binding sees
      // it, and remember that offset for every later poll of the same
      // binding, so only records written after that sighting can ack.
      //
      // A new file can copy old matching text before the paste completes.
      // Birthtime and first-record position cannot prove which send wrote it.
      // Keep the floor. Only the exact current input identity allows a
      // correlated binding to inspect a legitimate first record below it.
      let offset = baseline.rotationOffsets?.get(rotated);
      if (offset === undefined) {
        offset = await seedRotationOffset(baseline, rotated);
      }
      const found = await scanFileForUserText(
        rotated,
        baseline.deliveryId ? 0 : offset,
        normalizedTarget,
        baseline.deliveryId,
      );
      return { found, scannedFile: rotated };
    }
    // No chat-id rotation (or no rotated file yet): fall through to the
    // existing pinned-file re-resolve below. A symlinked worktree can baseline
    // against a candidate path that never gets written while cursor writes
    // the pinned transcript under a different worktree-path candidate; that
    // rescan must still run even when the chat id itself never rotated.
  }

  const latest = await findLatestCursorTranscriptFile(worktreePath, pinnedId);
  if (!latest || latest === baseline.file) {
    return { found: false, scannedFile: baseline.file };
  }
  const found = await scanFileForUserText(latest, 0, normalizedTarget, baseline.deliveryId);
  return { found, scannedFile: latest };
}
