import { createHash, type Hash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
import type { ProviderReasoningEffort, TranscriptEntry, SidecarMcpBinding } from "../types.js";
import { MAX_RETAINED_CONVERSATION_ENTRIES } from "../claude-jsonl-state.js";
import { createConcurrencyGate } from "../concurrency-gate.js";
import { SCAN_CHUNK_BYTES, scanJsonlLines } from "../jsonl-scan.js";
import { hashHistoryTail, PREFIX_VERIFY_BYTES } from "../agent-history-delta.js";
import { detectCodexRateLimit, type RateLimitDetection } from "../rate-limit-detect.js";
import { agentExecutableCommand } from "./executable.js";
import type { ProviderTokenUsageSample } from "../token-usage.js";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const MAX_SESSION_SCAN_DEPTH = 4;
const SESSION_INDEX_TTL_MS = 30_000;
const CODEX_HOOKS_FILE = "hooks.json";
const CODEX_HOOK_COMMAND = "$SPUR_AGENT_STATE_COMMAND";
const CODEX_HOME_DIR = "codex-home";
const CODEX_RESTRICT_WRITES_MATCHER = "apply_patch";
const CODEX_RESTRICT_WRITES_DENY_COMMAND =
  "echo 'restrictWrites: file edits are disabled for this session' >&2; exit 2";

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
  return agentExecutableCommand("codex");
}

interface CodexSessionLine {
  cwd?: string;
  payload?: {
    cwd?: string;
    id?: string;
    phase?: string;
    role?: string;
    source?: unknown;
    thread_source?: string;
    type?: string;
  };
  source?: unknown;
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

function isExplicitSubagentSessionMeta(line: CodexSessionLine): boolean {
  if (line.type !== "session_meta") {
    return false;
  }
  const source = line.payload?.source ?? line.source;
  return (
    line.payload?.thread_source === "subagent" || (isRecord(source) && isRecord(source["subagent"]))
  );
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

function cloneHookGroups(groups: HookMatcherGroup[]): HookMatcherGroup[] {
  return groups.map((group) => ({
    ...(group.matcher ? { matcher: group.matcher } : {}),
    hooks: [...group.hooks],
  }));
}

function ensureHookMatcherGroup(
  groups: HookMatcherGroup[],
  hasGroup: (group: HookMatcherGroup) => boolean,
  insert: HookMatcherGroup,
  position: "start" | "end" = "end",
): HookMatcherGroup[] {
  const updated = cloneHookGroups(groups);
  if (updated.some(hasGroup)) {
    return updated;
  }
  if (position === "start") {
    updated.unshift(insert);
  } else {
    updated.push(insert);
  }
  return updated;
}

function ensureHookEventGroup(groups: HookMatcherGroup[]): HookMatcherGroup[] {
  return ensureHookMatcherGroup(
    groups,
    (group) => group.hooks.some((hook) => hook.command === CODEX_HOOK_COMMAND),
    { hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }] },
  );
}

function ensureRestrictWritesPreToolUse(groups: HookMatcherGroup[]): HookMatcherGroup[] {
  return ensureHookMatcherGroup(
    groups,
    (group) =>
      group.matcher === CODEX_RESTRICT_WRITES_MATCHER &&
      group.hooks.some((hook) => hook.command === CODEX_RESTRICT_WRITES_DENY_COMMAND),
    {
      matcher: CODEX_RESTRICT_WRITES_MATCHER,
      hooks: [{ type: "command", command: CODEX_RESTRICT_WRITES_DENY_COMMAND }],
    },
    "start",
  );
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

export async function collectJsonlFiles(
  dir: string,
  depth = 0,
  requireComplete = false,
): Promise<string[]> {
  if (depth > MAX_SESSION_SCAN_DEPTH) {
    if (requireComplete) throw new Error("Incomplete rollout directory scan");
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (requireComplete) throw error;
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const filePath = join(dir, entry);
    if (requireComplete && (await lstat(filePath)).isSymbolicLink())
      throw new Error("Escaped rollout directory entry");
    if (entry.endsWith(".jsonl")) {
      files.push(filePath);
      continue;
    }
    try {
      if ((await lstat(filePath)).isDirectory()) {
        files.push(...(await collectJsonlFiles(filePath, depth + 1, requireComplete)));
      }
    } catch (error) {
      if (requireComplete) throw error;
      // Ignore inaccessible entries.
    }
  }
  return files;
}

function strictSessionMeta(line: unknown): { cwd: string; threadId: string } | null | undefined {
  if (!isRecord(line)) return null;
  if (line["type"] !== "session_meta") return undefined;
  const payload = line["payload"];
  if (payload !== undefined && !isRecord(payload)) return null;
  const ids = [line["threadId"], isRecord(payload) ? payload["id"] : undefined].filter(
    (value) => value !== undefined,
  );
  const cwds = [line["cwd"], isRecord(payload) ? payload["cwd"] : undefined].filter(
    (value) => value !== undefined,
  );
  const threadId = ids[0];
  const cwd = cwds[0];
  if (
    typeof threadId !== "string" ||
    !threadId.trim() ||
    typeof cwd !== "string" ||
    !cwd.trim() ||
    ids.some((value) => value !== threadId) ||
    cwds.some((value) => value !== cwd)
  )
    return null;
  if (
    line["thread_source"] === "subagent" ||
    (isRecord(payload) && payload["thread_source"] === "subagent")
  )
    return null;
  for (const source of [line["source"], isRecord(payload) ? payload["source"] : undefined]) {
    if (source === "subagent" || (isRecord(source) && source["subagent"] !== undefined))
      return null;
  }
  return { cwd, threadId };
}

async function* readRolloutLines(
  filePath: string,
  start: number,
  range?: { handle: FileHandle; end: number; hash?: Hash },
): AsyncGenerator<string> {
  if (range) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let position = start;
    let pending: Buffer = Buffer.alloc(0);
    while (position < range.end) {
      const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, range.end - position));
      const { bytesRead } = await range.handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) throw new Error("Incomplete original rollout read");
      range.hash?.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
      const combined = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let offset = 0;
      for (
        let newline = combined.indexOf(10);
        newline >= 0;
        newline = combined.indexOf(10, offset)
      ) {
        yield decoder.decode(combined.subarray(offset, newline));
        offset = newline + 1;
      }
      pending = combined.subarray(offset);
    }
    if (pending.length) throw new Error("Incomplete original rollout line");
    return;
  }
  const input = createReadStream(filePath, { encoding: "utf-8", start });
  let failure: Error | undefined;
  // Keep listeners through destroy: stream errors can arrive after iteration ends.
  input.on("error", (error: Error) => {
    failure = error;
    reader.close();
  });
  const reader = createInterface({ input, crlfDelay: Infinity });
  reader.on("error", (error: Error) => {
    failure = error;
    reader.close();
  });
  try {
    for await (const line of reader) {
      if (failure) throw failure;
      yield line;
    }
    if (failure) throw failure;
  } finally {
    reader.close();
    input.destroy();
  }
}

async function readSessionMeta(
  filePath: string,
  originalRange?: { handle: FileHandle; end: number },
): Promise<{ cwd: string; threadId: string | null; isSubagent: boolean } | null> {
  try {
    let linesRead = 0;
    let threadId: string | null = null;
    let originalCwd: string | null = null;
    for await (const line of readRolloutLines(filePath, 0, originalRange)) {
      if (!originalRange && linesRead >= 10) {
        break;
      }
      linesRead += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw: unknown = JSON.parse(trimmed);
        const parsed = raw as CodexSessionLine;
        if (originalRange) {
          const meta = strictSessionMeta(raw);
          if (meta === null) return null;
          if (meta === undefined) continue;
          if (
            (threadId !== null && threadId !== meta.threadId) ||
            (originalCwd !== null && originalCwd !== meta.cwd)
          )
            return null;
          threadId = meta.threadId;
          originalCwd = meta.cwd;
          continue;
        }
        if (isExplicitSubagentSessionMeta(parsed)) {
          continue;
        }
        const cwd = sessionMetaCwd(parsed);
        const resumeId = sessionResumeId(parsed);
        if (resumeId && !threadId) {
          threadId = resumeId;
        }
        if (cwd) {
          const source = parsed.payload?.source;
          const subagent = isRecord(source) ? source["subagent"] : undefined;
          const threadSpawn = isRecord(subagent) ? subagent["thread_spawn"] : undefined;
          return {
            cwd,
            threadId,
            isSubagent:
              isRecord(threadSpawn) && typeof threadSpawn["parent_thread_id"] === "string",
          };
        }
      } catch {
        if (originalRange) return null;
        // Ignore malformed lines and keep scanning the file header.
      }
    }
    if (originalRange && originalCwd && threadId)
      return { cwd: originalCwd, threadId, isSubagent: false };
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
    if (!meta || meta.isSubagent) {
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
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const sessionIndex = await loadSessionIndexForRoot(sessionRootDir);
    let bestMatch: IndexedSessionFile | null = null;
    for (const candidate of candidates) {
      const match = sessionIndex.get(candidate);
      if (match && (!bestMatch || match.mtimeMs > bestMatch.mtimeMs)) {
        bestMatch = match;
      }
    }
    if (!bestMatch) {
      continue;
    }
    return bestMatch.threadId ?? readThreadId(bestMatch.path);
  }
  return null;
}

