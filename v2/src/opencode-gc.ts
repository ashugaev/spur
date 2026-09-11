// Reclaim for opencode's own store (`~/.local/share/opencode` on Linux, but
// never hardcoded — the root is resolved from `opencode db path`). Three
// reclaim units: store rows of opencode sessions owned by terminal Spur
// sessions, `snapshot/<projectId>/<worktreeHash>` leaves whose recorded git
// worktree is gone, and the unrotated `log/opencode.log`.
//
// Selection contract, and the whole safety argument: an opencode session is
// selected ONLY IF a Spur record's `agentSessionId` equals its id AND every
// such record is in the selectable set AND no record whose canonicalized
// `worktreePath` equals its canonicalized `directory` is outside that set.
// Every gate is a positive requirement. No rule here derives a deletion from
// the ABSENCE of a record, an absence from the CLI listing, or a lookup that
// failed — the CLI enumerates fewer sessions than the store holds, so an
// absence carries no information.
//
// Orphan reclaim (a store session with no Spur record) and tool-output
// reclaim are deliberately absent, not stubbed: both need parent attribution,
// and `session list --format json` exposes no parent linkage on opencode
// 1.18.30.
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, rm, stat, truncate } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { opencodeCommand, readOpenCodeJson } from "./agents/opencode.js";
import { readFreeKb } from "./disk-space.js";
import { listSessions, readSession } from "./metadata.js";
import { canReadProcessTree, snapshotProcesses } from "./process-tree.js";
import { workspaceIdOf } from "./session-desk.js";
import {
  isTerminalSessionStatus,
  type AppConfig,
  type OpenCodeGcStatus,
  type SessionRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

// A whole-store enumeration, not the single-worktree identity lookup
// OPENCODE_SESSION_LIST_TIMEOUT_MS (agents/opencode.ts) sizes. Separate call
// shape, separate budget.
export const OPENCODE_STORE_LIST_TIMEOUT_MS = 60_000;
// `--max-count` defaults to 100 and truncates SILENTLY: exit 0, valid JSON,
// no warning. Always pass it, and abort when the returned count reaches it.
export const OPENCODE_STORE_LIST_LIMIT = 100_000;
const DU_TIMEOUT_MS = 120_000;
const DB_PATH_TIMEOUT_MS = 20_000;
// 6.4x the 93 s measured on a 3.1 GB store.
const VACUUM_TIMEOUT_MS = 600_000;
const SESSION_DELETE_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One object of `opencode session list --format json`. Flat, all scalars. */
export interface OpenCodeStoreSession {
  id: string;
  directory: string;
  /** Top-level epoch millis. NOT the nested `time.updated` of `export`. */
  updated: number;
}

export type OpenCodeGcSkipReason =
  | "protected_live_record"
  /** GONE, but a live record matched the raw path or the readlink hop. */
  | "directory_gone_protected"
  /** A running process carries this session's id in its argv. */
  | "live_process_holds_session"
  /** OPAQUE only: realpath failed with something other than ENOENT, the
   *  process tree was unreadable, or a live record's symlink chain did not
   *  terminate in one hop. A gone directory is NOT this reason. */
  | "directory_unresolvable"
  | "no_record_match"
  | "too_recent"
  | "over_limit";

/**
 * Outcome of resolving a directory, discriminated by errno rather than by
 * the presence of a throw.
 */
export type PathResolution =
  | { state: "resolved"; canonical: string }
  /** realpath failed with errno exactly ENOENT: some path component is gone. */
  | { state: "gone" }
  /** Any other errno, or an error carrying no `code` at all. Fails closed. */
  | { state: "opaque" };

/** A record's path, plus the one readlink hop 9.4 needs when it will not resolve. */
export interface RecordPathInfo {
  resolution: PathResolution;
  /**
   * Lexical one-hop readlink target, resolved against the link's dirname.
   * Present only when the path is a symlink that did not resolve. `terminates`
   * is false when the hop lands on another symlink.
   */
  hop?: { target: string; terminates: boolean };
}

export type OpenCodeGcPlanReason =
  | "store_unresolved"
  | "enumeration_failed"
  | "enumeration_truncated";

export interface OpenCodeGcSessionEntry {
  id: string;
  directory: string;
  /** The resolved path, or the raw directory when the state is "gone". */
  canonicalDirectory: string;
  /** "gone" selections rest on the 9.2.1 fallback, not on a resolved path. */
  directoryState: "resolved" | "gone";
  updatedAt: string;
  ageDays: number;
  /** Rule-(a) matches. Never empty — an empty array means (c) authorized. */
  recordIds: string[];
}

export interface OpenCodeGcSkipEntry {
  id: string;
  reason: OpenCodeGcSkipReason;
}

export interface OpenCodeSnapshotLeafInput {
  path: string;
  /** `worktree` under `[core]` of the leaf's git config, or null. */
  worktreePath: string | null;
  worktreeExists: boolean;
}

export interface OpenCodeGcLogPlan {
  path: string;
  archivePath: string;
  sizeBytes: number;
  /** Requested tail, an input. Never a term in the freed-bytes formula. */
  tailBytes: number;
}

export interface OpenCodeGcEnumeration {
  /** Distinct candidate directories the listing was run from. */
  directories: string[];
  /** Directories whose listing failed. Their sessions stay invisible. */
  directoriesFailed: number;
  /** Distinct store sessions merged across every directory's listing. */
  listedCount: number;
  limit: number;
  truncated: boolean;
  /**
   * `opencode session list` is scoped by the cwd's PROJECT and has no
   * directory flag, so the plan sees only what the candidate directories
   * project to. An unlisted session is invisible, never unowned, and every
   * byte total is a floor.
   */
  note: string;
}

export interface OpenCodeGcVacuumPlan {
  dbPath: string | null;
  dbSizeBytes: number | null;
  freeBytes: number | null;
  requiredBytes: number | null;
  /** Interlocks (ii) and (iii). Interlock (i) is runtime, in the executor. */
  blockReasons: string[];
}

export interface OpenCodeGcPlan {
  storeRoot: string | null;
  reason: OpenCodeGcPlanReason | null;
  olderThanDays: number;
  statuses: OpenCodeGcStatus[];
  limit: number;
  sessions: OpenCodeGcSessionEntry[];
  skipped: OpenCodeGcSkipEntry[];
  snapshotLeaves: string[];
  log: OpenCodeGcLogPlan | null;
  enumeration: OpenCodeGcEnumeration;
  vacuum: OpenCodeGcVacuumPlan;
}

export interface OpenCodeGcSessionResult extends OpenCodeGcSessionEntry {
  deleted: boolean;
  /** Set when the execute-time re-read no longer matches the plan. */
  blockReason?: "changed_during_run";
  /** Which gate the delete-time directory re-check tripped, when it did. */
  recheck?: OpenCodeGcSkipReason;
  error?: string;
}

export interface OpenCodeGcLeafResult {
  path: string;
  sizeBytes: number | null;
  removed: boolean;
  error?: string;
}

export interface OpenCodeGcLogResult {
  path: string;
  archivePath: string;
  /** `du` of the live log, taken before any archive write. */
  duBytes: number | null;
  /**
   * `du` of the written archive on an executing run; the requested tail
   * clamped to the file size on a dry run, where no archive exists yet.
   */
  retainedBytes: number | null;
  freedBytes: number;
  /** True while `retainedBytes` is the projection, not a `du`. */
  projected: boolean;
  truncated: boolean;
  error?: string;
}

export interface OpenCodeGcReport {
  dryRun: boolean;
  storeRoot: string | null;
  reason: OpenCodeGcPlanReason | null;
  olderThanDays: number;
  statuses: OpenCodeGcStatus[];
  enumeration: OpenCodeGcEnumeration;
  sessions: OpenCodeGcSessionResult[];
  skipped: OpenCodeGcSkipEntry[];
  snapshotLeaves: OpenCodeGcLeafResult[];
  log: OpenCodeGcLogResult | null;
  vacuum: { attempted: boolean; ok: boolean; blockReasons: string[]; error?: string };
  totals: {
    sessionsSelected: number;
    sessionsDeleted: number;
    /** Selected, then refused at execute time by the freshness re-read. */
    sessionsBlocked: number;
    snapshotLeavesRemoved: number;
    /** FILE bytes only: snapshot leaves plus the log delta. Never DB bytes. */
    freedBytes: number | null;
    /**
     * stat delta across the VACUUM, the ONLY DB-byte number this feature
     * reports. Null unless a VACUUM actually ran, so a dry run never claims
     * one: every way to estimate the payload up front opens the store, and
     * even `sqlite3 "file:<db>?mode=ro" "<SELECT>"` rewrites the -shm.
     */
    dbFileBytesFreed: number | null;
    errors: number;
  };
}

export interface OpenCodeGcExecutorDeps {
  /** `du -s --block-size=1 --`, the same measurement session-gc.ts makes. */
  measureSize(path: string): Promise<number | null>;
  removePath(path: string): Promise<void>;
  /**
   * Fresh read of the rule-(a) records, straight off disk. `null` for a
   * record that no longer exists. Mirrors session-gc.ts's readGroupMembers.
   */
  readRecords(ids: readonly string[]): (SessionRecord | null)[];
  /**
   * Re-runs the FULL directory rule for one session at delete time: fresh
   * records, fresh realpath, fresh 9.2.1/9.4 comparison, against the process
   * snapshot taken once for the run. Returns a skip reason, or null to
   * proceed.
   *
   * Re-reading records alone is not enough — a live record added mid-run can
   * carry the SYMLINK spelling of a recreated directory, which raw
   * comparison cannot see. Precedent: currentLivenessBlockReason
   * (session-gc.ts:441-453) is called at execute time, not only at plan time.
   *
   * THE RE-CHECK NARROWS THE RACE, IT DOES NOT CLOSE IT. An irreducible
   * window remains between this call and `session delete`; only a lock
   * opencode does not offer could remove it. What this buys is a window of
   * one function call instead of one planning run.
   */
  recheckDirectory(entry: OpenCodeGcSessionEntry): Promise<OpenCodeGcSkipReason | null>;
  /**
   * `cwd` is the session's own canonicalized directory — the same scope the
   * listing that produced it ran under, since `session delete` is
   * project-scoped like `session list`.
   */
  deleteSession(id: string, cwd: string): Promise<void>;
  writeLogArchive(logPath: string, archivePath: string, tailBytes: number): Promise<void>;
  truncateLog(logPath: string): Promise<void>;
  statDbSize(): Promise<number | null>;
  vacuum(): Promise<void>;
}

export interface ExecuteOpenCodeGcOptions {
  dryRun: boolean;
  sizes: boolean;
  /** The daemon sweep passes false: a 93 s blocking VACUUM is CLI-only. */
  vacuum: boolean;
}

// ---------------------------------------------------------------------------
// Parsing and canonicalization (pure)
// ---------------------------------------------------------------------------

export function parseOpenCodeStoreSessions(stdout: string): OpenCodeStoreSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("opencode session list returned invalid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("opencode session list did not return an array");
  }
  const sessions: OpenCodeStoreSession[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const directory = record["directory"];
    const updated = record["updated"];
    if (typeof id !== "string" || typeof directory !== "string") continue;
    sessions.push({
      id,
      directory,
      updated: typeof updated === "number" && Number.isFinite(updated) ? updated : 0,
    });
  }
  return sessions;
}

