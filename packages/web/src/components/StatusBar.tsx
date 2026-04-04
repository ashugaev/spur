"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CACHE_TTL_MS,
  CiStatusDot,
  fetchPrInfo,
  GithubIcon,
  prCache,
  useGitError,
  type CiStatus,
  type PrInfo,
} from "@/lib/link-icons";
import type { SpurSessionView } from "@/lib/types";

const AGGREGATE_POLL_MS = 120_000;

interface PrEntry {
  url: string;
  owner: string;
  repo: string;
  number: string;
  info: PrInfo;
}

function parsePrUrl(url: string): { owner: string; repo: string; number: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}

function worstStatus(entries: PrEntry[]): CiStatus {
  let worst: CiStatus = null;
  for (const e of entries) {
    if (e.info.ciStatus === "failure") return "failure";
    if (e.info.ciStatus === "pending") worst = "pending";
    if (e.info.ciStatus === "success" && worst === null) worst = "success";
  }
  return worst;
}

function useAggregatePr(sessions: SpurSessionView[]) {
  const prUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const s of sessions) {
      for (const link of s.slots?.links ?? []) {
        if (link.label === "pr") urls.add(link.url);
      }
    }
    return [...urls];
  }, [sessions]);

  const [entries, setEntries] = useState<PrEntry[]>([]);

  useEffect(() => {
    if (prUrls.length === 0) {
      setEntries([]);
      return;
    }

    let cancelled = false;

    const run = async () => {
      const results: PrEntry[] = [];
      for (const url of prUrls) {
        const parsed = parsePrUrl(url);
        if (!parsed) continue;
        const cached = prCache.get(url);
        const info =
          cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS
            ? cached.data
            : await fetchPrInfo(url);
        if (!cached || Date.now() - cached.fetchedAt >= CACHE_TTL_MS) {
          prCache.set(url, { data: info, fetchedAt: Date.now() });
        }
        results.push({ url, ...parsed, info });
      }
      if (!cancelled) setEntries(results);
    };

    void run();
    const timer = setInterval(() => void run(), AGGREGATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [prUrls]);

  return entries;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("en-GB", { hour12: false });
}

function PrStateLabel({ state }: { state: string | null }) {
  if (!state) return null;
  const colors: Record<string, string> = {
    draft: "var(--color-text-tertiary)",
    open: "var(--color-status-ready)",
    merged: "var(--color-accent-violet)",
    closed: "var(--color-status-error)",
  };
  return (
    <span className="uppercase" style={{ color: colors[state] ?? undefined }}>
      {state}
    </span>
  );
}

export function StatusBar({ sessions }: { sessions: SpurSessionView[] }) {
  const gitError = useGitError();
  const prEntries = useAggregatePr(sessions);
  const aggregate = worstStatus(prEntries);
  const clock = useClock();

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex h-6 items-center justify-between border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 text-[9px] uppercase tracking-[0.08em]">
      <div className="flex items-center gap-6">
        {/* Daemon status */}
        <div className="flex items-center gap-1.5">
          {gitError ? (
            <span
              className="font-bold text-[var(--color-status-error)]"
              title={gitError}
            >
              Git Error
            </span>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-status-ready)] shadow-[0_0_4px_var(--color-status-ready)]" />
              <span className="text-[var(--color-text-secondary)]">Online</span>
            </>
          )}
        </div>

        {/* Aggregate CI */}
        {prEntries.length > 0 ? (
          <div className="group relative flex items-center gap-1.5">
            <GithubIcon />
            <CiStatusDot status={aggregate} />

            {/* Tooltip */}
            <div className="absolute bottom-full left-0 z-50 mb-1.5 hidden min-w-[180px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_rgba(0,0,0,0.5)] group-hover:block">
              {prEntries.slice(0, 8).map((entry) => (
                <div
                  key={entry.url}
                  className="flex items-center gap-2 py-0.5"
                >
                  <span className="truncate text-[var(--color-text-secondary)]">
                    {entry.owner}/{entry.repo}#{entry.number}
                  </span>
                  <CiStatusDot status={entry.info.ciStatus} />
                  <PrStateLabel state={entry.info.state} />
                </div>
              ))}
              {prEntries.length > 8 ? (
                <div className="pt-0.5 text-[var(--color-text-tertiary)]">
                  +{prEntries.length - 8} more
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Clock */}
      <div className="text-[var(--color-text-tertiary)]">{clock}</div>
    </footer>
  );
}
