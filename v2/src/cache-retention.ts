import { execFile } from "node:child_process";
import { readdir, lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { listSessions } from "./metadata.js";
import {
  canReadProcessTree,
  collectDescendants,
  listProcesses,
  type ProcessInfo,
} from "./process-tree.js";
import { getTmuxPanePid, getTmuxSocketName, setTmuxSocketName } from "./runtime-tmux.js";
import type { InstanceConfigReadResult } from "./config.js";

const execFileAsync = promisify(execFile);

// `du` (measurement) and `rm` (deletion) only ever run from an explicit
// `spur cache` or `spur doctor` invocation, never from a daemon
// request-handling path. This is a call-site discipline, not an import-graph
// one: `spur daemon start` runs in the same process as every other CLI
// subcommand (cli.ts is the single entrypoint), so this module IS loaded
// into the daemon's process — via cli.ts's own top-level import of
// host-install.ts, not via session-service.ts (its only reference to
// host-install.ts, through workspace.ts, is a type-only import that is
// erased at build time and pulls in nothing at runtime). Importing it does
// not by itself widen the daemon's syscall surface — what matters is that
// neither server.ts nor session-service.ts ever calls
// `planCachePrune`/`executePrune`. The daemon's only disk syscall on that
// path stays `disk-space.ts`'s `readFreeKb` (a `df`, not a `du`) — see
// session-service.ts's warnIfHostDiskLow. Only host-install.ts's
// `reclaimable-caches` doctor check and cli.ts's `cache` command call these
// functions.

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
  | { kind: "pin-source" }
  | { kind: "spur-owned" }
  | { kind: "class-never-pruned" }
  | { kind: "process-tree-unreadable" }
  | { kind: "process-list-unavailable" }
  | { kind: "not-owned"; uid: number }
  | { kind: "symlink" };

export type CacheVerdict = { kind: "prunable" } | { kind: "protected"; reason: ProtectedReason };

export interface CacheEntry {
  path: string;
  rootId: CacheRootId;
  entryClass: CacheEntryClass;
  sizeKb: number;
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
  // `listProcesses()` returned `null` (ps unavailable, or an empty table —
  // see process-tree.ts) rather than a genuine process table. Kept distinct
  // from `processTreeReadable` (which only probes /proc/self/stat and stays
  // true even when the `ps` binary itself is missing or blocked).
  processListReadable: boolean;
  processes: readonly ProcessInfo[];
  sessionCwds: readonly LiveSessionCwd[];
  pinnedDirNames: ReadonlySet<string>;
  pinSourceCount: number;
  // Whether the instance config resolved (`status === "ok"`). Browser
  // revisions require this in addition to `pinSourceCount > 0`: P2/P3 pin
  // sources (every configured project/worktree) never resolve at all
  // without it, so a missing/invalid config must fail closed the same way
  // zero resolved sources does, not silently rely on whatever P1/P4 found.
  instanceConfigOk: boolean;
  // The set of `~/.npm/_npx/<hash>` directory names that supplied at least
  // one parsed `browsers.json` pin source (P4). An `npx-package` entry
  // whose hash is in this set is a pin source and must not be deleted.
  pinSourceNpxHashes: ReadonlySet<string>;
}

export interface CachePlan {
  generatedAt: string;
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
export const CACHE_MEASURE_TIMEOUT_MS = 30_000;
export const DU_CHUNK_SIZE = 500;

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

// Only the three prunable kinds reach this; verdictFor short-circuits
// all report-only classes before the floor is consulted.
type PrunableEntryClass = Extract<
  CacheEntryClass,
  { kind: "vendor-cache" | "npx-package" | "browser-revision" }
>;
const CLASS_FLOOR_DAYS: Record<PrunableEntryClass["kind"], number> = {
  "vendor-cache": GLOBAL_MIN_AGE_DAYS,
  "npx-package": NPX_MIN_AGE_DAYS,
  "browser-revision": BROWSER_REVISION_MIN_AGE_DAYS,
};

function classFloorDays(entryClass: PrunableEntryClass): number {
  return CLASS_FLOOR_DAYS[entryClass.kind];
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
  if (!liveness.processListReadable) {
    return { kind: "protected", reason: { kind: "process-list-unavailable" } };
  }
  if (
    entry.entryClass.kind === "browser-registry" ||
    entry.entryClass.kind === "tmp-entry" ||
    entry.entryClass.kind === "generic" ||
    entry.entryClass.kind === "browser-profile"
  ) {
    return { kind: "protected", reason: { kind: "class-never-pruned" } };
  }
  if (
    entry.entryClass.kind === "npx-package" &&
    liveness.pinSourceNpxHashes.has(entry.entryClass.hash)
  ) {
    return { kind: "protected", reason: { kind: "pin-source" } };
  }
  const effectiveFloor = Math.max(GLOBAL_MIN_AGE_DAYS, classFloorDays(entry.entryClass));
  if (entry.ageDays < effectiveFloor) {
    return {
      kind: "protected",
      reason: { kind: "too-recent", ageDays: entry.ageDays, floorDays: effectiveFloor },
    };
  }
  if (entry.entryClass.kind === "browser-revision") {
    // Fail closed on either signal: zero resolved `browsers.json` sources,
    // or no instance config at all (which P2/P3 — every configured
    // project/worktree — depend on; see resolvePins).
    if (!liveness.instanceConfigOk || liveness.pinSourceCount === 0) {
      return { kind: "protected", reason: { kind: "pin-unresolved" } };
    }
    if (liveness.pinnedDirNames.has(entry.entryClass.dirName)) {
      return {
        kind: "protected",
        reason: { kind: "pinned-revision", dirName: entry.entryClass.dirName },
      };
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
    {
      id: "playwright-mcp-profiles",
      path: join(home, ".cache", "ms-playwright-mcp"),
      mode: "entries",
    },
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
): Promise<{
  pinnedDirNames: Set<string>;
  pinSourceCount: number;
  pinSourceNpxHashes: Set<string>;
}> {
  const pinnedDirNames = new Set<string>();
  const pinSourceNpxHashes = new Set<string>();
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
    addFrom(
      await readBrowsersJson(join(projectPath, "node_modules", "playwright-core", "browsers.json")),
    );
    addFrom(await readPnpmStorePins(projectPath));
  }

  // P3: every real worktree (`<worktreeDir>/<projectId>/<sessionId>`, exactly
  // depth 2), independent of which sessions are currently live — 209 real
  // worktree installs on this host prove this is not a hypothetical source.
  if (instanceConfig.status === "ok") {
    for (const worktreePath of await listWorktreePaths(instanceConfig.config.worktreeDir)) {
      addFrom(
        await readBrowsersJson(
          join(worktreePath, "node_modules", "playwright-core", "browsers.json"),
        ),
      );
      addFrom(await readPnpmStorePins(worktreePath));
    }
  }

  // P4: every `~/.npm/_npx/<hash>` install — the `b`-registry proves MCP
  // browsers can launch from an _npx-installed playwright-core.
  const npxDir = join(home, ".npm", "_npx");
  try {
    const hashes = await readdir(npxDir);
    for (const hash of hashes) {
      const parsed = await readBrowsersJson(
        join(npxDir, hash, "node_modules", "playwright-core", "browsers.json"),
      );
      if (parsed !== undefined) {
        pinSourceNpxHashes.add(hash);
        addFrom(parsed);
      }
    }
  } catch {
    // ~/.npm/_npx absent or unreadable — no npx-installed pins.
  }

  return { pinnedDirNames, pinSourceCount, pinSourceNpxHashes };
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
    const parsed = await readBrowsersJson(
      join(pnpmDir, entry, "node_modules", "playwright-core", "browsers.json"),
    );
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
  const rawProcesses = await listProcesses();
  const processListReadable = rawProcesses !== null;
  const processes = rawProcesses ?? [];
  const processTreeReadable = await canReadProcessTree(process.pid);
  const { pinnedDirNames, pinSourceCount, pinSourceNpxHashes } = await resolvePins(
    home,
    instanceConfig,
  );

  const sessionCwds: LiveSessionCwd[] = [];
  if (instanceConfig.status === "ok") {
    // Read-only measurement path: `setTmuxSocketName` mutates a process-wide
    // global (see runtime-tmux.ts), so the prior value is restored once this
    // block is done rather than left clobbered for whatever else runs later
    // in the same process.
    const previousTmuxSocketName = getTmuxSocketName();
    setTmuxSocketName(instanceConfig.config.tmux.socketName);
    try {
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
    } finally {
      setTmuxSocketName(previousTmuxSocketName ?? undefined);
    }
  }

  return {
    processTreeReadable,
    processListReadable,
    processes,
    sessionCwds,
    pinnedDirNames,
    pinSourceCount,
    instanceConfigOk: instanceConfig.status === "ok",
    pinSourceNpxHashes,
  };
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

interface DuExecFailure {
  killed?: boolean;
  signal?: string | null;
  stdout?: unknown;
}

function isDuExecFailure(error: unknown): error is DuExecFailure {
  return typeof error === "object" && error !== null;
}

// `du` exits non-zero when even one entry in the chunk is unreadable
// (permission denied), while still writing correct size lines to stdout for
// every other entry in the chunk. Node's promisified `execFile` attaches
// `stdout` (and `killed`/`signal`) to the rejection error, so a
// partial-failure chunk is recoverable from its `stdout` instead of being
// discarded outright — discarding it previously zeroed the whole root's
// measurement over a single unreadable subdirectory anywhere inside it.
// Only a genuine timeout/abort (`killed`, or a `signal`) or a chunk with no
// usable stdout at all is treated as unmeasurable.
function partialDuStdout(error: unknown): string | undefined {
  if (!isDuExecFailure(error)) return undefined;
  if (error.killed || error.signal) return undefined;
  if (typeof error.stdout !== "string" || error.stdout.trim() === "") return undefined;
  return error.stdout;
}

async function duSizesKb(
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, number> | undefined> {
  const sizes = new Map<string, number>();
  for (let i = 0; i < paths.length; i += DU_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + DU_CHUNK_SIZE);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("du", ["-skx", ...chunk], {
        timeout: CACHE_MEASURE_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      }));
    } catch (error) {
      const partial = partialDuStdout(error);
      if (partial === undefined) {
        return undefined;
      }
      stdout = partial;
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

function makeRootResult(
  root: CacheRoot,
  status: CacheRootMeasurement["status"],
  totalKb: number,
  entries: CacheEntry[],
  ownership: ReadonlyMap<string, EntryOwnership>,
) {
  return {
    measurement: { rootId: root.id, path: root.path, status, totalKb, entryCount: entries.length },
    entries,
    ownership,
  };
}

async function measureRoot(
  root: CacheRoot,
  nowMs: number,
  signal?: AbortSignal,
): Promise<{
  measurement: CacheRootMeasurement;
  entries: CacheEntry[];
  ownership: ReadonlyMap<string, EntryOwnership>;
}> {
  const raw = await listRawEntries(root);
  if (raw === "absent") {
    return makeRootResult(root, "absent", 0, [], new Map());
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

  const sizes = await duSizesKb(
    statted.map((item) => item.path),
    signal,
  );
  if (sizes === undefined) {
    return makeRootResult(root, "skipped", 0, [], facts);
  }

  const entries: CacheEntry[] = [];
  let totalKb = 0;
  for (const item of statted) {
    const fact = facts.get(item.path);
    if (!fact) continue;
    const sizeKb = sizes.get(item.path);
    // No size line came back for this specific entry (e.g. it was the one
    // permission-denied entry in an otherwise-successful `du` chunk) — it is
    // simply unmeasured, not a reason to report it at size 0 or to drop the
    // whole root (see partialDuStdout above).
    if (sizeKb === undefined) continue;
    const ageDays = ageDaysFor(fact.mtimeMs, fact.ctimeMs, nowMs);
    entries.push({
      path: item.path,
      rootId: root.id,
      entryClass: item.entryClass,
      sizeKb,
      ageDays,
    });
    totalKb += sizeKb;
  }

  return makeRootResult(root, "measured", totalKb, entries, facts);
}

export interface PlanCachePruneOptions {
  home?: string;
  // Test-only seam (see cacheRoots) — production always scans the real
  // "/tmp"; never exposed as a CLI flag or config key.
  tmpPath?: string;
  instanceConfig?: InstanceConfigReadResult;
  // Bounds the `du` children the measurement spawns — a caller (host-install.ts's
  // `reclaimable-caches` doctor check) that races this against its own budget
  // needs the in-flight children actually killed on timeout, not just its own
  // await abandoned, or a wedged/slow `du` keeps the event loop (and `spur
  // doctor`'s exit) alive well past the budget.
  signal?: AbortSignal;
}

export async function planCachePrune(options: PlanCachePruneOptions = {}): Promise<CachePlan> {
  const home = options.home ?? homedir();
  const instanceConfig = options.instanceConfig ?? { status: "absent" as const };
  const nowMs = Date.now();

  const liveness = await collectLiveness(home, instanceConfig);
  const myUid = process.getuid?.();
  const spurOwnedDirs =
    instanceConfig.status === "ok" ? await resolveSpurOwnedDirs(instanceConfig) : [];

  const roots: CacheRootMeasurement[] = [];
  const candidates: CacheCandidate[] = [];
  let reclaimableKb = 0;

  for (const root of cacheRoots(home, options.tmpPath)) {
    const { measurement, entries, ownership } = await measureRoot(root, nowMs, options.signal);
    roots.push(measurement);
    for (const entry of entries) {
      const own = ownership.get(entry.path);
      if (!own) continue;
      let verdict = verdictFor(entry, own, liveness, myUid);
      if (verdict.kind === "prunable" && spurOwnedDirs.length > 0) {
        try {
          const targetReal = await realpath(entry.path);
          if (isSpurOwnedReal(targetReal, spurOwnedDirs)) {
            verdict = { kind: "protected", reason: { kind: "spur-owned" } };
          }
        } catch {
          // vanished between stat and realpath — leave verdict as prunable
        }
      }
      candidates.push({ entry, verdict });
      if (verdict.kind === "prunable") {
        reclaimableKb += entry.sizeKb;
      }
    }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    roots,
    candidates,
    reclaimableKb,
    processTreeReadable: liveness.processTreeReadable && liveness.processListReadable,
    pinSourceCount: liveness.pinSourceCount,
  };
}

// True when `targetReal` is `parentReal` itself or strictly nested under it.
function isWithin(parentReal: string, targetReal: string): boolean {
  const rel = relative(parentReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function resolveSpurOwnedDirs(
  instanceConfig: Extract<InstanceConfigReadResult, { status: "ok" }>,
): Promise<string[]> {
  return Promise.all(
    [instanceConfig.config.dataDir, instanceConfig.config.worktreeDir].map((path) =>
      realpath(path).catch(() => path),
    ),
  );
}

function isSpurOwnedReal(targetReal: string, spurOwnedDirs: readonly string[]): boolean {
  return spurOwnedDirs.some((dir) => isWithin(dir, targetReal));
}

// Deletion guard: re-`lstat` each candidate to rebuild age and ownership,
// decide through `verdictFor` against a single fresh liveness snapshot,
// assert the resolved path stays inside its own root (no symlink-escape)
// and outside `dataDir`/`worktreeDir`, then `fs.promises.rm`. Failures are
// collected, never thrown — one bad candidate must never abort the rest of
// the sweep.
export async function executePrune(
  candidates: CacheCandidate[],
  instanceConfig: Extract<InstanceConfigReadResult, { status: "ok" }>,
  seams?: { home?: string; tmpPath?: string },
): Promise<PruneOutcome> {
  const removed: { path: string; sizeKb: number }[] = [];
  const failures: { path: string; message: string }[] = [];
  const home = seams?.home ?? homedir();
  const roots = cacheRoots(home, seams?.tmpPath);
  const nowMs = Date.now();

  const freshLiveness = await collectLiveness(home, instanceConfig);
  const myUid = process.getuid?.();
  const spurOwnedDirs = await resolveSpurOwnedDirs(instanceConfig);

  for (const candidate of candidates) {
    if (candidate.verdict.kind !== "prunable") continue;
    const { path, rootId, sizeKb } = candidate.entry;
    try {
      const st = await lstat(path);
      const freshEntry = {
        ...candidate.entry,
        ageDays: ageDaysFor(st.mtimeMs, st.ctimeMs, nowMs),
      };
      const freshOwnership = { uid: st.uid, isSymlink: st.isSymbolicLink() };
      const verdict = verdictFor(freshEntry, freshOwnership, freshLiveness, myUid);
      if (verdict.kind !== "prunable") {
        failures.push({
          path,
          message: `refused at delete time: ${verdict.reason.kind}`,
        });
        continue;
      }
      const root = roots.find((r) => r.id === rootId);
      if (!root) {
        failures.push({ path, message: `refused: unknown cache root ${rootId}` });
        continue;
      }
      const rootDir = root.mode === "whole-root" ? dirname(path) : root.path;
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
      if (isSpurOwnedReal(targetRealPath, spurOwnedDirs)) {
        failures.push({ path, message: "refused: resolves inside Spur data directory" });
        continue;
      }
      await rm(path, { recursive: true, force: true });
      removed.push({ path, sizeKb });
    } catch (error) {
      failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { removed, failures, freedKb: removed.reduce((sum, item) => sum + item.sizeKb, 0) };
}

// Shared rendering helpers — both cli.ts's `spur cache` report and
// host-install.ts's `reclaimable-caches` doctor detail need "prunable
// candidates, biggest first" and a human GB size; one implementation here
// rather than each renderer keeping its own copy.
export function formatCacheSizeGb(sizeKb: number): string {
  return `${(sizeKb / (1024 * 1024)).toFixed(2)}GB`;
}

export function byEntrySizeDesc(a: CacheCandidate, b: CacheCandidate): number {
  return b.entry.sizeKb - a.entry.sizeKb;
}

export function prunableCandidates(
  plan: CachePlan,
): (CacheCandidate & { verdict: { kind: "prunable" } })[] {
  return plan.candidates
    .filter(
      (candidate): candidate is CacheCandidate & { verdict: { kind: "prunable" } } =>
        candidate.verdict.kind === "prunable",
    )
    .sort(byEntrySizeDesc);
}
