"use client";

import { useEffect, useMemo, useState } from "react";
import type { SpurSessionLink } from "@/lib/types";
import {
  type CiStatus,
  type PrInfo,
  type PrState,
  type ReviewDecision,
  isCiStatus,
  isPrInfoShape,
  isPrReady,
  isPrState,
  parseReviewDecision,
  prInfosEqual,
} from "@/lib/pr-status-shape";

export type ReviewProvider = "github" | "gitlab" | null;
export type { CiStatus, PrInfo, PrState, ReviewDecision };

const PR_STATE_COLORS: Record<PrState, string> = {
  draft: "var(--color-text-tertiary)",
  open: "var(--color-status-ready)",
  merged: "var(--color-accent-violet)",
  closed: "var(--color-status-error)",
};

const EMPTY_PR_INFO: PrInfo = {
  state: null,
  reviewDecision: null,
  ciStatus: null,
  canMerge: false,
  mergeConflict: false,
  totalThreads: 0,
  unresolvedThreads: 0,
};
const POLL_MS = 120_000;
const FRESH_TTL_MS = 120_000;
const PR_CACHE_STORAGE_KEY = "spur:pr-status-cache:v1";
const PR_CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  data: PrInfo;
  fetchedAt: number;
}

const prCache = new Map<string, CacheEntry>();
const pendingPrRequests = new Map<string, Promise<PrInfo>>();

// Notified from setPrCache so a `primePrInfo` write from anywhere (a batch
// fetch, a merge action) re-renders every already-mounted `usePrInfo`
// consumer for that URL, not just the one that triggered the write.
const prCacheListeners = new Map<string, Set<() => void>>();

function notifyPrCacheListeners(url: string): void {
  const listeners = prCacheListeners.get(url);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

export function subscribePrInfo(url: string, listener: () => void): () => void {
  let listeners = prCacheListeners.get(url);
  if (!listeners) {
    listeners = new Set();
    prCacheListeners.set(url, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) prCacheListeners.delete(url);
  };
}

export function isGitHubPrLinkLabel(label: string): boolean {
  return label === "github-pr" || label === "pr";
}

export function isGitLabPrLinkLabel(label: string): boolean {
  return label === "gitlab-pr";
}

export function isReviewLinkLabel(label: string): boolean {
  return isGitHubPrLinkLabel(label) || isGitLabPrLinkLabel(label);
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
    /* storage unavailable or malformed */
  }
}

let storageWriteTimer: ReturnType<typeof setTimeout> | null = null;
function persistPrCache(): void {
  if (typeof window === "undefined") return;
  if (storageWriteTimer) return;
  storageWriteTimer = setTimeout(() => {
    storageWriteTimer = null;
    try {
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
      /* quota / serialization */
    }
  }, 250);
}

function setPrCache(url: string, data: PrInfo): void {
  prCache.set(url, { data, fetchedAt: Date.now() });
  persistPrCache();
  notifyPrCacheListeners(url);
}

hydratePrCacheFromStorage();

function cachedOrEmpty(url: string): PrInfo {
  const cached = prCache.get(url);
  return cached ? cached.data : EMPTY_PR_INFO;
}

export function primePrInfo(url: string, data: PrInfo): void {
  setPrCache(url, data);
}

function parsePrInfoPayload(obj: Record<string, unknown>): PrInfo {
  return {
    state: isPrState(obj["state"]) ? obj["state"] : null,
    reviewDecision: parseReviewDecision(obj["reviewDecision"]),
    ciStatus: isCiStatus(obj["ciStatus"]) ? obj["ciStatus"] : null,
    canMerge: typeof obj["canMerge"] === "boolean" ? obj["canMerge"] : false,
    mergeConflict: typeof obj["mergeConflict"] === "boolean" ? obj["mergeConflict"] : false,
    totalThreads: typeof obj["totalThreads"] === "number" ? obj["totalThreads"] : 0,
    unresolvedThreads: typeof obj["unresolvedThreads"] === "number" ? obj["unresolvedThreads"] : 0,
    fetchedAt: typeof obj["fetchedAt"] === "number" ? obj["fetchedAt"] : undefined,
    stale: typeof obj["stale"] === "boolean" ? obj["stale"] : undefined,
  };
}

export async function fetchPrInfo(url: string): Promise<PrInfo> {
  const existing = pendingPrRequests.get(url);
  if (existing) return existing;

  const request = (async () => {
    try {
      const res = await fetch(`/api/pr-status?url=${encodeURIComponent(url)}`);
      if (!res.ok) return cachedOrEmpty(url);
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) return cachedOrEmpty(url);
      const obj = data as Record<string, unknown>;
      const error = typeof obj["error"] === "string" ? obj["error"] : null;
      const parsed = parsePrInfoPayload(obj);
      if (error && parsed.state === null) return cachedOrEmpty(url);
      return parsed;
    } catch {
      return cachedOrEmpty(url);
    } finally {
      pendingPrRequests.delete(url);
    }
  })();

  pendingPrRequests.set(url, request);
  return request;
}

