import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Persisted negative cache for PR discovery.
//
// Keyed by repo slug plus resolved branch, not by worktree path: the same
// branch in two worktrees of one repo is the same question, worktree paths
// churn under the worktree pool and `spur gc`, and a branch rename produces a
// new key with no resurrection path. Persisted so a daemon restart does not
// re-burst a lookup for every branch that has no PR.

export interface PrRepoSlug {
  owner: string;
  name: string;
}

export interface PrLookupTerminalPr {
  number: number;
  state: "CLOSED" | "MERGED";
}

export interface PrLookupEntry {
  branch: string;
  misses: number;
  lastCheckedAt: number;
  terminal?: PrLookupTerminalPr;
}

interface PrLookupFile {
  version: 1;
  entries: PrLookupEntry[];
}

const PR_LOOKUP_FILE_VERSION = 1;
const PR_LOOKUP_MISS_BASE_MS = 60_000;
const PR_LOOKUP_ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;
const PR_LOOKUP_MAX_ENTRIES_PER_REPO = 500;
/** Re-check cadence cap for a branch whose session is running. */
export const PR_LOOKUP_LIVE_CAP_MS = 5 * 60_000;
/** Re-check cadence cap for a branch whose session is not running. */
export const PR_LOOKUP_IDLE_CAP_MS = 60 * 60_000;
// A merged/closed-only branch skips the climb and sits at the cap step
// immediately: `PR_LOOKUP_MISS_BASE_MS * 2^(misses-1)` past this many misses is
// far above any cap, so `Math.min` always yields the cap.
const PR_LOOKUP_TERMINAL_MISSES = 24;

type RepoEntries = Map<string, PrLookupEntry>;

const loaded = new Map<string, RepoEntries>();

export function _resetPrLookupCacheForTests(): void {
  loaded.clear();
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

function repoFilePath(dataDir: string, slug: PrRepoSlug): string {
  return join(
    dataDir,
    "source-state",
    "pr-lookup",
    sanitizePathSegment(slug.owner),
    `${sanitizePathSegment(slug.name)}.json`,
  );
}

function isTerminalPr(value: unknown): value is PrLookupTerminalPr {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["number"] === "number" &&
    (record["state"] === "CLOSED" || record["state"] === "MERGED")
  );
}

function parseEntry(value: unknown): PrLookupEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const branch = record["branch"];
  const misses = record["misses"];
  const lastCheckedAt = record["lastCheckedAt"];
  if (typeof branch !== "string" || !branch) {
    return null;
  }
  if (typeof misses !== "number" || !Number.isFinite(misses) || misses < 1) {
    return null;
  }
  if (typeof lastCheckedAt !== "number" || !Number.isFinite(lastCheckedAt)) {
    return null;
  }
  const terminal = record["terminal"];
  return {
    branch,
    misses,
    lastCheckedAt,
    ...(isTerminalPr(terminal) ? { terminal } : {}),
  };
}

function bound(entries: RepoEntries, nowMs: number): RepoEntries {
  for (const [branch, entry] of entries) {
    if (nowMs - entry.lastCheckedAt > PR_LOOKUP_ENTRY_TTL_MS) {
      entries.delete(branch);
    }
  }
  if (entries.size > PR_LOOKUP_MAX_ENTRIES_PER_REPO) {
    const oldestFirst = [...entries.values()].sort((a, b) => a.lastCheckedAt - b.lastCheckedAt);
    const excess = entries.size - PR_LOOKUP_MAX_ENTRIES_PER_REPO;
    for (const entry of oldestFirst.slice(0, excess)) {
      entries.delete(entry.branch);
    }
  }
  return entries;
}

