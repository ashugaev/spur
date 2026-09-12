import { execFile } from "node:child_process";
import { readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  executePrune,
  isPackageManagerProcess,
  planCachePrune,
  type CacheCandidate,
} from "./cache-retention.js";
import type { BuildCacheDirFact } from "./build-cache-scan.js";
import { readSession } from "./metadata.js";
import { planNpmCacheCap } from "./npm-cache-cap.js";
import type { ProcessSnapshotEntry } from "./process-tree.js";
import { isTerminalSessionStatus, type AppConfig, type SessionRecord } from "./types.js";
import type { InstanceConfigReadResult } from "./config.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// T3: worktree build caches — planner
// ---------------------------------------------------------------------------

export interface BuildCacheCandidate {
  path: string;
  worktreePath: string;
  sizeBytes: number;
  ageDays: number;
  sessionIds: string[];
}

export type BuildCacheBlockReason =
  | "live_session"
  | "path_outside_worktree_dir"
  | "orphaned_no_record"
  | "too_recent";

export interface BuildCacheBlockedGroup {
  worktreePath: string;
  reason: BuildCacheBlockReason;
  sessionIds: string[];
}

// `rel === ""` additionally rejects the worktrees ROOT itself — the same
// guard and reason string as session-gc.ts's path_outside_worktree_dir.
function containmentRel(worktreeDir: string, worktreePath: string): string | undefined {
  const rel = relative(worktreeDir, worktreePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

export interface PlanBuildCacheInput {
  sessions: readonly SessionRecord[];
  worktreeDir: string;
  now: Date;
  olderThanDays: number;
  // Bounds how many of the ELIGIBLE (terminal, contained) worktrees this
  // sweep selects, ranked by reclaimable bytes descending — the N largest
  // eligible candidates, never the first N in some incidental order. Every
  // eligible worktree is still measured to compute that ranking; this caps
  // the SELECTION, not the measurement pass.
  maxWorktrees: number;
  // Injected IO seam: the bounded fs walk (see findBuildCacheDirs above).
  // Kept injectable so the planner stays a pure function of its inputs in
  // tests, mirroring session-gc.ts's `pathExists` seam.
  listBuildCacheDirs: (worktreePath: string) => Promise<BuildCacheDirFact[]>;
  measureBytes: (path: string) => Promise<number | null>;
}

function ageInDays(mtimeMs: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - mtimeMs) / 86_400_000));
}

