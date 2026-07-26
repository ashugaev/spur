import { execFile } from "node:child_process";
import { readdir, stat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
import type { AgentModel } from "./models.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_MANAGED_AUTH_UNSET_ENV = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
] as const;

export function claudeManagedAuthEnv(setupToken: string): NodeJS.ProcessEnv {
  const denied = new Set<string>(CLAUDE_MANAGED_AUTH_UNSET_ENV);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !denied.has(entry[0]),
    ),
  );
  env["CLAUDE_CODE_OAUTH_TOKEN"] = setupToken;
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Claude authentication check returned an invalid response");
  }
}

function probeError(error: unknown): Error {
  if (isRecord(error) && (error.code === "ETIMEDOUT" || error.killed === true)) {
    return new Error("Claude setup-token validation timed out");
  }
  return new Error("Claude setup token was rejected, expired, or rate limited");
}

export async function validateClaudeSetupToken(
  setupToken: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 30_000;
  const env = claudeManagedAuthEnv(setupToken);
  let authStdout: string;
  try {
    const result = await execFileAsync(claudeCommand(), ["auth", "status", "--json"], {
      cwd: options.cwd,
      env,
      timeout,
      maxBuffer: 256 * 1_024,
    });
    authStdout = result.stdout;
  } catch (error) {
    throw probeError(error);
  }
  const auth = parseJson(authStdout);
  if (
    !isRecord(auth) ||
    auth.loggedIn !== true ||
    auth.authMethod !== "oauth_token" ||
    auth.apiProvider !== "firstParty"
  ) {
    throw new Error("Claude setup token conflicts with the configured authentication source");
  }

  const probeDir = await mkdtemp(join(tmpdir(), "spur-claude-auth-"));
  try {
    const configDir = join(probeDir, "config");
    await mkdir(configDir, { mode: 0o700 });
    const settingsPath = join(probeDir, "settings.json");
    const mcpPath = join(probeDir, "mcp.json");
    await writeFile(settingsPath, '{"disableAllHooks":true}\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(mcpPath, '{"mcpServers":{}}\n', { encoding: "utf8", mode: 0o600 });
    let inferenceStdout: string;
    try {
      const result = await execFileAsync(
        claudeCommand(),
        [
          "-p",
          "Reply with OK.",
          "--model",
          "haiku",
          "--output-format",
          "json",
          "--max-budget-usd",
          "0.02",
          "--tools",
          "",
          "--no-session-persistence",
          "--settings",
          settingsPath,
          "--mcp-config",
          mcpPath,
          "--strict-mcp-config",
        ],
        {
          cwd: probeDir,
          env: { ...env, CLAUDE_CONFIG_DIR: configDir },
          timeout,
          maxBuffer: 1_024 * 1_024,
        },
      );
      inferenceStdout = result.stdout;
    } catch (error) {
      throw probeError(error);
    }
    const inference = parseJson(inferenceStdout);
    if (!isRecord(inference) || inference.is_error === true || typeof inference.result !== "string") {
      throw new Error("Claude setup token was rejected, expired, or rate limited");
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

const CLAUDE_BLOCKING_PANE_PATTERNS = [
  /choose (?:a )?theme/i,
  /select (?:a )?theme/i,
  /log in|login required|not logged in/i,
  /trust this folder|do you trust/i,
  /oauth (?:error|failed|invalid)/i,
  /api (?:error|key required)/i,
  /usage limit|rate limit|extra usage/i,
];

export function isClaudeResumePaneReady(paneText: string): boolean {
  return (
    /Claude Code/i.test(paneText) &&
    /❯/.test(paneText) &&
    !CLAUDE_BLOCKING_PANE_PATTERNS.some((pattern) => pattern.test(paneText))
  );
}

export function claudeCommand(): string {
  return process.env["SPUR_CLAUDE_BIN"] || "claude";
}

// Spur's default model for the Claude agent, applied when a spawn resolves to
// claude without an explicit or configured model.
export const DEFAULT_CLAUDE_MODEL = "opus";

// Claude's selectable models. This catalog and its default live with the agent,
// not in the generic models registry. listClaudeModels flags DEFAULT_CLAUDE_MODEL
// at call time so the picker badge tracks the spawn default from one source.
const CLAUDE_MODELS: AgentModel[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "fable", label: "Fable" },
];

export function listClaudeModels(): AgentModel[] {
  return CLAUDE_MODELS.map((model) =>
    model.id === DEFAULT_CLAUDE_MODEL ? { ...model, isDefault: true } : model,
  );
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
