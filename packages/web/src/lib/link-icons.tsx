"use client";

import { useCallback, useEffect, useState } from "react";
import type { SpurSessionLink } from "@/lib/types";

export type PrState = "draft" | "open" | "merged" | "closed";
export type CiStatus = "success" | "failure" | "pending" | null;

export interface PrInfo {
  state: PrState | null;
  ciStatus: CiStatus;
  reviewComments: number;
}

const PR_STATE_COLORS: Record<PrState, string> = {
  draft: "var(--color-text-tertiary)",
  open: "var(--color-status-ready)",
  merged: "var(--color-accent-violet)",
  closed: "var(--color-status-error)",
};

const EMPTY_PR_INFO: PrInfo = { state: null, ciStatus: null, reviewComments: 0 };
const CACHE_TTL_MS = 30_000;
const POLL_MS = 30_000;

interface CacheEntry {
  data: PrInfo;
  fetchedAt: number;
}

const prCache = new Map<string, CacheEntry>();

function isPrState(value: unknown): value is PrState {
  return value === "draft" || value === "open" || value === "merged" || value === "closed";
}

function isCiStatus(value: unknown): value is CiStatus {
  return value === "success" || value === "failure" || value === "pending" || value === null;
}

async function fetchPrInfo(url: string): Promise<PrInfo> {
  const res = await fetch(`/api/pr-status?url=${encodeURIComponent(url)}`);
  if (!res.ok) return EMPTY_PR_INFO;
  const data: unknown = await res.json();
  if (typeof data !== "object" || data === null) return EMPTY_PR_INFO;
  const obj = data as Record<string, unknown>;
  return {
    state: isPrState(obj["state"]) ? obj["state"] : null,
    ciStatus: isCiStatus(obj["ciStatus"]) ? obj["ciStatus"] : null,
    reviewComments: typeof obj["reviewComments"] === "number" ? obj["reviewComments"] : 0,
  };
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
  const [info, setInfo] = useState<PrInfo>(() => {
    if (!url) return EMPTY_PR_INFO;
    const cached = prCache.get(url);
    return cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS ? cached.data : EMPTY_PR_INFO;
  });

  const doFetch = useCallback(async (target: string) => {
    const cached = prCache.get(target);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setInfo(cached.data);
      return;
    }
    const result = await fetchPrInfo(target);
    prCache.set(target, { data: result, fetchedAt: Date.now() });
    setInfo(result);
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const run = () => {
      if (!cancelled) void doFetch(url);
    };

    run();
    const timer = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, doFetch]);

  return info;
}

export function prStateColor(state: PrState | null): string | undefined {
  return state ? PR_STATE_COLORS[state] : undefined;
}

const CI_DOT_COLORS: Record<string, string> = {
  success: "var(--color-status-ready)",
  failure: "var(--color-status-error)",
  pending: "var(--color-status-attention)",
};

export function CiStatusDot({ status }: { status: CiStatus }) {
  if (!status) return null;
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: CI_DOT_COLORS[status] }}
      title={`CI: ${status}`}
    />
  );
}

export function ReviewCommentsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-text-tertiary)]"
      title={`${count} review comment${count === 1 ? "" : "s"}`}
    >
      <svg
        className="h-2.5 w-2.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {count}
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
