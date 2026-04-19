import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand } from "./agents/claude.js";
import { buildEphemeralCodexConfig, codexCommand } from "./agents/codex.js";
import { PREFLIGHT_DEFER_SENTINEL } from "./preflight-contract.js";
import type { AgentName, ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const PREFLIGHT_TIMEOUT_MS = 60_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 1024 * 1024;
const PREFLIGHT_RM_RETRIES = 5;
const PREFLIGHT_RM_RETRY_DELAY_MS = 100;

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
  const { stdout } = await execFileAsync(
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
  return stdout;
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

    const { stdout } = await execFileAsync(
      codexCommand(),
      [
        "exec",
        "--ephemeral",
        "--disable",
        "codex_hooks",
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
      },
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

export async function runSpawnPreflight(
  input: RunSpawnPreflightInput,
): Promise<SpawnPreflightResult> {
  const prompt = buildSpawnPreflightPrompt(input);
  const raw =
    input.agent === "claude"
      ? await runClaudePreflight(prompt, input.project.path)
      : await runCodexPreflight(prompt, input.project.path, input.project.codexArgs);
  return parseSpawnPreflightResult(raw);
}
