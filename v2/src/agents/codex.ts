import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan, AgentStatusObservation } from "./types.js";

const CODEX_SESSIONS_DIR = join(process.env["HOME"] || "", ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;
const SESSION_INDEX_TTL_MS = 30_000;
const MAX_SESSION_TAIL_BYTES = 131_072;

const ACTIVE_EVENT_TYPES = new Set([
  "task_started",
  "agent_message:commentary",
  "assistant:commentary",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
  "reasoning",
]);

const WAITING_EVENT_TYPES = new Set([
  "task_complete",
  "turn_aborted",
  "agent_message:final_answer",
  "assistant:final_answer",
]);

interface IndexedSessionFile {
  path: string;
  mtimeMs: number;
  threadId: string | null;
}

interface SessionIndexCache {
  expiresAt: number;
  byCwd: Map<string, IndexedSessionFile>;
}

let sessionIndexCache: SessionIndexCache | null = null;

export function codexCommand(): string {
  return process.env["SPUR_CODEX_BIN"] || "codex";
}

interface CodexSessionLine {
  cwd?: string;
  payload?: {
    cwd?: string;
    id?: string;
    phase?: string;
    role?: string;
    type?: string;
  };
  threadId?: string;
  type?: string;
}

function sessionMetaCwd(line: CodexSessionLine): string | null {
  if (line.type !== "session_meta") {
    return null;
  }
  if (typeof line.cwd === "string" && line.cwd) {
    return line.cwd;
  }
  if (typeof line.payload?.cwd === "string" && line.payload.cwd) {
    return line.payload.cwd;
  }
  return null;
}

function sessionResumeId(line: CodexSessionLine): string | null {
  if (typeof line.threadId === "string" && line.threadId) {
    return line.threadId;
  }
  if (line.type === "session_meta" && typeof line.payload?.id === "string" && line.payload.id) {
    return line.payload.id;
  }
  return null;
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const filePath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      files.push(filePath);
      continue;
    }
    try {
      if ((await lstat(filePath)).isDirectory()) {
        files.push(...(await collectJsonlFiles(filePath, depth + 1)));
      }
    } catch {
      // Ignore inaccessible entries.
    }
  }
  return files;
}

async function readSessionMeta(
  filePath: string,
): Promise<{ cwd: string; threadId: string | null } | null> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let linesRead = 0;
    let threadId: string | null = null;
    for await (const line of reader) {
      if (linesRead >= 10) {
        break;
      }
      linesRead += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexSessionLine;
        const cwd = sessionMetaCwd(parsed);
        const resumeId = sessionResumeId(parsed);
        if (resumeId && !threadId) {
          threadId = resumeId;
        }
        if (cwd) {
          return { cwd, threadId };
        }
      } catch {
        // Ignore malformed lines and keep scanning the file header.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function loadSessionIndexForRoot(
  sessionRootDir: string,
): Promise<Map<string, IndexedSessionFile>> {
  const now = Date.now();
  if (
    sessionRootDir === CODEX_SESSIONS_DIR &&
    sessionIndexCache &&
    sessionIndexCache.expiresAt > now
  ) {
    return sessionIndexCache.byCwd;
  }

  const files = await collectJsonlFiles(sessionRootDir);
  const byCwd = new Map<string, IndexedSessionFile>();

  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    if (!meta) {
      continue;
    }
    try {
      const fileStat = await stat(filePath);
      const existing = byCwd.get(meta.cwd);
      if (!existing || fileStat.mtimeMs > existing.mtimeMs) {
        byCwd.set(meta.cwd, {
          path: filePath,
          mtimeMs: fileStat.mtimeMs,
          threadId: meta.threadId,
        });
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  if (sessionRootDir === CODEX_SESSIONS_DIR) {
    sessionIndexCache = {
      expiresAt: now + SESSION_INDEX_TTL_MS,
      byCwd,
    };
  }
  return byCwd;
}

function resolveSessionRootDirs(options?: {
  sessionRootDir?: string;
  sessionRootDirs?: string[];
}): string[] {
  const roots = [
    ...(options?.sessionRootDirs ?? []),
    ...(options?.sessionRootDir ? [options.sessionRootDir] : []),
    CODEX_SESSIONS_DIR,
  ];
  return [...new Set(roots.filter(Boolean))];
}

async function findSessionFile(
  worktreePath: string,
  options?: { sessionRootDir?: string; sessionRootDirs?: string[] },
): Promise<string | null> {
  const candidates = await resolveWorktreePathCandidates(worktreePath);
  let bestMatch: IndexedSessionFile | null = null;
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const sessionIndex = await loadSessionIndexForRoot(sessionRootDir);
    for (const candidate of candidates) {
      const match = sessionIndex.get(candidate);
      if (match && (!bestMatch || match.mtimeMs > bestMatch.mtimeMs)) {
        bestMatch = match;
      }
    }
  }
  return bestMatch?.path ?? null;
}

async function readThreadId(filePath: string): Promise<string | null> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexSessionLine;
        const resumeId = sessionResumeId(parsed);
        if (resumeId) {
          return resumeId;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readSessionTail(filePath: string, fileSize?: number): Promise<CodexSessionLine[]> {
  let content: string;
  let offset: number;
  try {
    const size = fileSize ?? (await stat(filePath)).size;
    offset = Math.max(0, size - MAX_SESSION_TAIL_BYTES);
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        content = buffer.toString("utf-8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return [];
  }

  const firstNewline = content.indexOf("\n");
  const safeContent = offset > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  const lines: CodexSessionLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as CodexSessionLine);
    } catch {
      // Ignore malformed lines and keep searching for the latest valid entry.
    }
  }
  return lines;
}

