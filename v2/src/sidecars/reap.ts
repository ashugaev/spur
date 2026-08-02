import { execFile } from "node:child_process";
import { realpath, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { getTmuxPanePid, killTmuxSession } from "../runtime-tmux.js";
import {
  isTerminalSessionStatus,
  type SessionRecord,
  type SidecarProcessIdentity,
} from "../types.js";

const execFileAsync = promisify(execFile);

// ── Reap primitives ──
// This module owns the one process-tree path in the codebase: an uncached
// `ps` snapshot, tree collection from that snapshot, group/pid signaling with
// confirmation, and the leaked-tree sweep predicate. It never imports
// session-service.js — callers pass session claims in. See spec spur-6128:
// the tmux pane pgid alone is NOT sufficient to reap a sidecar tree — a
// `setsid` escapee (e.g. scripts/spur-isolated-ui.sh:102) lives in a
// different process group that a bare `kill(-panePgid)` never reaches. The
// pre-signal snapshot + ppid tree walk carries the actual memory footprint;
// the pane-group signal stays as a free, correct addition for anything the
// snapshot could not see fork yet.

const REAP_GRACE_MS = 1500;
const REAP_CONFIRM_INTERVAL_MS = 100;
const REAP_CONFIRM_TIMEOUT_MS = 2000;
export const SWEEP_DETAIL_MAX_TREES = 10;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** Resident set size in KiB, from `ps -o rss`. */
  rssKb: number;
  /** Elapsed seconds since process start, from `ps -o etimes`. */
  etimes: number;
  args: string;
}

export interface ProcSnapshot {
  /**
   * false when `ps` failed or its output was unusable (non-Linux `ps` has no
   * `etimes`). Callers MUST then send no signals and report no leaks.
   */
  ok: boolean;
  byPid: ReadonlyMap<number, ProcessInfo>;
  byPgid: ReadonlyMap<number, readonly ProcessInfo[]>;
}

export interface PendingReap {
  sessionName: string;
  panePid: number | null;
  /** Pids signaled, root first. Empty when the snapshot was unusable. */
  tree: readonly number[];
  snapshot: ProcSnapshot;
  /** Pgids proven fully contained in `tree` at signal time. */
  ownedGroups: readonly number[];
}

export interface ReapOutcome {
  sessionName: string;
  panePid: number | null;
  /** Pids still alive after SIGKILL and the confirmation window. */
  survivors: readonly number[];
}

export interface SidecarClaim {
  /** Sidecar names claimed by any non-terminal session on this worktree. */
  sidecarNames: ReadonlySet<string>;
  /** pgids from `sidecarProcs` of every non-terminal session on this worktree. */
  livePgids: ReadonlySet<number>;
  /** true when at least one non-terminal session on this worktree has any `sidecarProcs` entry. */
  identityRecorded: boolean;
}

export interface LeakedSidecarTree {
  rootPid: number;
  pgid: number;
  ageSeconds: number;
  /** realpath of /proc/<rootPid>/cwd. A leak is never reported without it. */
  worktreePath: string;
  args: string;
  /** Sidecar name when the worktree's claim names one, else null. */
  sidecarName: string | null;
  /** Descendant pids from the same snapshot, root first. */
  tree: readonly number[];
  /** Total rss of `tree` in KiB. */
  treeRssKb: number;
  /** true when Spur provenance is proven and `--reap` may signal it. */
  reapable: boolean;
}

