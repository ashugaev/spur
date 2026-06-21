import type { OpenPrAction, OpenPrActionRequiredPayload } from "@/lib/types";

interface OpenPrActionDialogProps {
  payload: OpenPrActionRequiredPayload;
  busy?: boolean;
  onAction: (action: OpenPrAction) => void;
  onCancel: () => void;
}

export function OpenPrActionDialog({
  payload,
  busy = false,
  onAction,
  onCancel,
}: OpenPrActionDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] px-4">
      <div
        aria-labelledby="open-pr-action-title"
        aria-modal="true"
        className="w-full max-w-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-4"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="font-bold uppercase text-[var(--color-text-primary)]"
              id="open-pr-action-title"
            >
              Open Pull Request
            </h2>
            <p className="mt-2 text-[var(--color-text-secondary)]">
              Pull request #{payload.pr.number} is still open.
            </p>
            <a
              className="mt-2 block truncate text-[var(--color-accent)] underline-offset-4 hover:underline"
              href={payload.pr.url}
              rel="noreferrer"
              target="_blank"
            >
              {payload.pr.title}
            </a>
          </div>
          <button
            aria-label="Dismiss pull request action dialog"
            className="border border-[var(--color-border-default)] px-2 py-1 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            x
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
            disabled={busy}
            onClick={() => onAction("leave_open")}
            type="button"
          >
            Leave Pull Request Open
          </button>
          <button
            className="border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-status-error)]/10 disabled:opacity-50"
            disabled={busy}
            onClick={() => onAction("close")}
            type="button"
          >
            Close Pull Request
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
