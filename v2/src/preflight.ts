import {
  execFile,
  type ExecFileOptions,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeCommand } from "./agents/claude.js";
import { buildEphemeralCodexConfig, codexCommand, linkCodexAuth } from "./agents/codex.js";
import { cursorCommand } from "./agents/cursor.js";
import {
  deleteOpenCodeSession,
  exportOpenCodeSession,
  opencodeCommand,
  parseOpenCodeTokenUsage,
} from "./agents/opencode.js";
import { resolveCursorLaunchModel } from "./agents/models.js";
import { compileBranchNamingRegex, isPlausibleGitRef } from "./branch-name.js";
import { PREFLIGHT_DEFER_SENTINEL } from "./preflight-contract.js";
import { resolveTempDir } from "./temp-dir.js";
import type { AgentName, ProjectConfig, TokenUsageTotals } from "./types.js";

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

class PreflightExecError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    options: ErrorOptions,
  ) {
    super(message, options);
  }
}

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
  options: ExecFileOptions,
): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : stdout.toString("utf8"));
      });
      child.stdin?.end();
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`${label} preflight failed: ${String(error)}`, { cause: error });
    }
    const e = error as ExecError;
    const output = describeExecOutput(e.stderr) || describeExecOutput(e.stdout) || "no output";
    const cause = describeExecFailure(e, command);
    throw new PreflightExecError(
      `${label} preflight failed (${cause}): ${output}`,
      describeExecOutput(e.stdout),
      { cause: error },
    );
  }
}

export class PreflightBranchValidationError extends Error {
  constructor(
    readonly branch: string,
    regex: string,
  ) {
    super(`preflight branch "${branch}" must match ${regex}`);
    this.name = "PreflightBranchValidationError";
  }
}

export class PreflightArtifactError extends Error {}

export interface SpawnPreflightResult {
  noProjectBranchRequirements?: true;
  branch?: string;
  usage?: TokenUsageTotals;
  providerIterationCount?: number;
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
    `Return ${PREFLIGHT_DEFER_SENTINEL} only when the project instructions define no branch-naming rules. Otherwise return a branch that satisfies the rules.`,
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
          `Return a corrected branch name. Use ${PREFLIGHT_DEFER_SENTINEL} only when the project defines no branch-naming rules.`,
        ]
      : []),
    "",
    "Spawn context:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

