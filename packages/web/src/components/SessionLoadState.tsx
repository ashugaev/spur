"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/icons/Spinner";
import { StatusCard } from "@/components/StatusCard";

export interface SessionLoadFailure {
  message: string;
  // 502/503: daemon starting or unreachable. Worth retrying on a timer.
  transient: boolean;
}

const AUTO_RETRY_INTERVAL_MS = 2_000;

interface SessionLoadStateProps {
  failure: SessionLoadFailure;
  onRetry: () => Promise<void>;
}

// Page-local load-failure card shown while no session has loaded yet. Not a
// blocking overlay: it sits in the page area and never covers the shell.
export function SessionLoadState({ failure, onRetry }: SessionLoadStateProps) {
  const [attempt, setAttempt] = useState(1);
  const [retrying, setRetrying] = useState(false);
  const inFlightRef = useRef(false);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  const retry = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setAttempt((current) => current + 1);
    setRetrying(true);
    try {
      await onRetryRef.current();
    } finally {
      inFlightRef.current = false;
      setRetrying(false);
    }
  }, []);

  const { transient } = failure;
  useEffect(() => {
    if (!transient) return;
    setAttempt(1);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        await retry();
        if (!cancelled) schedule();
      }, AUTO_RETRY_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [transient, retry]);

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      {transient ? (
        <StatusCard role="status" testId="session-load-starting">
          <div className="flex items-start gap-3">
            <Spinner className="h-5 shrink-0 w-5 text-[var(--color-status-attention)]" />
            <div>
              <p className="font-bold text-[var(--color-text-primary)]">Spur is starting…</p>
              <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
                The daemon is still starting. This session opens automatically once it&apos;s ready.
              </p>
              <p
                aria-hidden="true"
                className="mt-1 normal-case tracking-normal text-[var(--color-text-tertiary)]"
              >
                Retrying · attempt {attempt}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end">
            <button
              className="border border-[var(--color-status-attention)] px-3 py-1 font-bold uppercase text-[var(--color-status-attention)] outline-none transition-colors enabled:hover:bg-[var(--color-status-attention)] enabled:hover:text-[var(--color-bg-elevated)] enabled:focus-visible:bg-[var(--color-status-attention)] enabled:focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-busy={retrying}
              disabled={retrying}
              type="button"
              onClick={() => void retry()}
            >
              {retrying ? "Retrying…" : "Retry now"}
            </button>
          </div>
        </StatusCard>
      ) : (
        <StatusCard role="alert" testId="session-load-failed" tone="error">
          <div className="flex items-start gap-3">
            <svg
              aria-hidden="true"
              className="h-5 w-5 shrink-0 text-[var(--color-status-error)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5h.01" strokeLinecap="round" />
            </svg>
            <div>
              <p className="font-bold text-[var(--color-status-error)]">
                Unable to load this session
              </p>
              <p className="mt-1 normal-case tracking-normal text-[var(--color-text-secondary)]">
                Spur returned an error for this session.
              </p>
            </div>
          </div>
          <p className="mt-3 whitespace-pre-wrap break-words border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-2 normal-case tracking-normal text-[var(--color-text-secondary)]">
            {failure.message}
          </p>
          <div className="mt-3 flex items-center justify-end">
            <button
              className="border border-[var(--color-status-error)] px-3 py-1 font-bold uppercase text-[var(--color-status-error)] outline-none transition-colors enabled:hover:bg-[var(--color-status-error)] enabled:hover:text-[var(--color-bg-elevated)] enabled:focus-visible:bg-[var(--color-status-error)] enabled:focus-visible:text-[var(--color-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-busy={retrying}
              disabled={retrying}
              type="button"
              onClick={() => void retry()}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        </StatusCard>
      )}
    </div>
  );
}
