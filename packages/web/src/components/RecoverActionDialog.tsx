import type { SessionNotRestorablePayload } from "@/lib/types";

interface RecoverActionDialogProps {
  payload: SessionNotRestorablePayload;
  busy?: boolean;
  onForceKill: () => void;
  onRespawn: () => void;
  onCancel: () => void;
}

export function RecoverActionDialog({
  payload,
  busy = false,
  onForceKill,
  onRespawn,
  onCancel,
}: RecoverActionDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] px-4">
      <div
        aria-labelledby="recover-action-title"
        aria-modal="true"
        className="w-full max-w-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-4"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="font-bold uppercase text-[var(--color-text-primary)]"
              id="recover-action-title"
            >
              Recover Session
            </h2>
            <p className="mt-2 text-[var(--color-text-secondary)]">{payload.reason}</p>
          </div>
          <button
            aria-label="Dismiss recover session dialog"
            className="border border-[var(--color-border-default)] px-2 py-1 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            x
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          {payload.availableActions.includes("respawn") ? (
            <button
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              disabled={busy}
              onClick={onRespawn}
              type="button"
            >
              Respawn
            </button>
          ) : null}
          <button
            className="border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-status-error)]/10 disabled:opacity-50"
            disabled={busy}
            onClick={onForceKill}
            type="button"
          >
            Force Kill
          </button>
          <button
            className="border border-[var(--color-border-default)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
