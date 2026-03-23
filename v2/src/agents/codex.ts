import { createReadStream } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentLaunchPlan, AgentResumePlan } from "./shared.js";
import { shellEscape } from "./shared.js";

export const CODEX_FULL_ACCESS_COMMAND = "codex --dangerously-bypass-approvals-and-sandbox";
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;
const CODEX_READY_MARKERS = ["Codex", "›"];

interface CodexJsonlLine {
  type?: string;
  cwd?: string;
  threadId?: string;
}

export function buildCodexPlan(prompt: string): AgentLaunchPlan {
  return {
    agent: "codex",
    launchCommand: CODEX_FULL_ACCESS_COMMAND,
    initialMessage: prompt,
    readyMarkers: CODEX_READY_MARKERS,
  };
}

export function buildCodexResumePlan(
  threadId: string,
  binary = "codex",
): AgentResumePlan {
  return {
    agent: "codex",
    launchCommand: `${shellEscape(binary)} resume --dangerously-bypass-approvals-and-sandbox ${shellEscape(threadId)}`,
    readyMarkers: CODEX_READY_MARKERS,
  };
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      results.push(fullPath);
      continue;
    }

    try {
      const details = await lstat(fullPath);
      if (details.isDirectory()) {
        results.push(...(await collectJsonlFiles(fullPath, depth + 1)));
      }
    } catch {
      // Ignore unreadable entries.
    }
  }
  return results;
}

async function sessionFileMatchesCwd(filePath: string, workspacePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, "r");
    let content: string;
    try {
      const buffer = Buffer.allocUnsafe(4096);
      const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
      content = buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }

    for (const line of content.split("\n").slice(0, 10)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexJsonlLine;
        if (parsed.type === "session_meta" && parsed.cwd === workspacePath) {
          return true;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch {
    // Ignore unreadable files.
  }

  return false;
}

async function findCodexSessionFile(workspacePath: string): Promise<string | null> {
  const files = await collectJsonlFiles(CODEX_SESSIONS_DIR);
  let bestMatch: { path: string; mtime: number } | null = null;

  for (const filePath of files) {
    if (!(await sessionFileMatchesCwd(filePath, workspacePath))) {
      continue;
    }
    try {
      const details = await stat(filePath);
      if (!bestMatch || details.mtimeMs > bestMatch.mtime) {
        bestMatch = { path: filePath, mtime: details.mtimeMs };
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  return bestMatch?.path ?? null;
}

export async function findCodexSessionId(workspacePath: string): Promise<string | null> {
  const sessionFile = await findCodexSessionFile(workspacePath);
  if (!sessionFile) {
    return null;
  }

  try {
    const reader = createInterface({
      input: createReadStream(sessionFile, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexJsonlLine;
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
