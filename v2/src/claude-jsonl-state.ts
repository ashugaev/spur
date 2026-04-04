import { open, readFile, stat } from "node:fs/promises";
import type { ConversationMessage, SessionState } from "./types.js";
import { findLatestSessionFile } from "./agents/claude.js";

/** Minimal shape extracted from a JSONL record for state classification. */
export interface ParsedRecord {
  type: string;
  role?: string;
  stopReason?: string;
  hasToolUse?: boolean;
  timestampMs: number;
}

export interface ClaudeJsonlReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailRecords: ParsedRecord[];
}

const TAIL_RECORD_LIMIT = 50;
const TOOL_USE_STALE_MS = 3_000;

// ── Pure classifier (no I/O) ──────────────────────────────────────────

export function classifyClaudeJsonlState(records: ParsedRecord[], nowMs: number): SessionState {
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
        // Check if a progress event followed within the stale window.
        const hasRecentProgress = records
          .slice(i + 1)
          .some(
            (r) => r.type === "progress" && r.timestampMs - record.timestampMs <= TOOL_USE_STALE_MS,
          );
        if (hasRecentProgress || nowMs - record.timestampMs <= TOOL_USE_STALE_MS) {
          return "working";
        }
        return "needs_input";
      }
      return "working";
    }

    if (record.type === "system" || record.type === "stop_hook_summary") {
      return "waiting";
    }

    if (record.type === "file-history-snapshot") {
      return "waiting";
    }

    if (record.type === "user") {
      // user + tool_result means the agent is processing tool output → working
      if (record.role === "tool_result") {
        return "working";
      }
      // user with permissionMode means a prompt was just sent → working
      return "working";
    }
  }

  // No meaningful records → assume working (just started)
  return "working";
}

// ── JSONL parser ──────────────────────────────────────────────────────

function parseJsonlRecord(line: string, timestampMs: number): ParsedRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = typeof parsed["type"] === "string" ? parsed["type"] : "";

  if (type === "progress") {
    return { type: "progress", timestampMs };
  }

  if (type === "system" || type === "stop_hook_summary" || type === "file-history-snapshot") {
    return { type, timestampMs };
  }

  // Assistant and user messages come nested under "message"
  const message =
    typeof parsed["message"] === "object" && parsed["message"] !== null
      ? (parsed["message"] as Record<string, unknown>)
      : parsed;

  const role =
    typeof message["role"] === "string"
      ? message["role"]
      : typeof parsed["role"] === "string"
        ? parsed["role"]
        : "";

  if (role === "assistant") {
    const stopReason =
      typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined;
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const hasToolUse = content.some(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "tool_use",
    );
    return {
      type: "assistant",
      role: "assistant",
      ...(stopReason ? { stopReason } : {}),
      hasToolUse,
      timestampMs,
    };
  }

  if (role === "user") {
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const hasToolResult = content.some(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "tool_result",
    );
    return {
      type: "user",
      role: hasToolResult ? "tool_result" : "user",
      timestampMs,
    };
  }

  if (type) {
    return { type, timestampMs };
  }

  return null;
}

// ── Incremental file reader ───────────────────────────────────────────

export async function readClaudeJsonlState(
  worktreePath: string,
  reader?: ClaudeJsonlReaderState,
): Promise<{ state: SessionState; reader: ClaudeJsonlReaderState } | null> {
  const filePath = reader?.filePath ?? (await findLatestSessionFile(worktreePath));
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
    return {
      state: classifyClaudeJsonlState(currentReader.tailRecords, Date.now()),
      reader: currentReader,
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

  return {
    state: classifyClaudeJsonlState(combined, nowMs),
    reader: nextReader,
  };
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

  const messages: ConversationMessage[] = [];
  const stateRecords: ParsedRecord[] = [];
  const nowMs = Date.now();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const stateRecord = parseJsonlRecord(trimmed, nowMs);
    if (stateRecord) stateRecords.push(stateRecord);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const message =
      typeof parsed["message"] === "object" && parsed["message"] !== null
        ? (parsed["message"] as Record<string, unknown>)
        : parsed;

    const role =
      typeof message["role"] === "string"
        ? message["role"]
        : typeof parsed["role"] === "string"
          ? parsed["role"]
          : "";

    if (role !== "user" && role !== "assistant") continue;

    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const textParts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string"
      ) {
        textParts.push((block as Record<string, unknown>)["text"] as string);
      }
    }
    const combinedText = textParts.join("\n").trim();
    if (!combinedText) continue;

    const ts =
      typeof parsed["timestamp"] === "number"
        ? parsed["timestamp"]
        : nowMs;

    messages.push({ role, text: combinedText, timestampMs: ts });
  }

  const state = classifyClaudeJsonlState(stateRecords, nowMs);
  return { messages, state };
}
