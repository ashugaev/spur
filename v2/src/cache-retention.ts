import { execFile } from "node:child_process";
import { readdir, lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { listSessions } from "./metadata.js";
import { canReadProcessTree, collectDescendants, listProcesses, type ProcessInfo } from "./process-tree.js";
import { getTmuxPanePid, setTmuxSocketName } from "./runtime-tmux.js";
import type { InstanceConfigReadResult } from "./config.js";

const execFileAsync = promisify(execFile);

// CLI-only module: `du` (measurement) and `rm` (deletion) only ever run from
// an explicit `spur cache` invocation, never from the daemon. The daemon's
// only disk syscall is `disk-space.ts`'s `readFreeKb` (a `df`, not a `du`) —
// see session-service.ts's warnIfHostDiskLow. Importing this module from the
// daemon's request-handling path (server.ts, session-service.ts) would
// silently widen that boundary; only host-install.ts's CLI-only
// `reclaimable-caches` doctor check and cli.ts's `cache` command may import
// it.

export type CacheRootId =
  | "npm-cacache"
  | "npm-npx"
  | "playwright-browsers"
  | "playwright-mcp-profiles"
  | "xdg-cache"
  | "tmp";

export interface CacheRoot {
  id: CacheRootId;
  path: string;
  mode: "whole-root" | "entries";
}

export type CacheEntryClass =
  | { kind: "vendor-cache" }
  | { kind: "npx-package"; hash: string }
  | { kind: "browser-revision"; browser: string; revision: string; dirName: string }
  | { kind: "browser-profile" }
  | { kind: "browser-registry" }
  | { kind: "generic"; name: string }
  | { kind: "tmp-entry"; name: string };

export type ProtectedReason =
  | { kind: "too-recent"; ageDays: number; floorDays: number }
  | { kind: "in-use"; pid: number; evidence: "argv" | "cwd" }
  | { kind: "package-manager-active"; pid: number }
  | { kind: "pinned-revision"; dirName: string }
  | { kind: "pin-unresolved" }
  | { kind: "class-never-pruned" }
  | { kind: "process-tree-unreadable" }
  | { kind: "not-owned"; uid: number }
  | { kind: "symlink" };

export type CacheVerdict = { kind: "prunable" } | { kind: "protected"; reason: ProtectedReason };

export interface CacheEntry {
  path: string;
  rootId: CacheRootId;
  entryClass: CacheEntryClass;
  sizeKb: number;
  newestChangeMs: number;
  ageDays: number;
}

export interface CacheCandidate {
  entry: CacheEntry;
  verdict: CacheVerdict;
}

export interface CacheRootMeasurement {
  rootId: CacheRootId;
  path: string;
  status: "measured" | "absent" | "skipped";
  totalKb: number;
  entryCount: number;
}

// A live session's descendant process holding a cwd inside a candidate path.
export interface LiveSessionCwd {
  pid: number;
  cwd: string;
}

export interface LivenessSnapshot {
  processTreeReadable: boolean;
  processes: readonly ProcessInfo[];
  sessionCwds: readonly LiveSessionCwd[];
  pinnedDirNames: ReadonlySet<string>;
  pinSourceCount: number;
}

export interface CachePlan {
  generatedAt: string;
  freeKbBefore?: number;
  roots: CacheRootMeasurement[];
  candidates: CacheCandidate[];
  reclaimableKb: number;
  processTreeReadable: boolean;
  pinSourceCount: number;
}

export interface PruneOutcome {
  removed: { path: string; sizeKb: number }[];
  failures: { path: string; message: string }[];
  freedKb: number;
}

// Global hard floor: no entry in any class is ever prunable younger than
// this, regardless of its class-specific floor.
export const GLOBAL_MIN_AGE_DAYS = 7;
export const NPX_MIN_AGE_DAYS = 30;
export const BROWSER_REVISION_MIN_AGE_DAYS = 30;
export const BROWSER_PROFILE_MIN_AGE_DAYS = 7;
// CORR-C: generic ~/.cache entries are regenerable XDG cache data, not a
// never-pruned class — measured AND prunable, at a slightly higher floor
// than the global one since there is no liveness signal for them beyond
// argv/cwd.
export const GENERIC_MIN_AGE_DAYS = 30;
// CORR-A: /tmp floor equals the global floor — no extra grace beyond the
// hard minimum every class already gets.
export const TMP_MIN_AGE_DAYS = GLOBAL_MIN_AGE_DAYS;
export const CACHE_MEASURE_TIMEOUT_MS = 30_000;
export const DU_CHUNK_SIZE = 500;

// CORR-A name deny-list: never a deletion candidate regardless of age/owner,
// independent of the uid check (root-owned lock dirs the invoking user
// happens to own are still off-limits; systemd/tmux/X11 sockets other
// processes depend on; /tmp/spur.yaml is a known landmine, and any other
// `spur*` path is the sibling ~/.spur-retention session's territory, not
// this one's).
const TMP_DENY_PATTERNS: RegExp[] = [
  /^systemd-private-/,
  /^tmux-/,
  /^\.X11-unix$/,
  /^\.font-unix$/,
  /^\.ICE-unix$/,
  /^snap-private-/,
  /^spur/,
];

function isTmpDenyListed(name: string): boolean {
  return TMP_DENY_PATTERNS.some((pattern) => pattern.test(name));
}

// `~/.cache/ms-playwright` and `~/.cache/ms-playwright-mcp` share this
// classifier: `b` (and any other non-matching name) is the running-browser
// registry, never a revision or a profile; `mcp-*` is a profile dir in
// either root; everything else matching `<name>-<rev>` is a browser
// revision. Moved out of `~/.cache`'s own "generic" classification (a
// separate CacheRootId per root, not a name exclusion inside "generic").
function classifyPlaywrightEntry(name: string): CacheEntryClass {
  if (name.startsWith("mcp-")) {
    return { kind: "browser-profile" };
  }
  const match = /^([a-z0-9_]+)-(\d+)$/.exec(name);
  if (match?.[1] && match[2]) {
    return { kind: "browser-revision", browser: match[1], revision: match[2], dirName: name };
  }
  return { kind: "browser-registry" };
}

export function classifyEntry(rootId: CacheRootId, name: string): CacheEntryClass {
  switch (rootId) {
    case "npm-cacache":
      return { kind: "vendor-cache" };
    case "npm-npx":
      return { kind: "npx-package", hash: name };
    case "playwright-browsers":
    case "playwright-mcp-profiles":
      return classifyPlaywrightEntry(name);
    case "xdg-cache":
      return { kind: "generic", name };
    case "tmp":
      return { kind: "tmp-entry", name };
  }
}

// `undefined` means "no age floor at all" — reachable only for
// browser-registry, the sole class that stays class-never-pruned regardless
// of age (C4: it is neither a revision nor a profile, so no staleness signal
// applies to it at all).
function classFloorDays(entryClass: CacheEntryClass): number | undefined {
  switch (entryClass.kind) {
    case "vendor-cache":
      return GLOBAL_MIN_AGE_DAYS;
    case "npx-package":
      return NPX_MIN_AGE_DAYS;
    case "browser-revision":
      return BROWSER_REVISION_MIN_AGE_DAYS;
    case "browser-profile":
      return BROWSER_PROFILE_MIN_AGE_DAYS;
    case "browser-registry":
      return undefined;
    case "generic":
      return GENERIC_MIN_AGE_DAYS;
    case "tmp-entry":
      return TMP_MIN_AGE_DAYS;
  }
}

// C1: age is `max(mtimeMs, ctimeMs)` ONLY — never atime. On this host a
// whole-tree scan poisons every surveyed root's atime to an identical
// one-day-old value (relatime), which would make the feature a no-op if
// atime were part of the signal.
export function ageDaysFor(mtimeMs: number, ctimeMs: number, nowMs: number): number {
  const newestChangeMs = Math.max(mtimeMs, ctimeMs);
  return Math.floor((nowMs - newestChangeMs) / 86_400_000);
}

const PACKAGE_MANAGER_BIN = /(^|\/)(npm|pnpm|npx|yarn)(\s|$)/;

function isPackageManagerProcess(proc: ProcessInfo): boolean {
  return PACKAGE_MANAGER_BIN.test(proc.args);
}

export interface EntryOwnership {
  uid: number;
  isSymlink: boolean;
}

// Pure verdict logic — no I/O. `entry` carries the pre-measured facts (size,
// age); `ownership` carries the pre-`lstat`ed facts; `liveness` is one shared
// snapshot for the whole plan. Rule order matches the spec's numbered list;
// every step but the last is a protection, so `prunable` is reachable only
// by falling through all of them.
export function verdictFor(
  entry: CacheEntry,
  ownership: EntryOwnership,
  liveness: LivenessSnapshot,
  myUid: number | undefined,
): CacheVerdict {
  if (ownership.isSymlink) {
    return { kind: "protected", reason: { kind: "symlink" } };
  }
  if (myUid !== undefined && ownership.uid !== myUid) {
    return { kind: "protected", reason: { kind: "not-owned", uid: ownership.uid } };
  }
  if (!liveness.processTreeReadable) {
    return { kind: "protected", reason: { kind: "process-tree-unreadable" } };
  }
  if (entry.entryClass.kind === "browser-registry") {
    return { kind: "protected", reason: { kind: "class-never-pruned" } };
  }
  if (entry.entryClass.kind === "tmp-entry" && isTmpDenyListed(entry.entryClass.name)) {
    return { kind: "protected", reason: { kind: "class-never-pruned" } };
  }
  const floorDays = classFloorDays(entry.entryClass);
  const effectiveFloor = Math.max(GLOBAL_MIN_AGE_DAYS, floorDays ?? GLOBAL_MIN_AGE_DAYS);
  if (entry.ageDays < effectiveFloor) {
    return { kind: "protected", reason: { kind: "too-recent", ageDays: entry.ageDays, floorDays: effectiveFloor } };
  }
  if (entry.entryClass.kind === "browser-revision") {
    if (liveness.pinSourceCount === 0) {
      return { kind: "protected", reason: { kind: "pin-unresolved" } };
    }
    if (liveness.pinnedDirNames.has(entry.entryClass.dirName)) {
      return { kind: "protected", reason: { kind: "pinned-revision", dirName: entry.entryClass.dirName } };
    }
  }
  if (entry.entryClass.kind === "vendor-cache") {
    const pm = liveness.processes.find(isPackageManagerProcess);
    if (pm) {
      return { kind: "protected", reason: { kind: "package-manager-active", pid: pm.pid } };
    }
  }
  const argvMatch = liveness.processes.find((proc) => proc.args.includes(entry.path));
  if (argvMatch) {
    return { kind: "protected", reason: { kind: "in-use", pid: argvMatch.pid, evidence: "argv" } };
  }
  const cwdMatch = liveness.sessionCwds.find(
    (live) => live.cwd === entry.path || live.cwd.startsWith(`${entry.path}/`),
  );
  if (cwdMatch) {
    return { kind: "protected", reason: { kind: "in-use", pid: cwdMatch.pid, evidence: "cwd" } };
  }
  return { kind: "prunable" };
}

// `tmpPath` defaults to the real "/tmp" in production (CORR-A: no
// `/tmp`-specific flag or config knob) — it exists as a parameter only so
// tests can point the "tmp" root at a synthetic tree instead of scanning the
// host's real /tmp on every test run.
function cacheRoots(home: string, tmpPath = "/tmp"): CacheRoot[] {
  return [
    { id: "npm-cacache", path: join(home, ".npm", "_cacache"), mode: "whole-root" },
    { id: "npm-npx", path: join(home, ".npm", "_npx"), mode: "entries" },
    { id: "playwright-browsers", path: join(home, ".cache", "ms-playwright"), mode: "entries" },
    { id: "playwright-mcp-profiles", path: join(home, ".cache", "ms-playwright-mcp"), mode: "entries" },
    { id: "xdg-cache", path: join(home, ".cache"), mode: "entries" },
    { id: "tmp", path: tmpPath, mode: "entries" },
  ];
}

// Names inside `~/.cache` owned by their own dedicated CacheRootId — never
// double-measured/double-classified as "generic".
const XDG_CACHE_EXCLUDED_NAMES = new Set(["ms-playwright", "ms-playwright-mcp"]);

async function readBrowsersJson(browsersJsonPath: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(browsersJsonPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function pinnedDirNamesFromBrowsersJson(parsed: unknown): string[] {
  if (typeof parsed !== "object" || parsed === null || !("browsers" in parsed)) {
    return [];
  }
  const browsers = (parsed as { browsers?: unknown }).browsers;
  if (!Array.isArray(browsers)) {
    return [];
  }
  const dirNames: string[] = [];
  for (const entry of browsers) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    const revision = (entry as { revision?: unknown }).revision;
    if (typeof name === "string" && typeof revision === "string") {
      dirNames.push(`${name.replace(/-/g, "_")}-${revision}`);
    }
  }
  return dirNames;
}

// Resolves `playwright-core`'s installed browsers.json by resolving its
// `package.json` (the one exports-map subpath every playwright-core version
// allows) and joining "browsers.json" onto its directory — NOT by resolving
// the "playwright-core/browsers.json" subpath directly, which throws
// ERR_PACKAGE_PATH_NOT_EXPORTED on every playwright-core version that ships
// a restrictive `exports` map (verified: 1.58.2 and the 1.61.0-alpha bundled
// with @playwright/mcp 0.0.76 both do).
async function readBrowsersJsonViaRequire(fromModulePath: string): Promise<unknown | undefined> {
  try {
    const req = createRequire(fromModulePath);
    const pkgJsonPath = req.resolve("playwright-core/package.json");
    return await readBrowsersJson(join(dirname(pkgJsonPath), "browsers.json"));
  } catch {
    return undefined;
  }
}

// Bounded, enumerated pin resolution (C2) — never an unbounded filesystem
// walk. Every source is try/catch->skip; `pinSourceCount` only counts
// sources that actually parsed, and 0 triggers fail-closed protection of
// every browser-revision entry (rule 6 in verdictFor).
async function resolvePins(
  home: string,
  instanceConfig: InstanceConfigReadResult,
): Promise<{ pinnedDirNames: Set<string>; pinSourceCount: number }> {
  const pinnedDirNames = new Set<string>();
  let pinSourceCount = 0;

  const addFrom = (parsed: unknown | undefined): void => {
    if (parsed === undefined) return;
    pinSourceCount += 1;
    for (const dirName of pinnedDirNamesFromBrowsersJson(parsed)) {
      pinnedDirNames.add(dirName);
    }
  };

  // P1: this module's own resolution context, plus @playwright/mcp's.
  addFrom(await readBrowsersJsonViaRequire(import.meta.url));
  try {
    const req = createRequire(import.meta.url);
    const mcpPkgJsonPath = req.resolve("@playwright/mcp/package.json");
    addFrom(await readBrowsersJsonViaRequire(mcpPkgJsonPath));
  } catch {
    // @playwright/mcp not installed — nothing to resolve from its context.
  }

  const projectPaths: string[] =
    instanceConfig.status === "ok"
      ? Object.values(instanceConfig.config.projects).map((project) => project.path)
      : [];

  // P2: each configured project's own playwright-core, plus any pnpm-store
  // sibling installs under its node_modules/.pnpm.
  for (const projectPath of projectPaths) {
    addFrom(await readBrowsersJson(join(projectPath, "node_modules", "playwright-core", "browsers.json")));
    addFrom(await readPnpmStorePins(projectPath));
  }

  // P3: every real worktree (`<worktreeDir>/<projectId>/<sessionId>`, exactly
  // depth 2), independent of which sessions are currently live — 209 real
  // worktree installs on this host prove this is not a hypothetical source.
  if (instanceConfig.status === "ok") {
    for (const worktreePath of await listWorktreePaths(instanceConfig.config.worktreeDir)) {
      addFrom(await readBrowsersJson(join(worktreePath, "node_modules", "playwright-core", "browsers.json")));
      addFrom(await readPnpmStorePins(worktreePath));
    }
  }

  // P4: every `~/.npm/_npx/<hash>` install — the `b`-registry proves MCP
  // browsers can launch from an _npx-installed playwright-core.
  const npxDir = join(home, ".npm", "_npx");
  try {
    const hashes = await readdir(npxDir);
    for (const hash of hashes) {
      addFrom(await readBrowsersJson(join(npxDir, hash, "node_modules", "playwright-core", "browsers.json")));
    }
  } catch {
    // ~/.npm/_npx absent or unreadable — no npx-installed pins.
  }

  return { pinnedDirNames, pinSourceCount };
}

async function readPnpmStorePins(rootPath: string): Promise<unknown | undefined> {
  const pnpmDir = join(rootPath, "node_modules", ".pnpm");
  let entries: string[];
  try {
    entries = await readdir(pnpmDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith("playwright-core@")) continue;
    const parsed = await readBrowsersJson(join(pnpmDir, entry, "node_modules", "playwright-core", "browsers.json"));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

async function listWorktreePaths(worktreeDir: string): Promise<string[]> {
  const paths: string[] = [];
  let projectIds: string[];
  try {
    projectIds = await readdir(worktreeDir);
  } catch {
    return paths;
  }
  for (const projectId of projectIds) {
    let sessionIds: string[];
    try {
      sessionIds = await readdir(join(worktreeDir, projectId));
    } catch {
      continue;
    }
    for (const sessionId of sessionIds) {
      paths.push(join(worktreeDir, projectId, sessionId));
    }
  }
  return paths;
}

// One `listProcesses()` call, one `canReadProcessTree` probe, and one
// `readlink("/proc/<pid>/cwd")` per live-session descendant — no
// `/proc/<pid>/fd`, no `/proc/<pid>/maps` scan. Rejected: that scan is
// O(1e5) racy readlinks across the whole host process table and still
// cannot see a not-yet-launched browser, which is exactly what the pin
// resolution above covers instead.
async function collectLiveness(
  home: string,
  instanceConfig: InstanceConfigReadResult,
): Promise<LivenessSnapshot> {
  const processes = await listProcesses();
  const processTreeReadable = await canReadProcessTree(process.pid);
  const { pinnedDirNames, pinSourceCount } = await resolvePins(home, instanceConfig);

  const sessionCwds: LiveSessionCwd[] = [];
  if (instanceConfig.status === "ok") {
    setTmuxSocketName(instanceConfig.config.tmux.socketName);
    const liveSessions = listSessions(instanceConfig.config.dataDir).filter(
      (session) => session.status === "running" || session.status === "spawning",
    );
    for (const session of liveSessions) {
      const panePid = await getTmuxPanePid(session.tmuxSession);
      if (panePid === null) continue;
      const descendants = collectDescendants(panePid, processes);
      for (const pid of descendants) {
        try {
          const cwd = await readlink(`/proc/${pid}/cwd`);
          sessionCwds.push({ pid, cwd });
        } catch {
          // Process exited between the ps snapshot and this readlink, or no
          // procfs — not a liveness signal either way.
        }
      }
    }
  }

  return { processTreeReadable, processes, sessionCwds, pinnedDirNames, pinSourceCount };
}

interface RawEntry {
  path: string;
  entryClass: CacheEntryClass;
}

async function listRawEntries(root: CacheRoot): Promise<RawEntry[] | "absent"> {
  if (root.mode === "whole-root") {
    try {
      await lstat(root.path);
    } catch {
      return "absent";
    }
    return [{ path: root.path, entryClass: classifyEntry(root.id, "") }];
  }
  let names: string[];
  try {
    names = await readdir(root.path);
  } catch {
    return "absent";
  }
  return names
    .filter((name) => !(root.id === "xdg-cache" && XDG_CACHE_EXCLUDED_NAMES.has(name)))
    .map((name) => ({ path: join(root.path, name), entryClass: classifyEntry(root.id, name) }));
}

async function duSizesKb(paths: string[]): Promise<Map<string, number> | undefined> {
  const sizes = new Map<string, number>();
  for (let i = 0; i < paths.length; i += DU_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + DU_CHUNK_SIZE);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("du", ["-skx", ...chunk], {
        timeout: CACHE_MEASURE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch {
      return undefined;
    }
    for (const line of stdout.split("\n")) {
      const match = /^(\d+)\t(.+)$/.exec(line);
      if (!match?.[1] || !match[2]) continue;
      sizes.set(match[2], Number.parseInt(match[1], 10));
    }
  }
  return sizes;
}

interface StatFacts extends EntryOwnership {
  mtimeMs: number;
  ctimeMs: number;
}

async function measureRoot(
  root: CacheRoot,
  nowMs: number,
): Promise<{ measurement: CacheRootMeasurement; entries: CacheEntry[]; ownership: Map<string, EntryOwnership> }> {
  const raw = await listRawEntries(root);
  if (raw === "absent") {
    return {
      measurement: { rootId: root.id, path: root.path, status: "absent", totalKb: 0, entryCount: 0 },
      entries: [],
      ownership: new Map(),
    };
  }

  const facts = new Map<string, StatFacts>();
  const statted: RawEntry[] = [];
  await Promise.all(
    raw.map(async (item) => {
      try {
        const st = await lstat(item.path);
        facts.set(item.path, {
          uid: st.uid,
          isSymlink: st.isSymbolicLink(),
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
        });
        statted.push(item);
      } catch {
        // Vanished between readdir and lstat — not a candidate.
      }
    }),
  );

  const ownership = new Map<string, EntryOwnership>();
  for (const [path, fact] of facts) {
    ownership.set(path, { uid: fact.uid, isSymlink: fact.isSymlink });
  }

  const sizes = await duSizesKb(statted.map((item) => item.path));
  if (sizes === undefined) {
    return {
      measurement: { rootId: root.id, path: root.path, status: "skipped", totalKb: 0, entryCount: 0 },
      entries: [],
      ownership,
    };
  }

  const entries: CacheEntry[] = [];
  let totalKb = 0;
  for (const item of statted) {
    const fact = facts.get(item.path);
    if (!fact) continue;
    const sizeKb = sizes.get(item.path) ?? 0;
    const newestChangeMs = Math.max(fact.mtimeMs, fact.ctimeMs);
    const ageDays = ageDaysFor(fact.mtimeMs, fact.ctimeMs, nowMs);
    entries.push({
      path: item.path,
      rootId: root.id,
      entryClass: item.entryClass,
      sizeKb,
      newestChangeMs,
      ageDays,
    });
    totalKb += sizeKb;
  }

  return {
    measurement: { rootId: root.id, path: root.path, status: "measured", totalKb, entryCount: entries.length },
    entries,
    ownership,
  };
}

export interface PlanCachePruneOptions {
  home?: string;
  // Test-only seam (see cacheRoots) — production always scans the real
  // "/tmp"; never exposed as a CLI flag or config key.
  tmpPath?: string;
  instanceConfig?: InstanceConfigReadResult;
  freeKbBefore?: number;
}

export async function planCachePrune(options: PlanCachePruneOptions = {}): Promise<CachePlan> {
  const home = options.home ?? homedir();
  const instanceConfig = options.instanceConfig ?? { status: "absent" as const };
  const nowMs = Date.now();

  const liveness = await collectLiveness(home, instanceConfig);
  const myUid = process.getuid?.();

  const roots: CacheRootMeasurement[] = [];
  const candidates: CacheCandidate[] = [];
  let reclaimableKb = 0;

  for (const root of cacheRoots(home, options.tmpPath)) {
    const { measurement, entries, ownership } = await measureRoot(root, nowMs);
    roots.push(measurement);
    for (const entry of entries) {
      const own = ownership.get(entry.path);
      if (!own) continue;
      const verdict = verdictFor(entry, own, liveness, myUid);
      candidates.push({ entry, verdict });
      if (verdict.kind === "prunable") {
        reclaimableKb += entry.sizeKb;
      }
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    ...(options.freeKbBefore !== undefined ? { freeKbBefore: options.freeKbBefore } : {}),
    roots,
    candidates,
    reclaimableKb,
    processTreeReadable: liveness.processTreeReadable,
    pinSourceCount: liveness.pinSourceCount,
  };
}

// True when `targetReal` is `parentReal` itself or strictly nested under it.
function isWithin(parentReal: string, targetReal: string): boolean {
  const rel = relative(parentReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

// Deletion guard: re-`lstat` (skip if now a symlink or missing), assert the
// resolved path stays inside its own root (no symlink-escape) and outside
// `dataDir`/`worktreeDir`, then `fs.promises.rm`. Failures are collected,
// never thrown — one bad candidate must never abort the rest of the sweep.
export async function executePrune(
  candidates: CacheCandidate[],
  guard: { dataDir?: string; worktreeDir?: string; home?: string; tmpPath?: string },
): Promise<PruneOutcome> {
  const removed: { path: string; sizeKb: number }[] = [];
  const failures: { path: string; message: string }[] = [];
  const roots = cacheRoots(guard.home ?? homedir(), guard.tmpPath);

  for (const candidate of candidates) {
    if (candidate.verdict.kind !== "prunable") continue;
    const { path, rootId, sizeKb } = candidate.entry;
    try {
      const st = await lstat(path);
      if (st.isSymbolicLink()) {
        failures.push({ path, message: "refused: now a symlink" });
        continue;
      }
      const root = roots.find((r) => r.id === rootId);
      const rootDir = root?.mode === "whole-root" ? dirname(path) : (root?.path ?? dirname(path));
      const rootRealPath = await realpath(rootDir);
      const targetRealPath = await realpath(path);
      // Must resolve strictly inside its own root (a "" relative would mean
      // the target equals the root itself — refused too, never a valid
      // per-entry candidate).
      const relToRoot = relative(rootRealPath, targetRealPath);
      if (!relToRoot || relToRoot.startsWith("..") || relToRoot.startsWith("/")) {
        failures.push({ path, message: "refused: resolves outside its cache root" });
        continue;
      }
      if (guard.dataDir) {
        const dataDirReal = await realpath(guard.dataDir).catch(() => guard.dataDir as string);
        if (isWithin(dataDirReal, targetRealPath)) {
          failures.push({ path, message: "refused: resolves inside dataDir" });
          continue;
        }
      }
      if (guard.worktreeDir) {
        const worktreeDirReal = await realpath(guard.worktreeDir).catch(() => guard.worktreeDir as string);
        if (isWithin(worktreeDirReal, targetRealPath)) {
          failures.push({ path, message: "refused: resolves inside worktreeDir" });
          continue;
        }
      }
      await rm(path, { recursive: true, force: true });
      removed.push({ path, sizeKb });
    } catch (error) {
      failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { removed, failures, freedKb: removed.reduce((sum, item) => sum + item.sizeKb, 0) };
}
