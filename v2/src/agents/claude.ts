import { spawn } from "node:child_process";
import { readdir, stat, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { shellEscape } from "./shell-escape.js";
import { SNAPSHOT_HOOK_TOOL_NAME, SNAPSHOT_HOOK_TURN_FILE } from "../snapshots.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan, ClaudeLaunchRegistration } from "./types.js";
import { detectClaudeUsageLimitMenu } from "../rate-limit-detect.js";
import type { AgentModel } from "./models.js";
import type { ProviderReasoningEffort } from "../types.js";
import { agentExecutableCommand } from "./executable.js";

export function claudeCommand(): string {
  return agentExecutableCommand("claude");
}

// Spur's default model for the Claude agent, applied when a spawn resolves to
// claude without an explicit or configured model.
export const DEFAULT_CLAUDE_MODEL = "sonnet";

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

export interface ClaudeModelCapability {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportsEffort: boolean;
  supportedEffortLevels: string[];
}

const capabilityCache = new Map<string, { models: ClaudeModelCapability[]; expiresAt: number }>();
const capabilityRequests = new Map<string, Promise<ClaudeModelCapability[]>>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClaudeModelCapabilities(value: unknown): ClaudeModelCapability[] {
  if (!Array.isArray(value)) throw new Error("Claude model capabilities unavailable");
  const models = value.map((row: unknown) => {
    if (
      !isObject(row) ||
      typeof row["value"] !== "string" ||
      !row["value"] ||
      typeof row["displayName"] !== "string" ||
      (row["supportsEffort"] !== undefined && typeof row["supportsEffort"] !== "boolean") ||
      (row["resolvedModel"] !== undefined && typeof row["resolvedModel"] !== "string") ||
      (row["supportsEffort"] &&
        (!Array.isArray(row["supportedEffortLevels"]) ||
          !row["supportedEffortLevels"].every((level: unknown) => typeof level === "string")))
    )
      throw new Error("Malformed Claude model capabilities");
    return {
      value: row["value"],
      displayName: row["displayName"],
      supportsEffort: row["supportsEffort"] === true,
      ...(typeof row["resolvedModel"] === "string" ? { resolvedModel: row["resolvedModel"] } : {}),
      supportedEffortLevels: row["supportsEffort"]
        ? (row["supportedEffortLevels"] as string[])
        : [],
    };
  });
  if (!value.some((row: unknown) => isObject(row) && typeof row["supportsEffort"] === "boolean"))
    throw new Error("Claude model capabilities unavailable");
  return models;
}

async function probeClaudeModelCapabilities(command: string): Promise<ClaudeModelCapability[]> {
  const cwd = await mkdtemp(join(tmpdir(), "spur-claude-models-"));
  try {
    return await new Promise<ClaudeModelCapability[]>((resolve, reject) => {
      const child = spawn(
        command,
        [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--settings",
          '{"disableAllHooks":true}',
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--tools",
          "",
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            DISABLE_AUTO_UPDATE: "1",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      );
      let buffer = "";
      let outputBytes = 0;
      let settled = false;
      let result: ClaudeModelCapability[] | undefined;
      let failure: Error | undefined;
      const finish = (error?: Error, models?: ClaudeModelCapability[]) => {
        if (settled) return;
        settled = true;
        failure = error;
        result = models;
        clearTimeout(deadline);
        child.stdin.destroy();
        child.kill("SIGKILL");
      };
      const deadline = setTimeout(
        () => finish(new Error("Claude model capabilities timed out")),
        5_000,
      );
      child.on("error", (error) => finish(error));
      child.on("close", () => {
        clearTimeout(deadline);
        if (result) resolve(result);
        else reject(failure ?? new Error("Claude model capabilities unavailable"));
      });
      child.stdin.on("error", (error) => finish(error));
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024)
          finish(new Error("Claude model capability output exceeded limit"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) {
          finish(new Error("Claude model capability output exceeded limit"));
          return;
        }
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let envelope: unknown;
          try {
            envelope = JSON.parse(line);
          } catch {
            finish(new Error("Malformed Claude initialize response"));
            return;
          }
          if (!isObject(envelope) || envelope["type"] !== "control_response") continue;
          const response = envelope["response"];
          if (!isObject(response) || response["request_id"] !== "spur-model-caps") continue;
          const payload = response["response"];
          try {
            if (response["subtype"] !== "success" || !isObject(payload))
              throw new Error("Claude initialize failed");
            finish(undefined, parseClaudeModelCapabilities(payload["models"]));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
      });
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: "spur-model-caps",
          request: { subtype: "initialize", hooks: {} },
        }) + "\n",
      );
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function discoverClaudeModelCapabilities(): Promise<ClaudeModelCapability[]> {
  const command = claudeCommand();
  const cached = capabilityCache.get(command);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const active = capabilityRequests.get(command);
  if (active) return active;
  const request = probeClaudeModelCapabilities(command)
    .then((models) => {
      capabilityCache.set(command, { models, expiresAt: Date.now() + 5 * 60 * 1000 });
      return models;
    })
    .finally(() => capabilityRequests.delete(command));
  capabilityRequests.set(command, request);
  return request;
}

const RESTRICT_WRITES_DENY_COMMAND =
  "echo 'restrictWrites: file edits are disabled for this session' >&2; exit 2";

export async function ensureClaudeSettings(
  sessionToolDir: string,
  options: { restrictWrites: boolean },
): Promise<string> {
  const settingsDir = join(sessionToolDir, "claude");
  const settingsPath = join(settingsDir, "settings.json");
  const snapshotHook = {
    hooks: [
      { type: "command", command: shellEscape(join(sessionToolDir, SNAPSHOT_HOOK_TOOL_NAME)) },
    ],
  };
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          ...(options.restrictWrites
            ? {
                PreToolUse: [
                  {
                    matcher: "Write|Edit|MultiEdit|NotebookEdit",
                    hooks: [{ type: "command", command: RESTRICT_WRITES_DENY_COMMAND }],
                  },
                ],
              }
            : {}),
          UserPromptSubmit: [snapshotHook],
          PostToolUse: [snapshotHook],
          Stop: [snapshotHook],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  // A new Claude process starts a work turn, whatever turn the previous process died in.
  await writeFile(
    join(sessionToolDir, SNAPSHOT_HOOK_TURN_FILE),
    JSON.stringify({ reminder: false, worked: false }),
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
 * Path claude writes for a pinned native session id (from
 * `claude --session-id <uuid>`) launched in `worktreePath`. The file appears
 * only once claude persists the session, so this is the expected path, not a
 * claim that it exists.
 */
export function sessionFilePathForId(worktreePath: string, sessionId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    toClaudeProjectPath(worktreePath),
    `${sessionId}.jsonl`,
  );
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
    const filePath = sessionFilePathForId(candidate, sessionId);
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
  reasoningEffort?: ProviderReasoningEffort;
}

function withClaudeConfigDir(command: string, configDir?: string): string {
  if (!configDir) {
    return command;
  }
  return `CLAUDE_CONFIG_DIR=${shellEscape(configDir)} ${command}`;
}

// The sessions dir the launched claude writes its registration into: the
// CLAUDE_CONFIG_DIR on the launch command, else the daemon's own (copied into
// the pane env), else ~/.claude. Empty values count as unset.
function claudeRegistrationFor(
  sessionId: string,
  options?: ClaudePlanOptions,
): ClaudeLaunchRegistration {
  const configDir =
    options?.claudeConfigDir || process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  return { sessionsDir: join(configDir, "sessions"), sessionId };
}

const CLAUDE_STARTUP_DIALOG_FOOTER = "Enter to confirm · Esc to";

const CLAUDE_STARTUP_DIALOG_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["Bypass Permissions mode", "bypass permissions warning"],
  ["Quick safety check", "workspace trust dialog"],
  ["Do you want to use this API key", "custom API key prompt"],
  ["Resume this conversation?", "resume usage prompt"],
  ["Resume from summary", "resume summary prompt"],
];

/**
 * Name of the Claude dialog blocking the composer in a pane capture, or null.
 * A dialog is live only when its footer sits in the last 3 non-empty lines, so
 * a dismissed dialog left in scrollback above a ready REPL does not count.
 */
export function claudeStartupDialog(capture: string): string | null {
  if (detectClaudeUsageLimitMenu(capture)) {
    return "usage limit menu";
  }
  const lines = capture
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!lines.slice(-3).some((line) => line.startsWith(CLAUDE_STARTUP_DIALOG_FOOTER))) {
    return null;
  }
  const bottom = lines.slice(-20).join("\n");
  for (const [needle, name] of CLAUDE_STARTUP_DIALOG_NAMES) {
    if (bottom.includes(needle)) {
      return name;
    }
  }
  return "startup dialog";
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
  const reasoningEffortArg = options?.reasoningEffort ? ` --effort ${options.reasoningEffort}` : "";
  return {
    launchCommand: withClaudeConfigDir(
      `${claudeCommand()} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}${modelArg}${sessionIdArg}${reasoningEffortArg}`,
      options?.claudeConfigDir,
    ),
    initialMessage: prompt,
    readyMarkers: ["Claude Code", "❯"],
    ...(options?.sessionId
      ? { claudeRegistration: claudeRegistrationFor(options.sessionId, options) }
      : {}),
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
  const reasoningEffortArg = options?.reasoningEffort ? ` --effort ${options.reasoningEffort}` : "";
  return {
    launchCommand: withClaudeConfigDir(
      `${shellEscape(binary)} --resume ${shellEscape(sessionId)} --dangerously-skip-permissions${planModeArg}${restrictWritesArg}${settingsArg}${mcpConfigArg}${reasoningEffortArg}`,
      options?.claudeConfigDir,
    ),
    readyMarkers: ["❯"],
    claudeRegistration: claudeRegistrationFor(sessionId, options),
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