interface LatestRolloutFile {
  filePath: string;
  mtimeMs: number;
}

// Walking the global sessions dir costs ~100 ms per call, so its newest file is
// cached process-wide; only that file's mtime is re-read per call.
let globalLatestRollout: { expiresAt: number; filePath: string | null } | null = null;
let globalRolloutWalk: Promise<LatestRolloutFile | null> | null = null;

async function newestRolloutFile(dir: string): Promise<LatestRolloutFile | null> {
  let bestMatch: LatestRolloutFile | null = null;
  const files = await collectJsonlFiles(dir).catch(() => []);
  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      if (!bestMatch || fileStat.mtimeMs > bestMatch.mtimeMs) {
        bestMatch = { filePath, mtimeMs: fileStat.mtimeMs };
      }
    } catch {
      // Ignore inaccessible files.
    }
  }
  return bestMatch;
}

// Concurrent callers on an expired cache share one walk.
function walkGlobalRolloutDir(): Promise<LatestRolloutFile | null> {
  globalRolloutWalk ??= (async () => {
    const expiresAt = Date.now() + SESSION_INDEX_TTL_MS;
    try {
      const best = await newestRolloutFile(CODEX_SESSIONS_DIR);
      globalLatestRollout = { expiresAt, filePath: best?.filePath ?? null };
      return best;
    } finally {
      globalRolloutWalk = null;
    }
  })();
  return globalRolloutWalk;
}

async function globalLatestRolloutFile(): Promise<LatestRolloutFile | null> {
  const cached = globalLatestRollout;
  if (!cached || cached.expiresAt <= Date.now()) return walkGlobalRolloutDir();
  if (!cached.filePath) return null;
  try {
    return { filePath: cached.filePath, mtimeMs: (await stat(cached.filePath)).mtimeMs };
  } catch {
    if (globalLatestRollout === cached) globalLatestRollout = null;
    return walkGlobalRolloutDir();
  }
}

export async function findLatestCodexSessionFile(options?: {
  sessionRootDir?: string;
  sessionRootDirs?: string[];
}): Promise<string | null> {
  let bestMatch: LatestRolloutFile | null = null;
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const candidate =
      sessionRootDir === CODEX_SESSIONS_DIR
        ? await globalLatestRolloutFile()
        : await newestRolloutFile(sessionRootDir);
    if (candidate && (!bestMatch || candidate.mtimeMs > bestMatch.mtimeMs)) {
      bestMatch = candidate;
    }
  }
  return bestMatch?.filePath ?? null;
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

function appendCodexReasoningEffort(
  command: string,
  reasoningEffort: ProviderReasoningEffort | undefined,
): string {
  return reasoningEffort
    ? `${command} -c ${shellEscape(`model_reasoning_effort="${reasoningEffort}"`)}`
    : command;
}

function appendCodexImages(command: string, imagePaths: string[] | undefined): string {
  if (!imagePaths || imagePaths.length === 0) {
    return command;
  }
  return `${command} ${imagePaths.map((path) => `--image ${shellEscape(path)}`).join(" ")}`;
}

function appendCodexModel(command: string, model: string | undefined): string {
  if (!model) {
    return command;
  }
  return `${command} --model ${shellEscape(model)}`;
}

function codexLaunchFlags(restrictWrites?: boolean): string {
  if (restrictWrites) {
    return "--enable hooks --sandbox read-only --ask-for-approval never --dangerously-bypass-hook-trust";
  }
  return "--enable hooks --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust";
}

export function buildCodexPlan(
  prompt: string,
  options?: {
    codexHomePath?: string;
    codexArgs?: string[];
    reasoningEffort?: ProviderReasoningEffort;
    startupImagePaths?: string[];
    restrictWrites?: boolean;
    model?: string;
  },
): AgentLaunchPlan {
  const command = withCodexHome(
    appendCodexImages(
      appendCodexModel(
        appendCodexReasoningEffort(
          appendCodexArgs(
            `${codexCommand()} ${codexLaunchFlags(options?.restrictWrites)}`,
            options?.codexArgs,
          ),
          options?.reasoningEffort,
        ),
        options?.model,
      ),
      options?.startupImagePaths,
    ),
    options?.codexHomePath,
  );
  if (options?.startupImagePaths?.length) {
    return {
      launchCommand: prompt.trim() ? `${command} -- ${shellEscape(prompt)}` : command,
      initialMessage: "",
      readyMarkers: ["OpenAI Codex", "›"],
    };
  }
  return {
    launchCommand: command,
    initialMessage: prompt,
    readyMarkers: ["OpenAI Codex", "›"],
  };
}

export function buildCodexResumePlan(
  threadId: string,
  binary = codexCommand(),
  options?: {
    codexHomePath?: string;
    codexArgs?: string[];
    reasoningEffort?: ProviderReasoningEffort;
    model?: string;
    restrictWrites?: boolean;
  },
): AgentResumePlan {
  return {
    launchCommand: withCodexHome(
      appendCodexModel(
        appendCodexReasoningEffort(
          appendCodexArgs(
            `${shellEscape(binary)} resume ${codexLaunchFlags(options?.restrictWrites)} ${shellEscape(threadId)}`,
            options?.codexArgs,
          ),
          options?.reasoningEffort,
        ),
        options?.model,
      ),
      options?.codexHomePath,
    ),
    readyMarkers: ["›"],
  };
}

export async function buildCodexRestorePlan(
  worktreePath: string,
  prompt: string,
  options?: {
    codexHomePath?: string;
    codexArgs?: string[];
    reasoningEffort?: ProviderReasoningEffort;
    restrictWrites?: boolean;
  },
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

// JSON.stringify yields a valid TOML basic-string for filesystem paths.
export function appendCodexTrustedProjects(
  configText: string,
  trustedProjects: readonly string[],
): string {
  if (trustedProjects.length === 0) {
    return configText;
  }
  let result = configText;
  for (const projectPath of trustedProjects) {
    const header = `[projects.${JSON.stringify(projectPath)}]`;
    if (result.includes(header)) {
      continue;
    }
    const trimmed = result.trimEnd();
    const separator = trimmed ? "\n\n" : "";
    result = `${trimmed}${separator}${header}\ntrust_level = "trusted"\n`;
  }
  return result;
}

// Remove an inherited [mcp_servers.<server>] table (header through the line
// before the next "[" table header or EOF). Parse-aware so adjacent tables stay
// intact. Only strips this exact table, never partial matches like
// [mcp_servers.<server>_x].
function stripCodexMcpTable(configText: string, server: string): string {
  const header = `[mcp_servers.${server}]`;
  const lines = configText.split("\n");
  const result: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (trimmed.startsWith("[")) {
        inTable = false;
      } else {
        continue;
      }
    }
    result.push(line);
  }
  return result.join("\n");
}

function withCodexMcpServer(configText: string, binding: SidecarMcpBinding): string {
  const stripped = stripCodexMcpTable(configText, binding.server);
  const trimmed = stripped.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  const table = `[mcp_servers.${binding.server}]\nurl = "${binding.url}"\n`;
  return `${trimmed}${separator}${table}`;
}

export async function buildEphemeralCodexConfig(
  trustedProjects: readonly string[],
  mcpBindings: readonly SidecarMcpBinding[] = [],
  mcpExclude: readonly string[] = [],
): Promise<string> {
  const userConfigPath = join(homedir(), ".codex", "config.toml");
  const baseConfig = await readFile(userConfigPath, "utf8").catch(() => "");
  const withTrust = appendCodexTrustedProjects(baseConfig, trustedProjects);
  // Exclude first so a project can suppress the host server and still receive
  // Spur's managed sidecar binding under the same name.
  const withExclusions = mcpExclude.reduce(
    (text, server) => stripCodexMcpTable(text, server),
    withTrust,
  );
  return mcpBindings.reduce((text, binding) => withCodexMcpServer(text, binding), withExclusions);
}

function withSuppressUnstableFeaturesWarning(configText: string): string {
  const keyPattern = /^\s*suppress_unstable_features_warning\s*=/;
  for (const line of configText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      break;
    }
    if (keyPattern.test(line)) {
      return configText;
    }
  }

  const line = "suppress_unstable_features_warning = true";
  const trimmed = configText.trimEnd();
  return trimmed ? `${line}\n\n${trimmed}\n` : `${line}\n`;
}

export async function linkCodexAuth(codexHome: string): Promise<void> {
  for (const filename of ["auth.json", ".credentials.json"]) {
    const source = join(homedir(), ".codex", filename);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(codexHome, filename);
    await rm(target, { force: true });
    await symlink(source, target);
  }
}

export async function copyCodexAgentDefinitions(codexHome: string): Promise<void> {
  const userAgentsDir = join(homedir(), ".codex", "agents");
  if (!existsSync(userAgentsDir)) return;
  await cp(userAgentsDir, join(codexHome, "agents"), { recursive: true, force: true });
}

