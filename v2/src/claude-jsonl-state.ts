import { open, stat } from "node:fs/promises";
import type { ConversationMessage, SessionState } from "./types.js";
import { findLatestSessionFile, sessionFileForId } from "./agents/claude.js";
import {
  CLAUDE_BOOKKEEPING_RECORD_TYPES,
  detectClaudeRateLimit,
  type RateLimitDetection,
} from "./rate-limit-detect.js";

/** Minimal shape extracted from a JSONL record for state classification. */
export interface ParsedRecord {
  type: string;
  role?: string;
  stopReason?: string;
  hasToolUse?: boolean;
  /** True when a tool_use payload is explicitly asking the human a question. */
  requestsUserInput?: boolean;
  /** True when the record is a synthetic `error: "rate_limit"` API error. */
  rateLimited?: boolean;
  timestampMs: number;
}

export interface ClaudeJsonlReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailRecords: ParsedRecord[];
}

/**
 * Incremental reader state for the conversation tail. `tailRecords` feeds state
 * classification; `tailMessages` feeds the dialog display. The two are capped
 * independently so a large transcript stays cheap to re-poll and to send.
 */
export interface ClaudeConversationReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailMessages: ConversationMessage[];
  tailRecords: ParsedRecord[];
  totalMessages: number;
}

const TAIL_RECORD_LIMIT = 50;
// Cap on the number of text-bearing messages returned/kept for display.
export const MAX_CONVERSATION_MESSAGES = 300;
// Activity window: inside → working. Past it: tool_use/plain-user → waiting; tool_result with no follow-up → needs_input (agent stalled).
export const ACTIVITY_WINDOW_MS = 60_000;
// Per-message text cap. Kept comfortably above the 500-char display truncation
// so the wire payload stays bounded without altering anything the UI shows.
export const MAX_MESSAGE_TEXT_CHARS = 2000;

// ── Pure classifier (no I/O) ──────────────────────────────────────────

export function classifyClaudeJsonlState(
  records: ParsedRecord[],
  nowMs: number,
  /**
   * Optional JSONL mtime. Anchors "last activity" to whichever is newer: the
   * record timestamp or the file's mtime. Deterministic: always taken from a
   * concrete `stat()` call, never inferred.
   */
  fileMtimeMs?: number,
): SessionState {
  // Walk backwards, skip progress noise to find the last meaningful record.
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) continue;

    if (record.type === "progress") {
      return "working";
    }

    if (record.type === "assistant") {
      if (
        record.stopReason === "end_turn" ||
        record.stopReason === "stop_sequence" ||
        record.stopReason === "refusal" ||
        record.stopReason === "max_tokens"
      ) {
        return "waiting";
      }
      if (record.hasToolUse) {
        if (record.requestsUserInput) {
          return "needs_input";
        }
        const lastActivityMs = Math.max(record.timestampMs, fileMtimeMs ?? 0);
        return nowMs - lastActivityMs <= ACTIVITY_WINDOW_MS ? "working" : "waiting";
      }
      return "working";
    }

    if (CLAUDE_BOOKKEEPING_RECORD_TYPES.has(record.type)) {
      return "waiting";
    }

    if (record.type === "user") {
      const lastActivityMs = Math.max(record.timestampMs, fileMtimeMs ?? 0);
      if (nowMs - lastActivityMs <= ACTIVITY_WINDOW_MS) return "working";
      return record.role === "tool_result" ? "needs_input" : "waiting";
    }
  }

  // No meaningful records → assume working (just started)
  return "working";
}

// ── JSONL helpers ─────────────────────────────────────────────────────

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Unwrap the nested "message" envelope that Claude JSONL uses. */
function unwrapMessage(parsed: Record<string, unknown>): Record<string, unknown> {
  return typeof parsed["message"] === "object" && parsed["message"] !== null
    ? (parsed["message"] as Record<string, unknown>)
    : parsed;
}

function extractRole(parsed: Record<string, unknown>, message: Record<string, unknown>): string {
  return typeof message["role"] === "string"
    ? message["role"]
    : typeof parsed["role"] === "string"
      ? parsed["role"]
      : "";
}

