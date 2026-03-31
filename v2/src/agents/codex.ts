import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

const CODEX_SESSIONS_DIR = join(process.env["HOME"] || "", ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;
const SESSION_INDEX_TTL_MS = 30_000;

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

export function buildCodexPlan(prompt: string): AgentLaunchPlan {
  return {
    launchCommand: `${codexCommand()} -c features.codex_hooks=true --dangerously-bypass-approvals-and-sandbox`,
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}

export function buildCodexResumePlan(threadId: string, binary = codexCommand()): AgentResumePlan {
  return {
    launchCommand: `${shellEscape(binary)} resume -c features.codex_hooks=true --dangerously-bypass-approvals-and-sandbox ${shellEscape(threadId)}`,
    readyMarkers: ["›"],
  };
}