export async function ensureCodexHooksConfig(
  sessionToolDir: string,
  trustedProjects: readonly string[] = [],
  options?: {
    restrictWrites?: boolean;
    mcpBindings?: SidecarMcpBinding[];
    mcpExclude?: string[];
    modelsCacheHome?: string;
  },
): Promise<string> {
  const codexDir = codexHookHomePath(sessionToolDir);
  const hooksPath = join(codexDir, CODEX_HOOKS_FILE);
  await mkdir(codexDir, { recursive: true });
  const existingContent = await readFile(hooksPath, "utf8").catch(() => "");
  const next = parseCodexHooksDocument(existingContent);
  if (options?.restrictWrites) {
    next.hooks.PreToolUse = ensureRestrictWritesPreToolUse(next.hooks.PreToolUse);
  }
  const sessionConfigPath = join(codexDir, "config.toml");
  const baseConfig = await buildEphemeralCodexConfig(
    trustedProjects,
    options?.mcpBindings ?? [],
    options?.mcpExclude ?? [],
  );
  const finalConfig = withSuppressUnstableFeaturesWarning(baseConfig);
  await writeFile(sessionConfigPath, finalConfig, "utf8");
  await linkCodexAuth(codexDir);
  if (options?.modelsCacheHome) {
    await cp(
      join(options.modelsCacheHome, "models_cache.json"),
      join(codexDir, "models_cache.json"),
      {
        force: true,
      },
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  }
  await copyCodexAgentDefinitions(codexDir);
  await writeFile(hooksPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return codexDir;
}

export type RolloutBaseline = Map<string, number>;

export async function captureCodexRolloutBaseline(sessionsDir: string): Promise<RolloutBaseline> {
  const baseline: RolloutBaseline = new Map();
  let files: string[];
  try {
    files = await collectJsonlFiles(sessionsDir);
  } catch {
    return baseline;
  }
  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath);
      baseline.set(filePath, fileStat.size);
    } catch {
      // Ignore inaccessible files.
    }
  }
  return baseline;
}

interface RolloutResponseItemPayload {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface RolloutEventMsgPayload {
  type?: string;
  message?: string;
  turn_id?: string;
  turnId?: string;
}

interface CodexSubmitAckScope {
  nativeSessionId: string;
  worktreePath: string;
}

function extractUserTextFromLine(line: string, strict?: CodexSubmitAckScope): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
  if (!isRecord(parsed)) {
    if (strict) throw new Error("Malformed original rollout record");
    return null;
  }
  return extractUserText(parsed, strict);
}

function extractUserText(
  parsed: Record<string, unknown>,
  strict?: CodexSubmitAckScope,
): string | null {
  if (strict) {
    const meta = strictSessionMeta(parsed);
    if (
      meta === null ||
      (meta !== undefined &&
        (meta.threadId !== strict.nativeSessionId || meta.cwd !== strict.worktreePath))
    )
      throw new Error("Conflicting original rollout metadata");
  }
  const type = parsed["type"];
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return null;
  }

  if (type === "response_item") {
    const p = payload as unknown as RolloutResponseItemPayload;
    if (strict && p.type === "message" && p.role === "user" && !Array.isArray(p.content))
      throw new Error("Malformed original rollout user content");
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      if (
        strict &&
        p.content.some((c) => isRecord(c) && c.type === "input_text" && typeof c.text !== "string")
      )
        throw new Error("Malformed original rollout user text");
      const texts = p.content
        .filter(
          (c): c is { type: string; text: string } =>
            isRecord(c) && c.type === "input_text" && typeof c.text === "string",
        )
        .map((c) => c.text);
      return texts.length > 0 ? texts.join("") : null;
    }
  }

  if (type === "event_msg") {
    const p = payload as unknown as RolloutEventMsgPayload;
    if (strict && p.type === "user_message" && typeof p.message !== "string")
      throw new Error("Malformed original rollout user message");
    if (p.type === "user_message" && typeof p.message === "string") {
      return p.message;
    }
  }

  return null;
}

function extractAssistantText(parsed: Record<string, unknown>): string | null {
  const type = parsed["type"];
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return null;
  }

  if (type === "response_item") {
    const p = payload as unknown as RolloutResponseItemPayload;
    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      const texts = p.content
        .filter(
          (c): c is { type: string; text: string } =>
            isRecord(c) && c.type === "output_text" && typeof c.text === "string",
        )
        .map((c) => c.text);
      return texts.length > 0 ? texts.join("") : null;
    }
  }

  return null;
}

export async function scanCodexRolloutForMessage(
  sessionsDir: string,
  messageText: string,
  baseline: RolloutBaseline,
  strict?: CodexSubmitAckScope,
): Promise<{ found: boolean; lastScannedFile: string | null; qualifiedNoMatch?: true }> {
  let files: string[];
  try {
    files = await collectJsonlFiles(sessionsDir);
  } catch {
    return { found: false, lastScannedFile: null };
  }
  let lastScannedFile: string | null = null;
  let qualifiedNoMatch = false;
  const trimmedTarget = messageText.trim();
  for (const filePath of files) {
    lastScannedFile = filePath;
    const offset = baseline.get(filePath) ?? 0;
    let original: FileHandle | undefined;
    try {
      if (
        strict &&
        (!strict.nativeSessionId ||
          !baseline.has(filePath) ||
          !Number.isSafeInteger(offset) ||
          offset <= 0 ||
          (await realpath(sessionsDir)) !== resolve(sessionsDir) ||
          (await realpath(filePath)) !== resolve(filePath))
      )
        continue;
      original = strict
        ? await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        : undefined;
      const observed = original ? await original.stat() : undefined;
      if (observed && (!observed.isFile() || observed.size < offset)) continue;
      if (strict && original && observed) {
        const boundary = Buffer.alloc(1);
        await original.read(boundary, 0, 1, offset - 1);
        if (boundary[0] !== 10) continue;
        const ending = Buffer.alloc(1);
        await original.read(ending, 0, 1, observed.size - 1);
        if (ending[0] !== 10) continue;
        const meta = await readSessionMeta(filePath, { handle: original, end: offset });
        if (
          !meta ||
          meta.threadId !== strict.nativeSessionId ||
          meta.isSubagent ||
          meta.cwd !== strict.worktreePath
        )
          continue;
      }
      let found = false;
      if (!observed || observed.size > offset) {
        for await (const rawLine of readRolloutLines(
          filePath,
          offset,
          original && observed ? { handle: original, end: observed.size } : undefined,
        )) {
          const trimmedLine = rawLine.trim();
          if (!trimmedLine) continue;
          const extracted = extractUserTextFromLine(trimmedLine, strict);
          if (
            extracted !== null &&
            (strict ? extracted === messageText : extracted.trim() === trimmedTarget)
          ) {
            found = true;
            if (!strict) break;
          }
        }
      }
      if (strict && !found && baseline.size === 1 && files.length === 1) {
        const currentFiles = await collectJsonlFiles(sessionsDir, 0, true);
        if (currentFiles.length !== 1 || !currentFiles.every((file) => baseline.has(file)))
          continue;
      }
      if (original && observed) {
        const current = await lstat(filePath);
        const held = await original.stat();
        if (
          [current, held].some(
            (entry) =>
              entry.dev !== observed.dev ||
              entry.ino !== observed.ino ||
              entry.size !== observed.size ||
              entry.mtimeMs !== observed.mtimeMs ||
              entry.ctimeMs !== observed.ctimeMs,
          )
        )
          continue;
      }
      if (strict && baseline.size === 1 && files.length === 1) qualifiedNoMatch = true;
      if (found) return { found: true, lastScannedFile: filePath };
    } catch {
      // Ignore unreadable files.
    } finally {
      await original?.close().catch(() => {
        // Already closed or inaccessible.
      });
    }
  }
  return {
    found: false,
    lastScannedFile,
    ...(qualifiedNoMatch ? { qualifiedNoMatch: true as const } : {}),
  };
}

export interface CodexRolloutStateRecord {
  state: "working" | "waiting" | "needs_input";
  timestamp: string;
  timestampMs: number;
  filePath: string;
  reason:
    | "task_started"
    | "function_call"
    | "custom_tool_call"
    | "task_complete"
    | "turn_aborted"
    | "thread_settings_applied"
    | "input_required"
    | "request_user_input";
  turnId?: string;
  callId?: string;
  precedingState?: { state: "working" | "waiting" | "needs_input"; timestampMs: number };
}

export interface CodexRolloutReadResult {
  rollout: CodexRolloutStateRecord | null;
  rateLimit: RateLimitDetection | null;
  threadId?: string;
  isSubagent?: boolean;
  model?: string;
  tokenUsage?: ProviderTokenUsageSample;
  tokenUsages?: ProviderTokenUsageSample[];
  launchProof?: CodexLaunchProof;
}

export interface CodexLaunchProofContext {
  sinceMs: number;
  nowMs: number;
}

export type CodexLaunchProof =
  | { kind: "unknown" }
  | {
      kind: "primary";
      complete: true;
      threadId: string;
      turnId: string;
      timestampMs: number;
      frame: string;
    };

