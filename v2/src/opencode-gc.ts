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
import { readdir, readFile, realpath, rm, stat, truncate } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { opencodeCommand, readOpenCodeJson } from "./agents/opencode.js";
import { readFreeKb } from "./disk-space.js";
import { listSessions, readSession } from "./metadata.js";
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
  | "no_record_match"
  | "directory_unresolvable"
  | "too_recent"
  | "over_limit";

export type OpenCodeGcPlanReason =
  | "store_unresolved"
  | "enumeration_failed"
  | "enumeration_truncated";

export interface OpenCodeGcSessionEntry {
  id: string;
  directory: string;
  canonicalDirectory: string;
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

// ---------------------------------------------------------------------------
// Planner (pure: no IO, no clock, no fs)
// ---------------------------------------------------------------------------

export interface OpenCodeGcPlanInput {
  storeRoot: string | null;
  reason?: OpenCodeGcPlanReason | null;
  sessions: readonly OpenCodeStoreSession[];
  records: readonly SessionRecord[];
  canonicalPaths: ReadonlyMap<string, string | null>;
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
  const canon = (path: string): string | null => input.canonicalPaths.get(path) ?? null;

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
    const sessionCanon = canon(session.directory);
    // Rule (a): direct agentSessionId equality. The ONLY selecting rule.
    const direct = byAgentSessionId.get(session.id) ?? [];
    // Rule (c): canonicalized directory co-location, unioned across
    // workspaceId. PROTECTION-ONLY — a shared directory proves co-location,
    // not ownership, and worktreePath is not unique.
    const coLocated = input.records.filter((record) => {
      const recordCanon = canon(record.worktreePath);
      if (sessionCanon !== null && recordCanon !== null) return sessionCanon === recordCanon;
      // A record whose worktreePath cannot be canonicalized keeps its
      // protecting power on raw equality; it only loses the ability to match
      // more widely.
      return record.worktreePath !== "" && record.worktreePath === session.directory;
    });
    const protection = new Map<string, SessionRecord>();
    for (const record of direct) protection.set(record.id, record);
    // One insertion path for the co-located half: every record sits in its
    // OWN workspace bucket, so the union below already re-inserts each
    // co-located record. Adding them here too was a second path to the same
    // fact.
    for (const record of coLocated) {
      for (const sibling of byWorkspaceId.get(workspaceIdOf(record)) ?? []) {
        protection.set(sibling.id, sibling);
      }
    }

    if ([...protection.values()].some((record) => !selectable.has(record.status))) {
      skipped.push({ id: session.id, reason: "protected_live_record" });
      continue;
    }
    if (direct.length === 0) {
      skipped.push({ id: session.id, reason: "no_record_match" });
      continue;
    }
    if (sessionCanon === null) {
      skipped.push({ id: session.id, reason: "directory_unresolvable" });
      continue;
    }
    const ageDays = (nowMs - session.updated) / DAY_MS;
    if (ageDays < input.olderThanDays) {
      skipped.push({ id: session.id, reason: "too_recent" });
      continue;
    }
    selected.push({
      id: session.id,
      directory: session.directory,
      canonicalDirectory: sessionCanon,
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
  realpath(path: string): Promise<string>;
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
    canonicalPaths: new Map(),
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
  // Record paths must be canonical BEFORE enumeration, because they choose
  // the directories to enumerate from. Store-session directories are folded
  // into the same map afterwards.
  const canonicalPaths = await resolveCanonicalPaths(
    records.map((record) => record.worktreePath),
    deps.realpath,
  );

  const directories = candidateDirectories(records, options.statuses, canonicalPaths);
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
  for (const [path, canonical] of await resolveCanonicalPaths(
    sessions.map((entry) => entry.directory),
    deps.realpath,
  )) {
    canonicalPaths.set(path, canonical);
  }

  return planOpenCodeGc({
    ...base,
    ...enumeration,
    storeRoot: store.storeRoot,
    sessions,
    records,
    canonicalPaths,
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
  canonicalPaths: ReadonlyMap<string, string | null>,
): string[] {
  const selectable = new Set<string>(statuses);
  const directories = new Set<string>();
  for (const record of records) {
    if (record.agent !== "opencode") continue;
    if (!record.agentSessionId) continue;
    if (!selectable.has(record.status)) continue;
    // An unresolvable path cannot be a cwd; skip it rather than guessing.
    const canonical = canonicalPaths.get(record.worktreePath);
    if (canonical) directories.add(canonical);
  }
  return [...directories].sort();
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
    realpath,
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
