"use client";

import { useEffect, useState } from "react";
import type { SpurSessionLink } from "@/lib/types";

export type PrState = "draft" | "open" | "merged" | "closed";
export type CiStatus = "success" | "failure" | "pending" | null;

export interface PrInfo {
  state: PrState | null;
  ciStatus: CiStatus;
  totalThreads: number;
  unresolvedThreads: number;
  fetchedAt?: number;
  stale?: boolean;
}

const PR_STATE_COLORS: Record<PrState, string> = {
  draft: "var(--color-text-tertiary)",
  open: "var(--color-status-ready)",
  merged: "var(--color-accent-violet)",
  closed: "var(--color-status-error)",
};

const EMPTY_PR_INFO: PrInfo = {
  state: null,
  ciStatus: null,
  totalThreads: 0,
  unresolvedThreads: 0,
};
const POLL_MS = 120_000; // poll every 2 min, not 30s
const PR_CACHE_STORAGE_KEY = "spur:pr-status-cache:v1";
const PR_CACHE_MAX_ENTRIES = 200;

let gitErrorMessage: string | null = null;
const gitErrorListeners = new Set<() => void>();

function setGitError(msg: string | null) {
  gitErrorMessage = msg;
  for (const cb of gitErrorListeners) cb();
}

/** Subscribe to GitHub integration error state. */
export function useGitError(): string | null {
  const [err, setErr] = useState(gitErrorMessage);
  useEffect(() => {
    const cb = () => setErr(gitErrorMessage);
    gitErrorListeners.add(cb);
    return () => {
      gitErrorListeners.delete(cb);
    };
  }, []);
  return err;
}

interface CacheEntry {
  data: PrInfo;
  fetchedAt: number;
}

const prCache = new Map<string, CacheEntry>();
const pendingPrRequests = new Map<string, Promise<PrInfo>>();

function isPrInfoShape(value: unknown): value is PrInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["state"] === null ||
      v["state"] === "draft" ||
      v["state"] === "open" ||
      v["state"] === "merged" ||
      v["state"] === "closed") &&
    (v["ciStatus"] === null ||
      v["ciStatus"] === "success" ||
      v["ciStatus"] === "failure" ||
      v["ciStatus"] === "pending") &&
    typeof v["totalThreads"] === "number" &&
    typeof v["unresolvedThreads"] === "number"
  );
}

function hydratePrCacheFromStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PR_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [url, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      const data = entry["data"];
      const fetchedAt = entry["fetchedAt"];
      if (typeof fetchedAt !== "number" || !isPrInfoShape(data)) continue;
      prCache.set(url, { data, fetchedAt });
    }
  } catch {
    // storage unavailable or malformed JSON — silent
  }
}

