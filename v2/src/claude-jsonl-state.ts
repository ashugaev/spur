import { open, readFile, stat } from "node:fs/promises";
import type { SessionState, TranscriptEntry } from "./types.js";
import { findLatestSessionFile, sessionFileForId } from "./agents/claude.js";
import {
  CLAUDE_BOOKKEEPING_RECORD_TYPES,
  detectClaudeRateLimit,
  parseRateLimitResetAtMs,
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
  /**
   * Epoch ms the limit resets at, parsed from this record's own banner text
   * and anchored to this record's own timestamp. Absent when the record
   * carries no parseable "resets HH[:MM](am|pm) (UTC)" clause, or no
   * parseable own timestamp — never inferred from the caller's clock.
   */
  rateLimitResetAtMs?: number;
  /** True when the record is a synthetic `error: "server_error"` API error. */
  serverError?: boolean;
  /** Real model id reported by the assistant message. Never the `<synthetic>` placeholder. */
  model?: string;
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
 * classification; `tailEntries` feeds the dialog display. The two are capped
 * independently so a large transcript stays cheap to re-poll and to send.
 */
export interface ClaudeConversationReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailEntries: TranscriptEntry[];
  tailRecords: ParsedRecord[];
  totalEntries: number;
}

const TAIL_RECORD_LIMIT = 50;
// Ceiling on a cold read's allocation. A reader with no prior offset would
// otherwise `Buffer.alloc` the whole transcript and then copy it again into a
// string — on this host the largest is 49.5 MB, and the state reader keeps
// only TAIL_RECORD_LIMIT records out of it. Cold reads are not rare: every
// daemon restart is one, and pruneSessionScopedState drops a reader whenever
// its session leaves the live set, so a session that flips back to live pays
// the full re-read again. Sized well above 50 records of ordinary transcript.
const MAX_COLD_READ_BYTES = 1 << 20; // 1 MiB
// Claude stamps locally-generated placeholder assistant records (API errors,
// stop-sequence stubs) with this instead of a model id.
const SYNTHETIC_MODEL = "<synthetic>";
// Page size for GET /sessions/:id/conversation. The default (no `from`) page
// and the scroll-back page-fetch step both use this.
export const CONVERSATION_PAGE_ENTRIES = 100;
// Cap on the number of transcript entries retained in the incremental reader's
// tail. Must stay >= 2 * CONVERSATION_PAGE_ENTRIES so the retained window
// always covers at least one scroll-back page beyond the default page.
export const MAX_RETAINED_CONVERSATION_ENTRIES = 300;
// Activity window: inside → working. Past it: tool_use/plain-user → waiting; tool_result with no follow-up → needs_input (agent stalled).
export const ACTIVITY_WINDOW_MS = 60_000;

/** Scan backward for the model reported by the most recent assistant record. */
export function deriveClaudeLiveModel(records: ParsedRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record && record.role === "assistant" && record.model) {
      return record.model;
    }
  }
  return undefined;
}

// ── Pure classifier (no I/O) ──────────────────────────────────────────

// Claude transcript tail. A trailing synthetic assistant record flagged
// `error: "server_error"` means the session is wedged on a transient Claude
// API failure (5xx or connection failure). Walks backwards skipping
// CLAUDE_BOOKKEEPING_RECORD_TYPES — the same shape as detectClaudeRateLimit —
// because Claude always appends a `system`/`file-history-snapshot` record
// after the error, which would otherwise mask it.
export function hasTrailingClaudeServerError(records: readonly ParsedRecord[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record || CLAUDE_BOOKKEEPING_RECORD_TYPES.has(record.type)) {
      continue;
    }
    return record.serverError === true;
  }
  return false;
}

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
  if (hasTrailingClaudeServerError(records)) {
    return "error";
  }

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

// Presence-aware: returns undefined rather than falling back, so callers that
// must not anchor to the reader's own clock (e.g. the rate-limit reset parse,
// which would otherwise anchor to a post-restart Date.now() up to ~24h off)
// can tell "no own timestamp" apart from "timestamp is exactly 0".
function extractRecordTimestampMs(
  parsed: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
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
  return undefined;
}

