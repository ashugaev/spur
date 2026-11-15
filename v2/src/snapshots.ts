import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT,
  RATE_LIMIT_REACTIVATION_PROMPT,
} from "./reactivation-prompts.js";
import { DEFAULT_WAKE_FORMAT_PATTERN, DEFAULT_WAKE_MESSAGE } from "./wake-schedule.js";
import type {
  AgentName,
  ProjectConfig,
  SessionLink,
  SessionRecord,
  TranscriptEntry,
  WorkSnapshot,
  WorkSnapshotMeta,
  WorkSnapshotTrigger,
} from "./types.js";

export const DEFAULT_SNAPSHOT_MAX_BYTES = 32768;
/** 6x JSON escape expansion plus envelope stays under the 1_000_000 byte body cap. */
export const MAX_SNAPSHOT_BYTES_CEILING = 131072;

const VERSION_FILE = /^([1-9][0-9]*)\.json$/;
const TRIGGERS: readonly WorkSnapshotTrigger[] = ["manual", "timer", "hook", "event", "final"];
const AGENTS: readonly AgentName[] = ["claude", "codex", "cursor", "opencode"];

export class InvalidSnapshotRequestError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_snapshot_request";
}

export class SnapshotTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "snapshot_too_large";
  constructor(
    readonly limitBytes: number,
    readonly actualBytes: number,
    projectId: string,
  ) {
    super(
      `Snapshot is ${actualBytes} bytes; limit is ${limitBytes} bytes (projects.${projectId}.snapshots.maxBytes).`,
    );
  }
}

export class SnapshotConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "snapshot_conflict";
}

export class SnapshotCorruptError extends Error {
  readonly statusCode = 500;
  readonly code = "snapshot_corrupt";
  constructor(
    readonly sessionId: string,
    readonly version: number,
    message: string,
  ) {
    super(message);
  }
}

export class WorkSnapshotRequiredError extends Error {
  readonly statusCode = 409;
  readonly code = "work_snapshot_required";
  constructor(
    readonly sessionIds: string[],
    readonly required: "final" | "any",
  ) {
    super(
      required === "final"
        ? 'Spur snapshot required: write "$SPUR_SNAPSHOT_COMMAND" write --final --file <path> after your last ToDo change.'
        : 'Spur snapshot required: write "$SPUR_SNAPSHOT_COMMAND" write --file <path> after your last ToDo change.',
    );
  }
}

export const DEFAULT_SNAPSHOT_FRESHNESS_MINUTES = 30;
export const SNAPSHOT_HOOK_TOOL_NAME = "spur-snapshot-hook";
export const SNAPSHOT_HOOK_TURN_FILE = "snapshot-hook-turn";

/**
 * Text a Spur reminder starts with: ToDo nudges (session-service.ts), the snapshot request, and
 * the default one-off wake message and the rate-limit and server-error continue prompts.
 * Interval and daily wakes arrive wrapped and match DEFAULT_WAKE_FORMAT_PATTERN instead. A wake
 * with its own message is real input.
 */
export const SNAPSHOT_REMINDER_PREFIXES: readonly string[] = [
  "Spur ToDo still has open work:",
  "Spur ToDo needs human input:",
  "Spur ToDo is empty.",
  "Spur snapshot is stale:",
  DEFAULT_WAKE_MESSAGE,
  RATE_LIMIT_REACTIVATION_PROMPT,
  CLAUDE_SERVER_ERROR_REACTIVATION_PROMPT,
];

/** RegExp source matching a command that touches the session's Spur tools. The hook script embeds it. */
export const SPUR_SESSION_TOOL_PATTERN =
  "SPUR_(?:TODO|SNAPSHOT|SLOT)_COMMAND|SPUR_SESSION_TOOL_DIR|/session-tools/|spur-(?:todo|snapshot|slots)";

const SPUR_SESSION_TOOL_REGEX = new RegExp(SPUR_SESSION_TOOL_PATTERN);

const DEFAULT_WAKE_FORMAT_REGEX = new RegExp(DEFAULT_WAKE_FORMAT_PATTERN);

export function isSpurReminder(text: string): boolean {
  const trimmed = text.trim();
  return (
    SNAPSHOT_REMINDER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    DEFAULT_WAKE_FORMAT_REGEX.test(trimmed)
  );
}

export function isSpurToolCommand(command: string): boolean {
  return SPUR_SESSION_TOOL_REGEX.test(command);
}

export function snapshotRequestMessage(command: string): string {
  return `Spur snapshot is stale: work moved on since your latest snapshot. Write one now with ${command} write --file <path> (--file - reads stdin), then continue.`;
}

