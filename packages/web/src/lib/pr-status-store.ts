import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type PrInfo, isPrInfoShape } from "@/lib/pr-status-shape";

export interface PrStatusResponse extends PrInfo {
  error?: string;
}

interface CacheEntry {
  response: PrStatusResponse;
  expiresAt: number;
}

type LastGoodEntry = Omit<PrInfo, "stale"> & { fetchedAt: number };

const cache = new Map<string, CacheEntry>();
const lastGoodCache = new Map<string, LastGoodEntry>();
const CACHE_TTL_MS = 120_000;
const ERROR_CACHE_TTL_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 1_000;

const EMPTY_PR_STATUS: Omit<PrStatusResponse, "error"> = {
  state: null,
  reviewDecision: null,
  ciStatus: null,
  canMerge: false,
  mergeConflict: false,
  totalThreads: 0,
  unresolvedThreads: 0,
};

function persistFilePath(): string {
  const stateDir = process.env["SPUR_STATE_DIR"];
  if (stateDir) {
    return path.join(stateDir, "spur-pr-status-cache.json");
  }
  return path.join(os.tmpdir(), "spur-pr-status-cache.json");
}

let persistTimer: NodeJS.Timeout | null = null;

function isLastGoodEntry(value: unknown): value is LastGoodEntry {
  return isPrInfoShape(value) && typeof (value as { fetchedAt?: unknown }).fetchedAt === "number";
}

function loadPersistedLastGood(): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(persistFilePath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLastGoodEntry(value)) lastGoodCache.set(key, value);
    }
  } catch {
    /* file missing, unreadable, or malformed */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const filePath = persistFilePath();
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      const data = Object.fromEntries(lastGoodCache.entries());
      writeFileSync(tmp, JSON.stringify(data), "utf-8");
      renameSync(tmp, filePath);
    } catch {
      /* best-effort */
    }
  }, PERSIST_DEBOUNCE_MS);
  if (persistTimer && typeof persistTimer.unref === "function") persistTimer.unref();
}

loadPersistedLastGood();

function recordLastGood(key: string, snapshot: Omit<LastGoodEntry, "fetchedAt">): LastGoodEntry {
  const entry: LastGoodEntry = { ...snapshot, fetchedAt: Date.now() };
  lastGoodCache.set(key, entry);
  schedulePersist();
  return entry;
}

function freshFromEntry(entry: LastGoodEntry): PrStatusResponse {
  return {
    state: entry.state,
    reviewDecision: entry.reviewDecision,
    ciStatus: entry.ciStatus,
    canMerge: entry.canMerge,
    mergeConflict: entry.mergeConflict,
    totalThreads: entry.totalThreads,
    unresolvedThreads: entry.unresolvedThreads,
    fetchedAt: entry.fetchedAt,
    stale: false,
  };
}

export function errorResponse(key: string, error: string): PrStatusResponse {
  const last = lastGoodCache.get(key);
  if (last) return { ...freshFromEntry(last), stale: true, error };
  return { ...EMPTY_PR_STATUS, stale: false, error };
}

export function extractPrCoords(
  url: string,
): { owner: string; repo: string; number: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

export function cacheKeyForCoords(coords: { owner: string; repo: string; number: string }): string {
  return `${coords.owner}/${coords.repo}/${coords.number}`;
}

export function readCachedPrStatus(key: string): PrStatusResponse | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.response;
}

export function cachePrStatusResponse(
  key: string,
  response: PrStatusResponse,
  ttlMs: number,
): void {
  cache.set(key, { response, expiresAt: Date.now() + ttlMs });
}

export function recordSuccessfulPrStatus(
  key: string,
  snapshot: Omit<LastGoodEntry, "fetchedAt">,
): PrStatusResponse {
  return freshFromEntry(recordLastGood(key, snapshot));
}

export function cacheTtlMs(): number {
  return CACHE_TTL_MS;
}

export function errorCacheTtlMs(): number {
  return ERROR_CACHE_TTL_MS;
}

export function markPrStatusMerged(url: string): void {
  const coords = extractPrCoords(url);
  if (!coords) return;
  const cacheKey = cacheKeyForCoords(coords);
  const previous = lastGoodCache.get(cacheKey);
  const next = recordLastGood(cacheKey, {
    state: "merged",
    reviewDecision: previous?.reviewDecision ?? null,
    ciStatus: previous?.ciStatus ?? null,
    canMerge: false,
    mergeConflict: false,
    totalThreads: previous?.totalThreads ?? 0,
    unresolvedThreads: previous?.unresolvedThreads ?? 0,
  });
  cachePrStatusResponse(cacheKey, freshFromEntry(next), CACHE_TTL_MS);
}

export function resetPrStatusCacheForTests(): void {
  cache.clear();
  lastGoodCache.clear();
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
