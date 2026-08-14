"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatRelativeTime } from "@/lib/format";
import { useFooterPopover } from "@/lib/footer-popover";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { updateSeverity, type UpdateSeverity } from "@/lib/semver";
import { AlertIcon } from "@/components/icons/AlertIcon";
import {
  isRuntimeInfoResponse,
  useVersionSwitch,
  type RuntimeInfoResponse,
} from "@/lib/version-switch-context";
import { SwitchVersionDialog } from "@/components/SwitchVersionDialog";

// Single source for the severity -> version color. Trigger label, alert icon,
// and the dropdown "latest" tag all read from here so they never drift apart.
const SEVERITY_TEXT_CLASS: Record<UpdateSeverity, string> = {
  none: "text-[var(--color-status-attention)]",
  update: "text-[var(--color-status-attention)]",
  major: "text-[var(--color-status-error)]",
};

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

export function VersionMenu() {
  const popover = useFooterPopover();
  const { phase: switchPhase, startSwitch, dismiss: dismissVersionSwitch } = useVersionSwitch();
  const [pending, setPending] = useState<string | null>(null);
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
      startSwitch(result.version);
      setPending(null);
      popover.dismiss();
      triggerRef.current?.focus();
    },
  });

  const triggerLabel = (() => {
    if (infoQuery.isError) return "dev";
    if (infoQuery.data) return infoQuery.data.version;
    return "…";
  })();

  const available = versionsQuery.data?.available ?? [];
  const current = versionsQuery.data?.current ?? infoQuery.data?.version ?? "";
  const latest = available[0]?.tag ?? "";
  const severity = updateSeverity(latest, current);
  const updateAvailable = severity !== "none";

  const { dismiss } = popover;
  useEffect(() => {
    if (!popover.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pending === null) dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [popover.open, dismiss, pending]);

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
        aria-label={`Show Spur version information${
          severity === "major"
            ? ", major update available"
            : severity === "update"
              ? ", update available"
              : ""
        }`}
        className="-m-1.5 flex items-center gap-1.5 p-1.5 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
        type="button"
        onClick={popover.toggle}
      >
        <span
          className={severity === "none" ? undefined : `font-bold ${SEVERITY_TEXT_CLASS[severity]}`}
          data-severity={severity}
        >
          {triggerLabel}
        </span>
        {severity === "none" ? null : (
          <AlertIcon
            aggressive={severity === "major"}
            className={`h-3 w-3 ${SEVERITY_TEXT_CLASS[severity]}`}
            data-testid="version-alert-icon"
          />
        )}
      </button>
      {popover.open && switchPhase === "idle" ? (
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
                        <span className={SEVERITY_TEXT_CLASS[severity]}>latest</span>
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
                            dismissVersionSwitch();
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