function extractTimestampMs(
  parsed: Record<string, unknown>,
  message: Record<string, unknown>,
  fallbackTimestampMs: number,
): number {
  return extractRecordTimestampMs(parsed, message) ?? fallbackTimestampMs;
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
  const ownTimestampMs = extractRecordTimestampMs(parsed, message);
  const recordTimestampMs = ownTimestampMs ?? timestampMs;

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
    const isRateLimit = parsed["error"] === "rate_limit";
    // Anchored to this record's OWN timestamp only. A record with no
    // parseable own timestamp (ownTimestampMs is undefined) is left without
    // a resetAtMs rather than anchoring to `timestampMs`, which on the first
    // post-restart read is the reader's Date.now(), not the record's real
    // time.
    const rateLimitResetAtMs =
      isRateLimit && ownTimestampMs !== undefined
        ? parseRateLimitResetAtMs(extractTextContent(message), ownTimestampMs)
        : undefined;
    return {
      type: "assistant",
      role: "assistant",
      ...(stopReason ? { stopReason } : {}),
      hasToolUse: toolUseHints.hasToolUse,
      ...(toolUseHints.requestsUserInput ? { requestsUserInput: true } : {}),
      ...(isRateLimit ? { rateLimited: true } : {}),
      ...(rateLimitResetAtMs !== undefined ? { rateLimitResetAtMs } : {}),
      ...(parsed["error"] === "server_error" ? { serverError: true } : {}),
      ...(typeof message["model"] === "string" && message["model"] !== SYNTHETIC_MODEL
        ? { model: message["model"] }
        : {}),
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
  serverError: boolean;
  liveModel?: string;
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
    const cachedLiveModel = deriveClaudeLiveModel(currentReader.tailRecords);
    return {
      state: classifyClaudeJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
      rateLimit: detectClaudeRateLimit(currentReader.tailRecords),
      serverError: hasTrailingClaudeServerError(currentReader.tailRecords),
      ...(cachedLiveModel ? { liveModel: cachedLiveModel } : {}),
    };
  }

  // Incremental reads always consume the full delta from lastOffset. The
  // cold-read ceiling applies only when unreadFrom is 0 — a reader with no
  // prior offset would otherwise Buffer.alloc the whole transcript. The window
  // may start mid-file; the partial line that opens it is handled below.
  const unreadFrom = Math.min(currentReader.lastOffset, fileStat.size);
  const readOffset =
    unreadFrom === 0 && fileStat.size > MAX_COLD_READ_BYTES
      ? fileStat.size - MAX_COLD_READ_BYTES
      : unreadFrom;
  const nowMs = Date.now();

  const chunk = await readNewJsonlBytes(filePath, fileStat.size, readOffset);
  if (!chunk) {
    // If we can't read, return null to fall back to other classification
    return null;
  }

  const newRecords: ParsedRecord[] = [];
  // A truncated window can open mid-record; that fragment is not valid JSON,
  // so parseJsonlRecord drops it. Discarding the first line unconditionally
  // would instead lose a whole record whenever the cut lands on a boundary.
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

  const liveModel = deriveClaudeLiveModel(combined);
  return {
    state: classifyClaudeJsonlState(combined, nowMs, fileStat.mtimeMs),
    reader: nextReader,
    rateLimit: detectClaudeRateLimit(combined),
    serverError: hasTrailingClaudeServerError(combined),
    ...(liveModel ? { liveModel } : {}),
  };
}

// ── Transcript entries (unified message/tool/question timeline) ──────

interface ClaudeQuestionOption {
  label: string;
  index: number;
}

interface ClaudeQuestion {
  header: string;
  prompt: string;
  options?: ClaudeQuestionOption[];
  multiSelect?: boolean;
}

function extractAskUserQuestions(input: unknown): ClaudeQuestion[] {
  if (typeof input !== "object" || input === null) return [];
  const questionsValue = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(questionsValue)) return [];

  const questions: ClaudeQuestion[] = [];
  for (const raw of questionsValue) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    const header = typeof q["header"] === "string" ? q["header"] : "";
    const prompt = typeof q["question"] === "string" ? q["question"] : "";
    const optionsValue = q["options"];
    const options = Array.isArray(optionsValue)
      ? optionsValue.map((option, index) => ({
          label:
            typeof option === "object" &&
            option !== null &&
            typeof (option as Record<string, unknown>)["label"] === "string"
              ? ((option as Record<string, unknown>)["label"] as string)
              : "",
          index,
        }))
      : undefined;
    const multiSelect = typeof q["multiSelect"] === "boolean" ? q["multiSelect"] : undefined;
    questions.push({
      header,
      prompt,
      ...(options ? { options } : {}),
      ...(multiSelect !== undefined ? { multiSelect } : {}),
    });
  }
  return questions;
}