interface CodexRolloutCandidate {
  result: CodexRolloutReadResult;
  mtimeMs: number;
}

interface CodexRolloutFileFingerprint {
  ino: number;
  mtimeMs: number;
  size: number;
  dev?: number;
}

type CodexRolloutStateLine = Omit<CodexRolloutStateRecord, "filePath">;

// Everything a result needs, folded line by line in file order. A fold held by
// a reader entry is never mutated: an append clones it first.
interface CodexRolloutFold {
  meta?: { generationId: string; threadId: string; isSubagent: boolean; replayBeforeMs?: number };
  currentTurn?: { id: string; timestampMs: number };
  // Every output call_id in the file, never pruned: a later call may reuse one.
  matchedCallIds: Set<string>;
  // State records since the newest anchor (non-TSA, no callId). Nothing older
  // can reach the result, so the tail stays one turn long.
  stateTail: CodexRolloutStateLine[];
  rateLimit: RateLimitDetection | null;
  origin: {
    kind: "primary" | "child" | "unknown";
    declaration?: string;
    threadId?: string;
    latestMs: number;
    timingKnown: boolean;
  };
  model?: string;
  token: {
    previous?: CodexTokenUsageSnapshot;
    accumulated?: CodexTokenUsageSnapshot;
    observedAtMs?: number;
    overflowed: boolean;
  };
}

interface CodexJsonlCursor<F> extends CodexRolloutFileFingerprint {
  // Bytes folded so far; can trail `size` when the file ends mid-line.
  offset: number;
  prefixHash: string;
  // Hash of the PREFIX_VERIFY_BYTES before `offset`, to detect an in-place rewrite.
  tailHash: string;
  tail: Buffer;
  fold: F;
}

interface CodexRolloutFileEntry extends CodexJsonlCursor<CodexRolloutFold> {
  candidate: CodexRolloutCandidate | null;
}

export interface CodexRolloutReaderState {
  files: Map<string, CodexRolloutFileEntry>;
}

// Rollouts reach 100+ MB and every session's reader is cold at daemon boot.
export const CODEX_ROLLOUT_READ_MAX_CONCURRENCY = 4;
const codexRolloutReadGate = createConcurrencyGate(CODEX_ROLLOUT_READ_MAX_CONCURRENCY);
const codexRolloutReaderQueues = new WeakMap<CodexRolloutReaderState, Promise<void>>();

function readRolloutString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readAgreeingCodexTurnIds(values: unknown[]): string | undefined {
  const first = values[0];
  return typeof first === "string" && first.trim() && values.every((value) => value === first)
    ? first
    : undefined;
}

function codexRolloutStateRecord(
  state: CodexRolloutStateRecord["state"],
  timestamp: string,
  timestampMs: number,
  reason: CodexRolloutStateRecord["reason"],
  turnId?: string,
  callId?: string,
): Omit<CodexRolloutStateRecord, "filePath"> {
  return {
    state,
    timestamp,
    timestampMs,
    reason,
    ...(turnId ? { turnId } : {}),
    ...(callId ? { callId } : {}),
  };
}

function extractCodexTurnContextModel(parsed: Record<string, unknown>): string | undefined {
  if (parsed["type"] !== "turn_context") {
    return undefined;
  }
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return undefined;
  }
  return readRolloutString(payload["model"]);
}

function extractCodexRolloutStateLine(
  parsed: Record<string, unknown>,
): Omit<CodexRolloutStateRecord, "filePath"> | null {
  const timestamp = typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : null;
  if (!timestamp) {
    return null;
  }
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const type = parsed["type"];
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return null;
  }

  if (type === "event_msg") {
    const payloadType = payload["type"];
    if (payloadType === "task_started") {
      const turnId = readRolloutString(payload["turn_id"]) ?? readRolloutString(payload["turnId"]);
      return codexRolloutStateRecord("working", timestamp, timestampMs, "task_started", turnId);
    }
    if (payloadType === "task_complete") {
      const turnId = readRolloutString(payload["turn_id"]) ?? readRolloutString(payload["turnId"]);
      return codexRolloutStateRecord("waiting", timestamp, timestampMs, "task_complete", turnId);
    }
    if (payloadType === "turn_aborted" && payload["reason"] === "interrupted") {
      const turnId = readRolloutString(payload["turn_id"]) ?? readRolloutString(payload["turnId"]);
      return codexRolloutStateRecord("waiting", timestamp, timestampMs, "turn_aborted", turnId);
    }
    // This event also occurs inside active turns. The caller may treat it as
    // resume-ready only when it crosses the recorded restore generation.
    if (payloadType === "thread_settings_applied") {
      return codexRolloutStateRecord("working", timestamp, timestampMs, "thread_settings_applied");
    }
    if (payloadType === "input_required") {
      const turnId = readRolloutString(payload["turn_id"]) ?? readRolloutString(payload["turnId"]);
      return codexRolloutStateRecord(
        "needs_input",
        timestamp,
        timestampMs,
        "input_required",
        turnId,
      );
    }
  }

  const payloadType = payload["type"];
  const payloadName = payload["name"];
  if (
    type === "response_item" &&
    (payloadType === "function_call" || payloadType === "custom_tool_call") &&
    payloadName === "request_user_input"
  ) {
    const turnId = readRolloutString(parsed["turn_id"]) ?? readRolloutString(payload["turn_id"]);
    return codexRolloutStateRecord(
      "needs_input",
      timestamp,
      timestampMs,
      "request_user_input",
      turnId,
    );
  }
  if (
    type === "response_item" &&
    (payloadType === "function_call" || payloadType === "custom_tool_call")
  ) {
    const turnId = readRolloutString(parsed["turn_id"]) ?? readRolloutString(payload["turn_id"]);
    const callId = readRolloutString(payload["call_id"]);
    return codexRolloutStateRecord("working", timestamp, timestampMs, payloadType, turnId, callId);
  }

  return null;
}

function updateCodexRolloutState(
  current: CodexRolloutStateRecord | null,
  state: Omit<CodexRolloutStateRecord, "filePath"> | null,
  filePath: string,
): CodexRolloutStateRecord | null {
  if (!state) return current;
  if (!current) return { ...state, filePath };
  if (
    current.reason !== "thread_settings_applied" ||
    current.precedingState ||
    state.reason === "thread_settings_applied"
  )
    return current;
  return {
    ...current,
    state: state.state,
    precedingState: { state: state.state, timestampMs: state.timestampMs },
  };
}

function readMatchedToolCallId(parsed: Record<string, unknown>): string | undefined {
  if (parsed["type"] !== "response_item") return undefined;
  const payload = parsed["payload"];
  if (!isRecord(payload)) return undefined;
  const payloadType = payload["type"];
  if (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output") {
    return undefined;
  }
  return readRolloutString(payload["call_id"]);
}

function extractCodexRateLimitsLine(parsed: Record<string, unknown>): unknown {
  if (parsed["type"] !== "event_msg") {
    return null;
  }
  const payload = parsed["payload"];
  if (!isRecord(payload) || payload["type"] !== "token_count") {
    return null;
  }
  return payload["rate_limits"];
}

interface CodexTokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}

interface CodexTokenUsageEvent {
  total: CodexTokenUsageSnapshot;
  last?: CodexTokenUsageSnapshot;
  observedAtMs: number;
}

function extractCodexTokenUsageLine(
  parsed: Record<string, unknown>,
): CodexTokenUsageEvent | undefined {
  if (parsed["type"] !== "event_msg") return undefined;
  const payload = parsed["payload"];
  if (!isRecord(payload) || payload["type"] !== "token_count") return undefined;
  const info = payload["info"];
  if (!isRecord(info)) return undefined;
  const timestamp = parsed["timestamp"];
  const observedAtMs = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const total = readCodexTokenUsageSnapshot(info["total_token_usage"]);
  if (!total || !Number.isFinite(observedAtMs)) return undefined;
  const last = readCodexTokenUsageSnapshot(info["last_token_usage"]);
  return { total, ...(last ? { last } : {}), observedAtMs };
}