// Matches the route's cap (route.ts MAX_BATCH_URLS): requests above this are
// rejected with a 400, so the batch must be chunked before it's sent.
const BATCH_CHUNK_SIZE = 100;

async function fetchPrInfoBatchChunk(urls: readonly string[]): Promise<boolean> {
  try {
    const res = await fetch("/api/pr-status/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    if (!res.ok) return false;
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return false;
    const results = (data as Record<string, unknown>)["results"];
    if (typeof results !== "object" || results === null) return false;
    for (const [url, value] of Object.entries(results as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const obj = value as Record<string, unknown>;
      const error = typeof obj["error"] === "string" ? obj["error"] : null;
      const parsed = parsePrInfoPayload(obj);
      // Mirror fetchPrInfo's guard: don't clobber a known-good cached entry
      // with a soft error payload (state: null alongside an `error` field).
      if (error && parsed.state === null) continue;
      primePrInfo(url, parsed);
    }
    return true;
  } catch {
    return false;
  }
}

// Primes the client cache for every URL in one round trip, so mounted rows'
// `usePrInfo` short-circuits on the next poll instead of each firing its own
// single-URL fetch. Chunks above the route's per-request cap. Returns
// whether every chunk succeeded, so a caller like `usePrReadyUrls` can tell
// a real (possibly partial) result apart from a failed fetch.
export async function fetchPrInfoBatch(urls: readonly string[]): Promise<boolean> {
  const unique = [...new Set(urls)];
  if (unique.length === 0) return true;

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + BATCH_CHUNK_SIZE));
  }

  const results = await Promise.all(chunks.map(fetchPrInfoBatchChunk));
  return results.every(Boolean);
}

export function reviewProviderFromUrl(url: string): ReviewProvider {
  try {
    const parsed = new URL(url);
    if (/github\.com$/i.test(parsed.hostname) && /\/pull\/\d+/.test(parsed.pathname)) {
      return "github";
    }
    if (/\/merge_requests\/\d+/.test(parsed.pathname)) {
      return "gitlab";
    }
    return null;
  } catch {
    return null;
  }
}

export function extractLinkId(link: SpurSessionLink): string {
  const url = link.url;
  if (isReviewLinkLabel(link.label)) {
    const githubMatch = url.match(/\/pull\/(\d+)/);
    if (githubMatch) return `#${githubMatch[1]}`;
    const gitlabMatch = url.match(/\/merge_requests\/(\d+)/);
    return gitlabMatch ? `!${gitlabMatch[1]}` : "PR";
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
      const cached = prCache.get(url);
      if (cached && Date.now() - cached.fetchedAt < FRESH_TTL_MS && !cached.data.stale) return;
      const result = await fetchPrInfo(url);
      if (cancelled) return;
      const prev = prCache.get(url)?.data;
      if (prev && prInfosEqual(prev, result)) {
        setInfo(result);
        return;
      }
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

  useEffect(() => {
    if (!url) return;
    const unsubscribe = subscribePrInfo(url, () => {
      setInfo((current) => {
        const next = cachedOrEmpty(url);
        return prInfosEqual(current, next) ? current : next;
      });
    });
    return unsubscribe;
  }, [url]);

  return info;
}

// GitHub-only URLs from `urls` are batch-fetched while `enabled` is true (on
// mount and every POLL_MS), and readiness is derived from the primed cache
// via `isPrReady`. `loaded` stays false until the first batch for the
// current URL set resolves, so a filter consumer can no-op instead of
// flashing an empty list while priming.
export function usePrReadyUrls(
  urls: readonly string[],
  enabled: boolean,
): { readonly ready: ReadonlySet<string>; readonly loaded: boolean } {
  // Keyed on content, not array identity: a caller that doesn't memoize its
  // `urls` array (a fresh literal each render) must not re-trigger the
  // fetch effect below every render.
  const urlsKey = urls.join("\n");
  const githubUrls = useMemo(
    () => urls.filter((url) => reviewProviderFromUrl(url) === "github"),
    [urlsKey],
  );
  const [state, setState] = useState<{ ready: ReadonlySet<string>; loaded: boolean }>({
    ready: new Set(),
    loaded: false,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ ready: new Set(), loaded: false });
      return;
    }
    if (githubUrls.length === 0) {
      setState({ ready: new Set(), loaded: true });
      return;
    }

    // The URL set just changed (this effect re-runs on every `githubUrls`
    // identity change): the previous `ready` set belonged to a different set
    // of URLs, so it must stop gating the filter as "loaded" until the new
    // batch below resolves — otherwise a newly PR-ready session is filtered
    // out for one round trip against stale readiness data.
    setState((current) => ({ ready: current.ready, loaded: false }));

    let cancelled = false;
    const run = async () => {
      const success = await fetchPrInfoBatch(githubUrls);
      if (cancelled) return;
      if (!success) {
        // Leave the existing state as-is: a failed fetch must not commit an
        // unprimed (empty) `ready` set, which would narrow a `prReadyOnly`
        // filter to nothing instead of leaving it a no-op.
        return;
      }
      const ready = new Set(githubUrls.filter((url) => isPrReady(cachedOrEmpty(url))));
      setState({ ready, loaded: true });
    };

    void run();
    const timer = setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, githubUrls]);

  // Recompute the ready set the moment any of these URLs' cache entries
  // change — a `primePrInfo` write from anywhere (e.g. the post-merge prime
  // in `SessionRow`) — rather than waiting for the next POLL_MS batch. Keeps
  // the filter's ready set aligned with the per-row badges it's meant to match.
  useEffect(() => {
    if (!enabled || githubUrls.length === 0) return;
    const recompute = () => {
      const ready = new Set(githubUrls.filter((url) => isPrReady(cachedOrEmpty(url))));
      setState({ ready, loaded: true });
    };
    const unsubscribes = githubUrls.map((url) => subscribePrInfo(url, recompute));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [enabled, githubUrls]);

  return state;
}

