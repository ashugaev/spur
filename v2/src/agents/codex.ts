import { createReadStream, existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;
const SESSION_INDEX_TTL_MS = 30_000;
const CODEX_HOOKS_FILE = "hooks.json";
const CODEX_HOOK_COMMAND = "$SPUR_AGENT_STATE_COMMAND";
const CODEX_HOME_DIR = "codex-home";

interface IndexedSessionFile {
  path: string;
  mtimeMs: number;
  threadId: string | null;
}

interface SessionIndexCache {
  expiresAt: number;
  byCwd: Map<string, IndexedSessionFile>;
}

let sessionIndexCache: SessionIndexCache | null = null;

export function codexCommand(): string {
  return process.env["SPUR_CODEX_BIN"] || "codex";
}

interface CodexSessionLine {
  cwd?: string;
  payload?: {
    cwd?: string;
    id?: string;
    phase?: string;
    role?: string;
    type?: string;
  };
  threadId?: string;
  type?: string;
}

interface HookCommandDefinition {
  type: "command";
  command: string;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandDefinition[];
}

interface CodexHooksDocument {
  hooks: {
    SessionStart: HookMatcherGroup[];
    UserPromptSubmit: HookMatcherGroup[];
    PreToolUse: HookMatcherGroup[];
    PostToolUse: HookMatcherGroup[];
    Stop: HookMatcherGroup[];
  };
}

function sessionMetaCwd(line: CodexSessionLine): string | null {
  if (line.type !== "session_meta") {
    return null;
  }
  if (typeof line.cwd === "string" && line.cwd) {
    return line.cwd;
  }
  if (typeof line.payload?.cwd === "string" && line.payload.cwd) {
    return line.payload.cwd;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asHookMatcherGroup(value: unknown): HookMatcherGroup | null {
  if (!isRecord(value)) {
    return null;
  }
  const hooksValue = value["hooks"];
  if (!Array.isArray(hooksValue)) {
    return null;
  }
  const hooks = hooksValue.filter((entry): entry is HookCommandDefinition => {
    if (!isRecord(entry)) {
      return false;
    }
    return entry["type"] === "command" && typeof entry["command"] === "string";
  });
  if (hooks.length !== hooksValue.length) {
    return null;
  }
  const matcher = typeof value["matcher"] === "string" ? value["matcher"] : undefined;
  return {
    ...(matcher ? { matcher } : {}),
    hooks,
  };
}

function parseHookGroups(value: unknown): HookMatcherGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asHookMatcherGroup(entry))
    .filter((entry): entry is HookMatcherGroup => Boolean(entry));
}

function ensureHookEventGroup(groups: HookMatcherGroup[]): HookMatcherGroup[] {
  const updated = groups.map((group) => ({
    ...(group.matcher ? { matcher: group.matcher } : {}),
    hooks: [...group.hooks],
  }));
  const hasCommand = updated.some((group) =>
    group.hooks.some((hook) => hook.command === CODEX_HOOK_COMMAND),
  );
  if (hasCommand) {
    return updated;
  }
  updated.push({
    hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }],
  });
  return updated;
}

function parseCodexHooksDocument(content: string): CodexHooksDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      hooks: {
        SessionStart: ensureHookEventGroup([]),
        UserPromptSubmit: ensureHookEventGroup([]),
        PreToolUse: ensureHookEventGroup([]),
        PostToolUse: ensureHookEventGroup([]),
        Stop: ensureHookEventGroup([]),
      },
    };
  }
  const root = isRecord(parsed) ? parsed : {};
  const hooksRecord = isRecord(root["hooks"]) ? root["hooks"] : {};
  return {
    hooks: {
      SessionStart: ensureHookEventGroup(parseHookGroups(hooksRecord["SessionStart"])),
      UserPromptSubmit: ensureHookEventGroup(parseHookGroups(hooksRecord["UserPromptSubmit"])),
      PreToolUse: ensureHookEventGroup(parseHookGroups(hooksRecord["PreToolUse"])),
      PostToolUse: ensureHookEventGroup(parseHookGroups(hooksRecord["PostToolUse"])),
      Stop: ensureHookEventGroup(parseHookGroups(hooksRecord["Stop"])),
    },
  };
}

function sessionResumeId(line: CodexSessionLine): string | null {
  if (typeof line.threadId === "string" && line.threadId) {
    return line.threadId;
  }
  if (line.type === "session_meta" && typeof line.payload?.id === "string" && line.payload.id) {
    return line.payload.id;
  }
  return null;
}

async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const filePath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      files.push(filePath);
      continue;
    }
    try {
      if ((await lstat(filePath)).isDirectory()) {
        files.push(...(await collectJsonlFiles(filePath, depth + 1)));
      }
    } catch {
      // Ignore inaccessible entries.
    }
  }
  return files;
}