function readCodexTokenUsageSnapshot(value: unknown): CodexTokenUsageSnapshot | null {
  if (!isRecord(value)) return null;
  const inputTokens = readTokenUsageNumber(value, ["input_tokens", "prompt_tokens"]);
  const outputTokens = readTokenUsageNumber(value, ["output_tokens", "completion_tokens"]);
  const totalTokens = readTokenUsageNumber(value, ["total_tokens"]);
  const cacheReadInputTokens = readTokenUsageNumber(value, [
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cached_tokens",
  ]);
  const cacheWriteInputTokens = readTokenUsageNumber(value, [
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
  ]);
  const reasoningOutputTokens = readTokenUsageNumber(value, [
    "reasoning_output_tokens",
    "reasoning_tokens",
  ]);
  if (
    inputTokens === null ||
    inputTokens === undefined ||
    outputTokens === null ||
    outputTokens === undefined ||
    totalTokens === null ||
    totalTokens === undefined ||
    cacheReadInputTokens === null ||
    cacheWriteInputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens !== inputTokens + outputTokens ||
    (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens ||
    (reasoningOutputTokens !== undefined && reasoningOutputTokens > outputTokens)
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

function readTokenUsageNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null | undefined {
  let result: number | undefined;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    if (result !== undefined && result !== value) {
      return null;
    }
    result = value;
  }
  return result;
}

const CODEX_OPTIONAL_USAGE_COMPONENTS = [
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "reasoningOutputTokens",
] as const;

function codexUsageReset(
  current: CodexTokenUsageSnapshot,
  previous: CodexTokenUsageSnapshot,
): boolean {
  if (
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.totalTokens < previous.totalTokens
  ) {
    return true;
  }
  return CODEX_OPTIONAL_USAGE_COMPONENTS.some(
    (component) =>
      current[component] !== undefined &&
      previous[component] !== undefined &&
      current[component] < previous[component],
  );
}

function subtractCodexUsage(
  current: CodexTokenUsageSnapshot,
  previous?: CodexTokenUsageSnapshot,
): CodexTokenUsageSnapshot {
  return {
    inputTokens: current.inputTokens - (previous?.inputTokens ?? 0),
    outputTokens: current.outputTokens - (previous?.outputTokens ?? 0),
    totalTokens: current.totalTokens - (previous?.totalTokens ?? 0),
    ...Object.fromEntries(
      CODEX_OPTIONAL_USAGE_COMPONENTS.flatMap((component) => {
        const value = current[component];
        const prior = previous?.[component];
        return value !== undefined && (previous === undefined || prior !== undefined)
          ? [[component, value - (prior ?? 0)]]
          : [];
      }),
    ),
  };
}

function addCodexUsage(
  accumulated: CodexTokenUsageSnapshot | undefined,
  delta: CodexTokenUsageSnapshot,
): CodexTokenUsageSnapshot | undefined {
  const inputTokens = (accumulated?.inputTokens ?? 0) + delta.inputTokens;
  const outputTokens = (accumulated?.outputTokens ?? 0) + delta.outputTokens;
  const totalTokens = (accumulated?.totalTokens ?? 0) + delta.totalTokens;
  if (![inputTokens, outputTokens, totalTokens].every(Number.isSafeInteger)) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...Object.fromEntries(
      CODEX_OPTIONAL_USAGE_COMPONENTS.flatMap((component) => {
        if (
          delta[component] === undefined ||
          (accumulated && accumulated[component] === undefined)
        ) {
          return [];
        }
        const value = (accumulated?.[component] ?? 0) + delta[component];
        return Number.isSafeInteger(value) ? [[component, value]] : [];
      }),
    ),
  };
}

function foldCodexTokenUsage(fold: CodexRolloutFold, parsed: Record<string, unknown>): void {
  const token = fold.token;
  if (token.overflowed) return;
  const event = extractCodexTokenUsageLine(parsed);
  if (!event) return;
  const reset = token.previous !== undefined && codexUsageReset(event.total, token.previous);
  const delta = reset ? event.last : subtractCodexUsage(event.total, token.previous);
  token.previous = event.total;
  if (event.observedAtMs < (fold.meta?.replayBeforeMs ?? -Infinity) || !delta) return;
  const accumulated = addCodexUsage(token.accumulated, delta);
  if (!accumulated) {
    token.overflowed = true;
    return;
  }
  token.accumulated = accumulated;
  token.observedAtMs = event.observedAtMs;
}

function newCodexRolloutFold(): CodexRolloutFold {
  return {
    matchedCallIds: new Set(),
    stateTail: [],
    rateLimit: null,
    origin: { kind: "unknown", latestMs: -Infinity, timingKnown: true },
    token: { overflowed: false },
  };
}

function cloneCodexRolloutFold(fold: CodexRolloutFold): CodexRolloutFold {
  return {
    ...fold,
    matchedCallIds: new Set(fold.matchedCallIds),
    stateTail: fold.stateTail.slice(),
    token: { ...fold.token },
    origin: { ...fold.origin },
  };
}

function foldCodexSessionMeta(fold: CodexRolloutFold, parsed: Record<string, unknown>): void {
  if (parsed["type"] !== "session_meta") return;
  const payload = parsed["payload"];
  const declarations = isRecord(payload) ? [parsed, payload] : [parsed];
  const ids = declarations.flatMap((data) =>
    [data["id"], data["threadId"], data["thread_id"]].filter((value) => value !== undefined),
  );
  const sources = declarations.flatMap((data) =>
    data["source"] === undefined ? [] : [data["source"]],
  );
  const threads = declarations.flatMap((data) =>
    data["thread_source"] === undefined ? [] : [data["thread_source"]],
  );
  const parents = declarations.flatMap((data) =>
    Object.entries(data)
      .filter(
        ([key, value]) =>
          /^(?:parent(?:$|_|[A-Z])|fork(?:ed)?(?:$|_|[A-Z]))/.test(key) && value !== null,
      )
      .map(([key, value]) => [key, value]),
  );
  const sourceKinds = sources.map((source) =>
    source === "cli"
      ? "cli"
      : source === "subagent" || (isRecord(source) && source["subagent"] !== undefined)
        ? "child"
        : "unknown",
  );
  const threadKinds = threads.map((source) =>
    source === "user" ? "user" : source === "subagent" ? "child" : "unknown",
  );
  const threadId = ids[0];
  let kind: CodexRolloutFold["origin"]["kind"] = "unknown";
  if (
    typeof threadId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(threadId) &&
    ids.every((id) => id === threadId) &&
    (payload === undefined || isRecord(payload)) &&
    parents.every(([, value]) => typeof value === "string" && value.trim().length > 0) &&
    !sourceKinds.includes("unknown") &&
    !threadKinds.includes("unknown") &&
    !(sourceKinds.includes("cli") && sourceKinds.includes("child")) &&
    !(threadKinds.includes("user") && threadKinds.includes("child"))
  ) {
    if (sourceKinds.includes("child") || threadKinds.includes("child") || parents.length > 0)
      kind = "child";
    else if (sourceKinds.length > 0 && threadKinds.length > 0) kind = "primary";
  }
  const declaration = JSON.stringify({ threadId, sources, threads, parents });
  const origin = fold.origin;
  if (origin.declaration === undefined) {
    origin.kind = kind;
    origin.declaration = declaration;
    if (typeof threadId === "string") origin.threadId = threadId;
  } else if (origin.declaration !== declaration || kind === "unknown") origin.kind = "unknown";
  if (fold.meta) return;
  if (!isRecord(payload) || typeof payload["id"] !== "string" || !payload["id"]) return;
  const source = payload["source"];
  const subagent = isRecord(source) ? source["subagent"] : undefined;
  const threadSpawn = isRecord(subagent) ? subagent["thread_spawn"] : undefined;
  const isSubagent = isRecord(threadSpawn) && typeof threadSpawn["parent_thread_id"] === "string";
  const timestamp =
    typeof payload["timestamp"] === "string" ? payload["timestamp"] : parsed["timestamp"];
  const timestampMs = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  fold.meta = {
    generationId: `codex:${payload["id"]}`,
    threadId: payload["id"],
    isSubagent,
    ...(isSubagent && Number.isFinite(timestampMs) ? { replayBeforeMs: timestampMs } : {}),
  };
}

function foldCodexRolloutLine(fold: CodexRolloutFold, parsed: Record<string, unknown>): void {
  foldCodexSessionMeta(fold, parsed);
  const payload = parsed["payload"];
  const payloadType = isRecord(payload) ? payload["type"] : undefined;
  if (
    parsed["type"] === "session_meta" ||
    (parsed["type"] === "event_msg" &&
      (payloadType === "task_started" ||
        payloadType === "task_complete" ||
        payloadType === "turn_aborted"))
  ) {
    delete fold.currentTurn;
  }
  if (parsed["type"] === "turn_context") {
    delete fold.currentTurn;
    if (isRecord(payload)) {
      const id = readAgreeingCodexTurnIds(
        ["turn_id", "id"].filter((key) => Object.hasOwn(payload, key)).map((key) => payload[key]),
      );
      const timestampMs =
        typeof parsed["timestamp"] === "string" ? Date.parse(parsed["timestamp"]) : NaN;
      if (id !== undefined && Number.isFinite(timestampMs)) fold.currentTurn = { id, timestampMs };
    }
  }
  const timestamps = [
    parsed["timestamp"],
    isRecord(parsed["payload"]) ? parsed["payload"]["timestamp"] : undefined,
  ].filter((value) => value !== undefined);
  if (
    timestamps.length === 0 ||
    timestamps.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)))
  ) {
    fold.origin.timingKnown = false;
  } else {
    for (const timestamp of timestamps) {
      if (typeof timestamp === "string")
        fold.origin.latestMs = Math.max(fold.origin.latestMs, Date.parse(timestamp));
    }
  }
  const matchedCallId = readMatchedToolCallId(parsed);
  if (matchedCallId) fold.matchedCallIds.add(matchedCallId);
  let state = extractCodexRolloutStateLine(parsed);
  if (
    state &&
    isRecord(payload) &&
    (state.reason === "function_call" ||
      state.reason === "custom_tool_call" ||
      state.reason === "request_user_input")
  ) {
    const explicit = [parsed, payload]
      .filter((value) => Object.hasOwn(value, "turn_id"))
      .map((value) => value["turn_id"]);
    let turnId: string | undefined;
    if (explicit.length > 0) {
      const id = readAgreeingCodexTurnIds(explicit);
      if (id !== undefined && (!fold.currentTurn || fold.currentTurn.id === id)) turnId = id;
      else delete fold.currentTurn;
    } else if (fold.currentTurn && fold.currentTurn.timestampMs <= state.timestampMs) {
      turnId = fold.currentTurn.id;
    }
    const { turnId: _previousTurn, ...rest } = state;
    state = { ...rest, ...(turnId !== undefined ? { turnId } : {}) };
  }
  if (state) {
    if (state.reason !== "thread_settings_applied" && !state.callId) fold.stateTail = [state];
    else fold.stateTail.push(state);
  }
  const detection = detectCodexRateLimit(extractCodexRateLimitsLine(parsed));
  if (detection) fold.rateLimit = detection;
  const model = extractCodexTurnContextModel(parsed);
  if (model !== undefined) fold.model = model;
  foldCodexTokenUsage(fold, parsed);
}

