"use client";

import { useMemo } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import {
  ActivityIcon,
  GithubIcon,
  GitlabIcon,
  isReviewLinkLabel,
  reviewProviderFromUrl,
} from "@/lib/link-icons";
import { formatAbsoluteTime } from "@/lib/format";
import { useFooterPopover } from "@/lib/footer-popover";
import type { GitHubStatusResponse } from "@/lib/github-status";
import type { GitLabStatusResponse } from "@/lib/gitlab-status";
import type { PlatformStatusResponse } from "@/lib/platform-status";
import type { ResourceSnapshot } from "@/lib/resource-monitoring";
import type { SpurSessionsResponse } from "@/lib/types";

const RESOURCE_POLL_MS = 15_000;
const CPU_RAM_ATTENTION_THRESHOLD = 85;
const DISK_ERROR_THRESHOLD = 85;
const PLATFORM_STATUS_POLL_MS = 120_000;

type HealthLevel = "ready" | "attention" | "error" | "unknown";
type PlatformKind = "github" | "gitlab";

function usePlatformStatus<TStatus extends PlatformStatusResponse>(
  path: string,
  unavailableMessage: string,
) {
  const { data } = useQuery<TStatus>({
    queryKey: ["platform-status", path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { signal });
      if (!response.ok) {
        return {
          ok: false,
          error: `${unavailableMessage} (${response.status})`,
          requestedAt: null,
          configured: true,
        } as TStatus;
      }
      return (await response.json()) as TStatus;
    },
    refetchInterval: PLATFORM_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: PLATFORM_STATUS_POLL_MS,
  });

  return data ?? null;
}

function useResourceMetrics(): ResourceSnapshot {
  const { data } = useQuery<ResourceSnapshot>({
    queryKey: ["runtime", "resources"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/runtime/resources", { signal });
      if (!response.ok) return { available: false };
      const payload = (await response.json()) as ResourceSnapshot;
      if (
        payload.available &&
        Number.isFinite(payload.cpuPercent) &&
        Number.isFinite(payload.memoryPercent) &&
        Number.isFinite(payload.diskPercent)
      ) {
        return payload;
      }
      return { available: false };
    },
    refetchInterval: RESOURCE_POLL_MS,
    refetchIntervalInBackground: true,
    staleTime: RESOURCE_POLL_MS,
  });

  return data ?? { available: false };
}

function useDaemonAlive(): boolean | undefined {
  const { data, status, isError } = useQuery<SpurSessionsResponse>({
    queryKey: ["sessions"],
    queryFn: skipToken,
  });
  if (isError) return false;
  if (status === "pending" && data === undefined) return undefined;
  if (data === undefined) return undefined;
  return data.daemonAlive !== false;
}

