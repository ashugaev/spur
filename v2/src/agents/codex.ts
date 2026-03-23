import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;

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

async function sessionFileMatchesWorktree(
  filePath: string,
  worktreePath: string,
): Promise<boolean> {
  const candidates = new Set(await resolveWorktreePathCandidates(worktreePath));
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let linesRead = 0;
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
        if (cwd && candidates.has(cwd)) {
          return true;
        }
      } catch {
        // Ignore malformed lines and keep scanning the file header.
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function findSessionFile(worktreePath: string): Promise<string | null> {
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  let bestMatch: { path: string; mtimeMs: number } | null = null;

  for (const filePath of files) {
    if (!(await sessionFileMatchesWorktree(filePath, worktreePath))) {
      continue;
    }
    try {
      const fileStat = await stat(filePath);
      if (!bestMatch || fileStat.mtimeMs > bestMatch.mtimeMs) {
        bestMatch = { path: filePath, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      // Ignore unreadable files.
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

export async function findCodexSessionId(worktreePath: string): Promise<string | null> {
  const sessionFile = await findSessionFile(worktreePath);
  return sessionFile ? readThreadId(sessionFile) : null;
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

export async function buildCodexRestorePlan(
  worktreePath: string,
  prompt: string,
): Promise<AgentLaunchPlan | null> {
  const threadId = await findCodexSessionId(worktreePath);
  if (!threadId) {
    return null;
  }

  return {
    ...buildCodexResumePlan(threadId),
    initialMessage: prompt,
  };
}
