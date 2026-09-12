import { execFile } from "node:child_process";
import { readdir, lstat, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  executePrune,
  isPackageManagerProcess,
  planCachePrune,
  type CacheCandidate,
} from "./cache-retention.js";
import { readSession } from "./metadata.js";
import { planNpmCacheCap, type NpmCacheCapResult } from "./npm-cache-cap.js";
import type { ProcessSnapshotEntry } from "./process-tree.js";
import { isTerminalSessionStatus, type AppConfig, type SessionRecord } from "./types.js";
import type { InstanceConfigReadResult } from "./config.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared: bounded build-cache walk (also used by disk-budget.ts's report row)
// ---------------------------------------------------------------------------

const BUILD_CACHE_MAX_DEPTH = 3;
const BUILD_CACHE_SKIP_NAMES = new Set(["node_modules", ".git"]);

export interface BuildCacheDirFact {
  path: string;
  newestMtimeMs: number;
}

async function newestMtimeMs(dirPath: string): Promise<number> {
  let newest = 0;
  const st = await lstat(dirPath);
  newest = Math.max(newest, st.mtimeMs);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return newest;
  }
  for (const name of entries) {
    try {
      const childStat = await lstat(join(dirPath, name));
      if (childStat.mtimeMs > newest) newest = childStat.mtimeMs;
    } catch {
      // vanished mid-walk — not a signal either way.
    }
  }
  return newest;
}

// Bounded, depth-3 walk from a worktree root, skipping node_modules and .git,
// collecting directories whose path ends `/.cache/webpack` or `/.next/cache`.
// Never an unbounded filesystem walk (same discipline as cache-retention.ts's
// pin resolution) — a worktree can contain arbitrarily deep node_modules
// trees, which BUILD_CACHE_SKIP_NAMES prunes before depth even matters.
export async function findBuildCacheDirs(worktreeRoot: string): Promise<BuildCacheDirFact[]> {
  const found: BuildCacheDirFact[] = [];

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (depth > BUILD_CACHE_MAX_DEPTH) return;
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch {
      return;
    }
    for (const name of names) {
      if (BUILD_CACHE_SKIP_NAMES.has(name)) continue;
      const childPath = join(dirPath, name);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(childPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const isWebpackCache = childPath.endsWith(join(".cache", "webpack"));
      const isNextCache = childPath.endsWith(join(".next", "cache"));
      if (isWebpackCache || isNextCache) {
        found.push({ path: childPath, newestMtimeMs: await newestMtimeMs(childPath) });
        continue; // do not descend into a matched build-cache dir itself
      }
      await walk(childPath, depth + 1);
    }
  }

  await walk(worktreeRoot, 0);
  return found;
}

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

  const candidates: BuildCacheCandidate[] = [];
  const blocked: BuildCacheBlockedGroup[] = [];
  let consideredWorktrees = 0;

  const sortedPaths = [...byWorktreePath.keys()].sort();
  for (const worktreePath of sortedPaths) {
    if (consideredWorktrees >= input.maxWorktrees) break;
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

    consideredWorktrees += 1;
    const dirs = await input.listBuildCacheDirs(worktreePath);
    for (const dir of dirs) {
      const ageDays = ageInDays(dir.newestMtimeMs, input.now);
      if (ageDays < input.olderThanDays) {
        blocked.push({ worktreePath, reason: "too_recent", sessionIds });
        continue;
      }
      const sizeBytes = await input.measureBytes(dir.path);
      if (sizeBytes === null) continue;
      candidates.push({ path: dir.path, worktreePath, sizeBytes, ageDays, sessionIds });
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

export interface NpmCapPlanResult {
  overCapBytes: number;
  capResult: NpmCacheCapResult;
  skippedReason?: "package_manager_active";
}

export async function planNpmCap(
  home: string,
  currentSizeBytes: number,
  capBytes: number,
  processes: readonly ProcessSnapshotEntry[],
): Promise<NpmCapPlanResult | undefined> {
  if (currentSizeBytes <= capBytes) return undefined;
  if (processes.some(isPackageManagerProcess)) {
    return {
      overCapBytes: currentSizeBytes - capBytes,
      capResult: { ok: false, reason: "npm_index_unreadable" },
      skippedReason: "package_manager_active",
    };
  }
  const capResult = await planNpmCacheCap(join(home, ".npm", "_cacache"), currentSizeBytes, capBytes);
  return { overCapBytes: currentSizeBytes - capBytes, capResult };
}

// ---------------------------------------------------------------------------
// Combined plan
// ---------------------------------------------------------------------------

export interface DiskGcPlan {
  generatedAt: string;
  buildCache: { candidates: BuildCacheCandidate[]; blocked: BuildCacheBlockedGroup[] };
  profiles: { candidates: ProfileCandidate[]; blocked: ProfileBlockedEntry[] };
  browserRevisions: CacheCandidate[];
  npmCap: NpmCapPlanResult | undefined;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface DiskGcReport {
  dryRun: boolean;
  freedBytes: number;
  buildCacheRemoved: string[];
  buildCacheFailures: { path: string; message: string }[];
  profilesRemoved: string[];
  profilesFailures: { path: string; message: string }[];
  browserRevisionsFreedBytes: number;
  npmCap:
    | undefined
    | {
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

  let browserRevisionsFreedBytes = 0;
  if (options.browserRevisions && plan.browserRevisions.length > 0) {
    if (options.dryRun) {
      browserRevisionsFreedBytes = plan.browserRevisions.reduce(
        (sum, c) => sum + c.entry.sizeKb * 1024,
        0,
      );
    } else {
      const outcome = await executePrune(plan.browserRevisions, deps.instanceConfig);
      browserRevisionsFreedBytes = outcome.freedKb * 1024;
      freedBytes += browserRevisionsFreedBytes;
    }
  }

  let npmCapReport: DiskGcReport["npmCap"];
  if (options.npmCap && plan.npmCap && plan.npmCap.capResult.ok) {
    const victims = plan.npmCap.capResult.plan.victims;
    if (options.dryRun) {
      npmCapReport = {
        ranSteps: ["[projected, not measured] npm cache verify", ...victims.map((v) => `[projected, not measured] npm cache clean ${v.key}`), "[projected, not measured] npm cache verify"],
        cleanedKeys: victims.length,
        freedBytes: plan.npmCap.capResult.plan.victimBytes,
      };
    } else {
      const ranSteps: string[] = [];
      await deps.npmVerify();
      ranSteps.push("npm cache verify");
      const before = await deps.measureCacacheBytes();
      for (const victim of victims) {
        await deps.npmClean(victim.key);
        ranSteps.push(`npm cache clean ${victim.key}`);
      }
      await deps.npmVerify();
      ranSteps.push("npm cache verify");
      const after = await deps.measureCacacheBytes();
      const npmFreed = before !== null && after !== null ? Math.max(0, before - after) : null;
      if (npmFreed !== null) freedBytes += npmFreed;
      npmCapReport = { ranSteps, cleanedKeys: victims.length, freedBytes: npmFreed };
    }
  }

  return {
    dryRun: options.dryRun,
    freedBytes,
    buildCacheRemoved,
    buildCacheFailures,
    profilesRemoved,
    profilesFailures,
    browserRevisionsFreedBytes,
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

export function createDiskGcDeps(
  config: AppConfig,
  instanceConfig: Extract<InstanceConfigReadResult, { status: "ok" }>,
): DiskGcExecutorDeps {
  return {
    worktreeDirReal: config.worktreeDir,
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
