import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
const MAX_SESSION_TAIL_BYTES = 131_072;
const CLAUDE_HOOK_SETTINGS_FILE = "claude-hooks.settings.json";

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

async function readSessionTail(filePath: string, fileSize?: number): Promise<ClaudeSessionLine[]> {
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
  const lines: ClaudeSessionLine[] = [];
  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ClaudeSessionLine;
      if (typeof parsed.type === "string" && parsed.type) {
        lines.push(parsed);
      }
    } catch {
      // Ignore malformed lines and keep searching for the latest valid entry.
    }
  }
  return lines;
}

async function readLastEntryType(filePath: string, fileSize?: number): Promise<string | null> {
  const lines = await readSessionTail(filePath, fileSize);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const type = lines[index]?.type;
    if (typeof type === "string" && type) {
      return type;
    }
  }
  return null;
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
    const lastType = await readLastEntryType(sessionFile, fileStat.size);
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
  } catch {
    return null;
  }
}

export function buildClaudePlan(prompt: string): AgentLaunchPlan {
  return buildClaudePlanWithSettings(prompt);
}

function buildClaudePlanWithSettings(
  prompt: string,
  options?: { settingsPath?: string },
): AgentLaunchPlan {
  const settingsArg = options?.settingsPath
    ? ` --settings ${shellEscape(options.settingsPath)}`
    : "";
  return {
    launchCommand: `${claudeCommand()} --dangerously-skip-permissions${settingsArg}`,
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
  };
}

export function buildClaudeResumePlan(
  sessionId: string,
  binary = claudeCommand(),
  options?: { settingsPath?: string },
): AgentResumePlan {
  const settingsArg = options?.settingsPath
    ? ` --settings ${shellEscape(options.settingsPath)}`
    : "";
  return {
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions${settingsArg}`,
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

export async function ensureClaudeHookSettings(sessionToolDir: string): Promise<string> {
  const settingsPath = join(sessionToolDir, CLAUDE_HOOK_SETTINGS_FILE);
  const hooksConfig = {
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "$SPUR_AGENT_STATE_COMMAND" }],
        },
      ],
    },
  };
  await writeFile(settingsPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
  return settingsPath;
}

export function buildClaudePlanWithHooks(prompt: string, settingsPath: string): AgentLaunchPlan {
  return buildClaudePlanWithSettings(prompt, { settingsPath });
}

export function buildClaudeResumePlanWithHooks(
  sessionId: string,
  settingsPath: string,
  binary = claudeCommand(),
): AgentResumePlan {
  return buildClaudeResumePlan(sessionId, binary, { settingsPath });
}
