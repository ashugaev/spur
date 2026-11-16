import { createHash, randomUUID } from "node:crypto";
import {
  type Dirent,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  type Stats,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, matchesGlob, sep } from "node:path";
import { AGENT_HISTORY_ARTIFACT_PREFIX } from "./agent-history-delta.js";
import type {
  CloseoutManifest,
  CloseoutManifestView,
  CloseoutRoot,
  ProjectConfig,
  SessionLink,
  SessionRecord,
} from "./types.js";

export const CLOSEOUT_ROOTS: readonly CloseoutRoot[] = ["artifacts", "work", "workspace"];
export const DEFAULT_CLOSEOUT_INCLUDE: readonly string[] = ["work:**", "artifacts:**"];
export const DEFAULT_CLOSEOUT_MAX_BYTES = 52428800;
export const CLOSEOUT_WALK_MAX_ENTRIES = 20000;

const MANIFEST_FILE = "manifest.json";
const FILES_DIR = "files";
const TMP_PREFIX = ".tmp-";
export const CLOSEOUT_VERSION = /^[1-9][0-9]*$/;
// Every character matchesGlob treats as syntax, extglob prefixes and alternation included.
const GLOB_MAGIC = /[*?[\]{}()!+@|]/;
const DAY_MS = 86_400_000;

export class CloseoutCorruptError extends Error {
  readonly statusCode = 500;
  readonly code = "closeout_corrupt";
  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message);
  }
}

export function closeoutSettings(project: ProjectConfig | undefined): {
  enabled: boolean;
  include: readonly string[];
  maxBytes: number;
  retentionDays: number | null;
} {
  return {
    enabled: project?.closeout?.enabled ?? true,
    include: project?.closeout?.include ?? DEFAULT_CLOSEOUT_INCLUDE,
    maxBytes: project?.closeout?.maxBytes ?? DEFAULT_CLOSEOUT_MAX_BYTES,
    retentionDays: project?.closeout?.retentionDays ?? null,
  };
}

/** Explicit owner location, same contract as snapshotDirAt: never infer it from dir existence. */
export function closeoutDirAt(
  dataDir: string,
  session: Pick<SessionRecord, "id" | "project">,
  location: "live" | "archived",
): string {
  return location === "live"
    ? join(dataDir, "sessions", session.id, "closeout")
    : join(dataDir, "sessions-archive", session.project, session.id, "closeout");
}

export interface CloseoutWriteInput {
  /** The session's shard directory (sessions/<id>); the archive lands in its closeout/ child. */
  sessionDir: string;
  sessionId: string;
  project: string;
  completedAt: string;
  links: SessionLink[];
  snapshotVersion: number | null;
  headSha: string | null;
  /** Absolute root directories; null when the session has no such root. */
  roots: Record<CloseoutRoot, string | null>;
  include: readonly string[];
  maxBytes: number;
}

interface Candidate {
  root: CloseoutRoot;
  path: string;
  /** Pattern body, for the agent-history rule. */
  glob: string;
}

interface Pattern {
  root: CloseoutRoot;
  glob: string;
}

function parsePattern(pattern: string): Pattern {
  const colon = pattern.indexOf(":");
  return { root: pattern.slice(0, colon) as CloseoutRoot, glob: pattern.slice(colon + 1) };
}

function literalBase(glob: string): string[] {
  const segments = glob.split("/");
  const base: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    base.push(segment);
  }
  return base;
}

function byPath(a: Candidate, b: Candidate): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function entryKind(entry: Dirent, fullPath: string): "file" | "directory" | "other" | "unknown" {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "other";
  try {
    const stat = lstatSync(fullPath);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "unknown";
  }
}

// A root that is itself a symlink is missing: only its ancestors may be links (home dirs).
function realRoot(root: string | null): string | null {
  if (root === null) return null;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    return realpathSync(root);
  } catch {
    return null;
  }
}

/** Carries what the walk collected before the entry budget ran out. */
class WalkBudgetError extends Error {
  constructor(readonly found: Candidate[]) {
    super("walk budget exhausted");
  }
}

