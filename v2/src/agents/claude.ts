import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { shellEscape } from "./shell-escape.js";
import type { AgentLaunchPlan } from "./types.js";

function claudeCommand(): string {
  return process.env["SPUR_CLAUDE_BIN"] || "claude";
}

function toClaudeProjectPath(worktreePath: string): string {
  return worktreePath.replaceAll("\\", "/").replaceAll(":", "").replace(/[/.]/g, "-");
}

async function findLatestSessionId(worktreePath: string): Promise<string | null> {
  const projectDir = join(homedir(), ".claude", "projects", toClaudeProjectPath(worktreePath));

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
          return { entry, mtimeMs: fileStat.mtimeMs };
        } catch {
          return { entry, mtimeMs: 0 };
        }
      }),
  );
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files[0] ? basename(files[0].entry, ".jsonl") : null;
}

export function buildClaudePlan(prompt: string): AgentLaunchPlan {
  return {
    launchCommand: `${claudeCommand()} --dangerously-skip-permissions`,
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
  };
}

export async function buildClaudeRestorePlan(
  worktreePath: string,
  prompt: string,
): Promise<AgentLaunchPlan | null> {
  const sessionId = await findLatestSessionId(worktreePath);
  if (!sessionId) {
    return null;
  }

  return {
    launchCommand: `${claudeCommand()} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions`,
    initialMessage: prompt,
    readyMarkers: ["❯"],
  };
}