export interface SidecarSweepResult {
  /** false when the process table or procfs is unreadable; `leaked` is then []. */
  supported: boolean;
  leaked: LeakedSidecarTree[];
  /** Non-empty only when the caller asked to reap. */
  reaped: ReapOutcome[];
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function emptySnapshot(): ProcSnapshot {
  return { ok: false, byPid: new Map(), byPgid: new Map() };
}

const PS_SNAPSHOT_ARGS = ["-eo", "pid=,ppid=,pgid=,rss=,etimes=,args="];
// Node's execFile default is 1 MiB; a busy host's full process table can
// exceed that and hit ENOBUFS, which this module's catch degrades to a
// silent empty snapshot (report-first design: never a false leak, but also
// never a log). 10 MiB matches this repo's other execFile callers (gh.ts).
// Exported so every `ps` invocation in the sidecar sweep family (including
// playwright.ts's portable fallback) shares the one buffer policy.
export const PS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;

function parsePsOutput(stdout: string): ProcSnapshot {
  const byPid = new Map<number, ProcessInfo>();
  const byPgidMut = new Map<number, ProcessInfo[]>();
  for (const line of stdout.split("\n")) {
    const match = PS_ROW_RE.exec(line);
    if (!match) {
      continue;
    }
    const info: ProcessInfo = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssKb: Number(match[4]),
      etimes: Number(match[5]),
      args: match[6] ?? "",
    };
    byPid.set(info.pid, info);
    const group = byPgidMut.get(info.pgid) ?? [];
    group.push(info);
    byPgidMut.set(info.pgid, group);
  }
  if (byPid.size === 0) {
    return emptySnapshot();
  }
  return { ok: true, byPid, byPgid: byPgidMut };
}

// Test-only: exercises the row parser (args-with-spaces, zero-rows-parsed)
// without forking a real `ps`.
export const _parsePsOutputForTests = parsePsOutput;

/**
 * ONE uncached `ps` fork. Strictly not memoized — a stale row means signaling
 * a pid that already died and may have been reused. Never reuse
 * runtime-tmux.ts's TTL-cached `getPsSnapshot`; its format has no pgid, rss,
 * or etimes.
 */
export async function snapshotProcesses(): Promise<ProcSnapshot> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", PS_SNAPSHOT_ARGS, {
      timeout: 5_000,
      maxBuffer: PS_MAX_BUFFER_BYTES,
    }));
  } catch {
    return emptySnapshot();
  }
  return parsePsOutput(stdout);
}

/**
 * BFS over ppid, root first, cycle-guarded. Reaches a `setsid` escapee whose
 * ppid links back into the pane's shell — that link is intact only because
 * the snapshot was taken BEFORE any signal.
 */
export function collectTree(rootPid: number, snapshot: ProcSnapshot): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const info of snapshot.byPid.values()) {
    const children = childrenByPpid.get(info.ppid) ?? [];
    children.push(info.pid);
    childrenByPpid.set(info.ppid, children);
  }
  const seen = new Set<number>([rootPid]);
  const ordered: number[] = [];
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) {
      break;
    }
    ordered.push(pid);
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      queue.push(child);
    }
  }
  return ordered;
}

// Every distinct pgid among `tree` (pgid > 1) whose full snapshot membership
// is contained in `tree` — proof a negative-pid signal cannot reach a
// foreign process. `allowGroupSignals` is false when the root isn't its own
// group leader (non-Linux tmux, exotic build): skip every negative-pid
// signal and fall back to per-pid only.
function computeOwnedGroups(
  tree: readonly number[],
  snapshot: ProcSnapshot,
  allowGroupSignals: boolean,
): number[] {
  if (!allowGroupSignals) {
    return [];
  }
  const treeSet = new Set(tree);
  const candidatePgids = new Set<number>();
  for (const pid of tree) {
    const info = snapshot.byPid.get(pid);
    if (info) {
      candidatePgids.add(info.pgid);
    }
  }
  const owned: number[] = [];
  for (const pgid of candidatePgids) {
    if (pgid <= 1) {
      continue;
    }
    const members = snapshot.byPgid.get(pgid) ?? [];
    if (members.length > 0 && members.every((member) => treeSet.has(member.pid))) {
      owned.push(pgid);
    }
  }
  return owned;
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ESRCH" || error.code === "EPERM")) {
      return;
    }
    process.stderr.write(
      `spur: sidecar reap failed to signal pid ${pid} with ${signal}: ${String(error)}\n`,
    );
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ESRCH" || error.code === "EPERM")) {
      return;
    }
    process.stderr.write(
      `spur: sidecar reap failed to signal group ${pgid} with ${signal}: ${String(error)}\n`,
    );
  }
}

