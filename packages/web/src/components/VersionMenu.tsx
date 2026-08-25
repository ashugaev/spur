"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatRelativeTime } from "@/lib/format";
import { useFooterPopover } from "@/lib/footer-popover";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import { updateSeverity, type UpdateSeverity } from "@/lib/semver";
import { AlertIcon } from "@/components/icons/AlertIcon";
import { RollbackIcon } from "@/components/icons/RollbackIcon";
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

// Present while the daemon holds a failed switch record whose recorded kind
// says the version installed and left the host changed. Cleared server-side by
// the operator acting on the update path — re-arming Auto, or any Switch.
type UpdateFailureKind = "rolled_back" | "install_unhealthy";

interface UpdateFailure {
  version: string;
  failureKind: UpdateFailureKind;
  initiator: "auto" | "manual";
}

interface RuntimeVersionsResponse {
  current: string;
  available: ReleaseEntry[];
  autoUpdate?: boolean;
  stale?: boolean;
  registryError?: string;
  updateFailure?: UpdateFailure;
}

interface SwitchSuccess {
  accepted: true;
  version: string;
  autoUpdate?: boolean;
}

interface AutoUpdateSuccess {
  autoUpdate: boolean;
}

interface SwitchInProgress {
  error: string;
  inProgress: true;
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

function isUpdateFailure(value: unknown): value is UpdateFailure {
  if (typeof value !== "object" || value === null) return false;
  const failure = value as { version: unknown; failureKind: unknown; initiator: unknown };
  return (
    typeof failure.version === "string" &&
    (failure.failureKind === "rolled_back" || failure.failureKind === "install_unhealthy") &&
    (failure.initiator === "auto" || failure.initiator === "manual")
  );
}

function isRuntimeVersionsResponse(value: unknown): value is RuntimeVersionsResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    current: unknown;
    available: unknown;
    autoUpdate?: unknown;
    updateFailure?: unknown;
  };
  if (typeof record.current !== "string") return false;
  if (!Array.isArray(record.available)) return false;
  if (record.autoUpdate !== undefined && typeof record.autoUpdate !== "boolean") return false;
  if (record.updateFailure !== undefined && !isUpdateFailure(record.updateFailure)) return false;
  return record.available.every(isReleaseEntry);
}

// The suspension clause only where it is true. The daemon disarms `autoUpdate`
// for its own attempts only, and `autoUpdate` is off by default, so "off" alone
// proves nothing: a manual rollback on a host that never armed it suspended
// nothing, and an auto one the operator re-armed by hand is no longer suspended.
function updateSuspended(failure: UpdateFailure, autoUpdateOn: boolean): boolean {
  return failure.initiator === "auto" && !autoUpdateOn;
}

function updateFailureMessage(failure: UpdateFailure, autoUpdateOn: boolean): string {
  const outcome =
    failure.failureKind === "rolled_back"
      ? `Update to ${failure.version} failed, an automatic rollback happened`
      : `Update to ${failure.version} failed and was not rolled back`;
  return updateSuspended(failure, autoUpdateOn) ? `${outcome}, auto-update is suspended` : outcome;
}

function isSwitchSuccess(value: unknown): value is SwitchSuccess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { accepted?: unknown; version?: unknown; autoUpdate?: unknown };
  if (v.accepted !== true || typeof v.version !== "string") return false;
  return v.autoUpdate === undefined || typeof v.autoUpdate === "boolean";
}

function isAutoUpdateSuccess(value: unknown): value is AutoUpdateSuccess {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { autoUpdate?: unknown }).autoUpdate === "boolean";
}

function isSwitchInProgress(value: unknown): value is SwitchInProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.error === "string" &&
    result.inProgress === true &&
    typeof result.version === "string"
  );
}

