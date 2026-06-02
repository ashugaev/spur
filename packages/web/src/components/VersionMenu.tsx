"use client";

import { useQuery } from "@tanstack/react-query";
import { formatRelativeTime } from "@/lib/format";
import { useFooterPopover } from "@/lib/footer-popover";
import { semverGt } from "@/lib/semver";

interface RuntimeInfoResponse {
  version: string;
}

interface ReleaseEntry {
  tag: string;
  publishedAt: string;
}

interface RuntimeVersionsResponse {
  current: string;
  available: ReleaseEntry[];
}

function isRuntimeInfoResponse(value: unknown): value is RuntimeInfoResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof (value as { version: unknown }).version === "string"
  );
}

function isReleaseEntry(value: unknown): value is ReleaseEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tag: unknown }).tag === "string" &&
    typeof (value as { publishedAt: unknown }).publishedAt === "string"
  );
}

function isRuntimeVersionsResponse(value: unknown): value is RuntimeVersionsResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { current: unknown; available: unknown };
  if (typeof record.current !== "string") return false;
  if (!Array.isArray(record.available)) return false;
  return record.available.every(isReleaseEntry);
}

export function VersionMenu() {
  const popover = useFooterPopover();

  const infoQuery = useQuery<RuntimeInfoResponse>({
    queryKey: ["runtime", "info"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/runtime/info", { signal });
      if (!response.ok) throw new Error(`runtime info ${response.status}`);
      const payload: unknown = await response.json();
      if (!isRuntimeInfoResponse(payload)) {
        throw new Error("Unexpected runtime info shape");
      }
      return payload;
    },
  });

  const versionsQuery = useQuery<RuntimeVersionsResponse>({
    queryKey: ["runtime", "versions"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/runtime/versions", { signal });
      if (!response.ok) throw new Error(`runtime versions ${response.status}`);
      const payload: unknown = await response.json();
      if (!isRuntimeVersionsResponse(payload)) {
        throw new Error("Unexpected runtime versions shape");
      }
      return payload;
    },
    staleTime: 60_000,
    refetchOnMount: true,
  });

  const triggerLabel = (() => {
    if (infoQuery.isError) return "dev";
    if (infoQuery.data) return infoQuery.data.version;
    return "…";
  })();

  const available = versionsQuery.data?.available ?? [];
  const current = versionsQuery.data?.current ?? infoQuery.data?.version ?? "";
  const latest = available[0]?.tag ?? "";
  const updateAvailable = semverGt(latest, current);

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
        aria-label="Show Spur version information"
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-tertiary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        type="button"
        onClick={popover.toggle}
      >
        <span>{triggerLabel}</span>
        {updateAvailable ? (
          <span
            className="rounded-sm border border-[var(--color-status-attention)] px-1 py-0.5 text-[8px] font-bold leading-none text-[var(--color-status-attention)]"
            data-testid="version-update-badge"
          >
            update available
          </span>
        ) : null}
      </button>
      {popover.open ? (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[min(18rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">Spur</span>
            <span className="font-bold text-[var(--color-text-primary)]">
              {current || triggerLabel}
            </span>
          </div>
          {available.length === 0 ? (
            <div className="normal-case tracking-normal text-[var(--color-text-secondary)]">
              No releases available
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {available.map((release) => {
                const isCurrent = release.tag === current;
                const isLatest = release.tag === latest;
                return (
                  <li
                    key={release.tag}
                    className="flex items-center justify-between gap-3 normal-case tracking-normal"
                    data-current={isCurrent ? "true" : undefined}
                  >
                    <span className="flex items-center gap-2 text-[var(--color-text-secondary)]">
                      <span className="font-bold text-[var(--color-text-primary)]">
                        {release.tag}
                      </span>
                      {isCurrent ? (
                        <span className="text-[var(--color-text-tertiary)]">current</span>
                      ) : null}
                      {!isCurrent && isLatest && updateAvailable ? (
                        <span className="text-[var(--color-status-attention)]">latest</span>
                      ) : null}
                    </span>
                    <span className="text-[var(--color-text-tertiary)]">
                      {formatRelativeTime(release.publishedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
