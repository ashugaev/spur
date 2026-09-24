import { open, readFile, stat } from "node:fs/promises";
import type { SessionState, TranscriptEntry } from "./types.js";
import type { ProviderTokenUsageSample } from "./token-usage.js";
import { findLatestSessionFile, sessionFileForId } from "./agents/claude.js";
import {
  CLAUDE_BOOKKEEPING_RECORD_TYPES,
  detectClaudeRateLimit,
  parseRateLimitResetAtMs,
  type RateLimitDetection,
} from "./rate-limit-detect.js";

interface ClaudeMessageTokenUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Minimal shape extracted from a JSONL record for state classification. */
export interface ParsedRecord {
  type: string;
  role?: string;
  stopReason?: string;
  hasToolUse?: boolean;
  /** True when a tool_use payload is explicitly asking the human a question. */
  requestsUserInput?: boolean;
  /** True when the record is Claude's synthetic "[Request interrupted by user…]" turn. */
  interrupted?: boolean;
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
  messageId?: string;
  sessionId?: string;
  tokenUsage?: ClaudeMessageTokenUsage;
  timestampMs: number;
  ownTimestampMs?: number;
}

export interface ClaudeJsonlReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailRecords: ParsedRecord[];
  usageByMessage?: Map<string, ClaudeMessageTokenUsage>;
  generationId?: string;
  fileIno?: number;
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

