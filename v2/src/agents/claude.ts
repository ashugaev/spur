import { readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

export function claudeCommand(): string {
  return process.env["SPUR_CLAUDE_BIN"] || "claude";
}

const RESTRICT_WRITES_DENY_COMMAND =
  "echo 'restrictWrites: file edits are disabled for this session' >&2; exit 2";

export async function ensureClaudeRestrictWritesSettings(sessionToolDir: string): Promise<string> {
  const settingsDir = join(sessionToolDir, "claude");
  const settingsPath = join(settingsDir, "settings.json");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit|MultiEdit|NotebookEdit",
              hooks: [{ type: "command", command: RESTRICT_WRITES_DENY_COMMAND }],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return settingsPath;
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

export async function findLatestSessionFile(worktreePath: string): Promise<string | null> {
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

export async function findClaudeSessionId(worktreePath: string): Promise<string | null> {
  return findLatestSessionId(worktreePath);
}

interface ClaudePlanOptions {
  settingsPath?: string;
  planMode?: boolean;
  mcpConfigPath?: string;
  restrictWrites?: boolean;
  model?: string;
}

const CLAUDE_RESTRICT_WRITES_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

function claudeRestrictWritesArgs(restrictWrites?: boolean): string {
  if (!restrictWrites) {
    return "";
  }
  return CLAUDE_RESTRICT_WRITES_TOOLS.map((tool) => ` --disallowed-tools ${tool}`).join("");
}

function claudeMcpConfigArg(options?: ClaudePlanOptions): string {
  return options?.mcpConfigPath ? ` --mcp-config ${shellEscape(options.mcpConfigPath)}` : "";
}

export function buildClaudePlan(prompt: string, options?: ClaudePlanOptions): AgentLaunchPlan {
  const settingsArg = options?.settingsPath
    ? ` --settings ${shellEscape(options.settingsPath)}`
    : "";
  const planModeArg = options?.planMode ? " --permission-mode plan" : "";
  const mcpConfigArg = claudeMcpConfigArg(options);
  const restrictWritesArg = claudeRestrictWritesArgs(options?.restrictWrites);
  const modelArg = options?.model ? ` --model ${shellEscape(options.model)}` : "";
  return {
    launchCommand: `${claudeCommand()} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}${modelArg}`,
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
  };
}

export function buildClaudeResumePlan(
  sessionId: string,
  binary = claudeCommand(),
  options?: ClaudePlanOptions,
): AgentResumePlan {
  const settingsArg = options?.settingsPath
    ? ` --settings ${shellEscape(options.settingsPath)}`
    : "";
  const planModeArg = options?.planMode ? " --permission-mode plan" : "";
  const mcpConfigArg = claudeMcpConfigArg(options);
  const restrictWritesArg = claudeRestrictWritesArgs(options?.restrictWrites);
  return {
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}`,
    readyMarkers: ["❯"],
  };
}

export async function buildClaudeRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: ClaudePlanOptions,
): Promise<AgentLaunchPlan | null> {
  const sessionId = await findClaudeSessionId(worktreePath);
  if (!sessionId) {
    return null;
  }

  return {
    ...buildClaudeResumePlan(sessionId, claudeCommand(), options),
    initialMessage: prompt,
  };
}