function collectCandidates(
  sessionId: string,
  root: CloseoutRoot,
  rootDir: string,
  glob: string,
  budget: { left: number },
  unreadable: CloseoutManifest["skipped"],
): Candidate[] {
  const found: Candidate[] = [];
  const base = literalBase(glob);
  const consider = (relPath: string): void => {
    if (!matchesGlob(relPath, glob)) return;
    const candidate = { root, path: relPath, glob };
    if (!isForeignOrExcludedCapture(candidate, sessionId)) found.push(candidate);
  };
  // lstat every base segment: a symlink anywhere on the literal path ends the pattern.
  const baseKind = ((): "file" | "directory" | "other" => {
    for (let depth = 1; depth <= base.length; depth += 1) {
      try {
        const stat = lstatSync(join(rootDir, ...base.slice(0, depth)));
        if (stat.isSymbolicLink()) return "other";
        if (depth === base.length)
          return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
        if (!stat.isDirectory()) return "other";
      } catch {
        return "other";
      }
    }
    return "directory";
  })();
  if (baseKind === "file") {
    consider(base.join("/"));
    return found;
  }
  if (baseKind !== "directory") return found;
  const stack: string[][] = [base];
  while (stack.length > 0) {
    const dirSegments = stack.pop() as string[];
    let entries: Dirent[];
    try {
      entries = readdirSync(join(rootDir, ...dirSegments), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      budget.left -= 1;
      if (budget.left < 0) {
        found.sort(byPath);
        throw new WalkBudgetError(found);
      }
      const segments = [...dirSegments, entry.name];
      const kind = entryKind(entry, join(rootDir, ...segments));
      if (kind === "file") {
        consider(segments.join("/"));
      } else if (kind === "directory") {
        if (!entry.name.startsWith(".")) stack.push(segments);
      } else if (kind === "unknown") {
        unreadable.push({ root, path: segments.join("/"), bytes: 0, reason: "unreadable" });
      }
    }
  }
  found.sort(byPath);
  return found;
}

function isForeignOrExcludedCapture(candidate: Candidate, sessionId: string): boolean {
  if (candidate.root !== "artifacts" || candidate.path.includes("/")) return false;
  if (!candidate.path.startsWith(AGENT_HISTORY_ARTIFACT_PREFIX)) return false;
  return !(
    candidate.glob.startsWith(AGENT_HISTORY_ARTIFACT_PREFIX) &&
    candidate.path.startsWith(`${AGENT_HISTORY_ARTIFACT_PREFIX}${sessionId}-`)
  );
}

type BoundedRead =
  | { kind: "ok"; data: Buffer }
  | { kind: "skip"; reason: "max_bytes" | "unreadable" | "changed"; bytes: number };

const READ_CHUNK_BYTES = 65536;

/** True when the opened fd is the file at `source`, a canonical path (ancestors not swapped). */
function fdIsAt(fd: number, source: string, opened: Stats): boolean {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === source;
    } catch {
      // /proc unavailable: use the portable check below.
    }
  }
  try {
    const at = lstatSync(source);
    return (
      realpathSync(dirname(source)) === dirname(source) &&
      at.dev === opened.dev &&
      at.ino === opened.ino
    );
  } catch {
    return false;
  }
}

/**
 * Opens without blocking (a FIFO would hang the daemon) or following the leaf, checks the fd
 * is the file at `source`, and reads at most budget + 1 bytes.
 */
function readBounded(source: string, budget: number): BoundedRead {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "skip", reason: "unreadable", bytes: stat.size };
    if (!fdIsAt(fd, source, stat)) {
      return { kind: "skip", reason: "changed", bytes: stat.size };
    }
    if (stat.size > budget) return { kind: "skip", reason: "max_bytes", bytes: stat.size };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= budget) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, budget + 1 - total));
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      chunks.push(chunk.subarray(0, got));
      total += got;
    }
    if (total > budget)
      return { kind: "skip", reason: "max_bytes", bytes: Math.max(total, stat.size) };
    return { kind: "ok", data: Buffer.concat(chunks, total) };
  } finally {
    closeSync(fd);
  }
}