function contentBlocks(message: Record<string, unknown>): unknown[] {
  return Array.isArray(message["content"]) ? (message["content"] as unknown[]) : [];
}

function extractTimestampMs(
  parsed: Record<string, unknown>,
  message: Record<string, unknown>,
  fallbackTimestampMs: number,
): number {
  const rawTimestamp = parsed["timestamp"] ?? message["timestamp"];
  if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)) {
    return rawTimestamp;
  }
  if (typeof rawTimestamp === "string") {
    const timestampMs = Date.parse(rawTimestamp);
    if (Number.isFinite(timestampMs)) {
      return timestampMs;
    }
  }
  return fallbackTimestampMs;
}

function hasBlockType(blocks: unknown[], type: string): boolean {
  return blocks.some(
    (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === type,
  );
}

/** Detect tool_use blocks and whether any explicitly asks the human a question. */
function extractToolUseHints(blocks: unknown[]): {
  hasToolUse: boolean;
  requestsUserInput: boolean;
} {
  let hasToolUse = false;
  let requestsUserInput = false;
  for (const block of blocks) {
    if (
      typeof block !== "object" ||
      block === null ||
      (block as Record<string, unknown>)["type"] !== "tool_use"
    ) {
      continue;
    }
    hasToolUse = true;
    const tool = block as Record<string, unknown>;
    const input = tool["input"];
    if (tool["name"] !== "AskUserQuestion") continue;
    if (typeof input !== "object" || input === null) continue;
    const inp = input as Record<string, unknown>;
    if (Array.isArray(inp["questions"]) && inp["questions"].length > 0) {
      requestsUserInput = true;
    }
  }
  return { hasToolUse, requestsUserInput };
}

export function extractTextContent(message: Record<string, unknown>): string {
  const raw = message["content"];
  if (typeof raw === "string") return raw.trim();
  const parts: string[] = [];
  for (const block of contentBlocks(message)) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>)["type"] === "text" &&
      typeof (block as Record<string, unknown>)["text"] === "string"
    ) {
      parts.push((block as Record<string, unknown>)["text"] as string);
    }
  }
  return parts.join("\n").trim();
}

// ── JSONL parser ──────────────────────────────────────────────────────

export function parseJsonlRecord(line: string, timestampMs: number): ParsedRecord | null {
  const parsed = tryParseJson(line);
  if (!parsed) return null;

  const type = typeof parsed["type"] === "string" ? parsed["type"] : "";
  const message = unwrapMessage(parsed);
  const recordTimestampMs = extractTimestampMs(parsed, message, timestampMs);

  if (type === "progress") {
    return { type: "progress", timestampMs: recordTimestampMs };
  }

  if (CLAUDE_BOOKKEEPING_RECORD_TYPES.has(type)) {
    return { type, timestampMs: recordTimestampMs };
  }

  const role = extractRole(parsed, message);

  if (role === "assistant") {
    const stopReason =
      typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined;
    const blocks = contentBlocks(message);
    const toolUseHints = extractToolUseHints(blocks);
    return {
      type: "assistant",
      role: "assistant",
      ...(stopReason ? { stopReason } : {}),
      hasToolUse: toolUseHints.hasToolUse,
      ...(toolUseHints.requestsUserInput ? { requestsUserInput: true } : {}),
      ...(parsed["error"] === "rate_limit" ? { rateLimited: true } : {}),
      timestampMs: recordTimestampMs,
    };
  }

  if (role === "user") {
    return {
      type: "user",
      role: hasBlockType(contentBlocks(message), "tool_result") ? "tool_result" : "user",
      timestampMs: recordTimestampMs,
    };
  }

  if (type) {
    return { type, timestampMs: recordTimestampMs };
  }

  return null;
}

// ── Incremental file reader ───────────────────────────────────────────

