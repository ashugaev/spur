import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionState, TranscriptEntry } from "./types.js";
import { resolveWorktreePathCandidates } from "./agents/worktree-path.js";
import { detectCursorRateLimit, type RateLimitDetection } from "./rate-limit-detect.js";

export interface CursorParsedRecord {
  role: "user" | "assistant";
  hasToolUse: boolean;
  hasToolResult: boolean;
  requestsUserInput?: boolean;
  terminalError?: boolean;
  text?: string;
  timestampMs: number;
}

export interface CursorJsonlReaderState {
  filePath: string;
  lastOffset: number;
  lastMtimeMs: number;
  tailRecords: CursorParsedRecord[];
}

const TAIL_RECORD_LIMIT = 50;
export const CURSOR_JSONL_ACTIVITY_WINDOW_MS = 60_000;
export const CURSOR_JSONL_TOOL_USE_GRACE_MS = 15 * 60_000; // 900_000ms

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Cursor slugifies the absolute workspace path into its
// `~/.cursor/projects/<slug>` directory name by replacing every run of
// characters that are neither alphanumeric nor an underscore with a single
// hyphen, then trimming leading and trailing hyphens. Underscores are kept
// verbatim (GitHub Actions `_work` dirs rely on this); a mid-segment dot
// (`spur-isolated-daemon.xOPkB8`) becomes a hyphen (`...daemon-xOPkB8`); a
// slash-adjacent dot (`/.spur`) collapses with the slash into one hyphen
// (`-spur`). Deleting dots outright — as an earlier version did — only happened
// to match slash-adjacent dots and silently pointed dotted worktree paths
// (shared shepherd workspaces, scratchpad dirs) at a nonexistent project dir,
// so the transcript was never found.
export function toCursorProjectPath(worktreePath: string): string {
  return worktreePath
    .replaceAll("\\", "/")
    .replace(/[^a-zA-Z0-9_]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

async function findLatestCursorTranscriptInDir(
  transcriptsDir: string,
  options?: { minMtimeMs?: number },
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(transcriptsDir);
  } catch {
    return null;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = join(transcriptsDir, entry, `${entry}.jsonl`);
      try {
        const fileStat = await stat(filePath);
        if (options?.minMtimeMs !== undefined && fileStat.mtimeMs < options.minMtimeMs) {
          return null;
        }
        return { path: filePath, mtimeMs: fileStat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const existing = files.filter((file): file is { path: string; mtimeMs: number } => Boolean(file));
  existing.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return existing[0]?.path ?? null;
}

export async function findLatestCursorTranscriptFile(
  worktreePath: string,
  agentSessionId?: string,
  options?: { minMtimeMs?: number },
): Promise<string | null> {
  for (const candidate of await resolveWorktreePathCandidates(worktreePath)) {
    const transcriptsDir = join(
      homedir(),
      ".cursor",
      "projects",
      toCursorProjectPath(candidate),
      "agent-transcripts",
    );
    if (agentSessionId) {
      const pinnedPath = join(transcriptsDir, agentSessionId, `${agentSessionId}.jsonl`);
      try {
        const fileStat = await stat(pinnedPath);
        if (options?.minMtimeMs !== undefined && fileStat.mtimeMs < options.minMtimeMs) {
          continue;
        }
        return pinnedPath;
      } catch {
        continue;
      }
    }
    const latest = await findLatestCursorTranscriptInDir(transcriptsDir, options);
    if (latest) {
      return latest;
    }
  }
  return null;
}

export function parseCursorJsonlRecord(
  line: string,
  fallbackTimestampMs: number,
): CursorParsedRecord | null {
  const parsed = tryParseJson(line);
  if (!parsed) {
    return null;
  }
  if (parsed["type"] === "turn_ended") {
    // Cursor writes `status: "aborted"` with an error-looking message when the
    // user interrupts the foreground turn. Background subagents may still be
    // running, so only Cursor's explicit error status is terminal evidence.
    if (parsed["status"] !== "error") {
      return null;
    }
    const error = typeof parsed["error"] === "string" ? parsed["error"].trim() : "";
    if (!error) {
      return null;
    }
    return {
      role: "assistant",
      hasToolUse: false,
      hasToolResult: false,
      terminalError: true,
      text: error,
      timestampMs: fallbackTimestampMs,
    };
  }
  const role = parsed["role"];
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const message = parsed["message"];
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = Array.isArray((message as Record<string, unknown>)["content"])
    ? ((message as Record<string, unknown>)["content"] as unknown[])
    : [];
  let hasToolUse = false;
  let hasToolResult = false;
  let requestsUserInput = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const tool = block as Record<string, unknown>;
    const type = tool["type"];
    if (type === "tool_use") {
      hasToolUse = true;
      if (tool["name"] === "AskUserQuestion") {
        requestsUserInput = true;
      }
    }
    if (type === "tool_result") {
      hasToolResult = true;
    }
  }
  // `text` is intentionally not populated here: the only reader of
  // CursorParsedRecord.text is latestCursorTerminalError, which is gated on
  // `terminalError` (set only by the turn_ended branch above). Retaining the
  // full assistant message body on every ordinary record for a value nothing
  // reads is what made cursorJsonlReaders' 50-record tail expensive per
  // session.
  return {
    role,
    hasToolUse,
    hasToolResult,
    ...(requestsUserInput ? { requestsUserInput: true } : {}),
    timestampMs: fallbackTimestampMs,
  };
}

// Cursor JSONL records never carry a genuine per-record timestamp (unlike Claude's
// JSONL, which stamps real event times); `record.timestampMs` is always the wall-clock
// moment we happened to parse the line, so a full re-read after a daemon restart stamps
// every historical record with "now". `fileMtimeMs` (the file's real last-write time) is
// therefore the only trustworthy staleness signal here and must take priority; the
// record timestamp is only a last-resort fallback for callers that don't supply it.
function lastActivityMs(record: CursorParsedRecord, fileMtimeMs?: number): number {
  return fileMtimeMs ?? record.timestampMs;
}

function isWithinActivityWindow(
  nowMs: number,
  record: CursorParsedRecord,
  fileMtimeMs: number | undefined,
  windowMs: number,
): boolean {
  return nowMs - lastActivityMs(record, fileMtimeMs) <= windowMs;
}

function latestCursorTerminalError(records: readonly CursorParsedRecord[]): string | null {
  const latest = records[records.length - 1];
  if (latest?.terminalError && typeof latest.text === "string" && latest.text.length > 0) {
    return latest.text;
  }
  return null;
}

export function classifyCursorJsonlState(
  records: CursorParsedRecord[],
  nowMs: number,
  fileMtimeMs?: number,
): SessionState {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record) {
      continue;
    }
    if (record.terminalError) {
      if (i === records.length - 1) {
        return "error";
      }
      continue;
    }
    if (record.role === "assistant") {
      if (record.requestsUserInput) {
        return "needs_input";
      }
      if (!record.hasToolUse) {
        return "waiting";
      }
      return isWithinActivityWindow(nowMs, record, fileMtimeMs, CURSOR_JSONL_TOOL_USE_GRACE_MS)
        ? "working"
        : "waiting";
    }
    if (record.hasToolResult) {
      return isWithinActivityWindow(nowMs, record, fileMtimeMs, CURSOR_JSONL_ACTIVITY_WINDOW_MS)
        ? "working"
        : "waiting";
    }
    return isWithinActivityWindow(nowMs, record, fileMtimeMs, CURSOR_JSONL_ACTIVITY_WINDOW_MS)
      ? "working"
      : "waiting";
  }
  return "working";
}

export async function readCursorJsonlState(
  worktreePath: string,
  reader?: CursorJsonlReaderState,
  agentSessionId?: string,
  options?: { minMtimeMs?: number },
): Promise<{
  state: SessionState;
  reader: CursorJsonlReaderState;
  rateLimit: RateLimitDetection | null;
} | null> {
  const resolvedPath = await findLatestCursorTranscriptFile(worktreePath, agentSessionId, options);
  const filePath =
    resolvedPath ??
    (agentSessionId ? null : reader?.filePath) ??
    (agentSessionId
      ? null
      : await findLatestCursorTranscriptFile(worktreePath, undefined, options));
  if (!filePath) {
    return null;
  }

  let fileStat: { size: number; mtimeMs: number };
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }
  if (options?.minMtimeMs !== undefined && fileStat.mtimeMs < options.minMtimeMs) {
    return null;
  }

  const currentReader: CursorJsonlReaderState =
    reader && reader.filePath === filePath
      ? reader
      : {
          filePath,
          lastOffset: 0,
          lastMtimeMs: 0,
          tailRecords: [],
        };

  if (fileStat.mtimeMs === currentReader.lastMtimeMs && currentReader.tailRecords.length > 0) {
    return {
      state: classifyCursorJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
      rateLimit: detectCursorRateLimit(latestCursorTerminalError(currentReader.tailRecords)),
    };
  }

  const readOffset = Math.min(currentReader.lastOffset, fileStat.size);
  const nowMs = Date.now();
  const newRecords: CursorParsedRecord[] = [];

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(filePath, "r");
    const buffer = Buffer.alloc(fileStat.size - readOffset);
    if (buffer.length > 0) {
      await fd.read(buffer, 0, buffer.length, readOffset);
    }
    for (const line of buffer.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const record = parseCursorJsonlRecord(trimmed, fileStat.mtimeMs);
      if (record) {
        newRecords.push(record);
      }
    }
  } catch {
    return null;
  } finally {
    await fd?.close();
  }

  const combined = [...currentReader.tailRecords, ...newRecords].slice(-TAIL_RECORD_LIMIT);
  const nextReader: CursorJsonlReaderState = {
    filePath,
    lastOffset: fileStat.size,
    lastMtimeMs: fileStat.mtimeMs,
    tailRecords: combined,
  };

  if (combined.length === 0) {
    return null;
  }

  return {
    state: classifyCursorJsonlState(combined, nowMs, fileStat.mtimeMs),
    reader: nextReader,
    rateLimit: detectCursorRateLimit(latestCursorTerminalError(combined)),
  };
}