/**
 * Plain per-pid tree signal, leaves-first (a supervisor cannot respawn a
 * worker mid-teardown). No group awareness — shared with playwright.ts's own
 * orphan sweep, which has no pgid concept of its own.
 */
export function killTree(tree: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of [...tree].reverse()) {
    killPid(pid, signal);
  }
}

// SIGTERM/SIGKILL a tree: group-signal every proven-contained pgid first,
// then per-pid, leaves-first, for whatever tree members aren't already
// covered by a group signal.
function signalOwnedThenTree(
  tree: readonly number[],
  ownedGroups: readonly number[],
  snapshot: ProcSnapshot,
  signal: NodeJS.Signals,
): void {
  for (const pgid of ownedGroups) {
    killGroup(pgid, signal);
  }
  const groupSet = new Set(ownedGroups);
  const remaining = tree.filter((pid) => {
    const info = snapshot.byPid.get(pid);
    return !(info && groupSet.has(info.pgid));
  });
  killTree(remaining, signal);
}

/**
 * Bounded confirmation loop: probe each pid with `process.kill(pid, 0)`
 * every REAP_CONFIRM_INTERVAL_MS up to REAP_CONFIRM_TIMEOUT_MS. ESRCH
 * confirms gone; EPERM confirms alive-but-foreign (a pid reused by another
 * user's process) and is dropped without being reported as a survivor.
 * Returns whatever is still alive at the timeout.
 */
async function confirmGone(pids: readonly number[]): Promise<number[]> {
  const pending = new Set(pids);
  const deadline = Date.now() + REAP_CONFIRM_TIMEOUT_MS;
  for (;;) {
    for (const pid of [...pending]) {
      try {
        process.kill(pid, 0);
      } catch {
        pending.delete(pid);
      }
    }
    if (pending.size === 0 || Date.now() >= deadline) {
      break;
    }
    await sleep(REAP_CONFIRM_INTERVAL_MS);
  }
  return [...pending];
}

/**
 * Step 1-9 of the reap algorithm: get the pane pid fresh, take the ONE
 * pre-signal snapshot, SIGTERM the tree (group-first where proven), then
 * `killTmuxSession` — after the group signal, so tmux's pty-close SIGHUP is
 * no longer the first thing the tree sees.
 */
export async function signalSidecarPane(sessionName: string): Promise<PendingReap> {
  const panePid = await getTmuxPanePid(sessionName, { fresh: true });
  if (panePid === null) {
    await killTmuxSession(sessionName);
    return { sessionName, panePid: null, tree: [], ownedGroups: [], snapshot: emptySnapshot() };
  }
  const snapshot = await snapshotProcesses();
  if (!snapshot.ok || !snapshot.byPid.has(panePid)) {
    await killTmuxSession(sessionName);
    return { sessionName, panePid, tree: [], ownedGroups: [], snapshot };
  }
  const paneInfo = snapshot.byPid.get(panePid);
  const paneIsGroupLeader = paneInfo !== undefined && paneInfo.pgid === panePid;
  const tree = collectTree(panePid, snapshot);
  const ownedGroups = computeOwnedGroups(tree, snapshot, paneIsGroupLeader);
  signalOwnedThenTree(tree, ownedGroups, snapshot, "SIGTERM");
  await killTmuxSession(sessionName);
  return { sessionName, panePid, tree, ownedGroups, snapshot };
}

/**
 * ONE shared grace window for every pending reap (not one per sidecar),
 * then a re-taken snapshot to filter out already-reused pids, SIGKILL, and
 * a bounded confirmation. Never throws — a survivor becomes a `warn` entry
 * the caller logs, not a rejected promise.
 */