let storageWriteTimer: ReturnType<typeof setTimeout> | null = null;
function persistPrCache(): void {
  if (typeof window === "undefined") return;
  if (storageWriteTimer) return;
  storageWriteTimer = setTimeout(() => {
    storageWriteTimer = null;
    try {
      // Cap entries to PR_CACHE_MAX_ENTRIES, dropping oldest by fetchedAt.
      if (prCache.size > PR_CACHE_MAX_ENTRIES) {
        const sorted = [...prCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
        const drop = sorted.length - PR_CACHE_MAX_ENTRIES;
        for (let i = 0; i < drop; i++) {
          const item = sorted[i];
          if (item) prCache.delete(item[0]);
        }
      }
      const obj = Object.fromEntries(prCache.entries());
      window.localStorage.setItem(PR_CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // ignore quota / serialization errors
    }
  }, 250);
}

function setPrCache(url: string, data: PrInfo): void {
  prCache.set(url, { data, fetchedAt: Date.now() });
  persistPrCache();
}

// Hydrate once at module load on the client.
hydratePrCacheFromStorage();

function isPrState(value: unknown): value is PrState {
  return value === "draft" || value === "open" || value === "merged" || value === "closed";
}

function isCiStatus(value: unknown): value is CiStatus {
  return value === "success" || value === "failure" || value === "pending" || value === null;
}

function cachedOrEmpty(url: string): PrInfo {
  const cached = prCache.get(url);
  return cached ? cached.data : EMPTY_PR_INFO;
}

export async function fetchPrInfo(url: string): Promise<PrInfo> {
  const existing = pendingPrRequests.get(url);
  if (existing) return existing;

  const request = (async () => {
    try {
      const res = await fetch(`/api/pr-status?url=${encodeURIComponent(url)}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setGitError(typeof body["error"] === "string" ? body["error"] : `GitHub API ${res.status}`);
        return cachedOrEmpty(url);
      }
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) {
        setGitError(null);
        return cachedOrEmpty(url);
      }
      const obj = data as Record<string, unknown>;
      const error = typeof obj["error"] === "string" ? obj["error"] : null;
      setGitError(error);
      const parsed: PrInfo = {
        state: isPrState(obj["state"]) ? obj["state"] : null,
        ciStatus: isCiStatus(obj["ciStatus"]) ? obj["ciStatus"] : null,
        totalThreads: typeof obj["totalThreads"] === "number" ? obj["totalThreads"] : 0,
        unresolvedThreads:
          typeof obj["unresolvedThreads"] === "number" ? obj["unresolvedThreads"] : 0,
        fetchedAt: typeof obj["fetchedAt"] === "number" ? obj["fetchedAt"] : undefined,
        stale: typeof obj["stale"] === "boolean" ? obj["stale"] : undefined,
      };
      // Don't clobber a known good cached value with an empty error payload.
      if (error && parsed.state === null) {
        return cachedOrEmpty(url);
      }
      return parsed;
    } catch {
      setGitError("GitHub API unreachable");
      return cachedOrEmpty(url);
    } finally {
      pendingPrRequests.delete(url);
    }
  })();

  pendingPrRequests.set(url, request);
  return request;
}

export function extractLinkId(link: SpurSessionLink): string {
  const url = link.url;
  if (link.label === "pr") {
    const match = url.match(/\/pull\/(\d+)/);
    return match ? `#${match[1]}` : "PR";
  }
  if (link.label === "tracker") {
    const match = url.match(/\/browse\/([A-Z]+-\d+)/) ?? url.match(/([A-Z]+-\d+)/);
    return match ? match[1] : "task";
  }
  return link.label;
}

export function usePrInfo(url: string | undefined): PrInfo {
  const [info, setInfo] = useState<PrInfo>(() => (url ? cachedOrEmpty(url) : EMPTY_PR_INFO));

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const run = async () => {
      const result = await fetchPrInfo(url);
      if (cancelled) return;
      setPrCache(url, result);
      setInfo(result);
    };

    void run();
    const timer = setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url]);

  return info;
}

export function prStateColor(state: PrState | null): string | undefined {
  return state ? PR_STATE_COLORS[state] : undefined;
}

export function CiStatusDot({ status }: { status: CiStatus }) {
  if (!status) return null;
  if (status === "success")
    return (
      <svg
        className="h-3 w-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-status-ready)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  if (status === "failure")
    return (
      <svg
        className="h-3 w-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-status-error)"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    );
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-status-attention)"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="10" strokeWidth="2" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

export function ReviewCommentsBadge({ total, unresolved }: { total: number; unresolved: number }) {
  if (total <= 0) return <span className="inline-flex w-6" />;
  const hasUnresolved = unresolved > 0;
  const color = hasUnresolved
    ? "text-[var(--color-status-attention)]"
    : "text-[var(--color-text-tertiary)]";
  const label = hasUnresolved ? `${unresolved}/${total}` : `${total}`;
  const title = hasUnresolved
    ? `${unresolved} unresolved of ${total} thread${total === 1 ? "" : "s"}`
    : `${total} resolved thread${total === 1 ? "" : "s"}`;
  return (
    <span
      className={`inline-flex w-6 items-center gap-0.5 text-[10px] font-bold ${color}`}
      title={title}
    >
      <svg
        className="h-2.5 w-2.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {label}
    </span>
  );
}

export function GithubIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function JiraIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77zM2 11.6a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72A4.362 4.362 0 0 0 12.48 22V12.44a.84.84 0 0 0-.84-.84H2z" />
    </svg>
  );
}
