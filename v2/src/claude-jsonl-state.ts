import { open, readFile, stat } from "node:fs/promises";
import type { ConversationMessage, SessionState, TranscriptEntry } from "./types.js";
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

const TAIL_RECORD_LIMIT = 50;
// Claude stamps locally-generated placeholder assistant records (API errors,
// stop-sequence stubs) with this instead of a model id.
const SYNTHETIC_MODEL = "<synthetic>";
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

  // Mtime unchanged and we already have records → skip re-read
  if (fileStat.mtimeMs === currentReader.lastMtimeMs && currentReader.tailRecords.length > 0) {
    const cachedLiveModel = deriveClaudeLiveModel(currentReader.tailRecords);
    return {
      state: classifyClaudeJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
      rateLimit: detectClaudeRateLimit(currentReader.tailRecords),
      serverError: hasTrailingClaudeServerError(currentReader.tailRecords),
      ...(cachedLiveModel ? { liveModel: cachedLiveModel } : {}),
    };
  }

  // Read only new bytes since last offset
  const readOffset = Math.min(currentReader.lastOffset, fileStat.size);
  const nowMs = Date.now();
  const newRecords: ParsedRecord[] = [];

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const buffer = Buffer.alloc(fileStat.size - readOffset);
    if (buffer.length > 0) {
      await fd.read(buffer, 0, buffer.length, readOffset);
    }
    const text = buffer.toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseJsonlRecord(trimmed, nowMs);
      if (record) {
        newRecords.push(record);
      }
    }
  } catch {
    // If we can't read, return null to fall back to other classification
    return null;
  } finally {
    await fd?.close();
  }

  const combined = [...currentReader.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);
  const nextReader: ClaudeJsonlReaderState = {
    filePath,
    lastOffset: fileStat.size,
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

// ── Conversation parser (pure, no I/O) ───────────────────────────────

export function parseConversationLines(
  lines: string[],
  nowMs: number,
): { messages: ConversationMessage[]; state: SessionState } {
  const messages: ConversationMessage[] = [];
  const stateRecords: ParsedRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const stateRecord = parseJsonlRecord(trimmed, nowMs);
    if (stateRecord) stateRecords.push(stateRecord);

    const parsed = tryParseJson(trimmed);
    if (!parsed) continue;

    const message = unwrapMessage(parsed);
    const role = extractRole(parsed, message);
    if (role !== "user" && role !== "assistant") continue;

    const combinedText = extractTextContent(message);
    if (!combinedText) continue;

    const ts = extractTimestampMs(parsed, message, nowMs);
    messages.push({ role, text: combinedText, timestampMs: ts });
  }

  return { messages, state: classifyClaudeJsonlState(stateRecords, nowMs) };
}

// ── Full conversation reader ──────────────────────────────────────────

export async function readClaudeConversation(
  worktreePath: string,
): Promise<{ messages: ConversationMessage[]; state: SessionState } | null> {
  const filePath = await findLatestSessionFile(worktreePath);
  if (!filePath) return null;

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  return parseConversationLines(text.split("\n"), Date.now());
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

  const nowMs = Date.now();
  const entries: TranscriptEntry[] = [];

  for (const line of fileText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

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

  return entries;
}
