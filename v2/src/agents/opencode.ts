import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellEscape } from "./shell-escape.js";
import type { AgentLaunchPlan, AgentResumePlan } from "./types.js";
import type { SidecarMcpBinding, TranscriptEntry } from "../types.js";

const execFileAsync = promisify(execFile);

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
  return process.env["SPUR_OPENCODE_BIN"] || "opencode";
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
    launchCommand: launchCommand(opencodeCommand(), "--auto", options),
    initialMessage: prompt,
    readyMarkers: ["OpenCode", "Ask anything"],
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
    readyMarkers: ["OpenCode", "Ask anything"],
  };
}

interface OpenCodeSession {
  id?: unknown;
  directory?: unknown;
  time?: { updated?: unknown };
}

export interface OpenCodeSessionBaseline {
  worktreePath: string;
  sessionIds: Set<string>;
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
    .sort((left, right) => Number(right.time?.updated ?? 0) - Number(left.time?.updated ?? 0));
  return typeof sessions[0]?.id === "string" ? sessions[0].id : null;
}

export async function findOpenCodeSessionId(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      opencodeCommand(),
      ["session", "list", "--format", "json"],
      { cwd: worktreePath, encoding: "utf8", timeout: 5_000 },
    );
    return parseSessionList(JSON.parse(stdout) as unknown, worktreePath);
  } catch {
    return null;
  }
}

async function listOpenCodeSessionIds(worktreePath: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    opencodeCommand(),
    ["session", "list", "--format", "json"],
    { cwd: worktreePath, encoding: "utf8", timeout: 5_000 },
  );
  const value = JSON.parse(stdout) as unknown;
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

function hasPendingRequest(value: unknown, key: "permission" | "question"): boolean {
  if (!isRecord(value)) return false;
  const requests = value[key] ?? value[`${key}s`];
  if (Array.isArray(requests) && requests.length > 0) return true;
  return openCodeMessages(value).some((message) =>
    (Array.isArray(message["parts"]) ? message["parts"] : []).some(
      (part) => isRecord(part) && part["type"] === key,
    ),
  );
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
  if (hasPendingRequest(value, "permission")) {
    return { state: "needs_input", reason: "permission pending" };
  }
  if (hasPendingRequest(value, "question")) {
    return { state: "needs_input", reason: "question pending" };
  }
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
  const parts = Array.isArray(last?.["parts"]) ? last["parts"] : [];
  const retry = parts.find((part) => isRecord(part) && part["type"] === "retry");
  if (retry) {
    return isRateLimit(retry)
      ? { state: "rate_limited", reason: "assistant retry rate limit" }
      : { state: "working", reason: "assistant retry" };
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

async function exportOpenCodeSession(sessionId: string): Promise<unknown> {
  const { stdout } = await execFileAsync(opencodeCommand(), ["export", sessionId], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return JSON.parse(stdout) as unknown;
}

export interface OpenCodeSubmitBaseline {
  sessionId: string;
  messageIds: Set<string>;
}

export async function captureOpenCodeSubmitBaseline(
  sessionId?: string,
): Promise<OpenCodeSubmitBaseline | null> {
  if (!sessionId) return null;
  try {
    const messageIds = new Set<string>();
    for (const message of openCodeMessages(await exportOpenCodeSession(sessionId))) {
      const id = messageInfo(message)?.["id"];
      if (typeof id === "string") messageIds.add(id);
    }
    return { sessionId, messageIds };
  } catch {
    return null;
  }
}

export async function scanOpenCodeExportForMessage(
  baseline: OpenCodeSubmitBaseline,
  text: string,
): Promise<boolean> {
  try {
    const candidates: Record<string, unknown>[] = [];
    for (const message of openCodeMessages(await exportOpenCodeSession(baseline.sessionId))) {
      const record = messageInfo(message);
      const id = record?.["id"];
      if (record?.["role"] === "user" && typeof id === "string" && !baseline.messageIds.has(id)) {
        candidates.push(message);
      }
    }
    return candidates.length === 1 && textFromParts(candidates[0]?.["parts"]) === text;
  } catch {
    return false;
  }
  return false;
}

export async function readOpenCodeState(
  sessionId?: string,
): Promise<OpenCodeStructuredState | null> {
  if (!sessionId) return null;
  try {
    return parseOpenCodeState(await exportOpenCodeSession(sessionId));
  } catch {
    return null;
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