function useReviewProvidersInUse(): Set<PlatformKind> {
  const { data } = useQuery<SpurSessionsResponse>({
    queryKey: ["sessions"],
    queryFn: skipToken,
  });
  return useMemo(() => {
    const providers = new Set<PlatformKind>();
    for (const session of data?.sessions ?? []) {
      for (const link of session.slots?.links ?? []) {
        if (!isReviewLinkLabel(link.label)) continue;
        const provider = reviewProviderFromUrl(link.url);
        if (provider) providers.add(provider);
      }
    }
    return providers;
  }, [data?.sessions]);
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

function aggregateOnlineLevel(
  metrics: ResourceSnapshot,
  daemonAlive: boolean | undefined,
): HealthLevel {
  if (daemonAlive === false) return "error";
  if (daemonAlive === undefined) return "unknown";
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

function platformStatusLevel(status: PlatformStatusResponse | null): HealthLevel {
  if (status === null) return "unknown";
  return status.ok ? "ready" : "error";
}

function platformStatusText(status: PlatformStatusResponse | null): string {
  if (status === null) return "Checking";
  return status.ok ? "Healthy" : "Error";
}

function PlatformStatusButton({
  platform,
  status,
}: {
  platform: PlatformKind;
  status: PlatformStatusResponse | null;
}) {
  const popover = useFooterPopover();
  const label = platform === "github" ? "GitHub" : "GitLab";
  const Icon = platform === "github" ? GithubIcon : GitlabIcon;
  const level = platformStatusLevel(status);
  const statusLabel = platformStatusText(status).toLowerCase();

  return (
    <div
      ref={popover.containerRef}
      className="relative"
      onBlur={popover.onBlur}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
    >
      <button
        aria-expanded={popover.open}
        aria-label={`${label} connection ${statusLabel}`}
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        type="button"
        onClick={popover.toggle}
      >
        <Icon />
        <StatusDot level={level} />
      </button>
      {popover.open ? (
        <div className="absolute bottom-full left-0 z-50 mb-1.5 min-w-[180px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">{label}</span>
            <span className="font-bold" style={{ color: healthColor(level) }}>
              {platformStatusText(status)}
            </span>
          </div>
          <div
            className="normal-case tracking-normal text-[var(--color-text-secondary)]"
            onClick={popover.dismiss}
          >
            {status === null ? (
              "Checking authentication and API availability."
            ) : status.ok ? (
              <>Last request: {formatAbsoluteTime(status.requestedAt)}</>
            ) : (
              status.error
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StatusBar() {
  const githubStatus = usePlatformStatus<GitHubStatusResponse>(
    "/api/github-status",
    "GitHub status unavailable",
  );
  const gitlabStatus = usePlatformStatus<GitLabStatusResponse>(
    "/api/gitlab-status",
    "GitLab status unavailable",
  );
  const resourceMetrics = useResourceMetrics();
  const daemonAlive = useDaemonAlive();
  const providersInUse = useReviewProvidersInUse();
  const onlinePopover = useFooterPopover();
  const onlineLevel = aggregateOnlineLevel(resourceMetrics, daemonAlive);
  const daemonLevel: HealthLevel =
    daemonAlive === undefined ? "unknown" : daemonAlive ? "ready" : "error";
  const daemonValue =
    daemonAlive === undefined ? "unavailable" : daemonAlive ? "online" : "offline";
  const onlineLabel =
    onlineLevel === "error"
      ? "Critical"
      : onlineLevel === "attention"
        ? "Warning"
        : onlineLevel === "ready"
          ? "Healthy"
          : "Unavailable";
  const showGithub =
    githubStatus === null || githubStatus.configured === true || providersInUse.has("github");
  const showGitlab =
    gitlabStatus === null || gitlabStatus.configured === true || providersInUse.has("gitlab");

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-6">
        <div
          ref={onlinePopover.containerRef}
          className="group/status relative"
          onBlur={onlinePopover.onBlur}
          onMouseEnter={onlinePopover.onMouseEnter}
          onMouseLeave={onlinePopover.onMouseLeave}
        >
          <button
            aria-expanded={onlinePopover.open}
            aria-label="Show aggregated system status"
            className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
            data-status={onlineLevel}
            type="button"
            onClick={onlinePopover.toggle}
          >
            <ActivityIcon />
            <StatusDot level={onlineLevel} />
          </button>

          {onlinePopover.open ? (
            <div
              className="absolute bottom-full left-0 z-50 mb-1.5 w-[min(16rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]"
              onClick={onlinePopover.dismiss}
            >
              <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
                <span className="text-[var(--color-text-secondary)]">System</span>
                <span className="font-bold" style={{ color: healthColor(onlineLevel) }}>
                  {onlineLabel}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <ResourceStatusRow label="Daemon" level={daemonLevel} value={daemonValue} />
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
        {showGithub ? <PlatformStatusButton platform="github" status={githubStatus} /> : null}
        {showGitlab ? <PlatformStatusButton platform="gitlab" status={gitlabStatus} /> : null}
      </div>

      <div className="ml-auto shrink-0 text-[var(--color-text-tertiary)]">
        {process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev"}
      </div>
    </footer>
  );
}