/** First `worktree = <path>` under `[core]`. Never shells out to git. */
export function parseGitConfigWorktree(text: string): string | null {
  let inCore = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCore = /^\[core(\s|\])/i.test(line);
      continue;
    }
    if (!inCore) continue;
    const match = /^worktree\s*=\s*(.+)$/i.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function stripTrailingSep(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/**
 * Canonicalizes BOTH sides of every directory comparison. `===` on raw paths
 * is a defect, not a simplification: `~/projects/spur` is a symlink to
 * `~/projects/ao` on the host this was measured on, opencode stores the
 * resolved spelling, and 603 Spur records — 6 of them running — carry the
 * symlink spelling. Raw equality hides every one of them from the protection
 * union. A path that cannot be resolved maps to null and is handled
 * fail-closed by the caller, never treated as "does not match".
 */
export async function resolveCanonicalPaths(
  paths: Iterable<string>,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const path of new Set(paths)) {
    if (out.has(path)) continue;
    if (!path) {
      out.set(path, null);
      continue;
    }
    try {
      // No existsSync-then-realpath: that is a TOCTOU race for no gain.
      out.set(path, stripTrailingSep(await resolve(path)));
    } catch {
      out.set(path, null);
    }
  }
  return out;
}

/** IO the directory rule needs. Injected so every branch is testable. */
export interface DirectoryProbe {
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  isSymlink(path: string): Promise<boolean>;
}

