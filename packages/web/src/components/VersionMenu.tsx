"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatRelativeTime } from "@/lib/format";
import { useFooterPopover } from "@/lib/footer-popover";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { semverGt } from "@/lib/semver";
import { SwitchVersionDialog } from "@/components/SwitchVersionDialog";

// Poll cadence for confirming a version switch: the daemon restart takes a few
// seconds; npm install can take tens of seconds on a cold cache.
const SWITCH_POLL_INTERVAL_MS = 3_000;
const SWITCH_POLL_ATTEMPTS = 30;

type SwitchStatus = { phase: "switching" | "done" | "failed"; target: string };

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
  stale?: boolean;
  registryError?: string;
}

interface SwitchSuccess {
  accepted: true;
  version: string;
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

function isSwitchSuccess(value: unknown): value is SwitchSuccess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { accepted?: unknown; version?: unknown };
  return v.accepted === true && typeof v.version === "string";
}

function messageForSwitchError(status: number, daemonError: string | null): string {
  if (status === 409) return "Cannot switch — daemon is running from a source checkout.";
  if (status === 503 && daemonError === "npm registry unreachable") {
    return "npm registry unreachable — try again in a minute.";
  }
  if (status === 400 && daemonError === "version not in registry") {
    return "Version not available in the npm registry yet.";
  }
  if (status === 400 && daemonError === "invalid version") {
    return "Version is not a valid semver release.";
  }
  return "Switch failed. Check the daemon log and try again.";
}

function switchStatusMessage(status: SwitchStatus): string {
  if (status.phase === "switching") return `Switching Spur to ${status.target}…`;
  if (status.phase === "done") return `Spur is now running ${status.target}.`;
  return `Switch to ${status.target} not confirmed — check ~/.spur/logs/install-and-restart.log.`;
}

