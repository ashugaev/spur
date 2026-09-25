import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { findLatestSessionFile, sessionFileForId, sessionFilePathForId } from "./claude.js";
import { extractTextContent } from "../claude-jsonl-state.js";

export interface ClaudeSubmitBaseline {
  file: string;
  size: number;
}

export async function captureClaudeSubmitBaseline(
  worktreePath: string,
  agentSessionId?: string,
  options?: { freshLaunch?: boolean },
): Promise<ClaudeSubmitBaseline | null> {
  const file = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (file) {
    try {
      const fileStat = await stat(file);
      return { file, size: fileStat.size };
    } catch {
      return null;
    }
  }
  if (!agentSessionId || options?.freshLaunch !== true) {
    return null;
  }
  // A freshly launched claude writes `<uuid>.jsonl` only when it persists the
  // first submitted message, so the launch send has no transcript to baseline
  // against — exactly when the ack matters. Bind to the path the pinned id will
  // create; `scanClaudeJsonlForMessage` tolerates a file that is not there yet
  // and re-resolves the id when this candidate never appears.
  return { file: sessionFilePathForId(worktreePath, agentSessionId), size: 0 };
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
  const message = parsed["message"];
  if (!isRecord(message)) {
    return null;
  }
  if (message["role"] !== "user") {
    return null;
  }
  return extractTextContent(message);
}

// A send typed into a busy pane is queued, and claude writes no `type:"user"`
// record for it until the turn absorbing it ends. The queue `enqueue` record is
// written when Enter lands and carries the submitted text, so it is the ack.
function extractEnqueuedText(parsed: Record<string, unknown>): string | null {
  if (parsed["operation"] !== "enqueue") {
    return null;
  }
  const content = parsed["content"];
  return typeof content === "string" ? content : null;
}

function extractDeliveredText(parsed: Record<string, unknown>): string | null {
  switch (parsed["type"]) {
    case "user":
      return extractUserMessageText(parsed);
    case "queue-operation":
      return extractEnqueuedText(parsed);
    default:
      return null;
  }
}

const CTRL_U = String.fromCharCode(0x15);

function stripLeadingCtrlU(value: string): string {
  let index = 0;
  while (value[index] === CTRL_U) {
    index += 1;
  }
  return value.slice(index);
}

const normalize = (s: string) =>
  stripLeadingCtrlU(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

async function scanFileForDeliveredText(
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
        const text = extractDeliveredText(parsed);
        if (text !== null && normalize(text) === normalizedTarget) {
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

export async function scanClaudeJsonlForMessage(
  baseline: ClaudeSubmitBaseline,
  text: string,
  worktreePath: string,
  agentSessionId?: string,
): Promise<boolean> {
  const normalizedTarget = normalize(text);

  if (await scanFileForDeliveredText(baseline.file, baseline.size, normalizedTarget)) {
    return true;
  }

  // When a pinned id exists, stay bound to its transcript; otherwise fall back
  // to the newest-mtime scan for legacy sessions.
  const latest = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (!latest || latest === baseline.file) {
    return false;
  }
  return scanFileForDeliveredText(latest, 0, normalizedTarget);
}