/**
 * Read new bytes `[offset, size)` and return the span that ends on a record
 * boundary, plus the exact byte count to advance the reader offset by so every
 * record is consumed exactly once.
 *
 * A trailing line with no newline is included only when it already parses as
 * valid JSON — i.e. a complete final record left unterminated because the
 * session was killed/crashed after the record flushed but before its newline
 * (a mid-write fragment of a JSON object never parses, so it is held back and
 * re-read intact once the completing bytes arrive). This keeps both readers
 * from either dropping a completed final record or consuming a partial one.
 */
async function readNewJsonlBytes(
  filePath: string,
  size: number,
  offset: number,
): Promise<{ consumedText: string; consumedBytes: number } | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const buffer = Buffer.alloc(size - offset);
    if (buffer.length > 0) {
      await fd.read(buffer, 0, buffer.length, offset);
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    const terminatedEnd = lastNewline + 1; // 0 when the chunk holds no newline
    const trailing = buffer.toString("utf8", terminatedEnd).trim();
    const trailingComplete = trailing.length > 0 && tryParseJson(trailing) !== null;
    const consumedBytes = trailingComplete ? buffer.length : terminatedEnd;
    return { consumedText: buffer.toString("utf8", 0, consumedBytes), consumedBytes };
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

export async function readClaudeJsonlState(
  worktreePath: string,
  reader?: ClaudeJsonlReaderState,
  agentSessionId?: string,
): Promise<{
  state: SessionState;
  reader: ClaudeJsonlReaderState;
  rateLimit: RateLimitDetection | null;
} | null> {
  // With a pinned id, resolve the transcript by id and never fall back to the
  // newest-mtime scan (which could cross-bind to a sibling session sharing the
  // worktree). Legacy sessions with no pinned id keep the mtime scan.
  const filePath =
    reader?.filePath ??
    (agentSessionId
      ? await sessionFileForId(worktreePath, agentSessionId)
      : await findLatestSessionFile(worktreePath));
  if (!filePath) {
    return null;
  }

  let fileStat: { size: number; mtimeMs: number };
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  const currentReader: ClaudeJsonlReaderState = reader ?? {
    filePath,
    lastOffset: 0,
    lastMtimeMs: 0,
    tailRecords: [],
  };

  // Nothing appended (same mtime and size) and we already have records → skip
  // re-read. Comparing size as well as mtime guards against coarse-granularity
  // filesystem timestamps where a second write lands within the same mtime tick.
  if (
    fileStat.mtimeMs === currentReader.lastMtimeMs &&
    fileStat.size === currentReader.lastOffset &&
    currentReader.tailRecords.length > 0
  ) {
    return {
      state: classifyClaudeJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
      rateLimit: detectClaudeRateLimit(currentReader.tailRecords),
    };
  }

  // Read only new bytes since last offset
  const readOffset = Math.min(currentReader.lastOffset, fileStat.size);
  const nowMs = Date.now();

  const chunk = await readNewJsonlBytes(filePath, fileStat.size, readOffset);
  if (!chunk) {
    // If we can't read, return null to fall back to other classification
    return null;
  }

  const newRecords: ParsedRecord[] = [];
  for (const line of chunk.consumedText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseJsonlRecord(trimmed, nowMs);
    if (record) {
      newRecords.push(record);
    }
  }

  const combined = [...currentReader.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);
  const nextReader: ClaudeJsonlReaderState = {
    filePath,
    lastOffset: readOffset + chunk.consumedBytes,
    lastMtimeMs: fileStat.mtimeMs,
    tailRecords: combined,
  };

  if (combined.length === 0) {
    return null;
  }

  return {
    state: classifyClaudeJsonlState(combined, nowMs, fileStat.mtimeMs),
    reader: nextReader,
    rateLimit: detectClaudeRateLimit(combined),
  };
}

// ── Conversation parser (pure, no I/O) ───────────────────────────────

/**
 * Parse a batch of JSONL lines into both classification records and display
 * messages. Message text is truncated to the per-message cap. Shared by the
 * pure line parser and the incremental tail reader so extraction stays single-path.
 */
export function parseConversationBatch(
  lines: string[],
  nowMs: number,
): { records: ParsedRecord[]; messages: ConversationMessage[] } {
  const records: ParsedRecord[] = [];
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const record = parseJsonlRecord(trimmed, nowMs);
    if (record) records.push(record);

    const parsed = tryParseJson(trimmed);
    if (!parsed) continue;

    const message = unwrapMessage(parsed);
    const role = extractRole(parsed, message);
    if (role !== "user" && role !== "assistant") continue;

    const combinedText = extractTextContent(message);
    if (!combinedText) continue;

    const ts = extractTimestampMs(parsed, message, nowMs);
    messages.push({ role, text: combinedText.slice(0, MAX_MESSAGE_TEXT_CHARS), timestampMs: ts });
  }

  return { records, messages };
}