function semanticStatus(
  line: CodexSessionLine,
): Extract<AgentStatusObservation["status"], "working" | "waiting"> | null {
  if (line.type === "event_msg") {
    const payload = line.payload;
    const payloadType = payload?.type;
    if (!payloadType) {
      return null;
    }
    if (WAITING_EVENT_TYPES.has(payloadType)) {
      return "waiting";
    }
    if (payloadType === "agent_message") {
      if (WAITING_EVENT_TYPES.has(`agent_message:${payload.phase}`)) {
        return "waiting";
      }
      if (ACTIVE_EVENT_TYPES.has(`agent_message:${payload.phase}`)) {
        return "working";
      }
      return null;
    }
    return ACTIVE_EVENT_TYPES.has(payloadType) ? "working" : null;
  }

  if (line.type !== "response_item") {
    return null;
  }
  const payload = line.payload;
  const payloadType = payload?.type;
  if (!payloadType) {
    return null;
  }
  if (payloadType === "message") {
    if (payload.role === "assistant" && WAITING_EVENT_TYPES.has(`assistant:${payload.phase}`)) {
      return "waiting";
    }
    if (payload.role === "assistant" && ACTIVE_EVENT_TYPES.has(`assistant:${payload.phase}`)) {
      return "working";
    }
    return null;
  }
  return ACTIVE_EVENT_TYPES.has(payloadType) ? "working" : null;
}

async function readSemanticStatus(
  filePath: string,
  fileSize?: number,
): Promise<Extract<AgentStatusObservation["status"], "working" | "waiting"> | null> {
  const lines = await readSessionTail(filePath, fileSize);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const status = semanticStatus(line);
    if (status) {
      return status;
    }
  }
  return null;
}

export async function findCodexSessionId(
  worktreePath: string,
  options?: { sessionRootDir?: string; sessionRootDirs?: string[] },
): Promise<string | null> {
  const candidates = await resolveWorktreePathCandidates(worktreePath);
  let bestMatch: IndexedSessionFile | null = null;
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const sessionIndex = await loadSessionIndexForRoot(sessionRootDir);
    for (const candidate of candidates) {
      const match = sessionIndex.get(candidate);
      if (match && (!bestMatch || match.mtimeMs > bestMatch.mtimeMs)) {
        bestMatch = match;
      }
    }
  }
  if (!bestMatch) {
    return null;
  }
  return bestMatch.threadId ?? readThreadId(bestMatch.path);
}

export async function observeCodexStatus(
  worktreePath: string,
  args: { processAlive: boolean; signalWindowMs: number },
): Promise<AgentStatusObservation | null> {
  const sessionFile = await findSessionFile(worktreePath);
  if (!sessionFile) {
    return null;
  }

  try {
    const fileStat = await stat(sessionFile);
    const signalAt = fileStat.mtime;
    if (!args.processAlive) {
      return { status: "exited", signalAt };
    }
    const status = await readSemanticStatus(sessionFile, fileStat.size);
    if (status === "waiting") {
      return { status, signalAt };
    }
    if (status === "working") {
      return {
        status: Date.now() - fileStat.mtimeMs <= args.signalWindowMs ? "working" : "waiting",
        signalAt,
      };
    }
    return {
      status: Date.now() - fileStat.mtimeMs <= args.signalWindowMs ? "working" : "waiting",
      signalAt,
    };
  } catch {
    return null;
  }
}

export function buildCodexPlan(prompt: string): AgentLaunchPlan {
  return {
    launchCommand: `${codexCommand()} --dangerously-bypass-approvals-and-sandbox`,
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}

export function buildCodexResumePlan(threadId: string, binary = codexCommand()): AgentResumePlan {
  return {
    launchCommand: `${shellEscape(binary)} resume --dangerously-bypass-approvals-and-sandbox ${shellEscape(threadId)}`,
    readyMarkers: ["›"],
  };
}
