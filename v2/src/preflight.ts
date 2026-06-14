import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand } from "./agents/claude.js";
import { buildEphemeralCodexConfig, codexCommand, linkCodexAuth } from "./agents/codex.js";
import { cursorCommand } from "./agents/cursor.js";
import { assertBranchNameMatches } from "./branch-name.js";
import { PREFLIGHT_DEFER_SENTINEL } from "./preflight-contract.js";
import type { AgentName, ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const PREFLIGHT_TIMEOUT_MS = 60_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 1024 * 1024;
const PREFLIGHT_RM_RETRIES = 5;
const PREFLIGHT_RM_RETRY_DELAY_MS = 100;

type ExecError = Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

function describeExecOutput(value: string | Buffer | undefined): string {
  return (typeof value === "string" ? value : (value?.toString("utf8") ?? "")).trim();
}

function describeExecFailure(e: ExecError, command: string): string {
  if (e.code === "ENOENT") return `command not found: ${command}`;
  if (e.killed) return `timed out after ${PREFLIGHT_TIMEOUT_MS / 1000}s`;
  if (e.signal) return `terminated by signal ${e.signal}`;
  if (typeof e.code === "number") return `exit code ${e.code}`;
  if (typeof e.code === "string") return `error ${e.code}`;
  return "no exit code";
}

async function runPreflightExec(
  label: string,
  command: string,
  args: string[],
  options: Parameters<typeof execFileAsync>[2],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, options);
    return typeof stdout === "string" ? stdout : stdout.toString("utf8");
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`${label} preflight failed: ${String(error)}`, { cause: error });
    }
    const e = error as ExecError;
    const output = describeExecOutput(e.stderr) || describeExecOutput(e.stdout) || "no output";
    const cause = describeExecFailure(e, command);
    throw new Error(`${label} preflight failed (${cause}): ${output}`, { cause: error });
  }
}

export interface SpawnPreflightResult {
  branch?: string;
}

export interface RunSpawnPreflightInput {
  agent: AgentName;
  projectId: string;
  project: ProjectConfig;
  baseBranch: string;
  worktree: boolean;
  prompt: string;
  feedback?: string;
}

function buildSpawnPreflightPrompt(args: RunSpawnPreflightInput): string {
  const context = {
    projectId: args.projectId,
    agent: args.agent,
    worktree: args.worktree,
    projectPath: args.project.path,
    baseBranch: args.baseBranch,
    defaultBranch: args.project.defaultBranch,
    sessionPrefix: args.project.sessionPrefix,
    initialTaskPrompt: args.prompt,
  };

  return [
    "You are running a Spur spawn preflight before worktree creation.",
    `Return exactly one line: either a git branch name or the exact token ${PREFLIGHT_DEFER_SENTINEL}.`,
    `Return ${PREFLIGHT_DEFER_SENTINEL} when the project instructions do not define branch-naming rules and Spur should use its default naming.`,
    "Do not include JSON, markdown, quotes, or prose.",
    "If you return a branch, return only the branch name.",
    "",
    "Project instructions:",
    args.project.preflight?.prompt ?? "",
    ...(args.feedback
      ? [
          "",
          "Previous attempt feedback:",
          args.feedback,
          "Return a corrected branch name, or defer if the project rules do not define one.",
        ]
      : []),
    "",
    "Spawn context:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function parseSpawnPreflightResult(raw: string): SpawnPreflightResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed === PREFLIGHT_DEFER_SENTINEL) {
    return {};
  }
  if (trimmed.includes("\n") || /\s/.test(trimmed)) {
    throw new Error(
      `Spawn preflight must return exactly one branch name or ${PREFLIGHT_DEFER_SENTINEL}: ${trimmed}`,
    );
  }

  return { branch: trimmed };
}

async function runClaudePreflight(prompt: string, cwd: string): Promise<string> {
  return runPreflightExec(
    "claude",
    claudeCommand(),
    ["--print", "--no-session-persistence", "--dangerously-skip-permissions", prompt],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDECODE: "",
      },
      timeout: PREFLIGHT_TIMEOUT_MS,
      maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
    },
  );
}

async function runCodexPreflight(
  prompt: string,
  cwd: string,
  codexArgs: string[] | undefined,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "spur-preflight-"));
  const outputPath = join(tempDir, "output.txt");
  const codexHomePath = join(tempDir, "codex-home");

  try {
    await mkdir(codexHomePath, { recursive: true });
    const ephemeralConfig = await buildEphemeralCodexConfig([cwd]);
    await writeFile(join(codexHomePath, "config.toml"), ephemeralConfig, "utf8");
    await linkCodexAuth(codexHomePath);

    const stdout = await runPreflightExec(
      "codex",
      codexCommand(),
      [
        "exec",
        "--ephemeral",
        "--disable",
        "hooks",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--dangerously-bypass-approvals-and-sandbox",
        ...(codexArgs ?? []),
        "--output-last-message",
        outputPath,
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: codexHomePath,
        },
        timeout: PREFLIGHT_TIMEOUT_MS,
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      } as ExecFileOptionsWithStringEncoding,
    );

    try {
      return await readFile(outputPath, "utf8");
    } catch {
      return stdout;
    }
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: PREFLIGHT_RM_RETRIES,
      retryDelay: PREFLIGHT_RM_RETRY_DELAY_MS,
    }).catch(() => {});
  }
}

async function runCursorPreflight(prompt: string, cwd: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "spur-preflight-cursor-"));

  try {
    return await runPreflightExec(
      "cursor",
      cursorCommand(),
      [
        "-p",
        "--output-format",
        "text",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--workspace",
        cwd,
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          CURSOR_CONFIG_DIR: tempDir,
        },
        timeout: PREFLIGHT_TIMEOUT_MS,
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
      },
    );
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: PREFLIGHT_RM_RETRIES,
      retryDelay: PREFLIGHT_RM_RETRY_DELAY_MS,
    }).catch(() => {});
  }
}

export async function runSpawnPreflight(
  input: RunSpawnPreflightInput,
): Promise<SpawnPreflightResult> {
  const prompt = buildSpawnPreflightPrompt(input);
  const raw =
    input.agent === "claude"
      ? await runClaudePreflight(prompt, input.project.path)
      : input.agent === "codex"
        ? await runCodexPreflight(prompt, input.project.path, input.project.codexArgs)
        : await runCursorPreflight(prompt, input.project.path);
  const result = parseSpawnPreflightResult(raw);
  if (result.branch) {
    assertBranchNameMatches(result.branch, input.project.branchNaming, "preflight branch");
  }
  return result;
}
