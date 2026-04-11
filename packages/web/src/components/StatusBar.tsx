"use client";

import { useMemo, useState, useEffect } from "react";
import {
  CiStatusDot,
  fetchPrInfo,
  GithubIcon,
  prStateColor,
  useGitError,
  type CiStatus,
  type PrInfo,
} from "@/lib/link-icons";
import type { SpurSessionView } from "@/lib/types";

const AGGREGATE_POLL_MS = 120_000;
const RESOURCE_POLL_MS = 15_000;

type ResourceMetrics =
  | { available: false }
  | {
      available: true;
      cpuPercent: number;
      memoryPercent: number;
      diskPercent: number;
    };

interface PrEntry {
  url: string;
  label: string;
  info: PrInfo;
}

function parsePrLabel(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
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
        const label = parsePrLabel(url);
        if (!label) continue;
        const info = await fetchPrInfo(url);
        results.push({ url, label, info });
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

function useResourceMetrics() {
  const [metrics, setMetrics] = useState<ResourceMetrics>({ available: false });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch("/api/runtime/resources", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setMetrics({ available: false });
          return;
        }
        const payload = (await response.json()) as ResourceMetrics;
        if (!cancelled) {
          setMetrics(
            payload.available &&
              Number.isFinite(payload.cpuPercent) &&
              Number.isFinite(payload.memoryPercent) &&
              Number.isFinite(payload.diskPercent)
              ? payload
              : { available: false },
          );
        }
      } catch {
        if (!cancelled) setMetrics({ available: false });
      }
    };

    void run();
    const timer = setInterval(() => void run(), RESOURCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return metrics;
}

function PrStateLabel({ state }: { state: PrInfo["state"] }) {
  if (!state) return null;
  return (
    <span className="uppercase" style={{ color: prStateColor(state) }}>
      {state}
    </span>
  );
}

export function StatusBar({ sessions }: { sessions: SpurSessionView[] }) {
  const gitError = useGitError();
  const prEntries = useAggregatePr(sessions);
  const aggregate = worstStatus(prEntries);
  const resourceMetrics = useResourceMetrics();
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex h-6 items-center justify-between border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 text-[10px] uppercase tracking-[0.08em]">
      <div className="flex items-center gap-6">
        {/* Daemon status */}
        <div className="flex items-center gap-1.5">
          {gitError ? (
            <span className="font-bold text-[var(--color-status-error)]" title={gitError}>
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
          <div className="group/ci relative flex items-center gap-1.5" tabIndex={0}>
            <GithubIcon />
            <CiStatusDot status={aggregate} />

            {/* Tooltip */}
            <div className="absolute bottom-full left-0 z-50 mb-1.5 hidden max-w-[90vw] min-w-[180px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_rgba(0,0,0,0.5)] group-focus-within/ci:block group-hover/ci:block">
              {prEntries.slice(0, 8).map((entry) => (
                <div key={entry.url} className="flex items-center gap-2 py-0.5">
                  <span className="truncate text-[var(--color-text-secondary)]">{entry.label}</span>
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

        {resourceMetrics.available ? (
          <div className="flex items-center gap-3 text-[var(--color-text-secondary)]">
            <span className="flex items-center gap-1">
              <span>CPU</span>
              <span className="font-bold text-[var(--color-text-primary)]">
                {resourceMetrics.cpuPercent}%
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span>RAM</span>
              <span className="font-bold text-[var(--color-text-primary)]">
                {resourceMetrics.memoryPercent}%
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span>DISK</span>
              <span className="font-bold text-[var(--color-text-primary)]">
                {resourceMetrics.diskPercent}%
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {/* Build version */}
      <div className="text-[var(--color-text-tertiary)]">
        {process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev"}
      </div>
    </footer>
  );
}