// ── Conversation parser (pure, no I/O) ───────────────────────────────

/**
 * Parse a batch of JSONL lines into classification records and full-fidelity
 * transcript entries (messages, tool_use calls, AskUserQuestion prompts).
 * Message text is never truncated. Shared by the incremental tail reader and
 * the full-file reader so extraction stays single-path.
 */
export function parseConversationBatch(
  lines: string[],
  nowMs: number,
): { records: ParsedRecord[]; entries: TranscriptEntry[] } {
  const records: ParsedRecord[] = [];
  const entries: TranscriptEntry[] = [];

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

    const timestampMs = extractTimestampMs(parsed, message, nowMs);

    const messageText = extractTextContent(message);
    if (messageText) {
      entries.push({ kind: "message", role, text: messageText, timestampMs });
    }

    if (role !== "assistant") continue;

    for (const block of contentBlocks(message)) {
      if (typeof block !== "object" || block === null) continue;
      const tool = block as Record<string, unknown>;
      if (tool["type"] !== "tool_use") continue;

      const name = typeof tool["name"] === "string" ? tool["name"] : "";
      const callId = typeof tool["id"] === "string" ? tool["id"] : undefined;

      if (name === "AskUserQuestion") {
        for (const question of extractAskUserQuestions(tool["input"])) {
          entries.push({ kind: "question", ...question, timestampMs });
        }
        continue;
      }

      entries.push({
        kind: "tool",
        name,
        ...(callId ? { callId } : {}),
        timestampMs,
      });
    }
  }

  return { records, entries };
}

/** Full transcript in file-line order: messages, tool_use calls, and AskUserQuestion prompts. */
export async function readClaudeTranscriptEntries(
  worktreePath: string,
  agentSessionId?: string,
): Promise<TranscriptEntry[] | null> {
  const filePath = agentSessionId
    ? await sessionFileForId(worktreePath, agentSessionId)
    : await findLatestSessionFile(worktreePath);
  if (!filePath) return null;

  let fileText: string;
  try {
    fileText = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const { entries } = parseConversationBatch(fileText.split("\n"), Date.now());
  return entries;
}

// ── Incremental conversation tail reader ──────────────────────────────

export async function readClaudeConversationTail(
  worktreePath: string,
  reader?: ClaudeConversationReaderState,
  agentSessionId?: string,
): Promise<{
  entries: TranscriptEntry[];
  state: SessionState;
  totalEntries: number;
  startIndex: number;
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
        tailEntries: [],
        tailRecords: [],
        totalEntries: 0,
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
      entries: base.tailEntries,
      state: classifyClaudeJsonlState(base.tailRecords, Date.now(), fileStat.mtimeMs),
      totalEntries: base.totalEntries,
      startIndex: Math.max(0, base.totalEntries - base.tailEntries.length),
      hasMore: base.totalEntries > base.tailEntries.length,
      reader: base,
    };
  }

  const readOffset = base.lastOffset;
  const nowMs = Date.now();

  const chunk = await readNewJsonlBytes(filePath, fileStat.size, readOffset);
  if (!chunk) return null;

  const { records: newRecords, entries: newEntries } = parseConversationBatch(
    chunk.consumedText.split("\n"),
    nowMs,
  );

  const totalEntries = base.totalEntries + newEntries.length;
  const tailEntries = [...base.tailEntries, ...newEntries].slice(
    -MAX_RETAINED_CONVERSATION_ENTRIES,
  );
  const tailRecords = [...base.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);

  const nextReader: ClaudeConversationReaderState = {
    filePath,
    lastOffset: readOffset + chunk.consumedBytes,
    lastMtimeMs: fileStat.mtimeMs,
    tailEntries,
    tailRecords,
    totalEntries,
  };

  return {
    entries: tailEntries,
    state: classifyClaudeJsonlState(tailRecords, nowMs, fileStat.mtimeMs),
    totalEntries,
    startIndex: Math.max(0, totalEntries - tailEntries.length),
    hasMore: totalEntries > tailEntries.length,
    reader: nextReader,
  };
}