export function hasClaudeRecoveryAfter(records: readonly ParsedRecord[], errorAt: string): boolean {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (!record || CLAUDE_BOOKKEEPING_RECORD_TYPES.has(record.type)) continue;
    return (
      record.role === "assistant" &&
      (record.model !== undefined || record.hasToolUse === true) &&
      !record.serverError &&
      !record.rateLimited &&
      !record.interrupted &&
      record.ownTimestampMs !== undefined &&
      record.ownTimestampMs > Date.parse(errorAt)
    );
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
      // An interrupt ends the turn at an idle prompt: nothing is in flight and
      // no tool call is stalled. Most interrupt records are a text block, which
      // already lands on "waiting" below; this covers the tool_result-shaped
      // one, which would otherwise read as "needs_input" (agent stalled) once
      // the activity window passes and raise a false attention alert.
      if (record.interrupted) {
        return "waiting";
      }
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

// The synthetic user turn Claude Code writes when the human interrupts. The
// whole content is the marker and nothing else, so this matches exactly rather
// than by prefix: a Bash tool_result whose stdout merely starts with the
// marker is a genuine stalled tool call, and flagging it would suppress the
// needs_input alert it should raise — the inverse of the case this fixes.
const CLAUDE_INTERRUPT_TEXTS: ReadonlySet<string> = new Set([
  "[request interrupted by user]",
  "[request interrupted by user for tool use]",
]);

function blockInterruptText(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  const value = record["type"] === "tool_result" ? record["content"] : record["text"];
  return typeof value === "string" ? value : undefined;
}

function isInterruptText(text: string | undefined): boolean {
  return CLAUDE_INTERRUPT_TEXTS.has((text ?? "").trim().toLowerCase());
}

function hasInterruptMarker(message: Record<string, unknown>, blocks: unknown[]): boolean {
  const raw = message["content"];
  if (typeof raw === "string") {
    return isInterruptText(raw);
  }
  return blocks.some((block) => isInterruptText(blockInterruptText(block)));
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
  const timestamps = {
    timestampMs: recordTimestampMs,
    ...(ownTimestampMs !== undefined ? { ownTimestampMs } : {}),
  };

  if (type === "progress") {
    return { type: "progress", ...timestamps };
  }

  if (CLAUDE_BOOKKEEPING_RECORD_TYPES.has(type)) {
    return { type, ...timestamps };
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
    const usage =
      typeof message["usage"] === "object" && message["usage"] !== null
        ? (message["usage"] as Record<string, unknown>)
        : undefined;
    const token = (key: string): number => {
      const value = usage?.[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    };
    const inputTokens = token("input_tokens");
    const cacheCreationInputTokens = token("cache_creation_input_tokens");
    const cacheReadInputTokens = token("cache_read_input_tokens");
    const outputTokens = token("output_tokens");
    const cacheCreation =
      typeof usage?.["cache_creation"] === "object" && usage["cache_creation"] !== null
        ? (usage["cache_creation"] as Record<string, unknown>)
        : undefined;
    const outputDetails =
      typeof usage?.["output_tokens_details"] === "object" &&
      usage["output_tokens_details"] !== null
        ? (usage["output_tokens_details"] as Record<string, unknown>)
        : undefined;
    const optionalToken = (
      record: Record<string, unknown> | undefined,
      key: string,
    ): number | undefined => {
      const value = record?.[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    };
    const cacheWrite5mInputTokens = optionalToken(cacheCreation, "ephemeral_5m_input_tokens");
    const cacheWrite1hInputTokens = optionalToken(cacheCreation, "ephemeral_1h_input_tokens");
    const reasoningOutputTokens = optionalToken(outputDetails, "thinking_tokens");
    const messageId = typeof message["id"] === "string" ? message["id"] : undefined;
    const sessionId = typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined;
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
      ...(messageId ? { messageId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(messageId &&
      inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens > 0
        ? {
            tokenUsage: {
              inputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              outputTokens,
              ...(cacheWrite5mInputTokens !== undefined ? { cacheWrite5mInputTokens } : {}),
              ...(cacheWrite1hInputTokens !== undefined ? { cacheWrite1hInputTokens } : {}),
              ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
            },
          }
        : {}),
      ...timestamps,
    };
  }

  if (role === "user") {
    const blocks = contentBlocks(message);
    return {
      type: "user",
      role: hasBlockType(blocks, "tool_result") ? "tool_result" : "user",
      ...(hasInterruptMarker(message, blocks) ? { interrupted: true } : {}),
      ...timestamps,
    };
  }

  if (type) {
    return { type, ...timestamps };
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

async function scanJsonlRecords(
  filePath: string,
  size: number,
  offset: number,
  timestampMs: number,
): Promise<{ records: ParsedRecord[]; consumedBytes: number } | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const records: ParsedRecord[] = [];
    let position = offset;
    let pending = Buffer.alloc(0);
    while (position < size) {
      const length = Math.min(MAX_COLD_READ_BYTES, size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await fd.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const combined =
        pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        pending = combined;
        continue;
      }
      for (const line of combined
        .subarray(0, lastNewline + 1)
        .toString("utf8")
        .split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = parseJsonlRecord(trimmed, timestampMs);
        if (record) records.push(record);
      }
      pending = combined.subarray(lastNewline + 1);
    }
    const trailing = pending.toString("utf8").trim();
    if (trailing) {
      const record = parseJsonlRecord(trailing, timestampMs);
      if (record) {
        records.push(record);
        pending = Buffer.alloc(0);
      }
    }
    return { records, consumedBytes: position - offset - pending.length };
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
  tokenUsage?: ProviderTokenUsageSample;
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

  let fileStat: { size: number; mtimeMs: number; ino: number };
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  const reuse =
    reader !== undefined &&
    reader.filePath === filePath &&
    reader.fileIno === fileStat.ino &&
    fileStat.size >= reader.lastOffset &&
    fileStat.mtimeMs >= reader.lastMtimeMs;
  const currentReader: ClaudeJsonlReaderState = reuse
    ? reader
    : {
        filePath,
        lastOffset: 0,
        lastMtimeMs: 0,
        tailRecords: [],
        usageByMessage: new Map(),
        fileIno: fileStat.ino,
      };
  const usageByMessage = currentReader.usageByMessage ?? new Map();

  const usageSample = (): ProviderTokenUsageSample | undefined => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadInputTokens = 0;
    let cacheWriteInputTokens = 0;
    let reasoningOutputTokens = 0;
    let cacheWrite5mInputTokens = 0;
    let cacheWrite1hInputTokens = 0;
    let reasoningComplete = true;
    let cache5mComplete = true;
    let cache1hComplete = true;
    for (const usage of usageByMessage.values()) {
      inputTokens +=
        usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
      outputTokens += usage.outputTokens;
      cacheReadInputTokens += usage.cacheReadInputTokens;
      cacheWriteInputTokens += usage.cacheCreationInputTokens;
      reasoningComplete &&= usage.reasoningOutputTokens !== undefined;
      cache5mComplete &&= usage.cacheWrite5mInputTokens !== undefined;
      cache1hComplete &&= usage.cacheWrite1hInputTokens !== undefined;
      reasoningOutputTokens += usage.reasoningOutputTokens ?? 0;
      cacheWrite5mInputTokens += usage.cacheWrite5mInputTokens ?? 0;
      cacheWrite1hInputTokens += usage.cacheWrite1hInputTokens ?? 0;
    }
    return inputTokens + outputTokens > 0 && currentReader.generationId
      ? {
          provider: "claude",
          generationId: currentReader.generationId,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
          ...(reasoningComplete ? { reasoningOutputTokens } : {}),
          ...(cache5mComplete ? { cacheWrite5mInputTokens } : {}),
          ...(cache1hComplete ? { cacheWrite1hInputTokens } : {}),
        }
      : undefined;
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
    const tokenUsage = usageSample();
    return {
      state: classifyClaudeJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
      rateLimit: detectClaudeRateLimit(currentReader.tailRecords),
      serverError: hasTrailingClaudeServerError(currentReader.tailRecords),
      ...(cachedLiveModel ? { liveModel: cachedLiveModel } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }

  // Incremental reads always consume the full delta from lastOffset. The
  // cold-read ceiling applies only when unreadFrom is 0 — a reader with no
  // prior offset would otherwise Buffer.alloc the whole transcript. The window
  // may start mid-file; the partial line that opens it is handled below.
  const unreadFrom = Math.min(currentReader.lastOffset, fileStat.size);
  const readOffset = unreadFrom;
  const nowMs = Date.now();

  const chunk = await scanJsonlRecords(filePath, fileStat.size, readOffset, nowMs);
  if (!chunk) {
    // If we can't read, return null to fall back to other classification
    return null;
  }

  const newRecords: ParsedRecord[] = [];
  // A truncated window can open mid-record; that fragment is not valid JSON,
  // so parseJsonlRecord drops it. Discarding the first line unconditionally
  // would instead lose a whole record whenever the cut lands on a boundary.
  for (const record of chunk.records) {
    newRecords.push(record);
    if (record.messageId && record.sessionId && record.tokenUsage) {
      const generationId = `claude:${record.sessionId}:${record.messageId}`;
      if (!currentReader.generationId) currentReader.generationId = generationId;
      if (currentReader.generationId.startsWith(`claude:${record.sessionId}:`)) {
        const prior = usageByMessage.get(record.messageId);
        usageByMessage.set(record.messageId, {
          ...prior,
          inputTokens: Math.max(prior?.inputTokens ?? 0, record.tokenUsage.inputTokens),
          cacheCreationInputTokens: Math.max(
            prior?.cacheCreationInputTokens ?? 0,
            record.tokenUsage.cacheCreationInputTokens,
          ),
          cacheReadInputTokens: Math.max(
            prior?.cacheReadInputTokens ?? 0,
            record.tokenUsage.cacheReadInputTokens,
          ),
          outputTokens: Math.max(prior?.outputTokens ?? 0, record.tokenUsage.outputTokens),
          ...(record.tokenUsage.reasoningOutputTokens !== undefined
            ? {
                reasoningOutputTokens: Math.max(
                  prior?.reasoningOutputTokens ?? 0,
                  record.tokenUsage.reasoningOutputTokens,
                ),
              }
            : {}),
          ...(record.tokenUsage.cacheWrite5mInputTokens !== undefined
            ? {
                cacheWrite5mInputTokens: Math.max(
                  prior?.cacheWrite5mInputTokens ?? 0,
                  record.tokenUsage.cacheWrite5mInputTokens,
                ),
              }
            : {}),
          ...(record.tokenUsage.cacheWrite1hInputTokens !== undefined
            ? {
                cacheWrite1hInputTokens: Math.max(
                  prior?.cacheWrite1hInputTokens ?? 0,
                  record.tokenUsage.cacheWrite1hInputTokens,
                ),
              }
            : {}),
        });
      }
    }
  }

  const combined = [...currentReader.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);
  const nextReader: ClaudeJsonlReaderState = {
    filePath,
    lastOffset: readOffset + chunk.consumedBytes,
    lastMtimeMs: fileStat.mtimeMs,
    tailRecords: combined,
    usageByMessage,
    ...(currentReader.generationId ? { generationId: currentReader.generationId } : {}),
    fileIno: fileStat.ino,
  };

  if (combined.length === 0) {
    return null;
  }

  const liveModel = deriveClaudeLiveModel(combined);
  const tokenUsage = usageSample();
  return {
    state: classifyClaudeJsonlState(combined, nowMs, fileStat.mtimeMs),
    reader: nextReader,
    rateLimit: detectClaudeRateLimit(combined),
    serverError: hasTrailingClaudeServerError(combined),
    ...(liveModel ? { liveModel } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
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