function parseSpawnPreflightResult(raw: string): SpawnPreflightResult {
  const trimmed = raw.trim();
  if (trimmed === PREFLIGHT_DEFER_SENTINEL) {
    return { noProjectBranchRequirements: true };
  }
  if (isPlausibleGitRef(trimmed)) return { branch: trimmed };
  throw new Error(
    `Spawn preflight must return exactly one branch name or ${PREFLIGHT_DEFER_SENTINEL}: ${trimmed}`,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function token(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function optionalToken(value: unknown): number | undefined | null {
  return value === undefined ? undefined : token(value);
}

function parseClaudeUsage(value: unknown): TokenUsageTotals | null {
  const usage = record(value);
  if (!usage) return null;
  const fresh = token(usage["input_tokens"]);
  const read = token(usage["cache_read_input_tokens"]);
  const nested = record(usage["cache_creation"]);
  const nested5m = optionalToken(nested?.["ephemeral_5m_input_tokens"]);
  const nested1h = optionalToken(nested?.["ephemeral_1h_input_tokens"]);
  const flatWrite = optionalToken(usage["cache_creation_input_tokens"]);
  const output = token(usage["output_tokens"]);
  const outputDetails = record(usage["output_tokens_details"]);
  const thinking = optionalToken(outputDetails?.["thinking_tokens"]);
  if (
    fresh === null ||
    read === null ||
    flatWrite === null ||
    output === null ||
    nested5m === null ||
    nested1h === null ||
    thinking === null ||
    (usage["cache_creation"] !== undefined && !nested) ||
    (usage["output_tokens_details"] !== undefined && !outputDetails)
  )
    return null;
  const write =
    nested5m !== undefined || nested1h !== undefined
      ? (nested5m ?? 0) + (nested1h ?? 0)
      : (flatWrite ?? 0);
  if ((thinking ?? 0) > output) return null;
  const input = fresh + read + write;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    ...(thinking !== undefined ? { reasoningOutputTokens: thinking } : {}),
    ...(nested5m !== undefined ? { cacheWrite5mInputTokens: nested5m } : {}),
    ...(nested1h !== undefined ? { cacheWrite1hInputTokens: nested1h } : {}),
  };
}

export function parseClaudePreflightOutput(raw: string): {
  text: string;
  usage?: TokenUsageTotals;
  providerIterationCount?: number;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { text: raw };
  }
  const parsed = record(decoded);
  if (!parsed || typeof parsed["result"] !== "string") return { text: raw };
  const base = parseClaudeUsage(parsed["usage"]);
  const advisors: TokenUsageTotals[] = [];
  let malformedAdvisor = false;
  const flatAdvisor = record(parsed["advisor_message"]);
  if (parsed["advisor_message"] !== undefined) {
    const sample = parseClaudeUsage(flatAdvisor?.["usage"]);
    if (sample) advisors.push(sample);
    else malformedAdvisor = true;
  }
  const nestedIterations = record(parsed["usage"])?.["iterations"];
  if (nestedIterations !== undefined) {
    if (!Array.isArray(nestedIterations)) {
      malformedAdvisor = true;
    } else {
      for (const iteration of nestedIterations) {
        const entry = record(iteration);
        if (entry?.["type"] !== "advisor_message") continue;
        const sample = parseClaudeUsage(entry);
        if (typeof entry["model"] !== "string" || !entry["model"] || !sample) {
          malformedAdvisor = true;
          break;
        }
        advisors.push(sample);
      }
    }
  }
  const iterations = Math.max(
    1 + advisors.length,
    Array.isArray(parsed["messages"]) ? parsed["messages"].length : 1,
  );
  const usage = !malformedAdvisor && base ? sumUsage([base, ...advisors]) : undefined;
  return {
    text: parsed["result"],
    ...(usage ? { usage } : {}),
    providerIterationCount: iterations,
  };
}

function parseAliasedUsage(value: unknown): TokenUsageTotals | null {
  const usage = record(value);
  if (!usage) return null;
  const valueFor = (...keys: string[]): unknown => {
    const values = keys.map((key) => usage[key]).filter((value) => value !== undefined);
    if (values.some((value) => value !== values[0])) return null;
    return values[0];
  };
  const input = token(valueFor("input", "input_tokens", "inputTokens"));
  const output = token(valueFor("output", "output_tokens", "outputTokens"));
  const reportedTotal = optionalToken(valueFor("total", "total_tokens", "totalTokens"));
  const cached = optionalToken(valueFor("cached", "cached_input_tokens", "cacheReadTokens"));
  const write = optionalToken(
    valueFor("cache_write", "cache_write_input_tokens", "cacheWriteTokens"),
  );
  const reasoning = optionalToken(
    valueFor("reasoning", "reasoning_output_tokens", "reasoningTokens"),
  );
  if (
    input === null ||
    output === null ||
    reportedTotal === null ||
    cached === null ||
    write === null ||
    reasoning === null ||
    (reportedTotal !== undefined && reportedTotal !== input + output)
  )
    return null;
  if ((cached ?? 0) + (write ?? 0) > input || (reasoning ?? 0) > output) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached !== undefined ? { cacheReadInputTokens: cached } : {}),
    ...(write !== undefined ? { cacheWriteInputTokens: write } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

export function parseCodexPreflightUsage(raw: string): TokenUsageTotals | undefined {
  let usage: TokenUsageTotals | undefined;
  for (const line of raw.split("\n")) {
    try {
      const parsed = record(JSON.parse(line) as unknown);
      const rawUsage = parsed?.["usage"] ?? record(parsed?.["payload"])?.["usage"];
      if (rawUsage !== undefined) {
        const candidate = parseAliasedUsage(rawUsage);
        if (!candidate) return undefined;
        usage = candidate;
      }
    } catch {
      // Codex JSON mode can interleave non-JSON diagnostics on stderr/stdout.
    }
  }
  return usage;
}

export function parseCursorPreflightOutput(raw: string): {
  text: string;
  usage?: TokenUsageTotals;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { text: raw };
  }
  const parsed = record(decoded);
  if (!parsed || typeof parsed["result"] !== "string")
    throw new Error("Invalid Cursor JSON output");
  const native = record(parsed["usage"]);
  const fresh = token(native?.["inputTokens"]);
  const output = token(native?.["outputTokens"]);
  const read = token(native?.["cacheReadTokens"]);
  const write = token(native?.["cacheWriteTokens"]);
  const reasoning = optionalToken(native?.["reasoningTokens"]);
  const reportedTotal = optionalToken(native?.["totalTokens"]);
  if (
    fresh === null ||
    output === null ||
    read === null ||
    write === null ||
    reasoning === null ||
    reportedTotal === null
  ) {
    return { text: parsed["result"] };
  }
  const input = fresh + read + write;
  if (reportedTotal !== undefined && reportedTotal !== input + output) {
    return { text: parsed["result"] };
  }
  const usage = {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
  return { text: parsed["result"], usage };
}

function sumUsage(values: TokenUsageTotals[]): TokenUsageTotals {
  const sum = (key: keyof TokenUsageTotals) =>
    values.reduce((total, value) => total + (value[key] ?? 0), 0);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    ...Object.fromEntries(
      [
        "cacheReadInputTokens",
        "cacheWriteInputTokens",
        "reasoningOutputTokens",
        "cacheWrite5mInputTokens",
        "cacheWrite1hInputTokens",
      ].flatMap((key) =>
        values.every((value) => value[key as keyof TokenUsageTotals] !== undefined)
          ? [[key, sum(key as keyof TokenUsageTotals)]]
          : [],
      ),
    ),
  };
}

function rethrowWithUsage(error: unknown, usage: TokenUsageTotals | undefined): never {
  if (usage && error instanceof Error) Object.assign(error, { usage });
  throw error instanceof Error ? error : new Error(String(error));
}

function parseResultWithUsage(text: string, usage?: TokenUsageTotals): SpawnPreflightResult {
  try {
    return { ...parseSpawnPreflightResult(text), ...(usage ? { usage } : {}) };
  } catch (error) {
    rethrowWithUsage(error, usage);
  }
}

async function runClaudePreflight(prompt: string, cwd: string): Promise<SpawnPreflightResult> {
  let raw: string;
  try {
    raw = await runPreflightExec(
      "claude",
      claudeCommand(),
      [
        "--print",
        "--output-format",
        "json",
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
  } catch (error) {
    const usage =
      error instanceof PreflightExecError
        ? parseClaudePreflightOutput(error.stdout).usage
        : undefined;
    rethrowWithUsage(error, usage);
  }
  const parsed = parseClaudePreflightOutput(raw);
  return {
    ...parseResultWithUsage(parsed.text, parsed.usage),
    ...(parsed.providerIterationCount !== undefined
      ? { providerIterationCount: parsed.providerIterationCount }
      : {}),
  };
}

async function runCodexPreflight(
  prompt: string,
  cwd: string,
  codexArgs: string[] | undefined,
): Promise<SpawnPreflightResult> {
  const tempDir = await mkdtemp(join(resolveTempDir(), "spur-preflight-"));
  const outputPath = join(tempDir, "output.txt");
  const codexHomePath = join(tempDir, "codex-home");

  try {
    await mkdir(codexHomePath, { recursive: true });
    const ephemeralConfig = await buildEphemeralCodexConfig([cwd]);
    await writeFile(join(codexHomePath, "config.toml"), ephemeralConfig, "utf8");
    await linkCodexAuth(codexHomePath);

    let stdout: string;
    try {
      stdout = await runPreflightExec(
        "codex",
        codexCommand(),
        [
          "exec",
          "--ephemeral",
          "--json",
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
    } catch (error) {
      const usage =
        error instanceof PreflightExecError ? parseCodexPreflightUsage(error.stdout) : undefined;
      rethrowWithUsage(error, usage);
    }

    try {
      const text = await readFile(outputPath, "utf8");
      const usage = parseCodexPreflightUsage(stdout);
      return parseResultWithUsage(text, usage);
    } catch {
      const usage = parseCodexPreflightUsage(stdout);
      return parseResultWithUsage(stdout, usage);
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

async function runCursorPreflight(prompt: string, cwd: string): Promise<SpawnPreflightResult> {
  const tempDir = await mkdtemp(join(resolveTempDir(), "spur-preflight-cursor-"));
  const model = await resolveCursorLaunchModel();

  try {
    let raw: string;
    try {
      raw = await runPreflightExec(
        "cursor",
        cursorCommand(),
        [
          "-p",
          "--output-format",
          "json",
          "--force",
          "--sandbox",
          "disabled",
          "--trust",
          "--workspace",
          cwd,
          "--model",
          model,
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
    } catch (error) {
      const usage =
        error instanceof PreflightExecError
          ? parseCursorPreflightOutput(error.stdout).usage
          : undefined;
      rethrowWithUsage(error, usage);
    }
    const parsed = parseCursorPreflightOutput(raw);
    return {
      ...parseResultWithUsage(parsed.text, parsed.usage),
    };
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: PREFLIGHT_RM_RETRIES,
      retryDelay: PREFLIGHT_RM_RETRY_DELAY_MS,
    }).catch(() => {});
  }
}

async function runOpenCodePreflight(prompt: string, cwd: string): Promise<SpawnPreflightResult> {
  let raw: string;
  let executionError: unknown;
  try {
    raw = await runPreflightExec(
      "opencode",
      opencodeCommand(),
      ["run", "--format", "json", "--agent", "build", prompt],
      {
        cwd,
        timeout: PREFLIGHT_TIMEOUT_MS,
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
      },
    );
  } catch (error) {
    executionError = error;
    raw = error instanceof PreflightExecError ? error.stdout : "";
  }
  let sessionId: string | undefined;
  let text = "";
  for (const line of raw.split("\n")) {
    try {
      const parsed = record(JSON.parse(line) as unknown);
      if (typeof parsed?.["sessionID"] === "string") sessionId ??= parsed["sessionID"];
      const part = record(parsed?.["part"]);
      if (part?.["type"] === "text" && typeof part["text"] === "string") text += part["text"];
    } catch {
      // Ignore non-JSON diagnostics; accounting only consumes structured rows.
    }
  }
  if (!text) text = raw;
  let usage: TokenUsageTotals | undefined;
  try {
    if (sessionId) {
      let sample: ReturnType<typeof parseOpenCodeTokenUsage>;
      let exportError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          sample = parseOpenCodeTokenUsage(await exportOpenCodeSession(sessionId));
          exportError = undefined;
          break;
        } catch (error) {
          exportError = error;
        }
      }
      if (exportError) {
        throw new PreflightArtifactError("OpenCode pre-flight export failed", {
          cause: exportError,
        });
      }
      if (sample) {
        const {
          provider: _provider,
          generationId: _generationId,
          observedAtMs: _observedAtMs,
          ...totals
        } = sample;
        usage = totals;
      }
    }
  } finally {
    if (sessionId) {
      let cleanupError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await deleteOpenCodeSession(sessionId);
          cleanupError = undefined;
          break;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) {
        rethrowWithUsage(
          new PreflightArtifactError("OpenCode pre-flight cleanup failed", {
            cause: cleanupError,
          }),
          usage,
        );
      }
    }
  }
  if (executionError) rethrowWithUsage(executionError, usage);
  return parseResultWithUsage(text, usage);
}

export async function runSpawnPreflight(
  input: RunSpawnPreflightInput,
): Promise<SpawnPreflightResult> {
  const prompt = buildSpawnPreflightPrompt(input);
  const result =
    input.agent === "claude"
      ? await runClaudePreflight(prompt, input.project.path)
      : input.agent === "codex"
        ? await runCodexPreflight(prompt, input.project.path, input.project.codexArgs)
        : input.agent === "cursor"
          ? await runCursorPreflight(prompt, input.project.path)
          : await runOpenCodePreflight(prompt, input.project.path);
  if (result.branch && input.project.branchNaming) {
    const regex = input.project.branchNaming.regex;
    if (!compileBranchNamingRegex(regex, "branchNaming").test(result.branch)) {
      rethrowWithUsage(new PreflightBranchValidationError(result.branch, regex), result.usage);
    }
  }
  return result;
}