export function VersionMenu() {
  const popover = useFooterPopover();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [switchStatus, setSwitchStatus] = useState<SwitchStatus | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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

  const switchMutation = useMutation<SwitchSuccess, Error, string>({
    mutationFn: async (version) => {
      const response = await fetch("/api/runtime/versions/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const payload = await readResponsePayload(response);
      if (response.status !== 202 || !isSwitchSuccess(payload)) {
        const daemonError = responseErrorMessage(payload, "");
        throw new Error(messageForSwitchError(response.status, daemonError || null));
      }
      return payload;
    },
    onSuccess: (result) => {
      setSwitchStatus({ phase: "switching", target: result.version });
      setPending(null);
      popover.dismiss();
      triggerRef.current?.focus();
    },
  });

  // Confirm the switch by polling the daemon until it reports the target
  // version. Fetch errors are expected while the daemon restarts.
  useEffect(() => {
    if (switchStatus?.phase !== "switching") return;
    const target = switchStatus.target;
    let attempts = 0;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        attempts += 1;
        try {
          const response = await fetch("/api/runtime/info");
          if (response.ok) {
            const payload = await readResponsePayload(response);
            if (!cancelled && isRuntimeInfoResponse(payload) && payload.version === target) {
              setSwitchStatus({ phase: "done", target });
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["runtime", "info"] }),
                queryClient.invalidateQueries({ queryKey: ["runtime", "versions"] }),
              ]);
              return;
            }
          }
        } catch {
          // daemon restarting; keep polling
        }
        if (!cancelled && attempts >= SWITCH_POLL_ATTEMPTS) {
          setSwitchStatus({ phase: "failed", target });
        }
      })();
    }, SWITCH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [switchStatus, queryClient]);

  const triggerLabel = (() => {
    if (infoQuery.isError) return "dev";
    if (infoQuery.data) return infoQuery.data.version;
    return "…";
  })();

  const available = versionsQuery.data?.available ?? [];
  const current = versionsQuery.data?.current ?? infoQuery.data?.version ?? "";
  const latest = available[0]?.tag ?? "";
  const updateAvailable = semverGt(latest, current);

  const { dismiss } = popover;
  useEffect(() => {
    if (!popover.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pending === null) dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [popover.open, dismiss, pending]);

  // Auto-clear only the success confirmation; a failure stays until dismissed.
  useEffect(() => {
    if (switchStatus?.phase !== "done") return;
    const timer = window.setTimeout(() => setSwitchStatus(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [switchStatus]);

  const handleCancel = useCallback(() => {
    if (switchMutation.isPending) return;
    setPending(null);
    switchMutation.reset();
  }, [switchMutation]);

  const handleConfirm = useCallback(() => {
    if (!pending) return;
    switchMutation.mutate(pending);
  }, [pending, switchMutation]);

  const dialogStatus: "idle" | "pending" | "error" = (() => {
    if (switchMutation.isPending) return "pending";
    if (switchMutation.isError) return "error";
    return "idle";
  })();
  const dialogErrorMessage = switchMutation.error?.message ?? null;

  return (
    <div
      ref={popover.containerRef}
      className="relative"
      onBlur={popover.onBlur}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
    >
      <button
        ref={triggerRef}
        aria-expanded={popover.open}
        aria-haspopup="true"
        aria-label="Show Spur version information"
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        type="button"
        onClick={popover.toggle}
      >
        <span>{triggerLabel}</span>
        {updateAvailable ? (
          <span
            className="rounded-sm border border-[var(--color-status-attention)] px-1 py-0.5 text-[10px] font-bold leading-none text-[var(--color-status-attention)]"
            data-testid="version-update-badge"
          >
            update available
          </span>
        ) : null}
      </button>
      {switchStatus ? (
        <div
          aria-live="polite"
          className={`absolute bottom-full right-0 z-50 mb-1.5 flex w-[min(20rem,calc(100vw-1rem))] items-start justify-between gap-2 border bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)] ${
            switchStatus.phase === "failed"
              ? "border-[var(--color-status-error)] text-[var(--color-status-error)]"
              : "border-[var(--color-status-attention)] text-[var(--color-status-attention)]"
          }`}
          data-testid="version-switch-status"
          role="status"
        >
          <span>{switchStatusMessage(switchStatus)}</span>
          {switchStatus.phase !== "switching" ? (
            <button
              aria-label="Dismiss version switch status"
              className="font-bold outline-none transition-opacity hover:opacity-70 focus-visible:opacity-70"
              type="button"
              onClick={() => setSwitchStatus(null)}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      {popover.open && !switchStatus ? (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[min(20rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <span className="text-[var(--color-text-secondary)]">Spur</span>
            <span className="font-bold text-[var(--color-text-primary)]">
              {current || triggerLabel}
            </span>
          </div>
          {versionsQuery.data?.stale ? (
            <div
              className="mb-2 normal-case tracking-normal text-[var(--color-status-attention)]"
              data-testid="version-registry-stale"
            >
              npm registry unreachable — list may be outdated
            </div>
          ) : null}
          {available.length === 0 ? (
            <div className="normal-case tracking-normal text-[var(--color-text-secondary)]">
              {versionsQuery.data?.registryError
                ? "npm registry unreachable"
                : "No releases available"}
            </div>
          ) : (
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
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
                    <span className="flex items-center gap-2">
                      <span className="text-[var(--color-text-tertiary)]">
                        {formatRelativeTime(release.publishedAt)}
                      </span>
                      {!isCurrent ? (
                        <button
                          aria-label={`Switch Spur to ${release.tag}`}
                          className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                          data-testid={`switch-version-${release.tag}`}
                          disabled={switchMutation.isPending}
                          type="button"
                          onClick={() => {
                            setSwitchStatus(null);
                            switchMutation.reset();
                            setPending(release.tag);
                          }}
                        >
                          Switch
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      {pending !== null ? (
        <SwitchVersionDialog
          current={current}
          errorMessage={dialogErrorMessage}
          pending={pending}
          status={dialogStatus}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
        />
      ) : null}
    </div>
  );
}
