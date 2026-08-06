import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

const CURSOR_TRUST_FILENAME = ".workspace-trusted";
export const DEFAULT_CURSOR_MODEL = "auto";
export const CURSOR_READY_MARKERS = ["Cursor Agent", "Composer"] as const;

/** Env gate a materialized guard script checks before denying anything. */
export const CURSOR_RESTRICT_WRITES_ENV = "SPUR_CURSOR_RESTRICT_WRITES";
const CURSOR_GIT_GUARD_FILENAME = "restrict-writes-hook.js";

/**
 * A Cursor `beforeShellExecution` hook, materialized per-session and
 * referenced by absolute path. Denies `git commit`/`git push` (including
 * through `git -c`/`-C`, a leading `env`/`VAR=val` prefix, an absolute git
 * path, one level of `sh|bash|zsh -c "..."` (even behind an `env`/`VAR=val`
 * prefix on the interpreter itself), a single `&` job-control separator, one
 * level of `(...)` subshell grouping, and `$(...)`/backtick command
 * substitution). Inert (`{"permission":"allow"}`) unless
 * `SPUR_CURSOR_RESTRICT_WRITES=1` is set in its process env — required
 * because pooled/reused worktrees can carry a leftover hooks.json entry into
 * a later, non-restricted session. Dependency-free node so it runs on any
 * cursor host with no extra install.
 *
 * NOT covered (raises the bar, not a sandbox): git aliases that resolve to
 * commit/push, a renamed git binary or a shell function/alias named `git`,
 * direct `.git` plumbing writes (`hash-object`/`write-tree`/`update-ref`) that
 * fabricate or advance refs without going through `commit`/`push`, more than
 * one level of nested `sh -c`, and other obfuscated encodings (e.g. quoted or
 * escaped subcommand names).
 */
export const CURSOR_GIT_GUARD_SCRIPT = `#!/usr/bin/env node
"use strict";

const ENV_VAR = ${JSON.stringify(CURSOR_RESTRICT_WRITES_ENV)};
const DENY_MESSAGE = "git commit/push blocked in this read-only Spur session";
const SEGMENT_SPLIT_RE = /(?:&&|\\|\\||;|&|\\||\\n)/;
const SHELL_C_RE = /^(?:\\S*\\/)?(sh|bash|zsh)\\s+-c\\s+(['"])([\\s\\S]*)\\2\\s*$/;
const ENV_PREFIX_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+/;
const ENV_PREFIX_ENV_RE = /^(?:\\S*\\/)?env\\s+/;
const SHORT_VALUE_FLAGS = new Set(["-c", "-C"]);
const LONG_VALUE_FLAGS = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function allow() {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
}

function deny() {
  process.stdout.write(JSON.stringify({ permission: "deny", user_message: DENY_MESSAGE }));
}

function basename(token) {
  const parts = token.split("/");
  return parts[parts.length - 1];
}

function tokenize(segment) {
  return segment.trim().split(/\\s+/).filter(Boolean);
}

function stripLeadingEnvPrefix(text) {
  let rest = text;
  for (;;) {
    const assignMatch = rest.match(ENV_PREFIX_ASSIGNMENT_RE);
    if (assignMatch) {
      rest = rest.slice(assignMatch[0].length);
      continue;
    }
    const envMatch = rest.match(ENV_PREFIX_ENV_RE);
    if (envMatch) {
      rest = rest.slice(envMatch[0].length);
      continue;
    }
    break;
  }
  return rest;
}

function unwrapShellC(command) {
  const trimmed = command.trim();
  const withoutPrefix = stripLeadingEnvPrefix(trimmed);
  const match = withoutPrefix.match(SHELL_C_RE);
  return match ? match[3] : trimmed;
}

function isBalancedOuterParens(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i === text.length - 1;
      }
    }
  }
  return false;
}

function stripGroupingParens(text) {
  let stripped = text;
  while (
    stripped.startsWith("(") &&
    stripped.endsWith(")") &&
    isBalancedOuterParens(stripped)
  ) {
    stripped = stripped.slice(1, -1).trim();
  }
  return stripped;
}

function extractSubstitutionInners(command) {
  const inners = [];
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") {
          depth += 1;
        } else if (command[j] === ")") {
          depth -= 1;
        }
        j += 1;
      }
      inners.push(command.slice(i + 2, j - 1));
      i = j - 1;
    } else if (command[i] === "\`") {
      const close = command.indexOf("\`", i + 1);
      if (close === -1) {
        break;
      }
      inners.push(command.slice(i + 1, close));
      i = close;
    }
  }
  return inners;
}

function segmentDeniesGitWrite(rawSegment) {
  const trimmedSegment = rawSegment.trim();
  const stripped = stripGroupingParens(trimmedSegment);
  if (stripped !== trimmedSegment) {
    return commandDeniesGitWrite(stripped);
  }
  const tokens = tokenize(stripped);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (ASSIGNMENT_RE.test(token) || basename(token) === "env") {
      index += 1;
      continue;
    }
    break;
  }
  if (index >= tokens.length || basename(tokens[index]) !== "git") {
    return false;
  }
  index += 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (SHORT_VALUE_FLAGS.has(token) || LONG_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = tokens[index];
  return subcommand === "commit" || subcommand === "push";
}

function commandDeniesGitWrite(command) {
  if (extractSubstitutionInners(command).some((inner) => commandDeniesGitWrite(inner))) {
    return true;
  }
  return unwrapShellC(command)
    .split(SEGMENT_SPLIT_RE)
    .some(segmentDeniesGitWrite);
}

if (process.env[ENV_VAR] !== "1") {
  allow();
  process.exit(0);
}

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny();
    process.exit(0);
    return;
  }

  const command = String((payload && payload.command) || "");
  if (commandDeniesGitWrite(command)) {
    deny();
  } else {
    allow();
  }
  process.exit(0);
});
`;

