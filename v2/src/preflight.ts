import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand } from "./agents/claude.js";
import { codexCommand } from "./agents/codex.js";
import type { AgentName, ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const PREFLIGHT_TIMEOUT_MS = 60_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 1024 * 1024;
const PREFLIGHT_SCHEMA = {
  type: "object",
  properties: {
    branch: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
  },
  required: ["branch"],
  additionalProperties: false,
};

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
    "Return a JSON object only. Do not include markdown fences or prose.",
    'Current recognized key: "branch".',
    'Return {"branch":"<git-branch-name>"} to suggest a branch, or {"branch":null} to defer to Spur default naming.',
    "If you set branch, make it a concise git branch name and follow the project instructions below.",
    "Prefer task, tracker, or PR identifiers when they appear in the task context.",
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
    throw new Error("Spawn preflight returned empty output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Spawn preflight returned invalid JSON: ${trimmed}`, {
      cause: error,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Spawn preflight must return a JSON object");
  }

  const root = parsed as {
    structured_output?: unknown;
    branch?: unknown;
  };
  const payload =
    root.structured_output &&
    typeof root.structured_output === "object" &&
    !Array.isArray(root.structured_output)
      ? (root.structured_output as { branch?: unknown })
      : root;
  const branch = payload.branch;
  if (branch === undefined || branch === null) {
    return {};
  }
  if (typeof branch !== "string" || !branch.trim()) {
    throw new Error('Spawn preflight field "branch" must be a non-empty string when provided');
  }

  return { branch: branch.trim() };
}

async function runClaudePreflight(prompt: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    claudeCommand(),
    [
      "--print",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(PREFLIGHT_SCHEMA),
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      prompt,
    ],
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

async function runCodexPreflight(prompt: string, cwd: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "spur-preflight-"));
  const schemaPath = join(tempDir, "schema.json");
  const outputPath = join(tempDir, "output.json");
  await writeFile(schemaPath, JSON.stringify(PREFLIGHT_SCHEMA), "utf8");

  try {
    const { stdout } = await execFileAsync(
      codexCommand(),
      [
        "exec",
        "--ephemeral",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        prompt,
      ],
      {
        cwd,
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
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runSpawnPreflight(
  input: RunSpawnPreflightInput,
): Promise<SpawnPreflightResult> {
  const prompt = buildSpawnPreflightPrompt(input);
  const raw =
    input.agent === "claude"
      ? await runClaudePreflight(prompt, input.project.path)
      : await runCodexPreflight(prompt, input.project.path);
  return parseSpawnPreflightResult(raw);
}