export async function confirmReaps(
  pendings: readonly PendingReap[],
  graceMs = REAP_GRACE_MS,
): Promise<ReapOutcome[]> {
  const anyWork = pendings.some((pending) => pending.tree.length > 0);
  if (!anyWork) {
    return pendings.map((pending) => ({
      sessionName: pending.sessionName,
      panePid: pending.panePid,
      survivors: [],
    }));
  }
  await sleep(graceMs);
  const snapshot2 = await snapshotProcesses();
  const outcomes: ReapOutcome[] = [];
  for (const pending of pendings) {
    if (pending.tree.length === 0) {
      outcomes.push({
        sessionName: pending.sessionName,
        panePid: pending.panePid,
        survivors: [],
      });
      continue;
    }
    let probeCandidates: number[];
    if (snapshot2.ok) {
      const treeSet = new Set(pending.tree);
      const survivorCandidates = pending.tree.filter((pid) => {
        const current = snapshot2.byPid.get(pid);
        if (!current) {
          return false;
        }
        const original = pending.snapshot.byPid.get(pid);
        // A pid present with a smaller etimes is a reused pid: drop it,
        // never signal it.
        return !(original && current.etimes < original.etimes);
      });
      const ownedStillContained = pending.ownedGroups.filter((pgid) => {
        const members = snapshot2.byPgid.get(pgid) ?? [];
        return members.length > 0 && members.every((member) => treeSet.has(member.pid));
      });
      for (const pgid of ownedStillContained) {
        killGroup(pgid, "SIGKILL");
      }
      const groupSet = new Set(ownedStillContained);
      const remaining = survivorCandidates.filter((pid) => {
        const current = snapshot2.byPid.get(pid);
        return !(current && groupSet.has(current.pgid));
      });
      killTree(remaining, "SIGKILL");
      probeCandidates = survivorCandidates;
    } else {
      // Unusable second snapshot: skip the SIGKILL pass entirely, probe
      // whatever was originally tracked.
      probeCandidates = [...pending.tree];
    }
    const survivors = await confirmGone(probeCandidates);
    outcomes.push({
      sessionName: pending.sessionName,
      panePid: pending.panePid,
      survivors,
    });
  }
  return outcomes;
}

/** `signalSidecarPane` then `confirmReaps` for a single tmux sidecar pane. */
export async function reapSidecarPane(sessionName: string): Promise<ReapOutcome> {
  const pending = await signalSidecarPane(sessionName);
  const [outcome] = await confirmReaps([pending]);
  return (
    outcome ?? {
      sessionName,
      panePid: pending.panePid,
      survivors: [],
    }
  );
}

type StarttimeProbe = { kind: "ok"; starttime: number } | { kind: "gone" } | { kind: "unknown" };

// /proc/<pid>/stat field 22 (starttime). The comm field is parenthesized and
// may itself contain spaces, so parsing anchors on the last ')'.
async function readProcStarttime(pid: number): Promise<StarttimeProbe> {
  let content: string;
  try {
    content = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { kind: "gone" };
    }
    return { kind: "unknown" };
  }
  const close = content.lastIndexOf(")");
  if (close === -1) {
    return { kind: "unknown" };
  }
  // Fields after ")": state(0) ppid(1) pgrp(2) session(3) tty_nr(4) tpgid(5)
  // flags(6) minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12)
  // cutime(13) cstime(14) priority(15) nice(16) num_threads(17)
  // itrealvalue(18) starttime(19) — field 22 overall.
  const fields = content
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const starttime = Number.parseInt(fields[19] ?? "", 10);
  return Number.isFinite(starttime) ? { kind: "ok", starttime } : { kind: "unknown" };
}

/**
 * /proc/<pid>/stat field 22, or null when unreadable/unparsable. Callers
 * (e.g. recording a freshly started sidecar's identity) must treat null as
 * "cannot record identity right now", never as "process is gone".
 */