export function snapshotSettings(project: ProjectConfig | undefined): {
  enabled: boolean;
  maxBytes: number;
  requireFinal: boolean;
  freshnessMinutes: number;
} {
  return {
    enabled: project?.snapshots?.enabled ?? true,
    maxBytes: project?.snapshots?.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
    requireFinal: project?.snapshots?.requireFinal ?? false,
    freshnessMinutes: project?.snapshots?.freshnessMinutes ?? DEFAULT_SNAPSHOT_FRESHNESS_MINUTES,
  };
}

/** Due when the agent worked more than freshnessMs after the latest snapshot (or session start). */
export function snapshotDue(input: {
  latestAt: string | null;
  sessionCreatedAt: string;
  activityAt: Date | null;
  freshnessMs: number;
}): boolean {
  if (input.activityAt === null) return false;
  const baseline = Date.parse(input.latestAt ?? input.sessionCreatedAt);
  return input.activityAt.getTime() - baseline > input.freshnessMs;
}

function isSpurToolEntry(entry: Extract<TranscriptEntry, { kind: "tool" }>): boolean {
  return (
    entry.spurCall === true ||
    (entry.inputSummary !== undefined && isSpurToolCommand(entry.inputSummary))
  );
}

/**
 * Newest agent work above floorMs, walking entries backward. A user message opens a turn; in a
 * Spur-reminder turn only non-Spur tool calls count, never text, reasoning or Spur calls.
 * workMs is null when nothing counts; complete is false when the slice ended before the answer
 * was known (caller reads the full transcript). Entries without a timestamp (Cursor, OpenCode,
 * rare Codex lines) never meet the floor: they count as untimedActivityMs once their opener is
 * known, and a wholly untimed slice only counts its newest turn.
 */
export function lastAgentWorkMs(
  entries: readonly TranscriptEntry[],
  options: { untimedActivityMs: number; floorMs: number; atStart: boolean },
): { workMs: number | null; complete: boolean } {
  const { untimedActivityMs, floorMs, atStart } = options;
  if (entries.length > 0 && entries.every((entry) => entry.timestampMs === undefined)) {
    let hasAgentEntry = false;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry === undefined) continue;
      if (entry.kind === "message" && entry.role === "user") {
        return {
          workMs: hasAgentEntry && !isSpurReminder(entry.text) ? untimedActivityMs : null,
          complete: true,
        };
      }
      hasAgentEntry = true;
    }
    if (!hasAgentEntry) return { workMs: null, complete: true };
    // The newest turn's opener is not in the slice: its type is unknown.
    return atStart
      ? { workMs: untimedActivityMs, complete: true }
      : { workMs: null, complete: false };
  }
  const pending: number[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const ts = entry.timestampMs;
    if (entry.kind === "message" && entry.role === "user") {
      if (!isSpurReminder(entry.text) && pending.length > 0) {
        return { workMs: Math.max(...pending), complete: true };
      }
      pending.length = 0;
    } else if (ts === undefined) {
      pending.push(untimedActivityMs);
      continue;
    } else if (ts > floorMs) {
      if (entry.kind === "tool" && !isSpurToolEntry(entry)) return { workMs: ts, complete: true };
      pending.push(ts);
      continue;
    }
    if (pending.length === 0 && ts !== undefined && ts <= floorMs) {
      return { workMs: null, complete: true };
    }
  }
  if (pending.length === 0) return { workMs: null, complete: true };
  return atStart
    ? { workMs: Math.max(...pending), complete: true }
    : { workMs: null, complete: false };
}

export function snapshotDir(dataDir: string, sessionId: string, project?: string): string {
  const live = join(dataDir, "sessions", sessionId);
  if (!existsSync(live) && project) {
    const archived = join(dataDir, "sessions-archive", project, sessionId);
    if (existsSync(archived)) return join(archived, "snapshots");
  }
  return join(live, "snapshots");
}

function listVersions(dir: string): number[] {
  if (!existsSync(dir)) return [];
  const versions: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = VERSION_FILE.exec(name);
    if (match?.[1]) versions.push(Number(match[1]));
  }
  return versions.sort((a, b) => a - b);
}

function isLink(value: unknown): value is SessionLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return typeof link["label"] === "string" && typeof link["url"] === "string";
}

