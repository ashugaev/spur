"use client";

import { BlockingOverlayShell } from "@/components/BlockingOverlayShell";
import { Spinner } from "@/components/icons/Spinner";
import { useBackendConnection } from "@/lib/backend-connection-context";

export function BackendConnectionOverlay() {
  const { phase, attempts } = useBackendConnection();

  if (phase === "connected") return null;

  const headingId = "backend-connection-overlay-heading";

  return (
    // No aria-live here: role="alertdialog" already announces once on
    // mount, and the incrementing attempt counter below would otherwise
    // re-announce to screen readers every RECONNECT_INTERVAL_MS for the
    // whole outage.
    <BlockingOverlayShell headingId={headingId} testId="backend-connection-overlay">
      <div className="flex items-center gap-3">
        <Spinner className="h-5 w-5" />
        <div>
          <p className="font-bold text-[var(--color-text-primary)]" id={headingId}>
            Reconnecting to Spur…
          </p>
          <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
            The backend is unavailable (attempt {attempts}). This page will reload automatically
            once it&apos;s back.
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end">
        <button
          className="border border-[var(--color-status-attention)] px-3 py-1 font-bold text-[var(--color-status-attention)] outline-none transition-colors hover:bg-[var(--color-status-attention)] hover:text-[var(--color-bg-elevated)] focus-visible:bg-[var(--color-status-attention)] focus-visible:text-[var(--color-bg-elevated)]"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reload now
        </button>
      </div>
    </BlockingOverlayShell>
  );
}
