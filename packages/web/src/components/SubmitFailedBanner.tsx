"use client";

import { useState } from "react";
import { BusyContent } from "@/components/BusyContent";
import { readApiErrorMessage } from "@/lib/json-payload";

interface SubmitFailedBannerProps {
  sessionId: string;
  message: string;
  onResolved: () => Promise<unknown>;
}

// Shown while the daemon reports submitFailedMessage: a send the agent never
// confirmed, even after one automatic retry. Retry queues it again at the
// head; Dismiss drops the notice.
export function SubmitFailedBanner({ sessionId, message, onResolved }: SubmitFailedBannerProps) {
  const [busy, setBusy] = useState<"retry" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (action: "retry" | "dismiss") => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/submit-failed/${action}`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, `Failed to ${action} the prompt`));
      }
      await onResolved();
    } catch (resolveError) {
      setError(
        resolveError instanceof Error ? resolveError.message : `Failed to ${action} the prompt`,
      );
    } finally {
      setBusy(null);
    }
  };

  const buttonClass =
    "inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50";
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 border border-[var(--color-status-error)] px-2.5 py-1.5 text-[var(--color-text-secondary)]"
    >
      <span className="min-w-0 flex-1 break-words">
        Agent did not confirm: “{message}”
        {error ? <span className="block text-[var(--color-status-error)]">{error}</span> : null}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          aria-busy={busy === "retry" || undefined}
          disabled={busy !== null}
          onClick={() => void resolve("retry")}
          className={buttonClass}
        >
          <BusyContent busy={busy === "retry"}>Retry</BusyContent>
        </button>
        <button
          type="button"
          aria-busy={busy === "dismiss" || undefined}
          disabled={busy !== null}
          onClick={() => void resolve("dismiss")}
          className={buttonClass}
        >
          <BusyContent busy={busy === "dismiss"}>Dismiss</BusyContent>
        </button>
      </div>
    </div>
  );
}