function parseSnapshot(text: string, owner: string, version: number): WorkSnapshot {
  const fail = (message: string): never => {
    throw new SnapshotCorruptError(owner, version, `Snapshot ${version} ${message}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("contains invalid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("is not an object");
  const value = raw as Record<string, unknown>;
  const nullableString = (field: string): boolean =>
    value[field] === null || typeof value[field] === "string";
  if (
    value["version"] !== version ||
    value["sessionId"] !== owner ||
    typeof value["at"] !== "string" ||
    Number.isNaN(Date.parse(value["at"])) ||
    typeof value["project"] !== "string" ||
    typeof value["agent"] !== "string" ||
    !AGENTS.includes(value["agent"] as AgentName) ||
    !nullableString("model") ||
    !nullableString("branch") ||
    !nullableString("headSha") ||
    !(value["dirty"] === null || typeof value["dirty"] === "boolean") ||
    typeof value["todoRevision"] !== "string" ||
    !Array.isArray(value["links"]) ||
    !value["links"].every(isLink) ||
    typeof value["trigger"] !== "string" ||
    !TRIGGERS.includes(value["trigger"] as WorkSnapshotTrigger) ||
    typeof value["final"] !== "boolean" ||
    typeof value["content"] !== "string"
  ) {
    return fail("has invalid fields");
  }
  return value as unknown as WorkSnapshot;
}

function readVersion(dir: string, owner: string, version: number): WorkSnapshot {
  return parseSnapshot(readFileSync(join(dir, `${version}.json`), "utf8"), owner, version);
}

function toMeta(snapshot: WorkSnapshot): WorkSnapshotMeta {
  const { content: _content, ...meta } = snapshot;
  return meta;
}

export function listSnapshots(dataDir: string, session: SessionRecord): WorkSnapshotMeta[] {
  const dir = snapshotDir(dataDir, session.id, session.project);
  return listVersions(dir).map((version) => toMeta(readVersion(dir, session.id, version)));
}

/** Undefined when the requested version (or any version for `latest`) does not exist. */
export function readSnapshot(
  dataDir: string,
  session: SessionRecord,
  version: number | "latest",
): WorkSnapshot | undefined {
  const dir = snapshotDir(dataDir, session.id, session.project);
  const target = version === "latest" ? listVersions(dir).at(-1) : version;
  if (target === undefined || !existsSync(join(dir, `${target}.json`))) return undefined;
  return readVersion(dir, session.id, target);
}

export interface WriteSnapshotInput {
  content: string;
  final: boolean;
}

export interface SnapshotWriteContext {
  maxBytes: number;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  todoRevision: string;
  links: SessionLink[];
}

export function writeSnapshot(
  dataDir: string,
  session: SessionRecord,
  input: WriteSnapshotInput,
  context: SnapshotWriteContext,
): WorkSnapshotMeta {
  const actualBytes = Buffer.byteLength(input.content, "utf8");
  if (actualBytes > context.maxBytes) {
    throw new SnapshotTooLargeError(context.maxBytes, actualBytes, session.project);
  }
  const dir = snapshotDir(dataDir, session.id, session.project);
  mkdirSync(dir, { recursive: true });
  const version = (listVersions(dir).at(-1) ?? 0) + 1;
  const snapshot: WorkSnapshot = {
    version,
    at: new Date().toISOString(),
    sessionId: session.id,
    project: session.project,
    agent: session.agent,
    model: session.model ?? null,
    branch: context.branch,
    headSha: context.headSha,
    dirty: context.dirty,
    todoRevision: context.todoRevision,
    links: context.links,
    trigger: input.final ? "final" : "manual",
    final: input.final,
    content: input.content,
  };
  const tmp = join(dir, `.${version}.json.tmp.${process.pid}.${randomUUID()}`);
  try {
    const descriptor = openSync(tmp, "wx", 0o600);
    try {
      const data = Buffer.from(JSON.stringify(snapshot), "utf8");
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(descriptor, data, offset);
        if (written === 0) throw new Error("Snapshot write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(tmp, join(dir, `${version}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SnapshotConflictError(`Snapshot version ${version} already exists`);
      }
      throw error;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist when open failed
    }
  }
  return toMeta(snapshot);
}

/**
 * True when the gate blocks: no snapshot (final one for "final") exists since the
 * last ToDo change. Scans newest first and stops at the first older revision.
 */
export function snapshotGateBlock(
  dataDir: string,
  session: SessionRecord,
  todoRevision: string,
  require: "final" | "any",
): boolean {
  const dir = snapshotDir(dataDir, session.id, session.project);
  for (const version of listVersions(dir).reverse()) {
    const snapshot = readVersion(dir, session.id, version);
    if (snapshot.todoRevision !== todoRevision) return true;
    if (require === "any" || snapshot.final) return false;
  }
  return true;
}