export async function readProcessStarttime(pid: number): Promise<number | null> {
  const probe = await readProcStarttime(pid);
  return probe.kind === "ok" ? probe.starttime : null;
}

async function readProcCwdRealpath(pid: number): Promise<string | null> {
  try {
    return await realpath(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// An empty or root parent is never a valid containment bound — without this
// guard `${parent}/` normalizes to "/" and every absolute path passes. This
// is the sole containment proof before a negative-pid signal in
// reapLeaderlessGroup, so a vacuous-true here is a kill-safety bug.
function isPathInside(child: string, parent: string): boolean {
  if (!parent || parent === "/") {
    return false;
  }
  if (child === parent) {
    return true;
  }
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalizedParent);
}

// Test-only: exercises the containment guard directly.
export const _isPathInsideForTests = isPathInside;

async function reapLeaderlessGroup(
  identity: SidecarProcessIdentity,
  worktreePath: string,
): Promise<ReapOutcome | null> {
  const snapshot = await snapshotProcesses();
  if (!snapshot.ok) {
    return null;
  }
  const members = snapshot.byPgid.get(identity.pgid) ?? [];
  if (members.length === 0) {
    return null;
  }
  const proven: number[] = [];
  let allContained = true;
  for (const member of members) {
    const cwd = await readProcCwdRealpath(member.pid);
    if (cwd && isPathInside(cwd, worktreePath)) {
      proven.push(member.pid);
    } else {
      allContained = false;
    }
  }
  if (proven.length === 0) {
    return null;
  }
  const ownedGroups = allContained ? [identity.pgid] : [];
  signalOwnedThenTree(proven, ownedGroups, snapshot, "SIGTERM");
  const pending: PendingReap = {
    sessionName: `sidecar-identity:${identity.pid}`,
    panePid: null,
    tree: proven,
    ownedGroups,
    snapshot,
  };
  const [outcome] = await confirmReaps([pending]);
  return outcome ?? null;
}

/**
 * Reap via a `sidecarProcs` identity when the owning tmux session is already
 * gone. Unreadable/reused-pid stat degrades to "do not signal" — never
 * treats unknown as leaked. The leaderless-group case (the tmux pane process
 * itself is gone but its pgid still has live members, as observed on the
 * measured 863333/863351 leak) only group-signals when every live member's
 * cwd proves it belongs to `worktreePath`.
 */
export async function reapRecordedIdentity(
  identity: SidecarProcessIdentity,
  worktreePath: string,
): Promise<ReapOutcome | null> {
  const probe = await readProcStarttime(identity.pid);
  if (probe.kind === "unknown") {
    return null;
  }
  if (probe.kind === "gone") {
    return reapLeaderlessGroup(identity, worktreePath);
  }
  if (probe.starttime !== identity.starttime) {
    // pid reused by an unrelated process — never signal it.
    return null;
  }
  const snapshot = await snapshotProcesses();
  if (!snapshot.ok) {
    return null;
  }
  const treeFromPid = collectTree(identity.pid, snapshot);
  const groupMembers = (snapshot.byPgid.get(identity.pgid) ?? []).map((info) => info.pid);
  const tree = [...new Set([...treeFromPid, ...groupMembers])];
  const ownedGroups = computeOwnedGroups(tree, snapshot, true);
  signalOwnedThenTree(tree, ownedGroups, snapshot, "SIGTERM");
  const pending: PendingReap = {
    sessionName: `sidecar-identity:${identity.pid}`,
    panePid: identity.pid,
    tree,
    ownedGroups,
    snapshot,
  };
  const [outcome] = await confirmReaps([pending]);
  return outcome ?? null;
}

/**
 * Builds the live-claim set from every non-terminal session, keyed by
 * realpath'd worktreePath. Desk siblings share `worktreePath`
 * (session-desk.ts), so this union is exactly "all non-terminal workspace
 * members" with no workspace resolution inside this module.
 */
export function buildSidecarClaims(sessions: readonly SessionRecord[]): Map<string, SidecarClaim> {
  interface MutableClaim {
    sidecarNames: Set<string>;
    livePgids: Set<number>;
    identityRecorded: boolean;
  }
  const claims = new Map<string, MutableClaim>();
  for (const session of sessions) {
    if (isTerminalSessionStatus(session.status) || !session.worktreePath) {
      continue;
    }
    let worktreePath: string;
    try {
      worktreePath = realpathSync(session.worktreePath);
    } catch {
      continue;
    }
    const claim = claims.get(worktreePath) ?? {
      sidecarNames: new Set<string>(),
      livePgids: new Set<number>(),
      identityRecorded: false,
    };
    for (const name of session.sidecarNames ?? []) {
      claim.sidecarNames.add(name);
    }
    const procs = session.sidecarProcs;
    if (procs && Object.keys(procs).length > 0) {
      claim.identityRecorded = true;
      for (const identity of Object.values(procs)) {
        claim.livePgids.add(identity.pgid);
      }
    }
    claims.set(worktreePath, claim);
  }
  const result = new Map<string, SidecarClaim>();
  for (const [worktreePath, claim] of claims) {
    result.set(worktreePath, claim);
  }
  return result;
}

export interface SidecarSweepClaims {
  claims: ReadonlyMap<string, SidecarClaim>;
  /** realpath'd worktreePath from every session record, any status. */
  worktreePaths: readonly string[];
  /** realpath'd worktreeDir. */
  worktreeDirRealpath: string;
}

/**
 * Shared assembly for both sweep callers — session-service.ts's `--reap`
 * sweep and host-install.ts's read-only doctor check — so the
 * claims/worktreePaths/worktreeDirRealpath trio has exactly one build path.
 * Returns null when `worktreeDir` itself is unreadable, the one case
 * neither caller can proceed from.
 */
export function assembleSidecarSweepClaims(
  sessions: readonly SessionRecord[],
  worktreeDir: string,
): SidecarSweepClaims | null {
  const claims = buildSidecarClaims(sessions);
  const worktreePaths: string[] = [];
  for (const session of sessions) {
    if (!session.worktreePath) {
      continue;
    }
    try {
      worktreePaths.push(realpathSync(session.worktreePath));
    } catch {
      continue;
    }
  }
  let worktreeDirRealpath: string;
  try {
    worktreeDirRealpath = realpathSync(worktreeDir);
  } catch {
    return null;
  }
  return { claims, worktreePaths, worktreeDirRealpath };
}

export interface FindLeakedSidecarTreesInput {
  /** A single pre-taken `ps` snapshot, shared across the whole predicate pass. */
  snapshot: ProcSnapshot;
  claims: ReadonlyMap<string, SidecarClaim>;
  /** realpath'd worktreePath from every session record, any status. */
  worktreePaths: readonly string[];
  /** realpath'd instanceConfig.worktreeDir. */
  worktreeDirRealpath: string;
  /** Injectable for tests; defaults to a real `/proc/<pid>/cwd` realpath read. */
  readCwd?: (pid: number) => Promise<string | null>;
}

/**
 * The sweep predicate. A row is leaked iff: the snapshot is usable, it's an
 * orphan (ppid === 1), its cwd is readable and inside worktreeDir, it
 * attributes to a known worktree, and that worktree either has no
 * non-terminal session or its recorded sidecar pgids don't include this
 * row's pgid. Unknown (unreadable cwd, unattributable worktree) never
 * becomes leaked.
 */
export async function findLeakedSidecarTrees(
  input: FindLeakedSidecarTreesInput,
): Promise<{ supported: boolean; leaked: LeakedSidecarTree[] }> {
  const {
    snapshot,
    claims,
    worktreePaths,
    worktreeDirRealpath,
    readCwd = readProcCwdRealpath,
  } = input;
  if (!snapshot.ok) {
    return { supported: false, leaked: [] };
  }
  const sortedWorktreePaths = [...new Set(worktreePaths)].sort((a, b) => b.length - a.length);
  const leaked: LeakedSidecarTree[] = [];
  for (const info of snapshot.byPid.values()) {
    if (info.ppid !== 1) {
      continue;
    }
    const cwd = await readCwd(info.pid);
    if (!cwd) {
      continue;
    }
    if (!isPathInside(cwd, worktreeDirRealpath)) {
      continue;
    }
    const owner = sortedWorktreePaths.find((worktreePath) => isPathInside(cwd, worktreePath));
    if (!owner) {
      continue;
    }
    const claim = claims.get(owner);
    const isLeaked = claim === undefined || !claim.livePgids.has(info.pgid);
    if (!isLeaked) {
      continue;
    }
    const tree = collectTree(info.pid, snapshot);
    const treeRssKb = tree.reduce((sum, pid) => sum + (snapshot.byPid.get(pid)?.rssKb ?? 0), 0);
    const matchingNames = claim
      ? [...claim.sidecarNames].filter((name) => info.args.includes(name))
      : [];
    const sidecarName = matchingNames.length === 1 ? (matchingNames[0] ?? null) : null;
    // Two independent gates, both required when a live claim exists:
    // - identityRecorded: the worktree's session has ever recorded sidecar
    //   identity at all. False means it predates identity recording — the
    //   accepted limitation is that such leaks are report-only, never
    //   reapable, no matter what.
    // - sidecarName !== null: this specific orphan's own args name one of
    //   the worktree's known sidecars. Without it, `identityRecorded` alone
    //   would let any unrelated orphan under the worktree (e.g. an agent's
    //   stray `nohup ... &`) ride along once the worktree has recorded
    //   identity for some other, unrelated sidecar.
    // With no claim at all (worktree has no non-terminal session), there's
    // nothing left to attribute against, so any orphan there is fair game.
    const reapable = claim === undefined || (claim.identityRecorded && sidecarName !== null);
    leaked.push({
      rootPid: info.pid,
      pgid: info.pgid,
      ageSeconds: info.etimes,
      worktreePath: owner,
      args: info.args,
      sidecarName,
      tree,
      treeRssKb,
      reapable,
    });
  }
  return { supported: true, leaked };
}

export interface SweepSidecarsInput {
  claims: ReadonlyMap<string, SidecarClaim>;
  worktreePaths: readonly string[];
  worktreeDirRealpath: string;
  /** Reaping happens only when true — report-first by default. */
  reap: boolean;
}

/**
 * Report-first sweep: takes its own snapshot, runs the predicate, and only
 * signals `reapable` leaked trees when `reap` is true. Never reachable from
 * `spur doctor`, which calls `findLeakedSidecarTrees` directly.
 */
export async function sweepSidecars(input: SweepSidecarsInput): Promise<SidecarSweepResult> {
  const snapshot = await snapshotProcesses();
  const { supported, leaked } = await findLeakedSidecarTrees({
    snapshot,
    claims: input.claims,
    worktreePaths: input.worktreePaths,
    worktreeDirRealpath: input.worktreeDirRealpath,
  });
  if (!input.reap || !supported) {
    return { supported, leaked, reaped: [] };
  }
  const pendings: PendingReap[] = leaked
    .filter((tree) => tree.reapable)
    .map((tree) => {
      const ownedGroups = computeOwnedGroups(tree.tree, snapshot, true);
      signalOwnedThenTree(tree.tree, ownedGroups, snapshot, "SIGTERM");
      return {
        sessionName: `leaked:${tree.rootPid}`,
        panePid: tree.rootPid,
        tree: tree.tree,
        ownedGroups,
        snapshot,
      };
    });
  const reaped = await confirmReaps(pendings);
  return { supported, leaked, reaped };
}