interface CursorSessionFile {
  chatId: string;
  mtimeMs: number;
}

export function cursorCommand(): string {
  return process.env["SPUR_CURSOR_BIN"] || "agent";
}

export function cursorConfigDir(): string {
  return process.env["CURSOR_CONFIG_DIR"] || join(homedir(), ".cursor");
}

export function cursorConfigDirForSession(dataDir: string, sessionId: string): string {
  return join(dataDir, "cursor", sessionId);
}

async function findLatestCursorSessionFile(projectDir: string): Promise<CursorSessionFile | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const storePath = join(projectDir, entry, "store.db");
      try {
        const fileStat = await stat(storePath);
        return { chatId: entry, mtimeMs: fileStat.mtimeMs } satisfies CursorSessionFile;
      } catch {
        return null;
      }
    }),
  );
  const existing = files.filter((file): file is CursorSessionFile => Boolean(file));
  existing.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return existing[0] ?? null;
}

export async function findCursorSessionId(
  worktreePath: string,
  options?: { configDir?: string },
): Promise<string | null> {
  let best: CursorSessionFile | null = null;
  const configDir = options?.configDir ?? cursorConfigDir();
  for (const candidate of await resolveWorktreePathCandidates(worktreePath)) {
    const pathHash = createHash("md5").update(resolve(candidate)).digest("hex");
    const match = await findLatestCursorSessionFile(join(configDir, "chats", pathHash));
    if (match && (!best || match.mtimeMs > best.mtimeMs)) {
      best = match;
    }
  }
  return best?.chatId ?? null;
}

/**
 * Denies Cursor's model Write/Edit tools via `permissions.deny`, and blocks
 * `git commit`/`git push` at the shell layer via a `beforeShellExecution`
 * hook (see `CURSOR_GIT_GUARD_SCRIPT`). Neither confines raw shell-exec
 * writes (`sed -i`, `tee`, `>`, ...): cursor launches with `--force`, which
 * auto-approves the Shell permission category and runs shell commands
 * unsandboxed regardless of these guards. A true no-writes posture
 * (workspace_readonly) exists in Cursor but is only settable via a
 * server-side Cursor team/repo policy, not via CLI flags or local config.
 */
