import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { findLatestCursorTranscriptFile } from "../cursor-jsonl-state.js";

export interface CursorSubmitBaseline {
  file: string;
  size: number;
}

export async function captureCursorSubmitBaseline(
  worktreePath: string,
  agentSessionId?: string,
): Promise<CursorSubmitBaseline | null> {
  const file = await findLatestCursorTranscriptFile(worktreePath, agentSessionId);
  if (!file) {
    return null;
  }
  try {
    const fileStat = await stat(file);
    return { file, size: fileStat.size };
  } catch {
    return null;
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
): Promise<boolean> {
  const normalizedTarget = submitAckMatchText(text);
  if (!normalizedTarget) {
    return false;
  }

  if (await scanFileForUserText(baseline.file, baseline.size, normalizedTarget)) {
    return true;
  }

  const latest = await findLatestCursorTranscriptFile(worktreePath, agentSessionId);
  if (!latest || latest === baseline.file) {
    return false;
  }
  return scanFileForUserText(latest, 0, normalizedTarget);
}
