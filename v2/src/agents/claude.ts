import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan, AgentStateProbe } from "./types.js";

const ACTIVE_ENTRY_TYPES = new Set([
  "user",
  "tool_use",
  "progress",
  "file-history-snapshot",
  "queue-operation",
  "pr-link",
]);

const WAITING_ENTRY_TYPES = new Set(["assistant", "system", "summary", "result"]);

interface ClaudeSessionLine {
  type?: string;
}

export function claudeCommand(): string {
  return process.env["SPUR_CLAUDE_BIN"] || "claude";
}

function toClaudeProjectPath(worktreePath: string): string {
  return worktreePath.replaceAll("\\", "/").replaceAll(":", "").replace(/[/.]/g, "-");
}

async function findLatestSessionFileForProjectDir(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".jsonl") && !entry.startsWith("agent-"))
      .map(async (entry) => {
        const filePath = join(projectDir, entry);
        try {
          const fileStat = await stat(filePath);
          return { path: filePath, mtimeMs: fileStat.mtimeMs };
        } catch {
          return { path: filePath, mtimeMs: 0 };
        }
      }),
  );
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files[0]?.path ?? null;
}

async function findLatestSessionFile(worktreePath: string): Promise<string | null> {
  for (const candidate of await resolveWorktreePathCandidates(worktreePath)) {
    const sessionFile = await findLatestSessionFileForProjectDir(
      join(homedir(), ".claude", "projects", toClaudeProjectPath(candidate)),
    );
    if (sessionFile) {
      return sessionFile;
    }
  }
  return null;
}

async function findLatestSessionId(worktreePath: string): Promise<string | null> {
  const sessionFile = await findLatestSessionFile(worktreePath);
  return sessionFile ? basename(sessionFile, ".jsonl") : null;
}

async function readLastEntryType(filePath: string): Promise<string | null> {
  let lastType: string | null = null;
  try {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ClaudeSessionLine;
        if (typeof parsed.type === "string" && parsed.type) {
          lastType = parsed.type;
        }
      } catch {
        // Ignore malformed lines and keep scanning for the latest valid entry.
      }
    }
  } catch {
    return null;
  }
  return lastType;
}

export async function findClaudeSessionId(worktreePath: string): Promise<string | null> {
  return findLatestSessionId(worktreePath);
}

export async function probeClaudeState(
  worktreePath: string,
  args: { processAlive: boolean; signalWindowMs: number },
): Promise<AgentStateProbe | null> {
  const sessionFile = await findLatestSessionFile(worktreePath);
  if (!sessionFile) {
    return null;
  }

  let signalAt: Date;
  let signalAgeMs: number;
  try {
    const fileStat = await stat(sessionFile);
    signalAt = fileStat.mtime;
    signalAgeMs = Date.now() - fileStat.mtimeMs;
  } catch {
    return null;
  }

  const lastType = await readLastEntryType(sessionFile);
  if (!lastType) {
    return null;
  }

  if (!args.processAlive) {
    return {
      state: lastType === "error" ? "error" : "stopped",
      signalAt,
    };
  }

  if (lastType === "permission_request") {
    return { state: "needs_input", signalAt };
  }
  if (lastType === "error") {
    return { state: "error", signalAt };
  }
  if (WAITING_ENTRY_TYPES.has(lastType)) {
    return { state: "waiting", signalAt };
  }
  if (ACTIVE_ENTRY_TYPES.has(lastType)) {
    return {
      state: signalAgeMs <= args.signalWindowMs ? "working" : "waiting",
      signalAt,
    };
  }
  return {
    state: signalAgeMs <= args.signalWindowMs ? "working" : "waiting",
    signalAt,
  };
}

export function buildClaudePlan(prompt: string): AgentLaunchPlan {
  return {
    launchCommand: `${claudeCommand()} --dangerously-skip-permissions`,
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
  };
}

export function buildClaudeResumePlan(
  sessionId: string,
  binary = claudeCommand(),
): AgentResumePlan {
  return {
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions`,
    readyMarkers: ["❯"],
  };
}

export async function buildClaudeRestorePlan(
  worktreePath: string,
  prompt: string,
): Promise<AgentLaunchPlan | null> {
  const sessionId = await findClaudeSessionId(worktreePath);
  if (!sessionId) {
    return null;
  }

  return {
    ...buildClaudeResumePlan(sessionId),
    initialMessage: prompt,
  };
}