export async function ensureCursorRestrictWritesConfig(
  worktreePath: string,
  cursorConfigDir: string,
): Promise<void> {
  await mkdir(cursorConfigDir, { recursive: true });
  await writeFile(
    join(cursorConfigDir, "cli-config.json"),
    JSON.stringify(
      {
        permissions: {
          deny: ["Write(**)"],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const scriptPath = join(cursorConfigDir, CURSOR_GIT_GUARD_FILENAME);
  await writeFile(scriptPath, CURSOR_GIT_GUARD_SCRIPT, "utf8");
  await chmod(scriptPath, 0o755);

  await mergeCursorGitGuardHook(worktreePath, scriptPath);
}

interface CursorHooksConfig {
  version?: number;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CursorHookEntry {
  command?: unknown;
  [key: string]: unknown;
}

/**
 * Merges a `beforeShellExecution` guard entry into `<worktreePath>/.cursor/hooks.json`
 * without clobbering existing hooks (e.g. the repo's `stop` array) or other
 * keys. Idempotent: re-invocation replaces (not duplicates) the entry for
 * the same `scriptPath`. Throws on an unparseable existing file rather than
 * silently overwriting a human-authored one.
 */
async function mergeCursorGitGuardHook(worktreePath: string, scriptPath: string): Promise<void> {
  const hooksDir = join(worktreePath, ".cursor");
  const hooksPath = join(hooksDir, "hooks.json");
  await mkdir(hooksDir, { recursive: true });

  let hooksConfig: CursorHooksConfig = { version: 1, hooks: {} };
  if (existsSync(hooksPath)) {
    const raw = await readFile(hooksPath, "utf8");
    try {
      hooksConfig = JSON.parse(raw) as CursorHooksConfig;
    } catch (error) {
      throw new Error(`Unparseable existing Cursor hooks.json at ${hooksPath}`, { cause: error });
    }
  }

  const hooks = { ...(hooksConfig.hooks ?? {}) };
  const existingEntries = Array.isArray(hooks["beforeShellExecution"])
    ? (hooks["beforeShellExecution"] as CursorHookEntry[])
    : [];
  const preserved = existingEntries.filter((entry) => entry.command !== scriptPath);
  hooks["beforeShellExecution"] = [
    ...preserved,
    { command: scriptPath, timeout: 5, failClosed: true },
  ];

  const merged: CursorHooksConfig = { ...hooksConfig, hooks };
  const tmpPath = join(hooksDir, `.hooks.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  await rename(tmpPath, hooksPath);
}

export function buildCursorPlan(
  prompt: string,
  options?: { planMode?: boolean; model?: string },
): AgentLaunchPlan {
  const model = options?.model ?? DEFAULT_CURSOR_MODEL;
  const modelArg = ` --model ${shellEscape(model)}`;
  const planArg = options?.planMode ? " --plan" : "";
  return {
    launchCommand: `${cursorCommand()} --force --sandbox disabled${planArg}${modelArg}`,
    initialMessage: prompt,
    readyMarkers: [...CURSOR_READY_MARKERS],
  };
}

export function buildCursorResumePlan(
  chatId: string,
  binary = cursorCommand(),
  options?: { planMode?: boolean },
): AgentResumePlan {
  const planArg = options?.planMode ? " --plan" : "";
  return {
    launchCommand: `${shellEscape(binary)} --resume ${shellEscape(chatId)} --force --sandbox disabled${planArg}`,
    readyMarkers: [...CURSOR_READY_MARKERS],
  };
}

export async function buildCursorRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: { planMode?: boolean; cursorConfigDir?: string },
): Promise<AgentLaunchPlan | null> {
  const chatId = await findCursorSessionId(
    worktreePath,
    options?.cursorConfigDir ? { configDir: options.cursorConfigDir } : undefined,
  );
  if (!chatId) {
    return null;
  }

  return {
    ...buildCursorResumePlan(chatId, cursorCommand(), options),
    initialMessage: prompt,
  };
}

export async function ensureCursorWorkspaceTrust(worktreePath: string): Promise<void> {
  const cursorDir = join(worktreePath, ".cursor");
  const trustPath = join(cursorDir, CURSOR_TRUST_FILENAME);
  if (existsSync(trustPath)) {
    return;
  }

  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    trustPath,
    JSON.stringify(
      {
        trustedAt: new Date().toISOString(),
        workspacePath: resolve(worktreePath),
        trustMethod: "spur",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