// ── Incremental conversation tail reader ──────────────────────────────

export async function readClaudeConversationTail(
  worktreePath: string,
  reader?: ClaudeConversationReaderState,
  agentSessionId?: string,
): Promise<{
  messages: ConversationMessage[];
  state: SessionState;
  totalMessages: number;
  hasMore: boolean;
  reader: ClaudeConversationReaderState;
} | null> {
  // Re-resolve each poll: a pinned id binds to its own transcript, else fall
  // back to the newest-mtime scan (legacy sessions with no pinned id).
  const filePath = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (!filePath) return null;

  let fileStat: { size: number; mtimeMs: number };
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  // Rebuild from scratch when there is no reader, the transcript file changed,
  // the file shrank below our last offset (truncation/rotation), or its mtime
  // moved backwards (the same path was replaced with an older file). Reading
  // from a stale offset into rewritten bytes would emit misaligned/garbled
  // lines. Residual gap: an in-place compaction that rewrites the same path to
  // a size >= the old offset with a newer mtime is not detectable here and
  // would still misalign until the next path change or shrink.
  const reuse =
    reader !== undefined &&
    reader.filePath === filePath &&
    fileStat.size >= reader.lastOffset &&
    fileStat.mtimeMs >= reader.lastMtimeMs;
  const base: ClaudeConversationReaderState = reuse
    ? reader
    : {
        filePath,
        lastOffset: 0,
        lastMtimeMs: 0,
        tailMessages: [],
        tailRecords: [],
        totalMessages: 0,
      };

  // Nothing appended (same mtime and size) and we already have content → skip
  // re-read. Comparing size as well as mtime guards against coarse-granularity
  // filesystem timestamps where a second write lands within the same mtime tick.
  if (
    reuse &&
    fileStat.mtimeMs === base.lastMtimeMs &&
    fileStat.size === base.lastOffset &&
    base.tailRecords.length > 0
  ) {
    return {
      messages: base.tailMessages,
      state: classifyClaudeJsonlState(base.tailRecords, Date.now(), fileStat.mtimeMs),
      totalMessages: base.totalMessages,
      hasMore: base.totalMessages > base.tailMessages.length,
      reader: base,
    };
  }

  const readOffset = base.lastOffset;
  const nowMs = Date.now();

  const chunk = await readNewJsonlBytes(filePath, fileStat.size, readOffset);
  if (!chunk) return null;

  const { records: newRecords, messages: newMessages } = parseConversationBatch(
    chunk.consumedText.split("\n"),
    nowMs,
  );

  const totalMessages = base.totalMessages + newMessages.length;
  const tailMessages = [...base.tailMessages, ...newMessages].slice(-MAX_CONVERSATION_MESSAGES);
  const tailRecords = [...base.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);

  const nextReader: ClaudeConversationReaderState = {
    filePath,
    lastOffset: readOffset + chunk.consumedBytes,
    lastMtimeMs: fileStat.mtimeMs,
    tailMessages,
    tailRecords,
    totalMessages,
  };

  return {
    messages: tailMessages,
    state: classifyClaudeJsonlState(tailRecords, nowMs, fileStat.mtimeMs),
    totalMessages,
    hasMore: totalMessages > tailMessages.length,
    reader: nextReader,
  };
}