export async function planBuildCacheGc(input: PlanBuildCacheInput): Promise<{
  candidates: BuildCacheCandidate[];
  blocked: BuildCacheBlockedGroup[];
}> {
  // Group every session record by its worktreePath (including the empty
  // string / no-worktree sessions, which are simply never grouped into a
  // real path below).
  const byWorktreePath = new Map<string, SessionRecord[]>();
  for (const session of input.sessions) {
    const path = session.worktreePath.trim();
    if (!path) continue;
    const list = byWorktreePath.get(path);
    if (list) {
      list.push(session);
    } else {
      byWorktreePath.set(path, [session]);
    }
  }

  const blocked: BuildCacheBlockedGroup[] = [];

  // ---------------------------------------------------------------------
  // PASS 1 — SAFETY FILTER (never widened by ranking below). Every group
  // that reaches `eligible` has already cleared both hard invariants:
  // Invariant 1 (live-session boundary) and Invariant 2 (worktreeDir
  // containment). Alphabetical order here is only for deterministic
  // `blocked` output; it plays no role in which worktrees get measured.
  // ---------------------------------------------------------------------
  interface EligibleGroup {
    worktreePath: string;
    sessionIds: string[];
  }
  const eligible: EligibleGroup[] = [];
  const sortedPaths = [...byWorktreePath.keys()].sort();
  for (const worktreePath of sortedPaths) {
    const members = byWorktreePath.get(worktreePath) ?? [];
    const sessionIds = members.map((m) => m.id);

    // Invariant 1 — live-session boundary: negate isTerminalSessionStatus.
    // ALL of spawning/running/stopped/paused/errored block the group.
    const nonTerminal = members.filter((m) => !isTerminalSessionStatus(m.status));
    if (nonTerminal.length > 0) {
      blocked.push({ worktreePath, reason: "live_session", sessionIds });
      continue;
    }

    // Invariant 2 — worktree containment: a `worktree: false` session's
    // worktreePath IS the operator's real checkout (session-service.ts:8612)
    // and must never be walked/reclaimed.
    const rel = containmentRel(input.worktreeDir, worktreePath);
    if (rel === undefined) {
      blocked.push({ worktreePath, reason: "path_outside_worktree_dir", sessionIds });
      continue;
    }

    eligible.push({ worktreePath, sessionIds });
  }

  // ---------------------------------------------------------------------
  // PASS 2 — MEASURE every eligible worktree (post-filter only). This is
  // a re-ordering step, not a filtering step: it must never make a group
  // eligible that PASS 1 already blocked, and it runs across the WHOLE
  // eligible set, not a prefix of it — measuring only the first N
  // alphabetically (the old behavior) silently excluded the fleet's
  // largest real caches from every sweep, forever, on a host with more
  // worktrees than `maxWorktrees`.
  // ---------------------------------------------------------------------
  interface MeasuredDir {
    path: string;
    sizeBytes: number;
    ageDays: number;
  }
  interface MeasuredGroup {
    worktreePath: string;
    sessionIds: string[];
    dirs: MeasuredDir[];
    totalBytes: number;
  }
  const measuredGroups: MeasuredGroup[] = [];
  for (const group of eligible) {
    const dirs = await input.listBuildCacheDirs(group.worktreePath);
    const sized: MeasuredDir[] = [];
    // S12: one `too_recent` row per WORKTREE, not per dir.
    let anyTooRecent = false;
    for (const dir of dirs) {
      const ageDays = ageInDays(dir.newestMtimeMs, input.now);
      if (ageDays < input.olderThanDays) {
        anyTooRecent = true;
        continue;
      }
      const sizeBytes = await input.measureBytes(dir.path);
      if (sizeBytes === null) continue;
      sized.push({ path: dir.path, sizeBytes, ageDays });
    }
    if (anyTooRecent) {
      blocked.push({
        worktreePath: group.worktreePath,
        reason: "too_recent",
        sessionIds: group.sessionIds,
      });
    }
    if (sized.length === 0) {
      continue;
    }
    measuredGroups.push({
      worktreePath: group.worktreePath,
      sessionIds: group.sessionIds,
      dirs: sized,
      totalBytes: sized.reduce((sum, d) => sum + d.sizeBytes, 0),
    });
  }

  // ---------------------------------------------------------------------
  // PASS 3 — RANK, explicit and separate from both filtering passes above:
  // descending by total reclaimable bytes per worktree, so `maxWorktrees`
  // bounds COST (how many worktrees this sweep measures deletion for) and
  // picks the N most valuable candidates, never an arbitrary alphabetical
  // prefix.
  // ---------------------------------------------------------------------
  measuredGroups.sort((a, b) => b.totalBytes - a.totalBytes);
  const selected = measuredGroups.slice(0, input.maxWorktrees);

  const candidates: BuildCacheCandidate[] = [];
  for (const group of selected) {
    for (const dir of group.dirs) {
      candidates.push({
        path: dir.path,
        worktreePath: group.worktreePath,
        sizeBytes: dir.sizeBytes,
        ageDays: dir.ageDays,
        sessionIds: group.sessionIds,
      });
    }
  }

  return { candidates, blocked };
}

// Report-only class (D6): a worktree path with ZERO matching session
// records is never a candidate and is reported as orphaned, never selected.
export function classifyOrphanedWorktrees(
  discoveredWorktreePaths: readonly string[],
  sessions: readonly SessionRecord[],
): string[] {
  const known = new Set(sessions.map((s) => s.worktreePath.trim()).filter(Boolean));
  return discoveredWorktreePaths.filter((path) => !known.has(path));
}

// ---------------------------------------------------------------------------
// T2: mcp-chrome-* profile dirs (default) + browser revisions (opt-in)
// ---------------------------------------------------------------------------

const MCP_PROFILE_MIN_AGE_DAYS = 7; // GLOBAL_MIN_AGE_DAYS, restated locally to avoid a cross-module const dependency on cache-retention internals

export interface ProfileCandidate {
  path: string;
  rootId: "playwright-browsers" | "playwright-mcp-profiles";
  sizeBytes: number;
  ageDays: number;
}

export interface ProfileBlockedEntry {
  path: string;
  reason: "in_use_argv" | "singleton_lock_live" | "too_recent" | "not_owned" | "symlink";
}