function messageForSwitchError(
  status: number,
  payload: unknown,
  daemonError: string | null,
): string {
  if (status === 409 && isSwitchInProgress(payload)) {
    return `Update to ${payload.version} is already in progress.`;
  }
  if (status === 409 && daemonError === "running from source checkout") {
    return "Cannot switch — daemon is running from a source checkout.";
  }
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
  const queryClient = useQueryClient();

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
    // The footer never unmounts, so without this nothing ever refetches: a
    // daemon-side disarm and the rollback notice behind it would only show up
    // after a reload.
    refetchInterval: 60_000,
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
        throw new Error(messageForSwitchError(response.status, payload, daemonError || null));
      }
      return payload;
    },
    onSuccess: (result) => {
      // Load-bearing, not decorative: when the confirmation poll exhausts its
      // 30 attempts the page never reloads (version-switch-context.tsx's
      // poll-exhaustion path), so the 60s-stale versions cache would
      // otherwise show a checked box against a daemon that already disarmed.
      // Same reason drops `updateFailure`: the daemon supersedes the failed
      // record with the `running` one for this switch, and the operator is
      // owed the notice going away the moment they act on it.
      queryClient.setQueryData<RuntimeVersionsResponse>(["runtime", "versions"], (old) =>
        old ? { ...old, autoUpdate: result.autoUpdate ?? false, updateFailure: undefined } : old,
      );
      startSwitch(result.version);
      setPending(null);
      popover.dismiss();
      triggerRef.current?.focus();
    },
  });

  const autoUpdateMutation = useMutation<AutoUpdateSuccess, Error, boolean>({
    mutationFn: async (enabled) => {
      const response = await fetch("/api/runtime/auto-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok || !isAutoUpdateSuccess(payload)) {
        throw new Error(responseErrorMessage(payload, "Failed to update Auto setting."));
      }
      return payload;
    },
    onSuccess: (result) => {
      queryClient.setQueryData<RuntimeVersionsResponse>(["runtime", "versions"], (old) =>
        old
          ? {
              ...old,
              autoUpdate: result.autoUpdate,
              // Re-arming is the operator answering the rollback, and the
              // daemon clears the record on that same request.
              ...(result.autoUpdate ? { updateFailure: undefined } : {}),
            }
          : old,
      );
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
  const autoUpdateOn = versionsQuery.data?.autoUpdate ?? false;
  // Gated on the notice, never on severity: an install that failed and was not
  // rolled back leaves the host running the newest release, i.e. severity
  // "none", and that is exactly the state that must not stay invisible.
  const updateFailure = versionsQuery.data?.updateFailure ?? null;

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
          updateFailure
            ? updateSuspended(updateFailure, autoUpdateOn)
              ? ", update failed, auto-update is suspended"
              : ", update failed"
            : severity === "major"
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
          className={
            updateFailure
              ? "font-bold text-[var(--color-status-error)]"
              : severity === "none"
                ? undefined
                : `font-bold ${SEVERITY_TEXT_CLASS[severity]}`
          }
          data-severity={severity}
        >
          {triggerLabel}
        </span>
        {/* The notice wins the icon slot: one glyph, never two. The popover
            still lists every release, so no severity information is lost.
            The colour is the token, not SEVERITY_TEXT_CLASS: a rollback is not
            a severity, so a recolour of `major` must not drag it along. */}
        {updateFailure ? (
          <RollbackIcon
            className="h-3 w-3 text-[var(--color-status-error)]"
            data-testid="version-rollback-icon"
          />
        ) : severity === "none" ? null : (
          <AlertIcon
            aggressive={severity === "major"}
            className={`h-3 w-3 ${SEVERITY_TEXT_CLASS[severity]}`}
            data-testid="version-alert-icon"
          />
        )}
      </button>
      {popover.open && switchPhase === "idle" ? (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[min(20rem,calc(100vw-1rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          {updateFailure ? (
            <div
              className="mb-2 normal-case tracking-normal text-[var(--color-status-error)]"
              data-testid="version-update-failure"
            >
              {updateFailureMessage(updateFailure, autoUpdateOn)}
            </div>
          ) : null}
          {/* The checkbox is the operator's way to clear the notice, so a
              refused write cannot be silent: the box snaps back to the server
              value and this says why. */}
          {autoUpdateMutation.isError ? (
            <div
              className="mb-2 normal-case tracking-normal text-[var(--color-status-error)]"
              data-testid="version-auto-update-error"
            >
              {autoUpdateMutation.error.message}
            </div>
          ) : null}
          <div className="mb-2 flex items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-2">
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-text-secondary)]">Spur</span>
              <span className="font-bold text-[var(--color-text-primary)]">
                {current || triggerLabel}
              </span>
            </div>
            <label
              className={`flex items-center gap-1.5 ${
                autoUpdateMutation.isPending ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              }`}
              title="Update automatically as soon as a new version is detected"
            >
              <input
                aria-label="Auto update"
                checked={autoUpdateOn}
                className="accent-[var(--color-accent)] disabled:cursor-not-allowed"
                disabled={autoUpdateMutation.isPending}
                type="checkbox"
                onChange={(event) => autoUpdateMutation.mutate(event.target.checked)}
              />
              <span
                className={
                  autoUpdateOn
                    ? "font-bold text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)]"
                }
              >
                Auto
              </span>
            </label>
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
          autoUpdate={autoUpdateOn}
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