export function prStateColor(state: PrState | null): string | undefined {
  return state ? PR_STATE_COLORS[state] : undefined;
}

export function CiStatusDot({ status }: { status: CiStatus }) {
  if (!status) return null;
  if (status === "success")
    return (
      <svg
        aria-label="CI passing"
        role="img"
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
        aria-label="CI failing"
        role="img"
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
      aria-label="CI pending"
      role="img"
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

export function MergeConflictBadge() {
  return (
    <svg
      aria-label="Merge conflict"
      role="img"
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-status-error)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="2.5" fill="var(--color-status-error)" stroke="none" />
      <circle cx="6" cy="18" r="2.5" fill="var(--color-status-error)" stroke="none" />
      <circle cx="18" cy="18" r="2.5" fill="var(--color-status-error)" stroke="none" />
      <path d="M6 8.5v7" />
      <path d="M6 11h8a4 4 0 0 1 4 4v0.5" />
    </svg>
  );
}

function CompositeCiReviewMark({
  className,
  reviewColor,
  title,
}: {
  className?: string;
  reviewColor: string;
  title: string;
}) {
  const halo = "var(--color-bg-base)";

  const strokedPath = (d: string, color: string, width: number) => (
    <>
      <path d={d} stroke={halo} strokeWidth={width + 1.25} />
      <path d={d} stroke={color} strokeWidth={width} />
    </>
  );

  return (
    <span
      aria-label={title}
      className={`inline-flex shrink-0 ${className ?? ""}`.trim()}
      role="img"
      title={title}
    >
      <svg
        aria-hidden="true"
        className="h-3.5 w-[1.15rem]"
        viewBox="0 0 24 18"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {strokedPath("M8.75 9.5 11.9 12.65 17.65 5.9", reviewColor, 2.15)}
        {strokedPath("M2.75 9.5 5.9 12.65 11.65 5.9", "var(--color-status-ready)", 2.15)}
      </svg>
    </span>
  );
}

export function ReviewDecisionDot({
  decision,
  className,
}: {
  decision: "approved" | "changes_requested";
  className?: string;
}) {
  if (decision === "approved")
    return (
      <span className={className} data-pr-review-decision="approved">
        <CompositeCiReviewMark reviewColor="var(--color-status-ready)" title="Approved" />
      </span>
    );

  return (
    <span className={className} data-pr-review-decision="changes_requested">
      <CompositeCiReviewMark reviewColor="var(--color-status-error)" title="Changes requested" />
    </span>
  );
}

export function ReviewCommentsBadge({ total, unresolved }: { total: number; unresolved: number }) {
  if (total <= 0) return null;
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
      className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${color}`}
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

export function GitlabIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8.001 15.15 10.945 6.09h-5.89L8 15.15Z" />
      <path d="M8.001 15.15 5.055 6.09H.925l7.076 9.06Z" />
      <path d="m.925 6.09-.895 2.755a.611.611 0 0 0 .221.683l7.75 5.622L.925 6.09Z" />
      <path d="M.925 6.09h4.13L3.28.633a.306.306 0 0 0-.581 0L.925 6.09Z" />
      <path d="M8.001 15.15 10.945 6.09h4.13L8 15.15Z" />
      <path d="m15.075 6.09.895 2.755a.611.611 0 0 1-.221.683l-7.75 5.622 7.076-9.06Z" />
      <path d="M15.075 6.09h-4.13L12.72.633a.306.306 0 0 1 .581 0l1.774 5.457Z" />
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

export function ActivityIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.5.5 0 0 1-.96 0L9.24 3.18a.5.5 0 0 0-.96 0l-2.35 8.36A2 2 0 0 1 4 13H2" />
    </svg>
  );
}