function loadRepoEntries(dataDir: string, slug: PrRepoSlug, nowMs: number): RepoEntries {
  const path = repoFilePath(dataDir, slug);
  const cached = loaded.get(path);
  if (cached) {
    return cached;
  }
  const entries: RepoEntries = new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      const file = parsed as Record<string, unknown>;
      if (file["version"] === PR_LOOKUP_FILE_VERSION && Array.isArray(file["entries"])) {
        for (const raw of file["entries"]) {
          const entry = parseEntry(raw);
          if (entry) {
            entries.set(entry.branch, entry);
          }
        }
      }
    }
  } catch {
    // Missing, unreadable, corrupt or unknown-version file reads as empty.
  }
  bound(entries, nowMs);
  loaded.set(path, entries);
  return entries;
}

function persist(dataDir: string, slug: PrRepoSlug, entries: RepoEntries): void {
  const path = repoFilePath(dataDir, slug);
  const file: PrLookupFile = { version: PR_LOOKUP_FILE_VERSION, entries: [...entries.values()] };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(file)}\n`, "utf-8");
    renameSync(tmpPath, path);
  } catch {
    // A cache that cannot reach disk degrades to in-memory only. Discovery must
    // never fail because the dataDir is read-only.
  }
}

export function readPrLookupEntry(
  dataDir: string,
  slug: PrRepoSlug,
  branch: string,
  nowMs: number = Date.now(),
): PrLookupEntry | null {
  return loadRepoEntries(dataDir, slug, nowMs).get(branch) ?? null;
}

/**
 * Records "this branch has no open PR", advancing the backoff by one step.
 * Only an `absent` lookup outcome may call this: a skipped lookup must never
 * write a false negative that outlives the rate-limit window.
 */
export function markPrLookupMiss(
  dataDir: string,
  slug: PrRepoSlug,
  branch: string,
  nowMs: number = Date.now(),
): PrLookupEntry {
  const entries = loadRepoEntries(dataDir, slug, nowMs);
  const previous = entries.get(branch);
  const entry: PrLookupEntry = {
    branch,
    misses: (previous?.terminal ? 0 : (previous?.misses ?? 0)) + 1,
    lastCheckedAt: nowMs,
  };
  entries.set(branch, entry);
  bound(entries, nowMs);
  persist(dataDir, slug, entries);
  return entry;
}

/**
 * Records "this branch's newest PRs are all merged or closed". Sits at the cap
 * step so a reopened PR is still detected, unlike a never-recheck skip.
 */
export function markPrLookupTerminal(
  dataDir: string,
  slug: PrRepoSlug,
  branch: string,
  pr: PrLookupTerminalPr,
  nowMs: number = Date.now(),
): PrLookupEntry {
  const entries = loadRepoEntries(dataDir, slug, nowMs);
  const entry: PrLookupEntry = {
    branch,
    misses: PR_LOOKUP_TERMINAL_MISSES,
    lastCheckedAt: nowMs,
    terminal: pr,
  };
  entries.set(branch, entry);
  bound(entries, nowMs);
  persist(dataDir, slug, entries);
  return entry;
}

/** Drops the negative entry once an open PR is found for the branch. */
export function clearPrLookupEntry(
  dataDir: string,
  slug: PrRepoSlug,
  branch: string,
  nowMs: number = Date.now(),
): void {
  const entries = loadRepoEntries(dataDir, slug, nowMs);
  if (!entries.delete(branch)) {
    return;
  }
  persist(dataDir, slug, entries);
}

function prLookupBackoffMs(entry: PrLookupEntry, capMs: number): number {
  const steps = Math.max(0, entry.misses - 1);
  return Math.min(PR_LOOKUP_MISS_BASE_MS * 2 ** steps, capMs);
}

/**
 * Whether a branch may be looked up again. An unknown branch is always due, so
 * no cache state can stop checking forever — the worst case is `capMs`.
 */
export function isPrLookupDue(
  entry: PrLookupEntry | null,
  capMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!entry) {
    return true;
  }
  return nowMs - entry.lastCheckedAt >= prLookupBackoffMs(entry, capMs);
}
