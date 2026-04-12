"use client";

import { useEffect, useMemo, useState } from "react";
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
const CPU_RAM_ATTENTION_THRESHOLD = 85;
const DISK_ERROR_THRESHOLD = 85;

type HealthLevel = "ready" | "attention" | "error" | "unknown";

type ResourceMetrics =
  | {
      available: false;
      daemonAlive: boolean;
    }
  | {
      available: true;
      daemonAlive: boolean;
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
  const [metrics, setMetrics] = useState<ResourceMetrics>({ available: false, daemonAlive: false });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch("/api/runtime/resources", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setMetrics({ available: false, daemonAlive: false });
          return;
        }
        const payload = (await response.json()) as ResourceMetrics;
        if (!cancelled) {
          setMetrics(
            payload.available &&
              typeof payload.daemonAlive === "boolean" &&
              Number.isFinite(payload.cpuPercent) &&
              Number.isFinite(payload.memoryPercent) &&
              Number.isFinite(payload.diskPercent)
              ? payload
              : {
                  available: false,
                  daemonAlive:
                    typeof payload.daemonAlive === "boolean" ? payload.daemonAlive : false,
                },
          );
        }
      } catch {
        if (!cancelled) setMetrics({ available: false, daemonAlive: false });
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

function healthColor(level: HealthLevel): string {
  if (level === "error") return "var(--color-status-error)";
  if (level === "attention") return "var(--color-status-attention)";
  if (level === "ready") return "var(--color-status-ready)";
  return "var(--color-text-tertiary)";
}

function resourceLevel(kind: "cpu" | "memory" | "disk", value: number): HealthLevel {
  if (kind === "disk") {
    return value >= DISK_ERROR_THRESHOLD ? "error" : "ready";
  }
  return value >= CPU_RAM_ATTENTION_THRESHOLD ? "attention" : "ready";
}

function aggregateOnlineLevel(metrics: ResourceMetrics): HealthLevel {
  if (!metrics.daemonAlive) return "error";
  if (!metrics.available) return "ready";

  const cpu = resourceLevel("cpu", metrics.cpuPercent);
  const memory = resourceLevel("memory", metrics.memoryPercent);
  const disk = resourceLevel("disk", metrics.diskPercent);
  if (disk === "error") return "error";
  if (cpu === "attention" || memory === "attention") return "attention";
  return "ready";
}

function StatusDot({ level }: { level: HealthLevel }) {
  const color = healthColor(level);
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color, boxShadow: `0 0 4px ${color}` }}
    />
  );
}

function statusText(level: HealthLevel): string {
  if (level === "error") return "critical";
  if (level === "attention") return "warning";
  if (level === "ready") return "healthy";
  return "unavailable";
}

function ResourceStatusRow({
  label,
  level,
  value,
}: {
  label: "CPU" | "RAM" | "HDD" | "Daemon";
  level: HealthLevel;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-2 text-[var(--color-text-secondary)]">
        <StatusDot level={level} />
        <span>{label}</span>
      </span>
      <span
        aria-label={`${label} ${value} ${statusText(level)}`}
        className="font-bold"
        style={{ color: healthColor(level) }}
      >
        {value}
      </span>
    </div>
  );
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
  const [onlineHovered, setOnlineHovered] = useState(false);
  const [onlinePinned, setOnlinePinned] = useState(false);
  const onlineLevel = aggregateOnlineLevel(resourceMetrics);
  const daemonLevel = resourceMetrics.daemonAlive ? "ready" : "error";
  const onlineOpen = onlineHovered || onlinePinned;
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-6">
        <div
          className="group/status relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setOnlinePinned(false);
            }
          }}
          onMouseEnter={() => setOnlineHovered(true)}
          onMouseLeave={() => setOnlineHovered(false)}
        >
          <button
            aria-expanded={onlineOpen}
            aria-label="Show aggregated online status"
            className="flex items-center gap-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
            type="button"
            onClick={() => setOnlinePinned((current) => !current)}
          >
            <StatusDot level={onlineLevel} />
            <span>Online</span>
          </button>

          {onlineOpen ? (
            <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[min(16rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_rgba(0,0,0,0.5)]">
              <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
                <span className="text-[var(--color-text-secondary)]">System</span>
                <span className="font-bold" style={{ color: healthColor(onlineLevel) }}>
                  {statusText(onlineLevel)}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <ResourceStatusRow
                  label="Daemon"
                  level={daemonLevel}
                  value={resourceMetrics.daemonAlive ? "online" : "offline"}
                />
                <ResourceStatusRow
                  label="CPU"
                  level={
                    resourceMetrics.available
                      ? resourceLevel("cpu", resourceMetrics.cpuPercent)
                      : "unknown"
                  }
                  value={
                    resourceMetrics.available ? `${resourceMetrics.cpuPercent}%` : "unavailable"
                  }
                />
                <ResourceStatusRow
                  label="RAM"
                  level={
                    resourceMetrics.available
                      ? resourceLevel("memory", resourceMetrics.memoryPercent)
                      : "unknown"
                  }
                  value={
                    resourceMetrics.available ? `${resourceMetrics.memoryPercent}%` : "unavailable"
                  }
                />
                <ResourceStatusRow
                  label="HDD"
                  level={
                    resourceMetrics.available
                      ? resourceLevel("disk", resourceMetrics.diskPercent)
                      : "unknown"
                  }
                  value={
                    resourceMetrics.available ? `${resourceMetrics.diskPercent}%` : "unavailable"
                  }
                />
              </div>
            </div>
          ) : null}
        </div>

        {gitError ? (
          <span className="font-bold text-[var(--color-status-error)]" title={gitError}>
            Git Error
          </span>
        ) : null}

        {prEntries.length > 0 && !gitError ? (
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
      </div>

      <div className="ml-auto shrink-0 text-[var(--color-text-tertiary)]">
        {process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev"}
      </div>
    </footer>
  );
}
