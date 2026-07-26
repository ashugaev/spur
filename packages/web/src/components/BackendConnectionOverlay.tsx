"use client";

import { Spinner } from "@/components/icons/Spinner";
import { useBackendConnection } from "@/lib/backend-connection-context";

// z-[100] matches VersionSwitchOverlay so whichever gate is active sits above
// TerminalModal's z-[90], the highest layer in the app otherwise.
export function BackendConnectionOverlay() {
  const { phase, attempts } = useBackendConnection();

  if (phase === "connected") return null;

  const headingId = "backend-connection-overlay-heading";

  return (
    <div
      aria-labelledby={headingId}
      aria-live="assertive"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      data-testid="backend-connection-overlay"
      role="alertdialog"
    >
      <div className="w-[min(24rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]">
        <div className="flex items-center gap-3">
          <Spinner className="h-5 w-5" />
          <div>
            <p className="font-bold text-[var(--color-text-primary)]" id={headingId}>
              Reconnecting to Spur…
            </p>
            <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
              The backend is unavailable. This page will reload automatically once it&apos;s back.
            </p>
            <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
              Attempt {attempts}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end">
          <button
            className="border border-[var(--color-border-default)] px-3 py-1 text-[var(--color-text-secondary)] outline-none transition-colors hover:text-[var(--color-text-primary)] focus-visible:text-[var(--color-text-primary)]"
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload now
          </button>
        </div>
      </div>
    </div>
  );
}
