import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  findCursorAckTranscriptFile,
  resolveCursorPinnedTranscriptPath,
} from "../cursor-jsonl-state.js";
import { findCursorSessionId } from "./cursor.js";

export interface CursorSubmitBaseline {
  file: string;
  size: number;
  // Mutated in place across polls of the same binding (session-service.ts
  // captures one baseline object and calls scan() repeatedly against it, see
  // waitForSubmitAck). Records the byte offset a rotated chat-id transcript
  // was FIRST seen at, so a later poll only scans records written after that
  // sighting rather than the rotated file's full pre-existing history.
  // Optional: attached lazily by scanCursorJsonlForMessage the first time a
  // rotation is observed, so callers that build a baseline literal (tests)
  // need not know about it up front.
  rotationOffsets?: Map<string, number>;
}

export interface CursorSubmitAckScanResult {
  found: boolean;
  scannedFile: string;
}

export async function captureCursorSubmitBaseline(
  worktreePath: string,
  agentSessionId?: string,
): Promise<CursorSubmitBaseline | null> {
  const file = await findCursorAckTranscriptFile(worktreePath, agentSessionId);
  if (!file) {
    if (!agentSessionId) {
      // No id to pin on and nothing resolved: today's behavior, unchanged. A
      // fresh launch with no project dir at all has no baseline to wait on.
      return null;
    }
    // A pinned id with nothing on disk yet must still yield a WAITING baseline,
    // never null — session-service.ts treats a null binding as an unconditional,
    // un-waited "submitted", so this is the anti-regression path for a send that
    // races cursor's own creation of the transcript file.
    return { file: await resolveCursorPinnedTranscriptPath(worktreePath, agentSessionId), size: 0 };
  }
  try {
    const fileStat = await stat(file);
    return { file, size: fileStat.size };
  } catch {
    return agentSessionId ? { file, size: 0 } : null;
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
        if (text !== null && normalize(text).includes(normalizedTarget)) {
          reader.close();
          return true;
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
): Promise<CursorSubmitAckScanResult> {
  const normalizedTarget = submitAckMatchText(text);
  if (!normalizedTarget) {
    return { found: false, scannedFile: baseline.file };
  }

  if (await scanFileForUserText(baseline.file, baseline.size, normalizedTarget)) {
    return { found: true, scannedFile: baseline.file };
  }

  if (agentSessionId && options?.cursorConfigDir) {
    // Cursor rotates its chat id mid-session; a pinned id's transcript never
    // rotates, so re-resolve the current chat id from the session-private
    // config dir (never the shared project transcripts dir — see #889/#890).
    const resolvedId = await findCursorSessionId(worktreePath, {
      configDir: options.cursorConfigDir,
    });
    if (resolvedId && resolvedId !== agentSessionId) {
      const rotated = await findCursorAckTranscriptFile(worktreePath, resolvedId);
      if (rotated) {
        // The rotated chat id can carry history from before this send (or
        // even before the rotation was first detected by this binding): a
        // full-history scan from 0 lets a short send like "continue" match an
        // unrelated earlier turn (substring match, see submitAckMatchText).
        // Baseline against the file's size the FIRST time this binding sees
        // it, and remember that offset for every later poll of the same
        // binding, so only records written after that sighting can ack.
        baseline.rotationOffsets ??= new Map();
        let offset = baseline.rotationOffsets.get(rotated);
        if (offset === undefined) {
          const rotatedStat = await stat(rotated).catch(() => null);
          offset = rotatedStat ? rotatedStat.size : 0;
          baseline.rotationOffsets.set(rotated, offset);
        }
        const found = await scanFileForUserText(rotated, offset, normalizedTarget);
        return { found, scannedFile: rotated };
      }
    }
    // No chat-id rotation (or no rotated file yet): fall through to the
    // existing pinned-file re-resolve below. A symlinked worktree can baseline
    // against a candidate path that never gets written while cursor writes
    // the pinned transcript under a different worktree-path candidate; that
    // rescan must still run even when the chat id itself never rotated.
  }

  const latest = await findCursorAckTranscriptFile(worktreePath, agentSessionId);
  if (!latest || latest === baseline.file) {
    return { found: false, scannedFile: baseline.file };
  }
  const found = await scanFileForUserText(latest, 0, normalizedTarget);
  return { found, scannedFile: latest };
}
