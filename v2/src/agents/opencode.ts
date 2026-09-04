import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { shellEscape } from "./shell-escape.js";
import { resolveTempDir } from "../temp-dir.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
import type { SidecarMcpBinding, TranscriptEntry } from "../types.js";
import {
  agentExecutableCommand,
  missingAgentExecutableMessage,
  resolveAgentExecutable,
} from "./executable.js";

const execFileAsync = promisify(execFile);

const OPENCODE_SESSION_LIST_TIMEOUT_MS = 20_000;
const OPENCODE_EXPORT_TIMEOUT_MS = 30_000;

// `opencode` truncates its own stdout at 128 KB when stdout is a pipe: it exits
// before the pipe drains, so a piped `export` of any session with real history
// yields invalid JSON. Capturing into a file is the only shape that returns the
// whole document, so every JSON read of the CLI goes through here.
export async function readOpenCodeJson(
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<string> {
  const directory = await mkdtemp(join(resolveTempDir(), "spur-opencode-"));
  const outputPath = join(directory, "out.json");
  try {
    const handle = await open(outputPath, "w");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(opencodeCommand(), args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          stdio: ["ignore", handle.fd, "ignore"],
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`opencode ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`opencode ${args.join(" ")} exited with code ${code}`));
        });
      });
    } finally {
      await handle.close();
    }
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface OpenCodePlanOptions {
  model?: string;
  sessionId?: string;
  configContent?: string;
}

export const MIN_OPENCODE_VERSION = "1.18.18";
const OPENCODE_RESTRICT_WRITES_PERMISSION = {
  edit: "deny",
  bash: {
    "*": "allow",
    "git commit*": "deny",
    "git push*": "deny",
  },
} as const;
export const OPENCODE_RESTRICT_WRITES_CONFIG = JSON.stringify({
  permission: OPENCODE_RESTRICT_WRITES_PERMISSION,
});

export function buildOpenCodeConfig(
  mcpBindings: SidecarMcpBinding[] | undefined,
  restrictWrites: boolean | undefined,
): string | undefined {
  const config: Record<string, unknown> = {};
  if (mcpBindings?.length) {
    config["mcp"] = Object.fromEntries(
      mcpBindings.map((binding) => [
        binding.server,
        { type: "remote", url: binding.url, enabled: true },
      ]),
    );
  }
  if (restrictWrites) {
    config["permission"] = OPENCODE_RESTRICT_WRITES_PERMISSION;
  }
  return Object.keys(config).length > 0 ? JSON.stringify(config) : undefined;
}

export function opencodeCommand(): string {
  return agentExecutableCommand("opencode");
}

function modelArg(model?: string): string {
  return model ? ` --model ${shellEscape(model)}` : "";
}

function launchCommand(binary: string, args: string, options?: OpenCodePlanOptions): string {
  const prefix = options?.configContent
    ? `OPENCODE_CONFIG_CONTENT=${shellEscape(options.configContent)} `
    : "";
  return `${prefix}${shellEscape(binary)} ${args}${modelArg(options?.model)}`;
}

export function buildOpenCodePlan(prompt: string, options?: OpenCodePlanOptions): AgentLaunchPlan {
  return {
    launchCommand: launchCommand(
      opencodeCommand(),
      `--auto --prompt ${shellEscape(prompt)}`,
      options,
    ),
    initialMessage: "",
    initialMessageDeliveredOnLaunch: true,
    readyMarkers: ["commands"],
  };
}

export function isSupportedOpenCodeVersion(version: string): boolean {
  const match = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const minimum = MIN_OPENCODE_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((actual[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

export async function assertOpenCodeCompatibility(): Promise<void> {
  if (!resolveAgentExecutable("opencode").path) {
    throw new Error(missingAgentExecutableMessage("opencode"));
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(opencodeCommand(), ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    }));
  } catch (error) {
    throw new Error(`OpenCode ${MIN_OPENCODE_VERSION}+ is required`, { cause: error });
  }
  if (!isSupportedOpenCodeVersion(stdout)) {
    throw new Error(
      `OpenCode ${MIN_OPENCODE_VERSION}+ is required; found ${stdout.trim() || "unknown"}`,
    );
  }
}

export function buildOpenCodeResumePlan(
  sessionId: string,
  binary = opencodeCommand(),
  options?: OpenCodePlanOptions,
): AgentResumePlan {
  return {
    launchCommand: launchCommand(binary, `--auto --session ${shellEscape(sessionId)}`, options),
    readyMarkers: ["commands"],
  };
}

interface OpenCodeSession {
  id?: unknown;
  directory?: unknown;
  updated?: unknown;
  time?: { updated?: unknown };
}

// `session list --format json` reports `updated` at the top level; `export`
// nests it under `time`. Accept both so the newest session wins either way.
function sessionUpdatedAt(session: OpenCodeSession): number {
  const raw = session.time?.updated ?? session.updated;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export interface OpenCodeSessionBaseline {
  worktreePath: string;
  sessionIds: Set<string>;
}

const launchIdentityTails = new Map<string, Promise<void>>();

export async function withOpenCodeLaunchIdentityLock<T>(
  worktreePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = launchIdentityTails.get(worktreePath) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  launchIdentityTails.set(worktreePath, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (launchIdentityTails.get(worktreePath) === tail) {
      launchIdentityTails.delete(worktreePath);
    }
  }
}

function parseSessionList(value: unknown, worktreePath: string): string | null {
  if (!Array.isArray(value)) return null;
  const sessions = value
    .filter((entry): entry is OpenCodeSession => typeof entry === "object" && entry !== null)
    .filter(
      (entry) =>
        typeof entry.id === "string" &&
        entry.id.startsWith("ses_") &&
        entry.directory === worktreePath,
    )
    .sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left));
  return typeof sessions[0]?.id === "string" ? sessions[0].id : null;
}

export function parseOpenCodeSessionListOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  return trimmed ? (JSON.parse(trimmed) as unknown) : [];
}

export async function findOpenCodeSessionId(worktreePath: string): Promise<string | null> {
  try {
    const stdout = await readOpenCodeJson(["session", "list", "--format", "json"], {
      cwd: worktreePath,
      timeoutMs: OPENCODE_SESSION_LIST_TIMEOUT_MS,
    });
    return parseSessionList(parseOpenCodeSessionListOutput(stdout), worktreePath);
  } catch {
    return null;
  }
}

async function listOpenCodeSessionIds(worktreePath: string): Promise<Set<string>> {
  const stdout = await readOpenCodeJson(["session", "list", "--format", "json"], {
    cwd: worktreePath,
    timeoutMs: OPENCODE_SESSION_LIST_TIMEOUT_MS,
  });
  const value = parseOpenCodeSessionListOutput(stdout);
  if (!Array.isArray(value)) throw new Error("OpenCode returned an invalid session list");
  const sessionIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    if (typeof id === "string" && id.startsWith("ses_") && entry["directory"] === worktreePath) {
      sessionIds.add(id);
    }
  }
  return sessionIds;
}

export async function captureOpenCodeSessionBaseline(
  worktreePath: string,
): Promise<OpenCodeSessionBaseline> {
  return { worktreePath, sessionIds: await listOpenCodeSessionIds(worktreePath) };
}

export function diffOpenCodeSessionIds(
  baseline: OpenCodeSessionBaseline,
  current: Set<string>,
): string | null {
  const created = [...current].filter((id) => !baseline.sessionIds.has(id));
  if (created.length > 1) {
    throw new Error(
      `OpenCode created ${created.length} sessions in ${baseline.worktreePath}; refusing ambiguous identity`,
    );
  }
  return created[0] ?? null;
}

export async function resolveNewOpenCodeSessionId(
  baseline: OpenCodeSessionBaseline,
): Promise<string | null> {
  const current = await listOpenCodeSessionIds(baseline.worktreePath);
  return diffOpenCodeSessionIds(baseline, current);
}

export async function buildOpenCodeRestorePlan(
  _worktreePath: string,
  prompt: string,
  options?: { model?: string; sessionId?: string; configContent?: string },
): Promise<AgentLaunchPlan | null> {
  const sessionId = options?.sessionId;
  if (!sessionId) return null;
  return {
    ...buildOpenCodeResumePlan(sessionId, opencodeCommand(), options),
    initialMessage: prompt,
  };
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>)["type"] === "text" &&
        typeof (part as Record<string, unknown>)["text"] === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function openCodeMessages(value: unknown): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null) return [];
  const messages = (value as Record<string, unknown>)["messages"];
  return Array.isArray(messages) ? messages.filter(isRecord) : [];
}

function messageInfo(message: Record<string, unknown>): Record<string, unknown> | null {
  const info = message["info"];
  return isRecord(info) ? info : null;
}

export function parseOpenCodeExport(value: unknown): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of openCodeMessages(value)) {
    const role = messageInfo(message)?.["role"];
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromParts(message["parts"]);
    if (text) entries.push({ kind: "message", role, text });
  }
  return entries;
}

export interface OpenCodeStructuredState {
  state: "working" | "waiting" | "needs_input" | "rate_limited" | "error";
  reason: string;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  return Object.values(value).map(errorText).join(" ");
}

function isRateLimit(value: unknown): boolean {
  if (isRecord(value)) {
    const status = value["status"] ?? value["statusCode"];
    if (status === 429) return true;
  }
  return /(?:rate[ _-]?limit|too many requests|\b429\b)/i.test(errorText(value));
}

export function parseOpenCodeState(value: unknown): OpenCodeStructuredState | null {
  const messages = openCodeMessages(value);
  if (messages.length === 0) return null;
  const last = messages.at(-1);
  const record = last ? messageInfo(last) : null;
  if (!record) return null;
  if (record["role"] === "user") {
    return { state: "working", reason: "last role=user" };
  }
  if (record["role"] !== "assistant") return null;
  if (record["error"] !== undefined && record["error"] !== null) {
    if (isRateLimit(record["error"])) {
      return { state: "rate_limited", reason: "assistant rate limit" };
    }
    return { state: "error", reason: "assistant error" };
  }
  const time = record["time"];
  if (
    typeof time === "object" &&
    time !== null &&
    typeof (time as Record<string, unknown>)["completed"] === "number"
  ) {
    return { state: "waiting", reason: "assistant completed" };
  }
  return { state: "working", reason: "assistant incomplete" };
}

// Every export is a subprocess that queries the one multi-gigabyte SQLite DB
// all opencode sessions share, so its cost scales with fleet size, not with the
// caller. Callers that cannot tolerate stale data — the launch wait and the
// submit-ack scan both poll for a *new* message — cannot be served from a
// cache, so the ceiling that bounds them lives here, on the single funnel every
// call site passes through. Measured before this gate: a 15-session fleet ran a
// mean of 4 and a peak of 17 concurrent exports, 3.7 GB resident at the peak.
// The limit sits at that mean; over it, callers queue rather than fan out.
export const OPENCODE_EXPORT_MAX_CONCURRENCY = 4;
let openCodeExportActive = 0;
const openCodeExportQueue: Array<() => void> = [];

async function acquireOpenCodeExportSlot(): Promise<void> {
  if (openCodeExportActive < OPENCODE_EXPORT_MAX_CONCURRENCY) {
    openCodeExportActive += 1;
    return;
  }
  await new Promise<void>((resolve) => openCodeExportQueue.push(resolve));
}

function releaseOpenCodeExportSlot(): void {
  // Hand the slot straight to the next waiter; the count only drops when the
  // queue is empty, so a burst never opens a gap above the limit.
  const next = openCodeExportQueue.shift();
  if (next) next();
  // Clamped for the test seam only: it zeroes the counter under waiters that
  // release afterwards. The export path releases exactly once, in `finally`,
  // so nothing here is guarding against a double release in production.
  else openCodeExportActive = Math.max(0, openCodeExportActive - 1);
}

async function exportOpenCodeSession(sessionId: string): Promise<unknown> {
  await acquireOpenCodeExportSlot();
  try {
    const stdout = await readOpenCodeJson(["export", sessionId], {
      timeoutMs: OPENCODE_EXPORT_TIMEOUT_MS,
    });
    return JSON.parse(stdout) as unknown;
  } finally {
    releaseOpenCodeExportSlot();
  }
}

export interface OpenCodeSubmitBaseline {
  sessionId: string;
  userMessageIds: Set<string>;
}

// OpenCode rewrites what it persists: a prompt that opens with a slash command
// is stored expanded, so the delivered text never equals the text Spur sent.
// Delivery is confirmed by a new user message id, never by matching text.
export function parseOpenCodeUserMessageIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  for (const message of openCodeMessages(value)) {
    const info = messageInfo(message);
    const id = info?.["id"];
    if (info?.["role"] === "user" && typeof id === "string") ids.add(id);
  }
  return ids;
}

export function hasNewOpenCodeUserMessage(
  baseline: OpenCodeSubmitBaseline,
  current: Set<string>,
): boolean {
  return [...current].some((id) => !baseline.userMessageIds.has(id));
}

export async function captureOpenCodeSubmitBaseline(
  sessionId?: string,
): Promise<OpenCodeSubmitBaseline | null> {
  if (!sessionId) return null;
  try {
    return {
      sessionId,
      userMessageIds: parseOpenCodeUserMessageIds(await exportOpenCodeSession(sessionId)),
    };
  } catch {
    return null;
  }
}

export async function scanOpenCodeForNewUserMessage(
  baseline: OpenCodeSubmitBaseline,
): Promise<boolean> {
  try {
    const current = parseOpenCodeUserMessageIds(await exportOpenCodeSession(baseline.sessionId));
    return hasNewOpenCodeUserMessage(baseline, current);
  } catch {
    return false;
  }
}

// One `opencode export` costs 2-4s on a loaded host, so the launch check needs
// the same budget as identity binding rather than a few polls' worth.
const OPENCODE_LAUNCH_MESSAGE_WAIT_MS = 60_000;

export async function waitForOpenCodeLaunchMessage(
  sessionId: string,
  timeoutMs = OPENCODE_LAUNCH_MESSAGE_WAIT_MS,
): Promise<boolean> {
  const baseline: OpenCodeSubmitBaseline = { sessionId, userMessageIds: new Set() };
  const deadline = Date.now() + timeoutMs;
  do {
    if (await scanOpenCodeForNewUserMessage(baseline)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() <= deadline);
  return false;
}

// Every other agent classifies from an incremental file read; opencode has no
// per-session file to stat — all sessions share one multi-gigabyte SQLite DB —
// so its only state source is `opencode export`, a subprocess that queries that
// DB and serializes the whole transcript. Left ungated, the 2s dashboard tick
// spawned one per live opencode session faster than they finished: a
// 15-session fleet sampled at mean 4 and peak 17 concurrent exports, 3.7 GB
// resident at the peak, with 40% of the daemon's own CPU in system time.
//
// So the derived state is cached — the two-field result, never the transcript
// that produced it — and concurrent callers share one in-flight export. A
// session's state is at most OPENCODE_STATE_TTL_MS staler than the export it
// came from, which was already seconds old by the time it returned.
const OPENCODE_STATE_TTL_MS = 5_000;
const openCodeStateCache = new Map<string, { at: number; state: OpenCodeStructuredState | null }>();
const openCodeStateInFlight = new Map<string, Promise<OpenCodeStructuredState | null>>();

/** Drops every session's cached state and the export gate's counters. Test seam. */
export function resetOpenCodeExportState(): void {
  openCodeStateCache.clear();
  openCodeStateInFlight.clear();
  // The gate's counters are module state too. A slot still held when a test
  // ends shifts the peak concurrency every later test observes, so clear them
  // here as well — resuming queued waiters rather than dropping them, so a
  // caller left mid-acquire cannot hang.
  for (const resume of openCodeExportQueue.splice(0)) resume();
  openCodeExportActive = 0;
}

export async function readOpenCodeState(
  sessionId?: string,
): Promise<OpenCodeStructuredState | null> {
  if (!sessionId) return null;

  const now = Date.now();
  const cached = openCodeStateCache.get(sessionId);
  if (cached && now - cached.at < OPENCODE_STATE_TTL_MS) {
    return cached.state;
  }
  const inFlight = openCodeStateInFlight.get(sessionId);
  if (inFlight) {
    return inFlight;
  }

  const pending = (async (): Promise<OpenCodeStructuredState | null> => {
    try {
      return parseOpenCodeState(await exportOpenCodeSession(sessionId));
    } catch {
      return null;
    }
  })();
  openCodeStateInFlight.set(sessionId, pending);
  try {
    const state = await pending;
    openCodeStateCache.set(sessionId, { at: Date.now(), state });
    // Expired entries are evicted here rather than on a timer: the map only
    // grows when a session is classified, so this is the one place it can.
    for (const [id, entry] of openCodeStateCache) {
      if (Date.now() - entry.at >= OPENCODE_STATE_TTL_MS) {
        openCodeStateCache.delete(id);
      }
    }
    return state;
  } finally {
    openCodeStateInFlight.delete(sessionId);
  }
}

export async function readOpenCodeConversation(
  sessionId?: string,
): Promise<TranscriptEntry[] | null> {
  if (!sessionId) return null;
  try {
    return parseOpenCodeExport(await exportOpenCodeSession(sessionId));
  } catch {
    return null;
  }
}
