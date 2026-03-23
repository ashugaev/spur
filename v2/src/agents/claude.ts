import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentLaunchPlan, AgentResumePlan } from "./shared.js";
import { shellEscape } from "./shared.js";

export const CLAUDE_FULL_ACCESS_COMMAND = "claude --dangerously-skip-permissions";
const CLAUDE_READY_MARKERS = ["Claude Code", "❯"];

export function buildClaudePlan(prompt: string): AgentLaunchPlan {
  return {
    agent: "claude",
    launchCommand: CLAUDE_FULL_ACCESS_COMMAND,
    initialMessage: prompt,
    readyMarkers: CLAUDE_READY_MARKERS,
  };
}

export function buildClaudeResumePlan(
  sessionId: string,
  binary = "claude",
): AgentResumePlan {
  return {
    agent: "claude",
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions`,
    readyMarkers: CLAUDE_READY_MARKERS,
  };
}

function toClaudeProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}

async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const jsonlFiles = entries.filter((entry) => entry.endsWith(".jsonl") && !entry.startsWith("agent-"));
  if (jsonlFiles.length === 0) return null;

  const withStats = await Promise.all(
    jsonlFiles.map(async (entry) => {
      const path = join(projectDir, entry);
      try {
        const details = await stat(path);
        return { path, mtime: details.mtimeMs };
      } catch {
        return { path, mtime: 0 };
      }
    }),
  );
  withStats.sort((left, right) => right.mtime - left.mtime);
  return withStats[0]?.path ?? null;
}

export async function findClaudeSessionId(workspacePath: string): Promise<string | null> {
  const projectDir = join(homedir(), ".claude", "projects", toClaudeProjectPath(workspacePath));
  const sessionFile = await findLatestSessionFile(projectDir);
  if (!sessionFile) {
    return null;
  }
  return basename(sessionFile, ".jsonl") || null;
}