export interface PlanProfileInput {
  roots: { rootId: "playwright-browsers" | "playwright-mcp-profiles"; path: string }[];
  now: Date;
  processes: readonly ProcessSnapshotEntry[];
  myUid: number | undefined;
  // IO seams.
  listProfileDirs: (rootPath: string) => Promise<string[]>;
  statProfile: (path: string) => Promise<{ uid: number; isSymlink: boolean; mtimeMs: number }>;
  measureBytes: (path: string) => Promise<number | null>;
  // A SingletonLock/SingletonSocket inside the profile resolving to a live
  // pid is a live-launch guard independent of argv matching.
  singletonLockLivePid: (profilePath: string) => Promise<number | null>;
}

export async function planProfileGc(input: PlanProfileInput): Promise<{
  candidates: ProfileCandidate[];
  blocked: ProfileBlockedEntry[];
}> {
  const candidates: ProfileCandidate[] = [];
  const blocked: ProfileBlockedEntry[] = [];

  for (const root of input.roots) {
    let names: string[];
    try {
      names = await input.listProfileDirs(root.path);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("mcp-")) continue;
      const profilePath = join(root.path, name);
      let facts: { uid: number; isSymlink: boolean; mtimeMs: number };
      try {
        facts = await input.statProfile(profilePath);
      } catch {
        continue;
      }
      if (facts.isSymlink) {
        blocked.push({ path: profilePath, reason: "symlink" });
        continue;
      }
      if (input.myUid !== undefined && facts.uid !== input.myUid) {
        blocked.push({ path: profilePath, reason: "not_owned" });
        continue;
      }
      const ageDays = ageInDays(facts.mtimeMs, input.now);
      if (ageDays < MCP_PROFILE_MIN_AGE_DAYS) {
        blocked.push({ path: profilePath, reason: "too_recent" });
        continue;
      }
      const argvMatch = input.processes.some((proc) => proc.args.includes(profilePath));
      if (argvMatch) {
        blocked.push({ path: profilePath, reason: "in_use_argv" });
        continue;
      }
      const lockPid = await input.singletonLockLivePid(profilePath);
      if (lockPid !== null) {
        blocked.push({ path: profilePath, reason: "singleton_lock_live" });
        continue;
      }
      const sizeBytes = await input.measureBytes(profilePath);
      if (sizeBytes === null) continue;
      candidates.push({ path: profilePath, rootId: root.rootId, sizeBytes, ageDays });
    }
  }

  return { candidates, blocked };
}

// Delegates to planCachePrune/executePrune unchanged (T2, --browser-revisions
// only) — keeps ONE deletion implementation for the pin-aware predicate.
export async function planBrowserRevisionCandidates(
  instanceConfig: InstanceConfigReadResult,
): Promise<CacheCandidate[]> {
  const plan = await planCachePrune({ instanceConfig, rootIds: ["playwright-browsers"] });
  return plan.candidates.filter(
    (c) => c.entry.entryClass.kind === "browser-revision" && c.verdict.kind === "prunable",
  );
}

// ---------------------------------------------------------------------------
// T1: npm per-key cap — plan only; deletion always via npm's own command.
// ---------------------------------------------------------------------------

// A dedicated discriminant per outcome (S8) — "index unreadable" and
// "skipped because a package manager is running" are different causes and
// must never share one reason string; a report or JSON consumer needs to
// tell them apart.
export type NpmCapPlanResult =
  | { kind: "not-over-cap" }
  | { kind: "skipped-package-manager-active"; overCapBytes: number }
  | { kind: "index-unreadable"; overCapBytes: number }
  | {
      kind: "planned";
      currentSizeBytes: number;
      capBytes: number;
      overCapBytes: number;
      plan: { victims: { key: string; size: number }[]; victimBytes: number };
    };

export async function planNpmCap(
  home: string,
  currentSizeBytes: number,
  capBytes: number,
  processes: readonly ProcessSnapshotEntry[],
): Promise<NpmCapPlanResult> {
  if (currentSizeBytes <= capBytes) return { kind: "not-over-cap" };
  const overCapBytes = currentSizeBytes - capBytes;
  if (processes.some(isPackageManagerProcess)) {
    return { kind: "skipped-package-manager-active", overCapBytes };
  }
  const capResult = await planNpmCacheCap(
    join(home, ".npm", "_cacache"),
    currentSizeBytes,
    capBytes,
  );
  if (!capResult.ok) {
    return { kind: "index-unreadable", overCapBytes };
  }
  return {
    kind: "planned",
    currentSizeBytes,
    capBytes,
    overCapBytes,
    plan: { victims: capResult.plan.victims, victimBytes: capResult.plan.victimBytes },
  };
}