function finalizeCodexRolloutFold(
  fold: CodexRolloutFold,
  filePath: string,
): CodexRolloutReadResult {
  let rollout: CodexRolloutStateRecord | null = null;
  for (let index = fold.stateTail.length - 1; index >= 0; index -= 1) {
    const state = fold.stateTail[index];
    if (!state || (state.callId && fold.matchedCallIds.has(state.callId))) continue;
    rollout = updateCodexRolloutState(rollout, state, filePath);
  }
  const { meta, token } = fold;
  const tokenUsage: ProviderTokenUsageSample | undefined =
    meta && !token.overflowed && token.accumulated && token.observedAtMs !== undefined
      ? {
          provider: "codex",
          generationId: meta.generationId,
          ...token.accumulated,
          observedAtMs: token.observedAtMs,
        }
      : undefined;
  return {
    rollout,
    rateLimit: fold.rateLimit,
    ...(meta ? { threadId: meta.threadId } : {}),
    ...(meta?.isSubagent ? { isSubagent: true } : {}),
    ...(fold.model ? { model: fold.model } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

// Verify raw history without parsing it again; include the old tail in this pass.
async function readCodexRolloutPrefix(
  filePath: string,
  endOffset: number,
): Promise<{ hash: Hash; tailHash: string } | null> {
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const hash = createHash("sha256");
    let tail: Buffer = Buffer.alloc(0);
    if (endOffset > 0) {
      fd = await open(filePath, "r");
      let position = 0;
      while (position < endOffset) {
        const length = Math.min(SCAN_CHUNK_BYTES, endOffset - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fd.read(buffer, 0, length, position);
        if (bytesRead === 0) return null;
        const bytes = buffer.subarray(0, bytesRead);
        hash.update(bytes);
        tail = Buffer.from(
          Buffer.concat([tail, bytes.subarray(-PREFIX_VERIFY_BYTES)]).subarray(
            -PREFIX_VERIFY_BYTES,
          ),
        );
        position += bytesRead;
      }
    }
    return { hash, tailHash: hashHistoryTail(tail) };
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}

interface CodexLineFolder<F> {
  start: () => F;
  // Copy of a cached fold to append to; the cached one is never mutated.
  resume: (fold: F) => F;
  line: (fold: F, parsed: Record<string, unknown>) => void;
}

// One gate slot covers prefix verification and the scan, so concurrent opens
// never exceed CODEX_ROLLOUT_READ_MAX_CONCURRENCY. Resumes from `cached` only
// when the verified prefix is unchanged, else folds the whole file. Null: read
// failed. `cursor` is null without a fingerprint.
async function foldCodexJsonlFile<F>(
  filePath: string,
  fingerprint: CodexRolloutFileFingerprint | null,
  cached: CodexJsonlCursor<F> | undefined,
  folder: CodexLineFolder<F>,
  strict = false,
): Promise<{
  fold: F;
  cursor: CodexJsonlCursor<F> | null;
  complete: boolean;
  frame?: string;
} | null> {
  return codexRolloutReadGate.run(async () => {
    let fold = folder.start();
    let offset = 0;
    let previousTail: Buffer = Buffer.alloc(0);
    let prefixHasher = createHash("sha256");
    let valid = true;
    const consume = (line: string): boolean => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        valid = false;
        return false;
      }
      if (!isRecord(parsed)) valid = false;
      if (
        strict &&
        isRecord(parsed) &&
        !["session_meta", "event_msg", "response_item", "turn_context"].includes(
          String(parsed["type"]),
        )
      )
        valid = false;
      if (
        strict &&
        isRecord(parsed) &&
        (parsed["type"] !== "session_meta" || parsed["payload"] !== undefined) &&
        !isRecord(parsed["payload"])
      )
        valid = false;
      if (isRecord(parsed)) folder.line(fold, parsed);
      return true;
    };
    if (strict) {
      if (!fingerprint) return null;
      let handle: FileHandle | undefined;
      let result: { fold: F; cursor: null; complete: boolean; frame: string } | null;
      try {
        handle = await open(
          filePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.ino !== fingerprint.ino ||
          before.dev !== fingerprint.dev ||
          before.size !== fingerprint.size ||
          before.mtimeMs !== fingerprint.mtimeMs
        )
          return null;
        for await (const line of readRolloutLines(filePath, 0, {
          handle,
          end: before.size,
          hash: prefixHasher,
        })) {
          if (line.trim()) consume(line);
        }
        const after = await handle.stat();
        if (
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        )
          return null;
        result = { fold, cursor: null, complete: valid, frame: prefixHasher.digest("hex") };
      } catch {
        result = null;
      } finally {
        try {
          await handle?.close();
        } catch {
          result = null;
        }
      }
      return result;
    }
    if (
      fingerprint &&
      cached &&
      cached.ino === fingerprint.ino &&
      fingerprint.size > cached.size &&
      fingerprint.size >= cached.offset
    ) {
      const verified = await readCodexRolloutPrefix(filePath, cached.offset);
      if (
        verified &&
        verified.tailHash === cached.tailHash &&
        verified.hash.copy().digest("hex") === cached.prefixHash
      ) {
        fold = folder.resume(cached.fold);
        offset = cached.offset;
        previousTail = cached.tail;
        prefixHasher = verified.hash;
      }
    }
    const scan = await scanJsonlLines(filePath, offset, consume, fingerprint?.size, (bytes) =>
      prefixHasher.update(bytes),
    );
    if (!scan) return null;
    if (!fingerprint) return { fold, cursor: null, complete: false };
    const tail = Buffer.from(
      Buffer.concat([previousTail, scan.tail]).subarray(-PREFIX_VERIFY_BYTES),
    );
    return {
      fold,
      complete: false,
      cursor: {
        ...fingerprint,
        offset: offset + scan.consumedBytes,
        prefixHash: prefixHasher.digest("hex"),
        tailHash: hashHistoryTail(tail),
        tail,
        fold,
      },
    };
  });
}

// Null: read failed, entry dropped.
async function readCodexRolloutFile(
  filePath: string,
  fingerprint: CodexRolloutFileFingerprint | null,
  cached: CodexRolloutFileEntry | undefined,
  strict = false,
): Promise<{
  candidate: CodexRolloutCandidate | null;
  entry?: CodexRolloutFileEntry;
  fold: CodexRolloutFold;
  complete: boolean;
  frame?: string;
} | null> {
  const read = await foldCodexJsonlFile(
    filePath,
    fingerprint,
    strict ? undefined : cached,
    {
      start: newCodexRolloutFold,
      resume: cloneCodexRolloutFold,
      line: foldCodexRolloutLine,
    },
    strict,
  );
  if (!read) return null;
  const result = finalizeCodexRolloutFold(read.fold, filePath);
  const candidate =
    !result.rollout && !result.rateLimit && !result.model && !result.tokenUsage
      ? null
      : { result, mtimeMs: fingerprint?.mtimeMs ?? 0 };
  return {
    candidate,
    fold: read.fold,
    complete: read.complete,
    ...(read.frame ? { frame: read.frame } : {}),
    ...(read.cursor ? { entry: { ...read.cursor, candidate } } : {}),
  };
}

export async function readCodexRolloutState(
  sessionsDir: string,
  reader?: CodexRolloutReaderState,
  rootThreadId?: string,
  proof?: CodexLaunchProofContext,
): Promise<CodexRolloutReadResult> {
  if (!reader) return readCodexRolloutStateSnapshot(sessionsDir, reader, rootThreadId, proof);
  // Serialize collection, stat, and cache publication together. Queued callers
  // see both the preceding scan's cache and any append made while it ran.
  const previous = codexRolloutReaderQueues.get(reader);
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  codexRolloutReaderQueues.set(reader, completed);
  await previous;
  try {
    return await readCodexRolloutStateSnapshot(sessionsDir, reader, rootThreadId, proof);
  } finally {
    complete();
    if (codexRolloutReaderQueues.get(reader) === completed) {
      codexRolloutReaderQueues.delete(reader);
    }
  }
}

async function readCodexRolloutStateSnapshot(
  sessionsDir: string,
  reader: CodexRolloutReaderState | undefined,
  rootThreadId: string | undefined,
  proof: CodexLaunchProofContext | undefined,
): Promise<CodexRolloutReadResult> {
  let files: string[];
  try {
    if (proof && (await realpath(sessionsDir)) !== resolve(sessionsDir))
      throw new Error("Escaped rollout root");
    files = await collectJsonlFiles(sessionsDir, 0, proof !== undefined);
  } catch {
    return {
      rollout: null,
      rateLimit: null,
      ...(proof ? { launchProof: { kind: "unknown" as const } } : {}),
    };
  }
  // The `codex resume` poison-id heal step rewrites every rollout file at ~the
  // same instant, so filesystem mtime stops reflecting content recency. Rank by
  // the newest in-content state timestamp instead (heal preserves those), and
  // keep mtime only as a deterministic tie-breaker.
  const nextFiles = new Map<string, CodexRolloutFileEntry>();
  let proofComplete = true;
  const contexts: {
    filePath: string;
    fingerprint: CodexRolloutFileFingerprint;
    fold: CodexRolloutFold;
    rollout: CodexRolloutStateRecord | null;
    frame: string;
  }[] = [];
  const candidates = await Promise.all(
    files.map(async (filePath) => {
      let fingerprint: CodexRolloutFileFingerprint | null = null;
      try {
        const fileStat = proof ? await lstat(filePath) : await stat(filePath);
        if (proof && (!fileStat.isFile() || (await realpath(filePath)) !== resolve(filePath))) {
          proofComplete = false;
          return null;
        }
        fingerprint = {
          ino: fileStat.ino,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          ...(proof ? { dev: fileStat.dev } : {}),
        };
      } catch {
        if (proof) {
          proofComplete = false;
          return null;
        }
        // Preserve the existing best-effort read below for a stat/read race.
      }
      const cached = reader?.files.get(filePath);
      if (
        !proof &&
        fingerprint &&
        cached?.ino === fingerprint.ino &&
        cached.mtimeMs === fingerprint.mtimeMs &&
        cached.size === fingerprint.size
      ) {
        nextFiles.set(filePath, cached);
        return cached.candidate;
      }
      const read = await readCodexRolloutFile(filePath, fingerprint, cached, proof !== undefined);
      if (!read) {
        if (proof) proofComplete = false;
        return null;
      }
      if (proof) {
        if (!read.complete || !fingerprint || !read.frame) proofComplete = false;
        else
          contexts.push({
            filePath,
            fingerprint,
            fold: read.fold,
            rollout: read.candidate?.result.rollout ?? null,
            frame: read.frame,
          });
      }
      if (read.entry) nextFiles.set(filePath, read.entry);
      return read.candidate;
    }),
  );
  if (reader && !proof) reader.files = nextFiles;
  let launchProof: CodexLaunchProof | undefined;
  if (proof) {
    launchProof = { kind: "unknown" };
    try {
      const finalFiles = await collectJsonlFiles(sessionsDir, 0, true);
      if (JSON.stringify(finalFiles.sort()) !== JSON.stringify([...files].sort()))
        proofComplete = false;
      for (const context of contexts) {
        const current = await lstat(context.filePath);
        const before = context.fingerprint;
        if (
          !current.isFile() ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs
        )
          proofComplete = false;
      }
    } catch {
      proofComplete = false;
    }
    const eligible = contexts.filter(
      ({ fold }) =>
        fold.origin.kind === "primary" &&
        !(fold.origin.timingKnown && fold.origin.latestMs < proof.sinceMs),
    );
    const selected = eligible[0];
    const rollout = selected?.rollout;
    if (
      proofComplete &&
      contexts.length === files.length &&
      eligible.length === 1 &&
      contexts.every(
        ({ fold }) => fold.origin.kind !== "unknown" && fold.origin.latestMs <= proof.nowMs,
      ) &&
      Number.isFinite(proof.sinceMs) &&
      Number.isFinite(proof.nowMs) &&
      proof.sinceMs <= proof.nowMs &&
      selected?.fold.origin.threadId === rootThreadId &&
      rootThreadId &&
      rollout?.turnId?.trim() &&
      rollout.timestampMs >= proof.sinceMs &&
      rollout.timestampMs <= proof.nowMs
    ) {
      launchProof = {
        kind: "primary",
        complete: true,
        threadId: rootThreadId,
        turnId: rollout.turnId,
        timestampMs: rollout.timestampMs,
        frame: createHash("sha256")
          .update(
            JSON.stringify(
              contexts
                .sort((a, b) => a.filePath.localeCompare(b.filePath))
                .map(({ filePath, fingerprint, frame }) => ({ filePath, fingerprint, frame })),
            ),
          )
          .digest("hex"),
      };
    }
  }
  const existing = candidates.filter(
    (candidate): candidate is CodexRolloutCandidate => candidate !== null,
  );
  if (existing.length === 0) {
    return { rollout: null, rateLimit: null, ...(launchProof ? { launchProof } : {}) };
  }
  // A just-started rollout file can carry a `turn_context` model before it has
  // any state or rate-limit line, so it loses both selections below. Rank the
  // model on its own to keep the live model available from the first turn.
  const rootCandidates = existing.filter((candidate) =>
    rootThreadId
      ? candidate.result.threadId === rootThreadId
      : candidate.result.isSubagent !== true,
  );
  const model = rootCandidates
    .filter((candidate) => candidate.result.model)
    .reduce<CodexRolloutCandidate | null>(
      (left, right) => (left === null || right.mtimeMs > left.mtimeMs ? right : left),
      null,
    )?.result.model;
  const newestTokenUsage = existing
    .filter((candidate) => candidate.result.tokenUsage)
    .reduce<CodexRolloutCandidate | null>((left, right) => {
      if (left === null) return right;
      const leftTs = left.result.tokenUsage?.observedAtMs ?? 0;
      const rightTs = right.result.tokenUsage?.observedAtMs ?? 0;
      return rightTs > leftTs || (rightTs === leftTs && right.mtimeMs > left.mtimeMs)
        ? right
        : left;
    }, null)?.result.tokenUsage;
  const tokenUsages = existing.flatMap((candidate) =>
    candidate.result.tokenUsage ? [candidate.result.tokenUsage] : [],
  );
  const stateful = rootCandidates.filter(
    (candidate) => candidate.result.rollout !== null || candidate.result.rateLimit !== null,
  );
  const withRollout = stateful.filter((candidate) => candidate.result.rollout !== null);
  if (withRollout.length > 0) {
    const best = withRollout.reduce((left, right) => {
      const leftTs = left.result.rollout?.timestampMs ?? 0;
      const rightTs = right.result.rollout?.timestampMs ?? 0;
      if (rightTs !== leftTs) {
        return rightTs > leftTs ? right : left;
      }
      return right.mtimeMs > left.mtimeMs ? right : left;
    });
    const tokenUsage = best.result.tokenUsage ?? newestTokenUsage;
    return {
      ...best.result,
      ...(launchProof ? { launchProof } : {}),
      ...(model ? { model } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(tokenUsages.length > 0 ? { tokenUsages } : {}),
    };
  }
  const newestByMtime = stateful.reduce<CodexRolloutCandidate | null>(
    (left, right) => (left === null || right.mtimeMs > left.mtimeMs ? right : left),
    null,
  );
  return {
    rollout: null,
    ...(launchProof ? { launchProof } : {}),
    rateLimit: newestByMtime?.result.rateLimit ?? null,
    ...(model ? { model } : {}),
    ...(newestTokenUsage ? { tokenUsage: newestTokenUsage } : {}),
    ...(tokenUsages.length > 0 ? { tokenUsages } : {}),
  };
}

// ── Transcript entries (unified message/tool/question timeline) ──────

interface CodexReasoningSummaryItem {
  type?: string;
  text?: string;
}

function extractCodexReasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .filter(
      (item): item is CodexReasoningSummaryItem =>
        isRecord(item) && typeof item["text"] === "string" && item["text"].trim() !== "",
    )
    .map((item) => (item.text as string).trim())
    .join("\n");
}

/** input_required questions carry the same `{header, question}` shape AskUserQuestion does. */
function extractCodexQuestionText(payload: Record<string, unknown>): {
  header: string;
  prompt: string;
} {
  const questionsValue = payload["questions"];
  if (Array.isArray(questionsValue) && questionsValue.length > 0 && isRecord(questionsValue[0])) {
    const first = questionsValue[0];
    return {
      header: typeof first["header"] === "string" ? first["header"] : "",
      prompt: typeof first["question"] === "string" ? first["question"] : "",
    };
  }
  return { header: "", prompt: "" };
}

/**
 * Full transcript in file-line order: user/assistant messages, reasoning summaries,
 * function_call tool invocations (paired with their output by call_id), and
 * request_user_input/input_required prompts. Question option payload shape is
 * unverified in production data, so options are always omitted here.
 */
export async function readCodexTranscriptEntries(
  sessionsDir: string,
): Promise<TranscriptEntry[] | null> {
  const filePath = await findLatestCodexSessionFile({ sessionRootDir: sessionsDir });
  if (!filePath) {
    return null;
  }
  const read = await foldCodexJsonlFile(
    filePath,
    null,
    undefined,
    codexTranscriptFolder(Number.POSITIVE_INFINITY),
  );
  return read?.fold.entries ?? null;
}

// Tool entries are the only ones a later line can change: an output line for
// their call_id fills `output`. Entries are replaced, never mutated, so a
// published window stays valid.
function codexToolEntry(
  name: string,
  callId: string | undefined,
  inputSummary: string | undefined,
  ts: { timestampMs: number } | Record<string, never>,
  output: string | undefined,
): TranscriptEntry {
  return {
    kind: "tool",
    name,
    ...(callId ? { callId } : {}),
    ...(inputSummary ? { inputSummary } : {}),
    ...(output ? { output } : {}),
    ...ts,
  };
}

interface CodexTranscriptFold {
  // MAX_RETAINED_CONVERSATION_ENTRIES, or Infinity for a full read.
  limit: number;
  // Newest entries, oldest first; at most `limit` once a pass finishes.
  entries: TranscriptEntry[];
  // Entries ever produced from this file.
  totalEntries: number;
  // Last non-empty output per call_id; after a pass only ids of retained tool entries.
  outputs: Map<string, string>;
  // call_id -> indexes into `entries` of its tool entries.
  toolOrdinals: Map<string, number[]>;
  // Every call_id that ever had an output, never pruned: a call whose output was
  // pruned from `outputs` cannot be resolved without a full read.
  outputCallIds: Set<string>;
  needsFullRead: boolean;
}

function newCodexTranscriptFold(limit: number): CodexTranscriptFold {
  return {
    limit,
    entries: [],
    totalEntries: 0,
    outputs: new Map(),
    toolOrdinals: new Map(),
    outputCallIds: new Set(),
    needsFullRead: false,
  };
}

function cloneCodexTranscriptFold(fold: CodexTranscriptFold): CodexTranscriptFold {
  return {
    ...fold,
    entries: fold.entries.slice(),
    outputs: new Map(fold.outputs),
    toolOrdinals: new Map(
      [...fold.toolOrdinals].map(([callId, ordinals]) => [callId, [...ordinals]]),
    ),
    outputCallIds: new Set(fold.outputCallIds),
    needsFullRead: false,
  };
}

function trimCodexTranscriptFold(fold: CodexTranscriptFold, keep: number): void {
  const drop = fold.entries.length - keep;
  if (drop <= 0) return;
  fold.entries.splice(0, drop);
  for (const [callId, ordinals] of fold.toolOrdinals) {
    const kept = ordinals.filter((ordinal) => ordinal >= drop).map((ordinal) => ordinal - drop);
    if (kept.length > 0) fold.toolOrdinals.set(callId, kept);
    else fold.toolOrdinals.delete(callId);
  }
}

function appendCodexTranscriptEntry(
  fold: CodexTranscriptFold,
  entry: TranscriptEntry,
  toolCallId?: string,
): void {
  fold.entries.push(entry);
  fold.totalEntries += 1;
  if (toolCallId) {
    const ordinals = fold.toolOrdinals.get(toolCallId) ?? [];
    ordinals.push(fold.entries.length - 1);
    fold.toolOrdinals.set(toolCallId, ordinals);
  }
  // Trim in batches so the per-line cost stays constant.
  if (fold.entries.length > 2 * fold.limit) trimCodexTranscriptFold(fold, fold.limit);
}

function foldCodexTranscriptLine(fold: CodexTranscriptFold, parsed: Record<string, unknown>): void {
  const timestamp = typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined;
  const parsedTimestampMs = timestamp ? Date.parse(timestamp) : NaN;
  const ts: { timestampMs: number } | Record<string, never> = Number.isFinite(parsedTimestampMs)
    ? { timestampMs: parsedTimestampMs }
    : {};

  const type = parsed["type"];

  if (type === "response_item") {
    const userText = extractUserText(parsed);
    if (userText !== null && userText.trim()) {
      appendCodexTranscriptEntry(fold, { kind: "message", role: "user", text: userText, ...ts });
      return;
    }

    const assistantText = extractAssistantText(parsed);
    if (assistantText !== null && assistantText.trim()) {
      appendCodexTranscriptEntry(fold, {
        kind: "message",
        role: "assistant",
        text: assistantText,
        ...ts,
      });
      return;
    }

    const payload = parsed["payload"];
    if (!isRecord(payload)) {
      return;
    }
    const payloadType = payload["type"];

    if (payloadType === "reasoning") {
      const text = extractCodexReasoningText(payload["summary"]);
      if (text) {
        appendCodexTranscriptEntry(fold, { kind: "reasoning", text, ...ts });
      }
      return;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const name = typeof payload["name"] === "string" ? payload["name"] : "";
      const callId = readRolloutString(payload["call_id"]);
      if (name === "request_user_input") {
        appendCodexTranscriptEntry(fold, { kind: "question", header: "", prompt: "", ...ts });
        return;
      }
      const output = callId ? fold.outputs.get(callId) : undefined;
      if (callId && output === undefined && fold.outputCallIds.has(callId)) {
        fold.needsFullRead = true;
      }
      appendCodexTranscriptEntry(
        fold,
        codexToolEntry(name, callId, readRolloutString(payload["arguments"]), ts, output),
        callId,
      );
      return;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = readRolloutString(payload["call_id"]);
      const output = readRolloutString(payload["output"]);
      if (!callId || !output) return;
      fold.outputs.set(callId, output);
      fold.outputCallIds.add(callId);
      for (const ordinal of fold.toolOrdinals.get(callId) ?? []) {
        const entry = fold.entries[ordinal];
        if (entry?.kind !== "tool") continue;
        fold.entries[ordinal] = codexToolEntry(
          entry.name,
          entry.callId,
          entry.inputSummary,
          entry.timestampMs === undefined ? {} : { timestampMs: entry.timestampMs },
          output,
        );
      }
    }
    return;
  }

  if (type === "event_msg") {
    const payload = parsed["payload"];
    if (!isRecord(payload) || payload["type"] !== "input_required") {
      return;
    }
    const { header, prompt } = extractCodexQuestionText(payload);
    appendCodexTranscriptEntry(fold, { kind: "question", header, prompt, ...ts });
  }
}

// Drop what the next append cannot reach: entries past the window and outputs
// of calls no longer retained.
function finishCodexTranscriptPass(fold: CodexTranscriptFold): void {
  trimCodexTranscriptFold(fold, fold.limit);
  for (const callId of fold.outputs.keys()) {
    if (!fold.toolOrdinals.has(callId)) fold.outputs.delete(callId);
  }
}

function codexTranscriptFolder(limit: number): CodexLineFolder<CodexTranscriptFold> {
  return {
    start: () => newCodexTranscriptFold(limit),
    resume: cloneCodexTranscriptFold,
    line: foldCodexTranscriptLine,
  };
}

export interface CodexConversationReaderState {
  filePath: string;
  cursor: CodexJsonlCursor<CodexTranscriptFold>;
}

/**
 * Newest MAX_RETAINED_CONVERSATION_ENTRIES transcript entries of the latest
 * rollout, equal to the tail of `readCodexTranscriptEntries`. An unchanged file
 * is not read; an append parses only the new bytes; a rewrite, rotation, or
 * a call whose output left the window re-reads the whole file.
 */
export async function readCodexConversationTail(
  sessionsDir: string,
  reader: CodexConversationReaderState | undefined,
): Promise<{
  entries: TranscriptEntry[];
  totalEntries: number;
  startIndex: number;
  reader: CodexConversationReaderState;
} | null> {
  const filePath = await findLatestCodexSessionFile({ sessionRootDir: sessionsDir });
  if (!filePath) return null;
  let fingerprint: CodexRolloutFileFingerprint;
  try {
    const fileStat = await stat(filePath);
    fingerprint = { ino: fileStat.ino, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch {
    return null;
  }
  const cached = reader?.filePath === filePath ? reader.cursor : undefined;
  let cursor = cached;
  if (
    !cursor ||
    cursor.ino !== fingerprint.ino ||
    cursor.mtimeMs !== fingerprint.mtimeMs ||
    cursor.size !== fingerprint.size
  ) {
    const folder = codexTranscriptFolder(MAX_RETAINED_CONVERSATION_ENTRIES);
    let read = await foldCodexJsonlFile(filePath, fingerprint, cached, folder);
    if (read?.fold.needsFullRead) {
      read = await foldCodexJsonlFile(filePath, fingerprint, undefined, folder);
    }
    if (!read?.cursor) return null;
    finishCodexTranscriptPass(read.fold);
    cursor = read.cursor;
  }
  const { entries, totalEntries } = cursor.fold;
  return {
    entries,
    totalEntries,
    startIndex: totalEntries - entries.length,
    reader: { filePath, cursor },
  };
}
