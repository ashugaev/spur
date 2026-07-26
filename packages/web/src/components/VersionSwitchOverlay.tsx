"use client";

import { BlockingOverlayShell } from "@/components/BlockingOverlayShell";
import { Spinner } from "@/components/icons/Spinner";
import { useVersionSwitch, versionSwitchFailedMessage } from "@/lib/version-switch-context";

export function VersionSwitchOverlay() {
  const { phase, target, dismiss } = useVersionSwitch();

  if (phase === "idle" || phase === "done") return null;

  const headingId = "version-switch-overlay-heading";

  return (
    <BlockingOverlayShell
      ariaLive="assertive"
      headingId={headingId}
      testId="version-switch-overlay"
    >
      {phase === "switching" ? (
        <div className="flex items-center gap-3">
          <Spinner className="h-5 w-5" />
          <div>
            <p className="font-bold text-[var(--color-text-primary)]" id={headingId}>
              Updating Spur…
            </p>
            <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
              Switching to {target}. The page will reload automatically once the daemon is back.
            </p>
          </div>
        </div>
      ) : (
        <div>
          <p className="font-bold text-[var(--color-status-error)]" id={headingId}>
            Updating Spur failed
          </p>
          <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
            {versionSwitchFailedMessage(target ?? "")}
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
              type="button"
              onClick={dismiss}
            >
              Dismiss
            </button>
            <button
              className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)]"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload now
            </button>
          </div>
        </div>
      )}
    </BlockingOverlayShell>
  );
}
