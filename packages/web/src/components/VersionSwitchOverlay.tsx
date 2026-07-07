"use client";

import { useVersionSwitch, versionSwitchFailedMessage } from "@/lib/version-switch-context";

const Spinner = () => (
  <svg
    aria-hidden="true"
    className="voice-spinner h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    viewBox="0 0 24 24"
  >
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>
);

// z-[70] sits above SwitchVersionDialog's z-[60] popover so the overlay wins
// once a switch is confirmed while the confirm dialog is still mounted.
export function VersionSwitchOverlay() {
  const { phase, target, dismiss } = useVersionSwitch();

  if (phase === "idle" || phase === "done") return null;

  return (
    <div
      aria-live="assertive"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      data-testid="version-switch-overlay"
      role="alertdialog"
    >
      <div className="w-[min(24rem,calc(100vw-2rem))] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4 shadow-[0_8px_24px_var(--color-shadow-modal-sm)]">
        {phase === "switching" ? (
          <div className="flex items-center gap-3">
            <Spinner />
            <div>
              <p className="font-bold text-[var(--color-text-primary)]">Updating Spur…</p>
              <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
                Switching to {target}. The page will reload automatically once the daemon is back.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <p className="font-bold text-[var(--color-status-error)]">Updating Spur failed</p>
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
      </div>
    </div>
  );
}
