"use client";

import { useEffect, useRef, useState } from "react";
import { CiStatusDot, GithubIcon } from "@/lib/link-icons";
import { formatAbsoluteTime } from "@/lib/format";
import type { GitHubStatusResponse } from "@/lib/github-status";

const GITHUB_STATUS_POLL_MS = 120_000;
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

function useGitHubStatus() {
  const [status, setStatus] = useState<GitHubStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch("/api/github-status", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) {
            setStatus({
              ok: false,
              error: `GitHub status unavailable (${response.status})`,
              requestedAt: null,
            });
          }
          return;
        }

        const payload = (await response.json()) as GitHubStatusResponse;
        if (!cancelled) {
          setStatus(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            ok: false,
            error: error instanceof Error ? error.message : "GitHub status unavailable",
            requestedAt: null,
          });
        }
      }
    };

    void run();
    const timer = setInterval(() => void run(), GITHUB_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
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

export function StatusBar() {
  const githubStatus = useGitHubStatus();
  const resourceMetrics = useResourceMetrics();
  const [onlineHovered, setOnlineHovered] = useState(false);
  const [onlinePinned, setOnlinePinned] = useState(false);
  const [onlineDismissed, setOnlineDismissed] = useState(false);
  const [githubHovered, setGitHubHovered] = useState(false);
  const [githubPinned, setGitHubPinned] = useState(false);
  const [githubDismissed, setGitHubDismissed] = useState(false);
  const onlineContainerRef = useRef<HTMLDivElement | null>(null);
  const githubContainerRef = useRef<HTMLDivElement | null>(null);
  const onlineLevel = aggregateOnlineLevel(resourceMetrics);
  const daemonLevel = resourceMetrics.daemonAlive ? "ready" : "error";
  const onlineLabel =
    onlineLevel === "error"
      ? "Critical"
      : onlineLevel === "attention"
        ? "Warning"
        : onlineLevel === "ready"
          ? "Healthy"
        : "Unavailable";
  const onlineOpen = !onlineDismissed && (onlineHovered || onlinePinned);
  const githubOpen = !githubDismissed && (githubHovered || githubPinned);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (!touchDevice || !onlineOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (onlineContainerRef.current?.contains(target)) return;
      setOnlineDismissed(true);
      setOnlinePinned(false);
      setOnlineHovered(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onlineOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (!touchDevice || !githubOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (githubContainerRef.current?.contains(target)) return;
      setGitHubDismissed(true);
      setGitHubPinned(false);
      setGitHubHovered(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [githubOpen]);

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-6">
        <div
          ref={onlineContainerRef}
          className="group/status relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setOnlinePinned(false);
              setOnlineDismissed(false);
            }
          }}
          onMouseEnter={() => {
            setOnlineDismissed(false);
            setOnlineHovered(true);
          }}
          onMouseLeave={() => {
            setOnlineDismissed(false);
            setOnlineHovered(false);
          }}
        >
          <button
            aria-expanded={onlineOpen}
            aria-label="Show aggregated system status"
            className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
            type="button"
            onClick={() => {
              setOnlineDismissed(false);
              setOnlinePinned((current) => !current);
            }}
          >
            <StatusDot level={onlineLevel} />
            <span>{onlineLabel}</span>
          </button>

          {onlineOpen ? (
            <div
              className="absolute bottom-full left-0 z-50 mb-1.5 w-[min(16rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]"
              onClick={() => {
                setOnlineDismissed(true);
                setOnlinePinned(false);
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
                <span className="text-[var(--color-text-secondary)]">System</span>
                <span className="font-bold" style={{ color: healthColor(onlineLevel) }}>
                  {onlineLabel}
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

        {githubStatus === null ? (
          <div className="flex items-center gap-1.5 text-[var(--color-text-tertiary)]">
            <GithubIcon />
            <span>Checking</span>
          </div>
        ) : githubStatus.ok === true ? (
          <div
            ref={githubContainerRef}
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setGitHubPinned(false);
                setGitHubDismissed(false);
              }
            }}
            onMouseEnter={() => {
              setGitHubDismissed(false);
              setGitHubHovered(true);
            }}
            onMouseLeave={() => {
              setGitHubDismissed(false);
              setGitHubHovered(false);
            }}
          >
            <button
              aria-expanded={githubOpen}
              aria-label="GitHub connection healthy"
              className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
              type="button"
              onClick={() => {
                setGitHubDismissed(false);
                setGitHubPinned((current) => !current);
              }}
            >
              <GithubIcon />
              <CiStatusDot status="success" />
            </button>
            {githubOpen ? (
              <div className="absolute bottom-full left-0 z-50 mb-1.5 min-w-[180px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
                <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
                  <span className="text-[var(--color-text-secondary)]">GitHub</span>
                  <span className="font-bold text-[var(--color-status-ready)]">Healthy</span>
                </div>
                <div className="normal-case tracking-normal text-[var(--color-text-secondary)]">
                  Last request: {formatAbsoluteTime(githubStatus.requestedAt)}
                </div>
              </div>
            ) : null}
          </div>
        ) : githubStatus.ok === false ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <GithubIcon />
            <span
              className="max-w-[min(24rem,50vw)] truncate font-bold normal-case tracking-normal text-[var(--color-status-error)]"
              title={githubStatus.error}
            >
              {githubStatus.error}
            </span>
          </div>
        ) : null}
      </div>

      <div className="ml-auto shrink-0 text-[var(--color-text-tertiary)]">
        {process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev"}
      </div>
    </footer>
  );
}
