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
import type {
  AgentName,
  ProjectConfig,
  SessionLink,
  SessionRecord,
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

export function snapshotSettings(project: ProjectConfig | undefined): {
  maxBytes: number;
  requireFinal: boolean;
} {
  return {
    maxBytes: project?.snapshots?.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
    requireFinal: project?.snapshots?.requireFinal ?? false,
  };
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
      while (offset < data.length) offset += writeSync(descriptor, data, offset);
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