function fileSizeHint(fullPath: string): number {
  try {
    return lstatSync(fullPath).size;
  } catch {
    return 0;
  }
}

/** Ascending archive versions under sessions/<id>/closeout/; empty when none. */
export function listCloseoutVersions(dir: string): number[] {
  try {
    return readdirSync(dir)
      .filter((name) => CLOSEOUT_VERSION.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function removeStaleTemps(closeoutDir: string): string | null {
  let failure: string | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(closeoutDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    try {
      rmSync(join(closeoutDir, name), { recursive: true, force: true });
    } catch (error) {
      failure = `Stale temp removal failed for ${name}: ${errorText(error)}`;
    }
  }
  return failure;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies the selected session files into sessions/<id>/closeout/<n>/ (n = latest + 1) and
 * returns the manifest. Build problems land in manifest.error and the manifest is still written;
 * only a failure to write the manifest or move the archive into place throws. Never writes a
 * top-level .json file into the shard directory (listSessions parses those as records).
 */
export function writeCloseoutArchive(input: CloseoutWriteInput): CloseoutManifest {
  const closeoutDir = join(input.sessionDir, "closeout");
  mkdirSync(closeoutDir, { recursive: true });
  const manifest: CloseoutManifest = {
    version: (listCloseoutVersions(closeoutDir).at(-1) ?? 0) + 1,
    sessionId: input.sessionId,
    project: input.project,
    completedAt: input.completedAt,
    links: input.links,
    snapshotVersion: input.snapshotVersion,
    headSha: input.headSha,
    files: [],
    skipped: [],
    missingRoots: [],
  };
  const problems: string[] = [];
  const staleFailure = removeStaleTemps(closeoutDir);
  if (staleFailure) problems.push(staleFailure);
  const tmpDir = join(closeoutDir, `${TMP_PREFIX}${randomUUID()}`);
  mkdirSync(join(tmpDir, FILES_DIR), { recursive: true });
  try {
    buildArchive(input, manifest, tmpDir, problems);
  } catch (error) {
    problems.push(errorText(error));
  }
  if (problems.length > 0) manifest.error = problems.join("; ");
  try {
    writeFileSync(join(tmpDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(tmpDir, join(closeoutDir, String(manifest.version)));
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

function buildArchive(
  input: CloseoutWriteInput,
  manifest: CloseoutManifest,
  tmpDir: string,
  problems: string[],
): void {
  const roots = {} as Record<CloseoutRoot, string | null>;
  for (const root of CLOSEOUT_ROOTS) roots[root] = realRoot(input.roots[root]);
  const patterns = input.include.map(parsePattern);
  const named = new Set(patterns.map((pattern) => pattern.root));
  manifest.missingRoots = CLOSEOUT_ROOTS.filter((root) => named.has(root) && roots[root] === null);

  const budget = { left: CLOSEOUT_WALK_MAX_ENTRIES };
  const seen = new Set<string>();
  const ordered: Candidate[] = [];
  const add = (found: Candidate[]): void => {
    for (const candidate of found) {
      const key = `${candidate.root}\u0000${candidate.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(candidate);
    }
  };
  try {
    for (const pattern of patterns) {
      const rootDir = roots[pattern.root];
      if (rootDir === null) continue;
      add(
        collectCandidates(
          input.sessionId,
          pattern.root,
          rootDir,
          pattern.glob,
          budget,
          manifest.skipped,
        ),
      );
    }
  } catch (error) {
    if (!(error instanceof WalkBudgetError)) throw error;
    add(error.found);
    problems.push(`Walk stopped after ${CLOSEOUT_WALK_MAX_ENTRIES} entries`);
  }

  let remaining = input.maxBytes;
  for (const candidate of ordered) {
    const rootDir = roots[candidate.root] as string;
    const source = join(rootDir, ...candidate.path.split("/"));
    let read: BoundedRead;
    try {
      read = readBounded(source, remaining);
    } catch {
      read = { kind: "skip", reason: "unreadable", bytes: fileSizeHint(source) };
    }
    if (read.kind === "skip") {
      manifest.skipped.push({
        root: candidate.root,
        path: candidate.path,
        bytes: read.bytes,
        reason: read.reason,
      });
      continue;
    }
    const target = join(tmpDir, FILES_DIR, candidate.root, ...candidate.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read.data);
    remaining -= read.data.length;
    manifest.files.push({
      root: candidate.root,
      path: candidate.path,
      bytes: read.data.length,
      sha256: createHash("sha256").update(read.data).digest("hex"),
    });
  }
}

function isManifest(value: unknown, sessionId: string): value is CloseoutManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    v.sessionId === sessionId &&
    typeof v.project === "string" &&
    typeof v.completedAt === "string" &&
    Array.isArray(v.links) &&
    Array.isArray(v.files) &&
    Array.isArray(v.skipped) &&
    Array.isArray(v.missingRoots)
  );
}

/**
 * Latest manifest, or the given version's, with every version listed. Null when the session has
 * no archive or no such version; CloseoutCorruptError when manifest.json is unusable.
 */
export function readCloseoutManifest(
  dir: string,
  sessionId: string,
  version?: number,
): CloseoutManifestView | null {
  const versions = listCloseoutVersions(dir);
  const selected = version ?? versions.at(-1);
  if (selected === undefined || !versions.includes(selected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, String(selected), MANIFEST_FILE), "utf8"));
  } catch {
    throw new CloseoutCorruptError(sessionId, "Closeout manifest is missing or invalid JSON");
  }
  if (!isManifest(parsed, sessionId) || parsed.version !== selected) {
    throw new CloseoutCorruptError(sessionId, "Closeout manifest has an unexpected shape");
  }
  return { ...parsed, versions };
}

/**
 * Resolves "<root>/<path>" to a regular file under closeout/<version>/files/<root>, or null
 * (version defaults to the latest). The caller has already rejected empty, ".", ".." and
 * backslash segments.
 */
export function resolveCloseoutFile(
  dir: string,
  rootAndPath: string,
  version?: number,
): { path: string; size: number; name: string } | null {
  const segments = rootAndPath.split("/");
  const root = segments[0] as CloseoutRoot;
  if (segments.length < 2 || !CLOSEOUT_ROOTS.includes(root)) return null;
  const selected = version ?? listCloseoutVersions(dir).at(-1);
  if (selected === undefined) return null;
  try {
    const rootDir = realpathSync(join(dir, String(selected), FILES_DIR, root));
    const target = realpathSync(join(rootDir, ...segments.slice(1)));
    if (!target.startsWith(rootDir + sep)) return null;
    const stat = lstatSync(target);
    if (!stat.isFile()) return null;
    return { path: target, size: stat.size, name: segments[segments.length - 1] as string };
  } catch {
    return null;
  }
}

/**
 * Per version: deletes files/ and stamps expiredAt once its completedAt + retentionDays has
 * passed. Returns how many versions expired.
 */
export function expireCloseout(
  dir: string,
  sessionId: string,
  retentionDays: number,
  now: number,
): number {
  let expired = 0;
  for (const version of listCloseoutVersions(dir)) {
    const manifest = readCloseoutManifest(dir, sessionId, version);
    if (!manifest || manifest.expiredAt) continue;
    if (Date.parse(manifest.completedAt) + retentionDays * DAY_MS > now) continue;
    const versionDir = join(dir, String(version));
    rmSync(join(versionDir, FILES_DIR), { recursive: true, force: true });
    const { versions: _versions, ...stored } = manifest;
    const next: CloseoutManifest = { ...stored, expiredAt: new Date(now).toISOString() };
    const tmp = join(versionDir, `${MANIFEST_FILE}.tmp-${randomUUID()}`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, join(versionDir, MANIFEST_FILE));
    expired += 1;
  }
  return expired;
}