export const REAL_DIRECTORY_PROBE: DirectoryProbe = {
  realpath,
  readlink,
  isSymlink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch {
      return false;
    }
  },
};

function errnoOf(error: unknown): string | undefined {
  // Narrow `unknown` with a guard before reading `.code`; no `any`.
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * ENOENT-ONLY ALLOW-LIST. Exactly one errno permits the gone fallback.
 *
 * Never a deny-list of known-bad codes: a future libuv errno absent from a
 * deny-list would default OPEN, and the worst outcome this feature can
 * produce is treating an EACCES on a live directory as "deleted". EACCES,
 * ELOOP, ENOTDIR, ENAMETOOLONG, ESTALE, EIO and an error carrying no `code`
 * at all all land in the default branch and fail closed.
 *
 * ENOENT means some path COMPONENT is missing, not "this directory was
 * deleted" — a vanished parent flips every session beneath it at once. The
 * render reports the gone count so that mass transition is visible, and
 * protection does not depend on the parent existing: 9.2.1's raw comparison
 * and 9.4's hop still match.
 */
export async function resolveDirectoryState(
  path: string,
  probe: DirectoryProbe,
): Promise<PathResolution> {
  if (!path) return { state: "opaque" };
  try {
    return { state: "resolved", canonical: stripTrailingSep(await probe.realpath(path)) };
  } catch (error: unknown) {
    return errnoOf(error) === "ENOENT" ? { state: "gone" } : { state: "opaque" };
  }
}

/**
 * A record's resolution plus, when it will not resolve, the single readlink
 * hop of 9.4. Node's realpath cannot resolve a DANGLING symlink; readlink
 * plus resolve can, and that is the only way a live record carrying the
 * symlink spelling of a deleted directory can still protect.
 */
export async function resolveRecordPathInfo(
  path: string,
  probe: DirectoryProbe,
): Promise<RecordPathInfo> {
  const resolution = await resolveDirectoryState(path, probe);
  if (resolution.state === "resolved") return { resolution };
  try {
    const target = stripTrailingSep(resolve(dirname(path), await probe.readlink(path)));
    // A hop that lands on another symlink has not terminated. One hop is a
    // deliberate bound on the effort, never a bound on the protection:
    // anything the hop cannot settle is refused, not allowed.
    return { resolution, hop: { target, terminates: !(await probe.isSymlink(target)) } };
  } catch {
    // Not a symlink, or unreadable. No hop to offer.
    return { resolution };
  }
}

// ---------------------------------------------------------------------------
// Planner (pure: no IO, no clock, no fs)
// ---------------------------------------------------------------------------

export interface OpenCodeGcPlanInput {
  storeRoot: string | null;
  reason?: OpenCodeGcPlanReason | null;
  sessions: readonly OpenCodeStoreSession[];
  records: readonly SessionRecord[];
  /** Per store-session directory, keyed by the raw string. */
  directoryStates: ReadonlyMap<string, PathResolution>;
  /** Per record worktreePath, keyed by the raw string. */
  recordPaths: ReadonlyMap<string, RecordPathInfo>;
  /** argv of every running process, or null when the tree is unreadable. */
  processArgs: readonly string[] | null;
  snapshotLeaves: readonly OpenCodeSnapshotLeafInput[];
  log: { path: string; sizeBytes: number } | null;
  now: Date;
  olderThanDays: number;
  statuses: readonly OpenCodeGcStatus[];
  limit: number;
  logMaxBytes: number;
  logTailBytes: number;
  directories: readonly string[];
  directoriesFailed: number;
  listedCount: number;
  listLimit: number;
  /** True when ANY directory's listing came back at the -n cap. */
  listTruncated: boolean;
  dbPath: string | null;
  dbSizeBytes: number | null;
  freeBytes: number | null;
}

const ENUMERATION_NOTE =
  "`opencode session list` is scoped by the cwd's project and has no directory flag, so this plan sees only what the candidate directories project to; an unlisted session is invisible, never unowned. Every byte total is a floor.";

function enumerationOf(
  input: OpenCodeGcPlanInput,
  truncated: boolean,
): OpenCodeGcPlan["enumeration"] {
  return {
    directories: [...input.directories],
    directoriesFailed: input.directoriesFailed,
    listedCount: input.listedCount,
    limit: input.listLimit,
    truncated,
    note: ENUMERATION_NOTE,
  };
}

function emptyPlan(
  input: OpenCodeGcPlanInput,
  reason: OpenCodeGcPlanReason | null,
): OpenCodeGcPlan {
  return {
    storeRoot: input.storeRoot,
    reason,
    olderThanDays: input.olderThanDays,
    statuses: [...input.statuses],
    limit: input.limit,
    sessions: [],
    skipped: [],
    snapshotLeaves: [],
    log: null,
    enumeration: enumerationOf(input, reason === "enumeration_truncated"),
    vacuum: {
      dbPath: input.dbPath,
      dbSizeBytes: input.dbSizeBytes,
      freeBytes: input.freeBytes,
      requiredBytes: input.dbSizeBytes === null ? null : input.dbSizeBytes * 2,
      // Not "no_sessions_deleted": the executor owns that reason and appends
      // it whenever deletedCount is 0, which an empty plan always is. One
      // source, or an empty dry run prints it twice.
      blockReasons: [],
    },
  };
}

export interface SessionProtectionInput {
  session: OpenCodeStoreSession;
  records: readonly SessionRecord[];
  byAgentSessionId: ReadonlyMap<string, SessionRecord[]>;
  byWorkspaceId: ReadonlyMap<string, SessionRecord[]>;
  selectable: ReadonlySet<string>;
  sessionState: PathResolution;
  recordPaths: ReadonlyMap<string, RecordPathInfo>;
  /**
   * argv of every running process, or null when the process tree could not
   * be read. Null DISABLES the gone fallback for the whole run — the same
   * degrade-to-report-only discipline cache-retention uses.
   */
  processArgs: readonly string[] | null;
}

export type SessionProtectionVerdict =
  | { reason: OpenCodeGcSkipReason }
  | {
      reason: null;
      direct: readonly SessionRecord[];
      canonicalDirectory: string;
      directoryState: "resolved" | "gone";
    };

/**
 * The full protection predicate, pure and shared: the planner runs it over
 * the enumerated store, and the executor RE-RUNS it immediately before each
 * `session delete`. One implementation, so the two can never disagree.
 */
export function evaluateSessionProtection(input: SessionProtectionInput): SessionProtectionVerdict {
  const { session, selectable, sessionState, recordPaths } = input;

  // 9.5, subtract-only and path-free: it can protect, it can never
  // authorize, so its incompleteness (a fresh spawn carries --prompt, not
  // --session, and is invisible to argv) is safe. Matched on the ses_ id,
  // NEVER on the binary name — resident opencode processes would otherwise
  // protect everything and silently restore the zero-reclaim bug.
  if (input.processArgs?.some((args) => args.includes(session.id))) {
    return { reason: "live_process_holds_session" };
  }

  // Rule (a): direct agentSessionId equality. The ONLY selecting rule.
  const direct = input.byAgentSessionId.get(session.id) ?? [];

  const coLocated: SessionRecord[] = [];
  let chainUnresolved = false;
  for (const record of input.records) {
    if (!record.worktreePath) continue;
    const info = recordPaths.get(record.worktreePath);
    const live = !selectable.has(record.status);
    if (sessionState.state === "resolved") {
      // 3.5 RESOLVED, unchanged: canonical on both sides.
      if (info?.resolution.state === "resolved") {
        if (info.resolution.canonical === sessionState.canonical) coLocated.push(record);
      } else if (record.worktreePath === session.directory) {
        // A record we cannot canonicalize never loses its protecting power;
        // it only loses the ability to match more widely.
        coLocated.push(record);
      }
      continue;
    }
    if (sessionState.state !== "gone") continue;
    // 9.2.1 GONE. No canonical comparison here, and adding one back is dead
    // code: realpath only ever returns an EXISTING path, which can never
    // equal a directory that does not exist.
    if (record.worktreePath === session.directory) {
      coLocated.push(record);
      continue;
    }
    // 9.4, the dangling-symlink hole. realpath cannot see through a link
    // whose target was deleted; one readlink hop can.
    if (!info?.hop) continue;
    if (info.hop.terminates && info.hop.target === session.directory) {
      coLocated.push(record);
      continue;
    }
    // A LIVE record whose hop did not settle makes the SESSION opaque. The
    // ambiguity is resolved against the delete, every time: a chain
    // S1 -> S2 -> D yields S2, which never equals the resolved D the store
    // recorded, and letting that fall through to "no match" would be
    // fail-open inside a fail-closed section.
    if (live) chainUnresolved = true;
  }

  const protection = new Map<string, SessionRecord>();
  for (const record of direct) protection.set(record.id, record);
  for (const record of coLocated) {
    for (const sibling of input.byWorkspaceId.get(workspaceIdOf(record)) ?? []) {
      protection.set(sibling.id, sibling);
    }
  }
  const protectedByRecord = [...protection.values()].some(
    (record) => !selectable.has(record.status),
  );

  if (sessionState.state === "gone" && protectedByRecord) {
    return { reason: "directory_gone_protected" };
  }
  if (protectedByRecord) return { reason: "protected_live_record" };
  if (direct.length === 0) return { reason: "no_record_match" };
  if (sessionState.state === "resolved") {
    return {
      reason: null,
      direct,
      canonicalDirectory: sessionState.canonical,
      directoryState: "resolved",
    };
  }
  // OPAQUE, or GONE with an unsettled live symlink chain, or GONE with the
  // process tree unreadable: never selectable.
  if (sessionState.state !== "gone" || chainUnresolved || input.processArgs === null) {
    return { reason: "directory_unresolvable" };
  }
  return {
    reason: null,
    direct,
    canonicalDirectory: session.directory,
    directoryState: "gone",
  };
}

export function planOpenCodeGc(input: OpenCodeGcPlanInput): OpenCodeGcPlan {
  if (input.storeRoot === null) return emptyPlan(input, "store_unresolved");
  if (input.reason) return emptyPlan(input, input.reason);
  // Derived by the collector, per directory: a merged count can legitimately
  // exceed one call's -n cap, so the cap can only be judged call by call.
  if (input.listTruncated) return emptyPlan(input, "enumeration_truncated");

  // The selectable set is exactly the configured statuses; every other status
  // is LIVE and protects. Default [completed, killed] is
  // isTerminalSessionStatus exactly, so spawning/running/paused/stopped/
  // errored all protect — never isRestorableStatus, which omits two of them.
  const selectable = new Set<string>(input.statuses);

  const byAgentSessionId = new Map<string, SessionRecord[]>();
  const byWorkspaceId = new Map<string, SessionRecord[]>();
  for (const record of input.records) {
    if (record.agentSessionId) {
      const bucket = byAgentSessionId.get(record.agentSessionId);
      if (bucket) bucket.push(record);
      else byAgentSessionId.set(record.agentSessionId, [record]);
    }
    const workspaceId = workspaceIdOf(record);
    const workspaceBucket = byWorkspaceId.get(workspaceId);
    if (workspaceBucket) workspaceBucket.push(record);
    else byWorkspaceId.set(workspaceId, [record]);
  }

  const selected: OpenCodeGcSessionEntry[] = [];
  const skipped: OpenCodeGcSkipEntry[] = [];
  const nowMs = input.now.getTime();

  for (const session of input.sessions) {
    const verdict = evaluateSessionProtection({
      session,
      records: input.records,
      byAgentSessionId,
      byWorkspaceId,
      selectable,
      sessionState: input.directoryStates.get(session.directory) ?? { state: "opaque" },
      recordPaths: input.recordPaths,
      processArgs: input.processArgs,
    });
    if (verdict.reason) {
      skipped.push({ id: session.id, reason: verdict.reason });
      continue;
    }
    const { direct, canonicalDirectory, directoryState } = verdict;
    const ageDays = (nowMs - session.updated) / DAY_MS;
    if (ageDays < input.olderThanDays) {
      skipped.push({ id: session.id, reason: "too_recent" });
      continue;
    }
    selected.push({
      id: session.id,
      directory: session.directory,
      canonicalDirectory,
      directoryState,
      updatedAt: new Date(session.updated).toISOString(),
      ageDays,
      recordIds: direct.map((record) => record.id),
    });
  }

  selected.sort((a, b) => b.ageDays - a.ageDays);
  for (const entry of selected.slice(input.limit)) {
    skipped.push({ id: entry.id, reason: "over_limit" });
  }
  const sessions = selected.slice(0, input.limit);

  const snapshotLeaves = input.snapshotLeaves
    .filter((leaf) => leaf.worktreePath !== null && !leaf.worktreeExists)
    .map((leaf) => leaf.path);

  const log =
    input.log && input.log.sizeBytes > input.logMaxBytes
      ? {
          path: input.log.path,
          archivePath: `${input.log.path}.1`,
          sizeBytes: input.log.sizeBytes,
          tailBytes: Math.min(input.log.sizeBytes, input.logTailBytes),
        }
      : null;

  const blockReasons: string[] = [];
  const requiredBytes = input.dbSizeBytes === null ? null : input.dbSizeBytes * 2;
  if (input.dbPath === null) blockReasons.push("db_path_unresolved");
  if (requiredBytes === null || input.freeBytes === null) blockReasons.push("free_space_unknown");
  else if (input.freeBytes < requiredBytes) blockReasons.push("insufficient_free_space");
  // VACUUM rewrites the whole DB under an exclusive lock. A live opencode
  // agent is an active writer, so this is the one moment the feature can hurt
  // a running session. A RECORD check, not a process check: opencode
  // processes are permanently resident, so a zero-process interlock would
  // mean the VACUUM never runs.
  if (
    input.records.some(
      (record) => record.agent === "opencode" && !isTerminalSessionStatus(record.status),
    )
  ) {
    blockReasons.push("live_opencode_record");
  }

  return {
    storeRoot: input.storeRoot,
    reason: null,
    olderThanDays: input.olderThanDays,
    statuses: [...input.statuses],
    limit: input.limit,
    sessions,
    skipped,
    snapshotLeaves,
    log,
    enumeration: enumerationOf(input, false),
    vacuum: {
      dbPath: input.dbPath,
      dbSizeBytes: input.dbSizeBytes,
      freeBytes: input.freeBytes,
      requiredBytes,
      blockReasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function executeOpenCodeGc(
  plan: OpenCodeGcPlan,
  deps: OpenCodeGcExecutorDeps,
  options: ExecuteOpenCodeGcOptions,
): Promise<OpenCodeGcReport> {
  const sessions: OpenCodeGcSessionResult[] = [];
  const leaves: OpenCodeGcLeafResult[] = [];
  let freedBytes = 0;
  let deletedCount = 0;
  let blockedCount = 0;
  let removedCount = 0;
  let errors = 0;

  // The plan's statuses were read at collect time. Enumeration alone costs
  // 2-4 s, the snapshot scan and the du of a 484 MB log follow, and each
  // delete carries a 60 s timeout — so by the last entry the snapshot is
  // minutes old. `completed` is in isRespawnableStatus and an opencode
  // resume is `--session <agentSessionId>`, so a session respawned inside
  // that window would come back EMPTY if its rows went. Re-read per entry,
  // immediately before its own delete, because the window keeps widening as
  // the loop proceeds.
  const selectable = new Set<string>(plan.statuses);
  for (const entry of plan.sessions) {
    if (options.dryRun) {
      sessions.push({ ...entry, deleted: false });
      continue;
    }
    if (isChangedDuringRun(deps, entry, selectable)) {
      blockedCount += 1;
      sessions.push({ ...entry, deleted: false, blockReason: "changed_during_run" });
      continue;
    }
    // Re-run the DIRECTORY rule too, not just the record read: a directory
    // recreated mid-run (`git worktree add` at the same path, a restore) can
    // acquire a live record whose worktreePath is the SYMLINK spelling,
    // which the raw record re-read above cannot see.
    let recheck: OpenCodeGcSkipReason | null;
    try {
      recheck = await deps.recheckDirectory(entry);
    } catch {
      recheck = "directory_unresolvable";
    }
    if (recheck) {
      blockedCount += 1;
      sessions.push({ ...entry, deleted: false, blockReason: "changed_during_run", recheck });
      continue;
    }
    try {
      await deps.deleteSession(entry.id, entry.canonicalDirectory);
      deletedCount += 1;
      sessions.push({ ...entry, deleted: true });
    } catch (error) {
      errors += 1;
      sessions.push({ ...entry, deleted: false, error: messageOf(error) });
    }
  }

  for (const path of plan.snapshotLeaves) {
    const sizeBytes = options.sizes ? await deps.measureSize(path) : null;
    if (options.dryRun) {
      freedBytes += sizeBytes ?? 0;
      leaves.push({ path, sizeBytes, removed: false });
      continue;
    }
    try {
      await deps.removePath(path);
      removedCount += 1;
      freedBytes += sizeBytes ?? 0;
      leaves.push({ path, sizeBytes, removed: true });
    } catch (error) {
      errors += 1;
      leaves.push({ path, sizeBytes, removed: false, error: messageOf(error) });
    }
  }

  let log: OpenCodeGcLogResult | null = null;
  if (plan.log) {
    const duBytes = options.sizes ? await deps.measureSize(plan.log.path) : null;
    if (options.dryRun) {
      // No archive exists yet, so the retained term is the requested tail
      // clamped to the file size — an apparent-size projection, up to one
      // filesystem block off the `du` an executing run measures.
      const retainedBytes = Math.min(plan.log.sizeBytes, plan.log.tailBytes);
      const logFreed = Math.max(0, (duBytes ?? 0) - retainedBytes);
      freedBytes += logFreed;
      log = {
        path: plan.log.path,
        archivePath: plan.log.archivePath,
        duBytes,
        retainedBytes,
        freedBytes: logFreed,
        projected: true,
        truncated: false,
      };
    } else {
      try {
        // Copy-truncate, never rename/unlink: every holder of this file opens
        // it O_APPEND, so ftruncate resumes all of them at offset 0 with no
        // sparse hole and no leaked inode. A rename would leave every live
        // opencode process writing to the archived inode forever. Writes
        // landing between the copy and the truncate are lost — one syscall
        // gap, accepted and documented in docs/commands.md.
        await deps.writeLogArchive(plan.log.path, plan.log.archivePath, plan.log.tailBytes);
        const retainedBytes = options.sizes ? await deps.measureSize(plan.log.archivePath) : null;
        await deps.truncateLog(plan.log.path);
        // Both terms are du numbers. Mixing a du with an apparent size leaves
        // a block of rounding.
        const logFreed = Math.max(0, (duBytes ?? 0) - (retainedBytes ?? 0));
        freedBytes += logFreed;
        log = {
          path: plan.log.path,
          archivePath: plan.log.archivePath,
          duBytes,
          retainedBytes,
          freedBytes: logFreed,
          projected: false,
          truncated: true,
        };
      } catch (error) {
        errors += 1;
        log = {
          path: plan.log.path,
          archivePath: plan.log.archivePath,
          duBytes,
          retainedBytes: null,
          freedBytes: 0,
          projected: false,
          truncated: false,
          error: messageOf(error),
        };
      }
    }
  }

  const vacuum = { attempted: false, ok: false, blockReasons: [...plan.vacuum.blockReasons] };
  let dbFileBytesFreed: number | null = null;
  // `dry_run` is its own reason, not folded into `no_sessions_deleted`: a
  // dry run must say why it did not VACUUM, and the guard stays load-bearing
  // rather than resting on "a dry run happens to delete nothing".
  if (options.dryRun) vacuum.blockReasons.push("dry_run");
  if (deletedCount === 0) vacuum.blockReasons.push("no_sessions_deleted");
  if (options.vacuum && vacuum.blockReasons.length === 0) {
    const before = await deps.statDbSize();
    try {
      vacuum.attempted = true;
      await deps.vacuum();
      vacuum.ok = true;
      const after = await deps.statDbSize();
      dbFileBytesFreed = before !== null && after !== null ? before - after : null;
    } catch (error) {
      // SQLite VACUUM builds a temp DB and swaps, so a failure leaves the
      // original intact. Never retried inside one run.
      errors += 1;
      Object.assign(vacuum, { ok: false, error: messageOf(error) });
    }
  }

  return {
    dryRun: options.dryRun,
    storeRoot: plan.storeRoot,
    reason: plan.reason,
    olderThanDays: plan.olderThanDays,
    statuses: plan.statuses,
    enumeration: plan.enumeration,
    sessions,
    skipped: plan.skipped,
    snapshotLeaves: leaves,
    log,
    vacuum,
    totals: {
      sessionsSelected: plan.sessions.length,
      sessionsDeleted: deletedCount,
      sessionsBlocked: blockedCount,
      snapshotLeavesRemoved: removedCount,
      freedBytes: options.sizes ? freedBytes : null,
      dbFileBytesFreed,
      errors,
    },
  };
}

/**
 * Fail-closed freshness gate. True means "refuse this entry". A record that
 * vanished, a read that threw, or a status that left the selectable set all
 * count as changed — never as a clean re-confirmation.
 *
 * Only the session deletes need this. A snapshot leaf is selected because
 * its recorded git worktree does not exist, and Spur never recreates a
 * removed worktree at the same path; its `du` already sits in the same loop
 * iteration as its removal. The log is selected on size, which only grows
 * during a run, so staleness cannot flip that decision toward acting.
 */
function isChangedDuringRun(
  deps: OpenCodeGcExecutorDeps,
  entry: OpenCodeGcSessionEntry,
  selectable: ReadonlySet<string>,
): boolean {
  let fresh: (SessionRecord | null)[];
  try {
    fresh = deps.readRecords(entry.recordIds);
  } catch {
    return true;
  }
  if (fresh.length !== entry.recordIds.length) return true;
  return fresh.some((record) => !record || !selectable.has(record.status));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Real dependency wiring
// ---------------------------------------------------------------------------

export interface OpenCodeGcCollectorDeps {
  /** `opencode db path`; null when the call fails or the path is not a file. */
  resolveStore(): Promise<{ storeRoot: string; dbPath: string } | null>;
  /**
   * One `opencode session list` run FROM `cwd`. The listing is scoped by
   * that directory's project and the CLI exposes no directory flag, so the
   * caller runs it once per distinct candidate directory. Measured on the
   * dev host, same command and same -n: cwd ~/projects/ao returns 280
   * sessions, cwd ~/.spur/worktrees returns 4, cwd ~ returns 4.
   */
  listStoreSessions(cwd: string): Promise<string>;
  listSpurRecords(): SessionRecord[];
  readSnapshotLeaves(storeRoot: string): Promise<OpenCodeSnapshotLeafInput[]>;
  statLog(storeRoot: string): Promise<{ path: string; sizeBytes: number } | null>;
  probe: DirectoryProbe;
  /**
   * argv of every running process, or null when the process tree cannot be
   * read. Null disables the gone fallback for the run.
   */
  processArgs(): Promise<readonly string[] | null>;
  freeBytes(path: string): Promise<number | null>;
  statPathSize(path: string): Promise<number | null>;
}

export interface CollectOpenCodeGcOptions {
  now: Date;
  olderThanDays: number;
  statuses: readonly OpenCodeGcStatus[];
  limit: number;
  logMaxBytes: number;
  logTailBytes: number;
}

/** All the IO the planner refuses to do, funnelled into one plan input. */
export async function collectOpenCodeGcPlan(
  deps: OpenCodeGcCollectorDeps,
  options: CollectOpenCodeGcOptions,
): Promise<OpenCodeGcPlan> {
  const base: OpenCodeGcPlanInput = {
    storeRoot: null,
    sessions: [],
    records: [],
    directoryStates: new Map(),
    recordPaths: new Map(),
    processArgs: null,
    snapshotLeaves: [],
    log: null,
    now: options.now,
    olderThanDays: options.olderThanDays,
    statuses: options.statuses,
    limit: options.limit,
    logMaxBytes: options.logMaxBytes,
    logTailBytes: options.logTailBytes,
    directories: [],
    directoriesFailed: 0,
    listedCount: 0,
    listLimit: OPENCODE_STORE_LIST_LIMIT,
    listTruncated: false,
    dbPath: null,
    dbSizeBytes: null,
    freeBytes: null,
  };

  const store = await deps.resolveStore();
  if (!store) return planOpenCodeGc(base);

  const records = deps.listSpurRecords();
  // Record paths resolve BEFORE enumeration, because they choose the
  // directories to enumerate from. Each also carries the one readlink hop
  // of 9.4, used only when the path itself will not resolve.
  const recordPaths = await resolveRecordPaths(records, deps.probe);

  const directories = candidateDirectories(records, options.statuses, recordPaths);
  const merged = new Map<string, OpenCodeStoreSession>();
  let directoriesFailed = 0;
  let listTruncated = false;
  for (const directory of directories) {
    try {
      const listed = parseOpenCodeStoreSessions(await deps.listStoreSessions(directory));
      // Judge the -n cap per call: a merged total across directories can
      // legitimately exceed one call's limit.
      if (listed.length >= OPENCODE_STORE_LIST_LIMIT) listTruncated = true;
      for (const session of listed) merged.set(session.id, session);
    } catch {
      // Losing one directory's listing only shrinks the candidate set, and
      // absence never authorizes a deletion, so carry on and report it.
      directoriesFailed += 1;
    }
  }
  const enumeration = { directories, directoriesFailed, listTruncated };
  if (directories.length > 0 && directoriesFailed === directories.length) {
    return planOpenCodeGc({
      ...base,
      ...enumeration,
      storeRoot: store.storeRoot,
      reason: "enumeration_failed",
    });
  }

  const sessions = [...merged.values()];
  const directoryStates = new Map<string, PathResolution>();
  for (const directory of new Set(sessions.map((entry) => entry.directory))) {
    directoryStates.set(directory, await resolveDirectoryState(directory, deps.probe));
  }

  return planOpenCodeGc({
    ...base,
    ...enumeration,
    storeRoot: store.storeRoot,
    sessions,
    records,
    directoryStates,
    recordPaths,
    processArgs: await deps.processArgs(),
    snapshotLeaves: await deps.readSnapshotLeaves(store.storeRoot),
    log: await deps.statLog(store.storeRoot),
    listedCount: sessions.length,
    dbPath: store.dbPath,
    dbSizeBytes: await deps.statPathSize(store.dbPath),
    freeBytes: await deps.freeBytes(dirname(store.dbPath)),
  });
}

/**
 * The distinct canonicalized directories worth enumerating from: those of
 * records that could supply a rule-(a) match.
 *
 * Restricted to `agent === "opencode"` records because only an opencode
 * record's `agentSessionId` can ever equal a `ses_` store id, so no other
 * record's directory can produce a match. Measured on the dev host at the
 * default statuses: 3 directories instead of 24, which at the measured 2-4 s
 * per listing is 12 s instead of 96 s per sweep.
 *
 * Narrowing here is safe by construction: it can only enumerate FEWER store
 * sessions, and a session that is never enumerated is never selected.
 */
export function candidateDirectories(
  records: readonly SessionRecord[],
  statuses: readonly OpenCodeGcStatus[],
  recordPaths: ReadonlyMap<string, RecordPathInfo>,
): string[] {
  const selectable = new Set<string>(statuses);
  const directories = new Set<string>();
  for (const record of records) {
    if (record.agent !== "opencode") continue;
    if (!record.agentSessionId) continue;
    if (!selectable.has(record.status)) continue;
    // A path that will not resolve cannot be a cwd; skip it rather than
    // guessing. A gone worktree is exactly this case, and its store sessions
    // still surface through the directories of records that DO resolve.
    const resolution = recordPaths.get(record.worktreePath)?.resolution;
    if (resolution?.state === "resolved") directories.add(resolution.canonical);
  }
  return [...directories].sort();
}

/**
 * argv of every running process, or null when the process tree cannot be
 * read. `snapshotProcesses` runs `ps -eo pid=,ppid=,rss=,etime=,args=` —
 * argv only, NOT the env-dumping `ps e` form, so this can never surface a
 * secret into a report. Null degrades the gone fallback to report-only,
 * matching cache-retention's discipline.
 */
export interface RecheckDirectoryDeps {
  listRecords(): SessionRecord[];
  probe: DirectoryProbe;
  statuses: readonly OpenCodeGcStatus[];
  processArgs(): Promise<readonly string[] | null>;
}

/**
 * Delete-time re-run of the full directory rule. Same evaluator the planner
 * uses, fresh inputs. Returns the gate that now refuses the session, or null
 * to proceed.
 */
export async function recheckSessionDirectory(
  entry: OpenCodeGcSessionEntry,
  deps: RecheckDirectoryDeps,
): Promise<OpenCodeGcSkipReason | null> {
  const records = deps.listRecords();
  const byAgentSessionId = new Map<string, SessionRecord[]>();
  const byWorkspaceId = new Map<string, SessionRecord[]>();
  for (const record of records) {
    if (record.agentSessionId) {
      const bucket = byAgentSessionId.get(record.agentSessionId);
      if (bucket) bucket.push(record);
      else byAgentSessionId.set(record.agentSessionId, [record]);
    }
    const workspaceId = workspaceIdOf(record);
    const workspaceBucket = byWorkspaceId.get(workspaceId);
    if (workspaceBucket) workspaceBucket.push(record);
    else byWorkspaceId.set(workspaceId, [record]);
  }
  const verdict = evaluateSessionProtection({
    session: { id: entry.id, directory: entry.directory, updated: 0 },
    records,
    byAgentSessionId,
    byWorkspaceId,
    selectable: new Set<string>(deps.statuses),
    sessionState: await resolveDirectoryState(entry.directory, deps.probe),
    recordPaths: await resolveRecordPaths(records, deps.probe),
    processArgs: await deps.processArgs(),
  });
  if (verdict.reason) return verdict.reason;
  // A directory that was GONE at plan time and RESOLVES now was recreated
  // under us; refuse rather than delete against the new state.
  return verdict.directoryState === entry.directoryState ? null : "directory_unresolvable";
}

export async function readProcessArgs(): Promise<readonly string[] | null> {
  if (!(await canReadProcessTree(process.pid))) return null;
  const snapshot = await snapshotProcesses();
  if (snapshot.status !== "ok") return null;
  return snapshot.processes.map((entry) => entry.args);
}

/** Resolves every record worktreePath once, with its 9.4 readlink hop. */
export async function resolveRecordPaths(
  records: readonly SessionRecord[],
  probe: DirectoryProbe,
): Promise<Map<string, RecordPathInfo>> {
  const out = new Map<string, RecordPathInfo>();
  for (const path of new Set(records.map((record) => record.worktreePath))) {
    if (!path || out.has(path)) continue;
    out.set(path, await resolveRecordPathInfo(path, probe));
  }
  return out;
}

async function measureSize(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-s", "--block-size=1", "--", path], {
      timeout: DU_TIMEOUT_MS,
    });
    const digits = /^(\d+)/.exec(stdout)?.[1];
    return digits ? Number.parseInt(digits, 10) : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readSnapshotLeaves(storeRoot: string): Promise<OpenCodeSnapshotLeafInput[]> {
  const root = join(storeRoot, "snapshot");
  const leaves: OpenCodeSnapshotLeafInput[] = [];
  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return leaves;
  }
  for (const project of projects) {
    const projectDir = join(root, project);
    let children: string[];
    try {
      children = (await readdir(projectDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const child of children) {
      const leafPath = join(projectDir, child);
      let worktreePath: string | null;
      try {
        worktreePath = parseGitConfigWorktree(await readFile(join(leafPath, "config"), "utf8"));
      } catch {
        worktreePath = null;
      }
      leaves.push({
        path: leafPath,
        worktreePath,
        worktreeExists: worktreePath === null ? true : await pathExists(worktreePath),
      });
    }
  }
  return leaves;
}

/** Streams the last `tailBytes` of `logPath` over `archivePath`. */
export async function writeLogTailArchive(
  logPath: string,
  archivePath: string,
  tailBytes: number,
): Promise<void> {
  const { size } = await stat(logPath);
  const start = Math.max(0, size - tailBytes);
  await pipeline(createReadStream(logPath, { start }), createWriteStream(archivePath));
}

export function createOpenCodeGcDeps(
  config: AppConfig,
): OpenCodeGcCollectorDeps & OpenCodeGcExecutorDeps {
  // Every vendor spawn this module makes carries the log cap. Section 8's
  // OPENCODE_CONFIG_CONTENT rides the tmux LAUNCH string only, so without
  // this the reclaim sweep writes INFO lines into the log it is reclaiming.
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ logLevel: config.opencodeGc.logLevel }) };
  // Explicit cwd, never inherited: a daemon-side spawn with no cwd inherits
  // the daemon's $HOME, the pattern behind ~692k `creating instance
  // directory=/home/alek` lines. worktreeDir is Spur-owned, stable, and not
  // any session's worktree. Used for the store-global calls only — `db path`
  // and `db VACUUM` ignore cwd. The listing and the per-session delete are
  // project-scoped and carry their own directory instead.
  const cwd = config.worktreeDir;
  let dbPath: string | null = null;
  let processArgsOnce: Promise<readonly string[] | null> | undefined;

  return {
    resolveStore: async () => {
      try {
        const raw = (
          await readOpenCodeJson(["db", "path"], { cwd, timeoutMs: DB_PATH_TIMEOUT_MS, env })
        ).trim();
        if (!raw) return null;
        const stats = await stat(raw);
        if (!stats.isFile()) return null;
        dbPath = raw;
        return { storeRoot: dirname(raw), dbPath: raw };
      } catch {
        // Fail closed: no fallback path, no guessed store root.
        return null;
      }
    },
    listStoreSessions: (listCwd) =>
      readOpenCodeJson(
        ["session", "list", "--format", "json", "-n", String(OPENCODE_STORE_LIST_LIMIT)],
        { cwd: listCwd, timeoutMs: OPENCODE_STORE_LIST_TIMEOUT_MS, env },
      ),
    listSpurRecords: () => listSessions(config.dataDir),
    readSnapshotLeaves,
    statLog: async (storeRoot) => {
      const path = join(storeRoot, "log", "opencode.log");
      try {
        return { path, sizeBytes: (await stat(path)).size };
      } catch {
        return null;
      }
    },
    probe: REAL_DIRECTORY_PROBE,
    processArgs: readProcessArgs,
    freeBytes: async (path) => {
      const freeKb = await readFreeKb(path);
      return freeKb === undefined ? null : freeKb * 1024;
    },
    statPathSize: async (path) => {
      try {
        return (await stat(path)).size;
      } catch {
        return null;
      }
    },
    measureSize,
    removePath: (path) => rm(path, { recursive: true, force: true }),
    readRecords: (ids) => ids.map((id) => readSession(config.dataDir, id)),
    recheckDirectory: (entry) =>
      recheckSessionDirectory(entry, {
        listRecords: () => listSessions(config.dataDir),
        probe: REAL_DIRECTORY_PROBE,
        statuses: config.opencodeGc.statuses,
        // One `ps` per executor run, not per session: 15 processes, and a
        // per-session re-snapshot would multiply the cost by the session
        // count for no additional safety inside one run.
        processArgs: () => (processArgsOnce ??= readProcessArgs()),
      }),
    deleteSession: async (id, deleteCwd) => {
      await execFileAsync(opencodeCommand(), ["session", "delete", id], {
        cwd: deleteCwd,
        timeout: SESSION_DELETE_TIMEOUT_MS,
        env: { ...process.env, ...env },
      });
    },
    writeLogArchive: writeLogTailArchive,
    truncateLog: (logPath) => truncate(logPath, 0),
    // No payload estimate, deliberately. Every way to size the selected rows
    // up front opens the store, and a read-only URI is not enough: measured
    // on a scratch WAL db, `sqlite3 "file:<db>?mode=ro" "<SELECT>"` rewrites
    // the -shm. DB reclaim is reported on the execute path only, as the
    // opencode.db size delta below, which costs a stat and no DB open.
    statDbSize: async () => {
      if (!dbPath) return null;
      try {
        return (await stat(dbPath)).size;
      } catch {
        return null;
      }
    },
    vacuum: async () => {
      await execFileAsync(opencodeCommand(), ["db", "VACUUM;"], {
        cwd,
        timeout: VACUUM_TIMEOUT_MS,
        env: { ...process.env, ...env },
      });
    },
  };
}