// ── Transcript entries (unified message/tool/question timeline) ──────

/**
 * Full transcript in file-line order: messages, tool_use calls, and AskUserQuestion
 * prompts. Cursor tool_use blocks carry no id (unlike Claude), so tool entries omit
 * callId. Cursor's AskUserQuestion input is always `{}`, so question entries carry
 * an empty header/prompt and omit options.
 */
export async function readCursorTranscriptEntries(
  worktreePath: string,
  agentSessionId?: string,
): Promise<TranscriptEntry[] | null> {
  const filePath = await findLatestCursorTranscriptFile(worktreePath, agentSessionId);
  if (!filePath) return null;

  let fileText: string;
  try {
    fileText = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const entries: TranscriptEntry[] = [];

  for (const line of fileText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = tryParseJson(trimmed);
    if (!parsed) continue;

    const role = parsed["role"];
    if (role !== "user" && role !== "assistant") continue;

    const message = parsed["message"];
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b["type"] === "text" && typeof b["text"] === "string") {
        const text = b["text"].trim();
        if (text) {
          entries.push({ kind: "message", role, text });
        }
        continue;
      }

      if (b["type"] === "tool_use") {
        const name = typeof b["name"] === "string" ? b["name"] : "";
        if (name === "AskUserQuestion") {
          entries.push({ kind: "question", header: "", prompt: "" });
          continue;
        }
        entries.push({ kind: "tool", name });
      }
    }
  }

  return entries;
}
