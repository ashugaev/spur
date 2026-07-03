import { createReadStream, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shellEscape } from "./shell-escape.js";
import { resolveWorktreePathCandidates } from "./worktree-path.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
import { detectCodexRateLimit, type RateLimitDetection } from "../rate-limit-detect.js";

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

export async function collectJsonlFiles(dir: string, depth = 0): Promise<string[]> {
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

export async function findLatestCodexSessionFile(options?: {
  sessionRootDir?: string;
  sessionRootDirs?: string[];
}): Promise<string | null> {
  let bestMatch: { filePath: string; mtimeMs: number } | null = null;
  for (const sessionRootDir of resolveSessionRootDirs(options)) {
    const files = await collectJsonlFiles(sessionRootDir).catch(() => []);
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
    startupImagePaths?: string[];
    restrictWrites?: boolean;
    model?: string;
  },
): AgentLaunchPlan {
  const command = withCodexHome(
    appendCodexImages(
      appendCodexModel(
        appendCodexArgs(
          `${codexCommand()} ${codexLaunchFlags(options?.restrictWrites)}`,
          options?.codexArgs,
        ),
        options?.model,
      ),
      options?.startupImagePaths,
    ),
    options?.codexHomePath,
  );
  if (options?.startupImagePaths?.length) {
    return {
      launchCommand: prompt.trim() ? `${command} ${shellEscape(prompt)}` : command,
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
  options?: { codexHomePath?: string; codexArgs?: string[]; restrictWrites?: boolean },
): AgentResumePlan {
  return {
    launchCommand: withCodexHome(
      appendCodexArgs(
        `${shellEscape(binary)} resume ${codexLaunchFlags(options?.restrictWrites)} ${shellEscape(threadId)}`,
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
  options?: { codexHomePath?: string; codexArgs?: string[]; restrictWrites?: boolean },
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

export async function buildEphemeralCodexConfig(
  trustedProjects: readonly string[],
): Promise<string> {
  const userConfigPath = join(homedir(), ".codex", "config.toml");
  const baseConfig = await readFile(userConfigPath, "utf8").catch(() => "");
  return appendCodexTrustedProjects(baseConfig, trustedProjects);
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

export async function ensureCodexHooksConfig(
  sessionToolDir: string,
  trustedProjects: readonly string[] = [],
  options?: { restrictWrites?: boolean },
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
  const baseConfig = await buildEphemeralCodexConfig(trustedProjects);
  const finalConfig = withSuppressUnstableFeaturesWarning(baseConfig);
  await writeFile(sessionConfigPath, finalConfig, "utf8");
  await linkCodexAuth(codexDir);
  const userAgentsDir = join(homedir(), ".codex", "agents");
  if (existsSync(userAgentsDir)) {
    await cp(userAgentsDir, join(codexDir, "agents"), { recursive: true, force: true });
  }
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

function extractUserTextFromLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const type = parsed["type"];
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return null;
  }

  if (type === "response_item") {
    const p = payload as unknown as RolloutResponseItemPayload;
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
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
    if (p.type === "user_message" && typeof p.message === "string") {
      return p.message;
    }
  }

  return null;
}

export async function scanCodexRolloutForMessage(
  sessionsDir: string,
  messageText: string,
  baseline: RolloutBaseline,
): Promise<{ found: boolean; lastScannedFile: string | null }> {
  let files: string[];
  try {
    files = await collectJsonlFiles(sessionsDir);
  } catch {
    return { found: false, lastScannedFile: null };
  }
  let lastScannedFile: string | null = null;
  const trimmedTarget = messageText.trim();
  for (const filePath of files) {
    lastScannedFile = filePath;
    const offset = baseline.get(filePath) ?? 0;
    try {
      const input = createReadStream(filePath, { encoding: "utf-8", start: offset });
      const reader = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const rawLine of reader) {
          const trimmedLine = rawLine.trim();
          if (!trimmedLine) continue;
          const extracted = extractUserTextFromLine(trimmedLine);
          if (extracted !== null && extracted.trim() === trimmedTarget) {
            reader.close();
            return { found: true, lastScannedFile: filePath };
          }
        }
      } finally {
        reader.close();
      }
    } catch {
      // Ignore unreadable files.
    }
  }
  return { found: false, lastScannedFile };
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
    | "input_required"
    | "request_user_input";
  turnId?: string;
  callId?: string;
}

export interface CodexRolloutReadResult {
  rollout: CodexRolloutStateRecord | null;
  rateLimit: RateLimitDetection | null;
}

function readRolloutString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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

function extractCodexRolloutStateLine(
  line: string,
): Omit<CodexRolloutStateRecord, "filePath"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
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

function readMatchedToolCallIds(lines: string[]): Set<string> {
  const matched = new Set<string>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed["type"] !== "response_item") {
      continue;
    }
    const payload = parsed["payload"];
    if (!isRecord(payload)) {
      continue;
    }
    const payloadType = payload["type"];
    if (payloadType !== "function_call_output" && payloadType !== "custom_tool_call_output") {
      continue;
    }
    const callId = readRolloutString(payload["call_id"]);
    if (callId) {
      matched.add(callId);
    }
  }
  return matched;
}

function extractCodexRateLimitsLine(line: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["type"] !== "event_msg") {
    return null;
  }
  const payload = parsed["payload"];
  if (!isRecord(payload) || payload["type"] !== "token_count") {
    return null;
  }
  return payload["rate_limits"];
}

function readCodexRolloutFromLines(filePath: string, lines: string[]): CodexRolloutReadResult {
  const matchedCallIds = readMatchedToolCallIds(lines);
  let rollout: CodexRolloutStateRecord | null = null;
  let rateLimit: RateLimitDetection | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (rateLimit === null) {
      const detection = detectCodexRateLimit(extractCodexRateLimitsLine(line));
      if (detection) {
        rateLimit = detection;
      }
    }
    if (rollout === null) {
      const state = extractCodexRolloutStateLine(line);
      if (!state) {
        continue;
      }
      if (state.callId && matchedCallIds.has(state.callId)) {
        continue;
      }
      rollout = {
        ...state,
        filePath,
      };
    }
    if (rateLimit) {
      break;
    }
  }
  return { rollout, rateLimit };
}

export async function readCodexRolloutState(sessionsDir: string): Promise<CodexRolloutReadResult> {
  let files: string[];
  try {
    files = await collectJsonlFiles(sessionsDir);
  } catch {
    return { rollout: null, rateLimit: null };
  }
  const filesWithTimes = await Promise.all(
    files.map(async (filePath) => {
      try {
        const fileStat = await stat(filePath);
        return { filePath, mtimeMs: fileStat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const existingFiles = filesWithTimes.filter(
    (file): file is { filePath: string; mtimeMs: number } => file !== null,
  );
  for (const file of existingFiles.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
    let content: string;
    try {
      content = await readFile(file.filePath, "utf8");
    } catch {
      continue;
    }
    const lines = content.trim().split("\n").filter(Boolean);
    const result = readCodexRolloutFromLines(file.filePath, lines);
    if (result.rollout || result.rateLimit) {
      return result;
    }
  }
  return { rollout: null, rateLimit: null };
}
