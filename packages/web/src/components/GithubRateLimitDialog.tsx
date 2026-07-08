import type { GithubPrCheckUnavailablePayload } from "@/lib/types";

interface GithubRateLimitDialogProps {
  payload: GithubPrCheckUnavailablePayload;
  busy?: boolean;
  onSkip: () => void;
  onRetry: () => void;
  onCancel: () => void;
}

export function GithubRateLimitDialog({
  payload,
  busy = false,
  onSkip,
  onRetry,
  onCancel,
}: GithubRateLimitDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)] px-4">
      <div
        aria-labelledby="github-rate-limit-title"
        aria-modal="true"
        className="w-full max-w-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-4"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="font-bold uppercase text-[var(--color-status-attention)]"
              id="github-rate-limit-title"
            >
              GitHub PR Check Unavailable
            </h2>
            <p className="mt-2 text-[var(--color-text-secondary)]">
              {payload.rateLimited
                ? "GitHub is rate limited, so the open pull request could not be checked."
                : "The open pull request could not be checked because a GitHub call failed."}
            </p>
            {payload.pr ? (
              <a
                className="mt-2 block truncate text-[var(--color-accent)] underline-offset-4 hover:underline"
                href={payload.pr.url}
                rel="noreferrer"
                target="_blank"
              >
                #{payload.pr.number} {payload.pr.repo}
              </a>
            ) : (
              <p className="mt-2 text-[var(--color-text-tertiary)]">
                No linked pull request URL is available.
              </p>
            )}
          </div>
          <button
            aria-label="Dismiss GitHub PR check dialog"
            className="border border-[var(--color-border-default)] px-2 py-1 font-bold uppercase text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            x
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          {payload.rateLimited ? (
            <button
              className="border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
              disabled={busy}
              onClick={onRetry}
              type="button"
            >
              Retry PR Check
            </button>
          ) : null}
          <button
            className="border border-[var(--color-status-error)] px-3 py-1.5 font-bold uppercase text-[var(--color-status-error)] transition hover:bg-[var(--color-status-error)]/10 disabled:opacity-50"
            disabled={busy}
            onClick={onSkip}
            type="button"
          >
            Skip PR Check &amp; Proceed
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
