import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "./types.js";
import { resolveWorktreePathCandidates } from "./agents/worktree-path.js";

export interface CursorParsedRecord {
  role: "user" | "assistant";
  hasToolUse: boolean;
  hasToolResult: boolean;
  requestsUserInput?: boolean;
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

function tryParseJson(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function toCursorProjectPath(worktreePath: string): string {
  return worktreePath
    .replaceAll("\\", "/")
    .replaceAll(":", "")
    .replace(/^\/+/, "")
    .replace(/\//g, "-")
    .replace(/\./g, "");
}

async function findLatestCursorTranscriptInDir(transcriptsDir: string): Promise<string | null> {
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
        await stat(pinnedPath);
        return pinnedPath;
      } catch {
        // Fall through to latest transcript in this project dir.
      }
    }
    const latest = await findLatestCursorTranscriptInDir(transcriptsDir);
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
  return {
    role,
    hasToolUse,
    hasToolResult,
    ...(requestsUserInput ? { requestsUserInput: true } : {}),
    timestampMs: fallbackTimestampMs,
  };
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
    if (record.role === "assistant") {
      if (record.requestsUserInput) {
        return "needs_input";
      }
      return record.hasToolUse ? "working" : "waiting";
    }
    if (record.role === "user") {
      if (record.hasToolResult) {
        return "working";
      }
      const lastActivityMs = Math.max(record.timestampMs, fileMtimeMs ?? 0);
      return nowMs - lastActivityMs <= CURSOR_JSONL_ACTIVITY_WINDOW_MS ? "working" : "waiting";
    }
  }
  return "working";
}

export async function readCursorJsonlState(
  worktreePath: string,
  reader?: CursorJsonlReaderState,
  agentSessionId?: string,
): Promise<{ state: SessionState; reader: CursorJsonlReaderState } | null> {
  const filePath =
    reader?.filePath ?? (await findLatestCursorTranscriptFile(worktreePath, agentSessionId));
  if (!filePath) {
    return null;
  }

  let fileStat: { size: number; mtimeMs: number };
  try {
    fileStat = await stat(filePath);
  } catch {
    return null;
  }

  const currentReader: CursorJsonlReaderState = reader ?? {
    filePath,
    lastOffset: 0,
    lastMtimeMs: 0,
    tailRecords: [],
  };

  if (fileStat.mtimeMs === currentReader.lastMtimeMs && currentReader.tailRecords.length > 0) {
    return {
      state: classifyCursorJsonlState(currentReader.tailRecords, Date.now(), fileStat.mtimeMs),
      reader: currentReader,
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
      const record = parseCursorJsonlRecord(trimmed, nowMs);
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
  };
}
