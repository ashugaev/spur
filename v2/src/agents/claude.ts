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

/**
 * Resolve the transcript file for a pinned native session id (from
 * `claude --session-id <uuid>`). Returns the `<uuid>.jsonl` path under the
 * first matching project dir, or null when it does not exist yet. This is how
 * two sessions sharing one worktree stay bound to their own transcript instead
 * of guessing by newest mtime.
 */
export async function sessionFileForId(
  worktreePath: string,
  sessionId: string,
): Promise<string | null> {
  for (const candidate of await resolveWorktreePathCandidates(worktreePath)) {
    const filePath = join(
      homedir(),
      ".claude",
      "projects",
      toClaudeProjectPath(candidate),
      `${sessionId}.jsonl`,
    );
    try {
      await stat(filePath);
      return filePath;
    } catch {
      continue;
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
  claudeConfigDir?: string;
  sessionId?: string;
}

function withClaudeConfigDir(command: string, configDir?: string): string {
  if (!configDir) {
    return command;
  }
  return `CLAUDE_CONFIG_DIR=${shellEscape(configDir)} ${command}`;
}

const CLAUDE_RESTRICT_WRITES_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const;

function claudeRestrictWritesArgs(restrictWrites?: boolean): string {
  if (!restrictWrites) {
    return "";
  }
  return CLAUDE_RESTRICT_WRITES_TOOLS.map((tool) => ` --disallowed-tools ${tool}`).join("");
}

function claudeMcpConfigArg(options?: ClaudePlanOptions): string {
  return options?.mcpConfigPath
    ? ` --mcp-config ${shellEscape(options.mcpConfigPath)} --strict-mcp-config`
    : "";
}

export function buildClaudePlan(prompt: string, options?: ClaudePlanOptions): AgentLaunchPlan {
  const settingsArg = options?.settingsPath
    ? ` --settings ${shellEscape(options.settingsPath)}`
    : "";
  const planModeArg = options?.planMode ? " --permission-mode plan" : "";
  const mcpConfigArg = claudeMcpConfigArg(options);
  const restrictWritesArg = claudeRestrictWritesArgs(options?.restrictWrites);
  const modelArg = options?.model ? ` --model ${shellEscape(options.model)}` : "";
  const sessionIdArg = options?.sessionId ? ` --session-id ${shellEscape(options.sessionId)}` : "";
  return {
    launchCommand: withClaudeConfigDir(
      `${claudeCommand()} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}${modelArg}${sessionIdArg}`,
      options?.claudeConfigDir,
    ),
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
    launchCommand: withClaudeConfigDir(
      `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}`,
      options?.claudeConfigDir,
    ),
    readyMarkers: ["❯"],
  };
}

export async function buildClaudeRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: ClaudePlanOptions,
): Promise<AgentLaunchPlan | null> {
  // Prefer resuming the pinned native session id when its transcript exists,
  // so a restored session rebinds to its own transcript. Fall back to the
  // newest-mtime scan for legacy sessions with no pinned id.
  const sessionId = options?.sessionId
    ? (await sessionFileForId(worktreePath, options.sessionId))
      ? options.sessionId
      : null
    : await findClaudeSessionId(worktreePath);
  if (!sessionId) {
    return null;
  }

  return {
    ...buildClaudeResumePlan(sessionId, claudeCommand(), options),
    initialMessage: prompt,
  };
}