// ---------------------------------------------------------------------------
// Combined plan
// ---------------------------------------------------------------------------

export interface DiskGcPlan {
  generatedAt: string;
  buildCache: { candidates: BuildCacheCandidate[]; blocked: BuildCacheBlockedGroup[] };
  profiles: { candidates: ProfileCandidate[]; blocked: ProfileBlockedEntry[] };
  browserRevisions: CacheCandidate[];
  npmCap: NpmCapPlanResult;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

// Every candidate the operator would need to read to decide whether to
// re-run with --execute — path, bytes, and the justification line — printed
// in BOTH dry-run and executed reports (B3: a dry run that prints only a
// total and no paths does not meet "printing exactly what it would remove").
export interface DiskGcReportCandidate {
  path: string;
  sizeBytes: number;
  reason: string;
}

export interface DiskGcReport {
  dryRun: boolean;
  freedBytes: number;
  buildCache: {
    candidates: DiskGcReportCandidate[];
    removed: string[];
    failures: { path: string; message: string }[];
  };
  profiles: {
    candidates: DiskGcReportCandidate[];
    removed: string[];
    failures: { path: string; message: string }[];
  };
  browserRevisions: {
    candidates: DiskGcReportCandidate[];
    freedBytes: number;
  };
  npmCap:
    | { status: "not-over-cap" }
    | { status: "skipped-package-manager-active"; overCapBytes: number }
    | { status: "index-unreadable"; overCapBytes: number }
    | {
        status: "planned";
        overCapBytes: number;
        victims: DiskGcReportCandidate[];
        ranSteps: string[];
        cleanedKeys: number;
        freedBytes: number | null;
      };
}

export interface DiskGcExecutorDeps {
  worktreeDirReal: string;
  readSessionFresh: (sessionId: string) => SessionRecord | null;
  rm: (path: string) => Promise<void>;
  realpath: (path: string) => Promise<string>;
  npmClean: (key: string) => Promise<void>;
  npmVerify: () => Promise<void>;
  measureCacacheBytes: () => Promise<number | null>;
  instanceConfig: Extract<InstanceConfigReadResult, { status: "ok" }>;
}

export async function executeDiskGc(
  plan: DiskGcPlan,
  deps: DiskGcExecutorDeps,
  options: { dryRun: boolean; browserRevisions: boolean; npmCap: boolean },
): Promise<DiskGcReport> {
  let freedBytes = 0;
  const buildCacheCandidates: DiskGcReportCandidate[] = plan.buildCache.candidates.map((c) => ({
    path: c.path,
    sizeBytes: c.sizeBytes,
    reason: `worktree build cache, ${c.ageDays}d old, terminal session(s) ${c.sessionIds.join(",")}`,
  }));
  const buildCacheRemoved: string[] = [];
  const buildCacheFailures: { path: string; message: string }[] = [];

  for (const candidate of plan.buildCache.candidates) {
    if (options.dryRun) {
      freedBytes += candidate.sizeBytes;
      continue;
    }
    try {
      // Executor re-read guard: a status that left the terminal set between
      // plan and execute blocks this entry.
      const stillTerminal = candidate.sessionIds.every((id) => {
        const fresh = deps.readSessionFresh(id);
        return fresh !== null && isTerminalSessionStatus(fresh.status);
      });
      if (!stillTerminal) {
        buildCacheFailures.push({ path: candidate.path, message: "changed_during_run" });
        continue;
      }
      // Executor re-assertion of containment (Invariant 2, D2): realpath the
      // build-cache dir and re-check against a realpath'd worktreeDir. A
      // planner-only check is defeated by a symlink swapped in between plan
      // and execute.
      const targetReal = await deps.realpath(candidate.path);
      const rel = containmentRel(deps.worktreeDirReal, targetReal);
      if (rel === undefined) {
        buildCacheFailures.push({ path: candidate.path, message: "refused: outside worktreeDir" });
        continue;
      }
      await deps.rm(candidate.path);
      buildCacheRemoved.push(candidate.path);
      freedBytes += candidate.sizeBytes;
    } catch (error) {
      buildCacheFailures.push({
        path: candidate.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const profileCandidates: DiskGcReportCandidate[] = plan.profiles.candidates.map((c) => ({
    path: c.path,
    sizeBytes: c.sizeBytes,
    reason: `mcp profile dir, ${c.ageDays}d old, no live argv/SingletonLock match`,
  }));
  const profilesRemoved: string[] = [];
  const profilesFailures: { path: string; message: string }[] = [];
  for (const candidate of plan.profiles.candidates) {
    if (options.dryRun) {
      freedBytes += candidate.sizeBytes;
      continue;
    }
    try {
      await deps.rm(candidate.path);
      profilesRemoved.push(candidate.path);
      freedBytes += candidate.sizeBytes;
    } catch (error) {
      profilesFailures.push({
        path: candidate.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const browserRevisionCandidates: DiskGcReportCandidate[] = plan.browserRevisions.map((c) => ({
    path: c.entry.path,
    sizeBytes: c.entry.sizeKb * 1024,
    reason:
      c.entry.entryClass.kind === "browser-revision"
        ? `unpinned browser revision, ${c.entry.ageDays}d old`
        : "unpinned browser revision",
  }));
  let browserRevisionsFreedBytes = 0;
  if (options.browserRevisions && plan.browserRevisions.length > 0) {
    if (options.dryRun) {
      browserRevisionsFreedBytes = browserRevisionCandidates.reduce(
        (sum, c) => sum + c.sizeBytes,
        0,
      );
    } else {
      const outcome = await executePrune(plan.browserRevisions, deps.instanceConfig);
      browserRevisionsFreedBytes = outcome.freedKb * 1024;
      freedBytes += browserRevisionsFreedBytes;
    }
  }

  let npmCapReport: DiskGcReport["npmCap"];
  if (!options.npmCap || plan.npmCap.kind === "not-over-cap") {
    npmCapReport = { status: "not-over-cap" };
  } else if (plan.npmCap.kind === "skipped-package-manager-active") {
    npmCapReport = {
      status: "skipped-package-manager-active",
      overCapBytes: plan.npmCap.overCapBytes,
    };
  } else if (plan.npmCap.kind === "index-unreadable") {
    npmCapReport = { status: "index-unreadable", overCapBytes: plan.npmCap.overCapBytes };
  } else {
    const npmCapPlan = plan.npmCap;
    const victims: DiskGcReportCandidate[] = npmCapPlan.plan.victims.map((v) => ({
      path: v.key,
      sizeBytes: v.size,
      reason: "oldest index-v5 entry, ranked for npm cache clean",
    }));
    if (options.dryRun) {
      npmCapReport = {
        status: "planned",
        overCapBytes: npmCapPlan.overCapBytes,
        victims,
        ranSteps: [
          "[projected, not measured] npm cache verify",
          ...victims.map((v) => `[projected, not measured] npm cache clean ${v.path}`),
          "[projected, not measured] npm cache verify (only if step 2 above still runs)",
        ],
        cleanedKeys: victims.length,
        freedBytes: npmCapPlan.plan.victimBytes,
      };
    } else {
      // R3-D's real gate: verify -> RE-MEASURE -> stop if under cap -> only
      // THEN clean the ranked victims -> verify again. The victim list is
      // computed at plan time against the PRE-verify size, so it must never
      // be cleaned unconditionally — verify alone may already have cleared
      // the cap by collecting orphaned/corrupt content, and every victim
      // byte cleaned past that point is a needless refetch of still-valid
      // content.
      const ranSteps: string[] = [];
      await deps.npmVerify();
      ranSteps.push("npm cache verify");
      const afterVerify = await deps.measureCacacheBytes();
      if (afterVerify !== null && afterVerify <= npmCapPlan.capBytes) {
        const npmFreed = Math.max(0, npmCapPlan.currentSizeBytes - afterVerify);
        freedBytes += npmFreed;
        npmCapReport = {
          status: "planned",
          overCapBytes: npmCapPlan.overCapBytes,
          victims,
          ranSteps,
          cleanedKeys: 0,
          freedBytes: npmFreed,
        };
      } else {
        // The victim list was ranked oldest-first against the PRE-verify
        // size (npm-cache-cap.ts's planNpmCacheVictims). `npm cache verify`
        // may have already collected enough orphaned/corrupt content on its
        // own that fewer victims are needed now — re-walk that SAME ranking
        // against the POST-verify size and clean only the prefix still
        // required to clear the cap. Cleaning the full pre-verify list here
        // would delete already-under-cap, still-valid entries a second time
        // (measured on this host: 14381260894 bytes of orphan content verify
        // alone reclaims). When the post-verify size is unknown
        // (`afterVerify === null`), fall back to the full ranked list — the
        // only safe choice when there is no measurement to rank against.
        let toClean = npmCapPlan.plan.victims;
        if (afterVerify !== null) {
          const prefix: typeof npmCapPlan.plan.victims = [];
          let projected = afterVerify;
          for (const victim of npmCapPlan.plan.victims) {
            if (projected <= npmCapPlan.capBytes) break;
            prefix.push(victim);
            projected -= victim.size;
          }
          toClean = prefix;
        }
        for (const victim of toClean) {
          await deps.npmClean(victim.key);
          ranSteps.push(`npm cache clean ${victim.key}`);
        }
        await deps.npmVerify();
        ranSteps.push("npm cache verify");
        const after = await deps.measureCacacheBytes();
        const npmFreed = after !== null ? Math.max(0, npmCapPlan.currentSizeBytes - after) : null;
        if (npmFreed !== null) freedBytes += npmFreed;
        npmCapReport = {
          status: "planned",
          overCapBytes: npmCapPlan.overCapBytes,
          // Dry-run contract is unchanged: the report always names the FULL
          // planned victim set, never just the cleaned prefix.
          victims,
          ranSteps,
          cleanedKeys: toClean.length,
          freedBytes: npmFreed,
        };
      }
    }
  }

  return {
    dryRun: options.dryRun,
    freedBytes,
    buildCache: {
      candidates: buildCacheCandidates,
      removed: buildCacheRemoved,
      failures: buildCacheFailures,
    },
    profiles: {
      candidates: profileCandidates,
      removed: profilesRemoved,
      failures: profilesFailures,
    },
    browserRevisions: {
      candidates: browserRevisionCandidates,
      freedBytes: browserRevisionsFreedBytes,
    },
    npmCap: npmCapReport,
  };
}

// ---------------------------------------------------------------------------
// Real dependency wiring
// ---------------------------------------------------------------------------

const DU_TIMEOUT_MS = 120_000;

async function measureBytes(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("du", ["-s", "--block-size=1", "--", path], {
      timeout: DU_TIMEOUT_MS,
    });
    const match = /^(\d+)/.exec(stdout);
    const digits = match?.[1];
    return digits ? Number.parseInt(digits, 10) : null;
  } catch {
    return null;
  }
}

async function singletonLockLivePid(profilePath: string): Promise<number | null> {
  for (const lockName of ["SingletonLock", "SingletonSocket"]) {
    try {
      const target = await readlink(join(profilePath, lockName));
      const match = /^[^-]+-(\d+)$/.exec(target);
      const pidStr = match?.[1];
      if (!pidStr) continue;
      const pid = Number.parseInt(pidStr, 10);
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        continue;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// D2 requires the executor to re-assert containment of the candidate's
// REALPATH against a REALPATH'd worktreeDir — a merely lexical worktreeDir
// mis-fires (refuses every legitimate candidate) the moment `worktreeDir` or
// any ancestor is itself a symlink, since `relative(lexicalDir, realCandidate)`
// then starts with "..". Resolved once here, at dep construction, not per
// candidate. Falls back to the lexical path only if the directory does not
// exist yet — nothing under a nonexistent worktreeDir can be a real candidate
// either way.
export async function createDiskGcDeps(
  config: AppConfig,
  instanceConfig: Extract<InstanceConfigReadResult, { status: "ok" }>,
): Promise<DiskGcExecutorDeps> {
  const worktreeDirReal = await realpath(config.worktreeDir).catch(() => config.worktreeDir);
  return {
    worktreeDirReal,
    readSessionFresh: (sessionId) => readSession(config.dataDir, sessionId),
    rm: async (path) => {
      await rm(path, { recursive: true, force: true });
    },
    realpath: (path) => realpath(path),
    npmClean: async (key) => {
      await execFileAsync("npm", ["cache", "clean", key]);
    },
    npmVerify: async () => {
      await execFileAsync("npm", ["cache", "verify"]);
    },
    measureCacacheBytes: () => measureBytes(join(process.env["HOME"] ?? "", ".npm", "_cacache")),
    instanceConfig,
  };
}

export { measureBytes, singletonLockLivePid };