async function readSessionMeta(
  filePath: string,
): Promise<{ cwd: string; threadId: string | null } | null> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    let linesRead = 0;
    let threadId: string | null = null;
    for await (const line of reader) {
      if (linesRead >= 10) {
        break;
      }
      linesRead += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexSessionLine;
        const cwd = sessionMetaCwd(parsed);
        const resumeId = sessionResumeId(parsed);
        if (resumeId && !threadId) {
          threadId = resumeId;
        }
        if (cwd) {
          return { cwd, threadId };
        }
      } catch {
        // Ignore malformed lines and keep scanning the file header.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function loadSessionIndexForRoot(
  sessionRootDir: string,
): Promise<Map<string, IndexedSessionFile>> {
  const now = Date.now();
  if (
    sessionRootDir === CODEX_SESSIONS_DIR &&
    sessionIndexCache &&
    sessionIndexCache.expiresAt > now
  ) {
    return sessionIndexCache.byCwd;
  }

  const files = await collectJsonlFiles(sessionRootDir);
  const byCwd = new Map<string, IndexedSessionFile>();

  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    if (!meta) {
      continue;
    }
    try {
      const fileStat = await stat(filePath);
      const existing = byCwd.get(meta.cwd);
      if (!existing || fileStat.mtimeMs > existing.mtimeMs) {
        byCwd.set(meta.cwd, {
          path: filePath,
          mtimeMs: fileStat.mtimeMs,
          threadId: meta.threadId,
        });
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  if (sessionRootDir === CODEX_SESSIONS_DIR) {
    sessionIndexCache = {
      expiresAt: now + SESSION_INDEX_TTL_MS,
      byCwd,
    };
  }
  return byCwd;
}

function resolveSessionRootDirs(options?: {
  sessionRootDir?: string;
  sessionRootDirs?: string[];
}): string[] {
  const roots = [
    ...(options?.sessionRootDirs ?? []),
    ...(options?.sessionRootDir ? [options.sessionRootDir] : []),
    CODEX_SESSIONS_DIR,
  ];
  return [...new Set(roots.filter(Boolean))];
}

async function readThreadId(filePath: string): Promise<string | null> {
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as CodexSessionLine;
        const resumeId = sessionResumeId(parsed);
        if (resumeId) {
          return resumeId;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function findCodexSessionId(
  worktreePath: string,
  options?: { sessionRootDir?: string; sessionRootDirs?: string[] },
): Promise<string | null> {
  const candidates = await resolveWorktreePathCandidates(worktreePath);
  let bestMatch: IndexedSessionFile | null = null;
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const sessionIndex = await loadSessionIndexForRoot(sessionRootDir);
    for (const candidate of candidates) {
      const match = sessionIndex.get(candidate);
      if (match && (!bestMatch || match.mtimeMs > bestMatch.mtimeMs)) {
        bestMatch = match;
      }
    }
  }
  if (!bestMatch) {
    return null;
  }
  return bestMatch.threadId ?? readThreadId(bestMatch.path);
}

function withCodexHome(command: string, codexHomePath: string | undefined): string {
  if (!codexHomePath) {
    return command;
  }
  return `CODEX_HOME=${shellEscape(codexHomePath)} ${command}`;
}

function appendCodexArgs(command: string, codexArgs: string[] | undefined): string {
  if (!codexArgs || codexArgs.length === 0) {
    return command;
  }
  return `${command} ${codexArgs.map((arg) => shellEscape(arg)).join(" ")}`;
}

export function buildCodexPlan(
  prompt: string,
  options?: { codexHomePath?: string; codexArgs?: string[] },
): AgentLaunchPlan {
  return {
    launchCommand: withCodexHome(
      appendCodexArgs(
        `${codexCommand()} --enable codex_hooks --dangerously-bypass-approvals-and-sandbox`,
        options?.codexArgs,
      ),
      options?.codexHomePath,
    ),
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}

export function buildCodexResumePlan(
  threadId: string,
  binary = codexCommand(),
  options?: { codexHomePath?: string; codexArgs?: string[] },
): AgentResumePlan {
  return {
    launchCommand: withCodexHome(
      appendCodexArgs(
        `${shellEscape(binary)} resume --enable codex_hooks --dangerously-bypass-approvals-and-sandbox ${shellEscape(threadId)}`,
        options?.codexArgs,
      ),
      options?.codexHomePath,
    ),
    readyMarkers: ["›"],
  };
}

export async function buildCodexRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: { codexHomePath?: string; codexArgs?: string[] },
): Promise<AgentLaunchPlan | null> {
  const sessionRootDir = options?.codexHomePath
    ? join(options.codexHomePath, "sessions")
    : undefined;
  const threadId = await findCodexSessionId(
    worktreePath,
    sessionRootDir ? { sessionRootDirs: [sessionRootDir, CODEX_SESSIONS_DIR] } : undefined,
  );
  if (!threadId) {
    return null;
  }

  return {
    ...buildCodexResumePlan(threadId, codexCommand(), options),
    initialMessage: prompt,
  };
}

export function codexHookHomePath(sessionToolDir: string): string {
  return join(sessionToolDir, CODEX_HOME_DIR);
}

export async function ensureCodexHooksConfig(sessionToolDir: string): Promise<string> {
  const codexDir = codexHookHomePath(sessionToolDir);
  const hooksPath = join(codexDir, CODEX_HOOKS_FILE);
  await mkdir(codexDir, { recursive: true });
  const existingContent = await readFile(hooksPath, "utf8").catch(() => "");
  const next = parseCodexHooksDocument(existingContent);
  const userConfigPath = join(homedir(), ".codex", "config.toml");
  const sessionConfigPath = join(codexDir, "config.toml");
  const baseConfig = await readFile(userConfigPath, "utf8").catch(() => "");
  const suppressWarningConfig = baseConfig.includes("suppress_unstable_features_warning")
    ? baseConfig
    : `${baseConfig.trimEnd()}\n${baseConfig.trimEnd() ? "\n" : ""}suppress_unstable_features_warning = true\n`;
  await writeFile(sessionConfigPath, suppressWarningConfig, "utf8");
  const userAgentsDir = join(homedir(), ".codex", "agents");
  if (existsSync(userAgentsDir)) {
    await cp(userAgentsDir, join(codexDir, "agents"), { recursive: true, force: true });
  }
  await writeFile(hooksPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return codexDir;
}
