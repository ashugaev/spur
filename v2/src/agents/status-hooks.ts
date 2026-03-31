import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentName, SessionStatusUpdateStatus } from "../types.js";
import { shellEscape } from "./shell-escape.js";

type JsonObject = Record<string, unknown>;

const STATUS_HOOK_PATHS = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
} as const;
export const STATUS_HOOK_GIT_STATUS_EXCLUDES = [
  ".claude/",
  ".codex/",
] as const;
const STATUS_HOOK_EXCLUDE_PATHS = {
  claude: ".claude/",
  codex: ".codex/",
} as const;
const STATUS_COMMAND_MARKER = "spur-session-status";
const HOOK_TIMEOUT_SECONDS = 5;
const GIT_EXCLUDE_BLOCK_START = "# >>> Spur status hooks >>>";
const GIT_EXCLUDE_BLOCK_END = "# <<< Spur status hooks <<<";

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected ${path} to contain a JSON object`);
  }
  return parsed as JsonObject;
}

function writeJsonObject(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function isHookMatcher(value: unknown): value is JsonObject & { hooks: unknown[] } {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { hooks?: unknown }).hooks),
  );
}

function isSpurStatusMatcher(value: unknown): boolean {
  return (
    isHookMatcher(value) &&
    value.hooks.some(
      (hook) =>
        Boolean(
          hook &&
            typeof hook === "object" &&
            (hook as { type?: unknown }).type === "command" &&
            typeof (hook as { command?: unknown }).command === "string" &&
            (hook as { command: string }).command.includes(STATUS_COMMAND_MARKER),
        ),
    )
  );
}

function mergeHookMatchers(existing: unknown, additions: JsonObject[]): JsonObject[] {
  if (existing === undefined) {
    return additions;
  }
  if (!Array.isArray(existing)) {
    throw new Error("Expected hook event config to be an array");
  }
  return [...existing.filter((entry) => !isSpurStatusMatcher(entry)), ...additions];
}

function pruneHookMatchers(existing: unknown): JsonObject[] | undefined {
  if (existing === undefined) {
    return undefined;
  }
  if (!Array.isArray(existing)) {
    throw new Error("Expected hook event config to be an array");
  }
  const kept = existing.filter((entry) => !isSpurStatusMatcher(entry));
  return kept.length > 0 ? kept : undefined;
}

function buildCommand(statusCommandPath: string, status: SessionStatusUpdateStatus): string {
  return `${shellEscape(statusCommandPath)} ${shellEscape(status)}`;
}

function buildMatcher(matcher: string, command: string): JsonObject {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command,
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function claudeSettingsPath(worktreePath: string): string {
  return join(worktreePath, STATUS_HOOK_PATHS.claude);
}

function codexHooksPath(worktreePath: string): string {
  return join(worktreePath, STATUS_HOOK_PATHS.codex);
}

function statusHookExcludePathForAgent(agent: AgentName): string {
  return STATUS_HOOK_EXCLUDE_PATHS[agent];
}

function resolveGitDir(worktreePath: string): string | null {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function splitManagedExcludeBlock(content: string): {
  contentWithoutBlock: string;
  managedPaths: string[];
} {
  const start = content.indexOf(GIT_EXCLUDE_BLOCK_START);
  const end = content.indexOf(GIT_EXCLUDE_BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return {
      contentWithoutBlock: content.trim(),
      managedPaths: [],
    };
  }
  const before = content.slice(0, start).trim();
  const managedBlock = content
    .slice(start + GIT_EXCLUDE_BLOCK_START.length, end)
    .trim();
  const after = content.slice(end + GIT_EXCLUDE_BLOCK_END.length).trim();
  return {
    contentWithoutBlock: [before, after].filter(Boolean).join("\n"),
    managedPaths: managedBlock
      ? managedBlock
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  };
}

function writeManagedExcludeBlock(excludePath: string, managedPaths: Set<string>): void {
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const { contentWithoutBlock } = splitManagedExcludeBlock(existing);
  const nextSections = [contentWithoutBlock].filter(Boolean);
  if (managedPaths.size > 0) {
    nextSections.push(
      [
        GIT_EXCLUDE_BLOCK_START,
        ...[...managedPaths].sort(),
        GIT_EXCLUDE_BLOCK_END,
      ].join("\n"),
    );
  }
  const nextContent = nextSections.join("\n\n").trim();
  if (!nextContent) {
    rmSync(excludePath, { force: true });
    return;
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, `${nextContent}\n`, "utf8");
}

function updateManagedExcludePaths(
  worktreePath: string,
  update: (managedPaths: Set<string>) => void,
): void {
  const gitDir = resolveGitDir(worktreePath);
  if (!gitDir) {
    return;
  }
  const excludePath = join(gitDir, "info", "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const { managedPaths } = splitManagedExcludeBlock(existing);
  const nextPaths = new Set(managedPaths);
  update(nextPaths);
  writeManagedExcludeBlock(excludePath, nextPaths);
}

function ensureManagedExcludePath(worktreePath: string, relativePath: string): void {
  updateManagedExcludePaths(worktreePath, (managedPaths) => {
    managedPaths.add(relativePath);
  });
}

function removeManagedExcludePath(worktreePath: string, relativePath: string): void {
  updateManagedExcludePaths(worktreePath, (managedPaths) => {
    managedPaths.delete(relativePath);
  });
}

function ensureClaudeStatusHooks(worktreePath: string, statusCommandPath: string): void {
  const path = claudeSettingsPath(worktreePath);
  const settings = readJsonObject(path);
  settings["UserPromptSubmit"] = mergeHookMatchers(settings["UserPromptSubmit"], [
    buildMatcher("*", buildCommand(statusCommandPath, "working")),
  ]);
  settings["Stop"] = mergeHookMatchers(settings["Stop"], [
    buildMatcher("*", buildCommand(statusCommandPath, "waiting")),
  ]);
  settings["Notification"] = mergeHookMatchers(settings["Notification"], [
    buildMatcher("permission_prompt", buildCommand(statusCommandPath, "needs_input")),
    buildMatcher("idle_prompt", buildCommand(statusCommandPath, "waiting")),
  ]);
  writeJsonObject(path, settings);
  ensureManagedExcludePath(worktreePath, statusHookExcludePathForAgent("claude"));
}

function removeClaudeStatusHooks(worktreePath: string): void {
  const path = claudeSettingsPath(worktreePath);
  if (!existsSync(path)) {
    removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("claude"));
    return;
  }
  const settings = readJsonObject(path);
  const userPromptSubmit = pruneHookMatchers(settings["UserPromptSubmit"]);
  const stop = pruneHookMatchers(settings["Stop"]);
  const notification = pruneHookMatchers(settings["Notification"]);
  if (userPromptSubmit) {
    settings["UserPromptSubmit"] = userPromptSubmit;
  } else {
    delete settings["UserPromptSubmit"];
  }
  if (stop) {
    settings["Stop"] = stop;
  } else {
    delete settings["Stop"];
  }
  if (notification) {
    settings["Notification"] = notification;
  } else {
    delete settings["Notification"];
  }
  if (Object.keys(settings).length === 0) {
    rmSync(path, { force: true });
    removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("claude"));
    return;
  }
  writeJsonObject(path, settings);
  removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("claude"));
}

function ensureCodexStatusHooks(worktreePath: string, statusCommandPath: string): void {
  const path = codexHooksPath(worktreePath);
  const config = readJsonObject(path);
  const hooksValue = config["hooks"];
  if (
    hooksValue !== undefined &&
    (!hooksValue || typeof hooksValue !== "object" || Array.isArray(hooksValue))
  ) {
    throw new Error(`Expected ${path} hooks field to be a JSON object`);
  }
  const hooks = (hooksValue ?? {}) as JsonObject;
  hooks["UserPromptSubmit"] = mergeHookMatchers(hooks["UserPromptSubmit"], [
    buildMatcher("*", buildCommand(statusCommandPath, "working")),
  ]);
  hooks["Stop"] = mergeHookMatchers(hooks["Stop"], [
    buildMatcher("*", buildCommand(statusCommandPath, "waiting")),
  ]);
  config["hooks"] = hooks;
  writeJsonObject(path, config);
  ensureManagedExcludePath(worktreePath, statusHookExcludePathForAgent("codex"));
}

function removeCodexStatusHooks(worktreePath: string): void {
  const path = codexHooksPath(worktreePath);
  if (!existsSync(path)) {
    removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("codex"));
    return;
  }
  const config = readJsonObject(path);
  const hooksValue = config["hooks"];
  if (
    hooksValue !== undefined &&
    (!hooksValue || typeof hooksValue !== "object" || Array.isArray(hooksValue))
  ) {
    throw new Error(`Expected ${path} hooks field to be a JSON object`);
  }
  const hooks = (hooksValue ?? {}) as JsonObject;
  const userPromptSubmit = pruneHookMatchers(hooks["UserPromptSubmit"]);
  const stop = pruneHookMatchers(hooks["Stop"]);
  if (userPromptSubmit) {
    hooks["UserPromptSubmit"] = userPromptSubmit;
  } else {
    delete hooks["UserPromptSubmit"];
  }
  if (stop) {
    hooks["Stop"] = stop;
  } else {
    delete hooks["Stop"];
  }
  if (Object.keys(hooks).length > 0) {
    config["hooks"] = hooks;
  } else {
    delete config["hooks"];
  }
  if (Object.keys(config).length === 0) {
    rmSync(path, { force: true });
    removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("codex"));
    return;
  }
  writeJsonObject(path, config);
  removeManagedExcludePath(worktreePath, statusHookExcludePathForAgent("codex"));
}

export function ensureAgentStatusHooks(args: {
  agent: AgentName;
  worktreePath: string;
  statusCommandPath: string;
}): void {
  if (args.agent === "claude") {
    ensureClaudeStatusHooks(args.worktreePath, args.statusCommandPath);
    return;
  }
  ensureCodexStatusHooks(args.worktreePath, args.statusCommandPath);
}

export function removeAgentStatusHooks(args: { agent: AgentName; worktreePath: string }): void {
  if (args.agent === "claude") {
    removeClaudeStatusHooks(args.worktreePath);
    return;
  }
  removeCodexStatusHooks(args.worktreePath);
}
