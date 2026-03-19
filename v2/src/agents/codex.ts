import { createReadStream } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import type { AgentLaunchPlan } from "./types.js";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;

function codexCommand(): string {
  return process.env["SPUR_CODEX_BIN"] || "codex";
}

interface CodexSessionLine {
  cwd?: string;
  threadId?: string;
  type?: string;
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
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(4096);
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf-8")
      .split("\n")
      .slice(0, 10);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexSessionLine;
        if (parsed.type === "session_meta" && parsed.cwd === worktreePath) {
          return true;
        }
      } catch {
        // Ignore malformed lines and keep scanning the file header.
      }
    }
  } catch {
    return false;
  } finally {
    await handle?.close();
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
        if (typeof parsed.threadId === "string" && parsed.threadId) {
          return parsed.threadId;
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

export function buildCodexPlan(prompt: string): AgentLaunchPlan {
  return {
    launchCommand: `${codexCommand()} --dangerously-bypass-approvals-and-sandbox`,
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}

export async function buildCodexRestorePlan(
  worktreePath: string,
  prompt: string,
): Promise<AgentLaunchPlan | null> {
  const sessionFile = await findSessionFile(worktreePath);
  const threadId = sessionFile ? await readThreadId(sessionFile) : null;
  if (!threadId) {
    return null;
  }

  return {
    launchCommand: `${codexCommand()} resume --dangerously-bypass-approvals-and-sandbox ${shellEscape(threadId)}`,
    initialMessage: prompt,
    readyMarkers: ["›"],
  };
}
