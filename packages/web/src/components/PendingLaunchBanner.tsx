"use client";

import { useState } from "react";
import { BusyContent } from "@/components/BusyContent";
import { readApiErrorMessage } from "@/lib/json-payload";

interface PendingLaunchBannerProps {
  sessionId: string;
  onSubmitted: () => Promise<unknown>;
}

// Shown while the daemon reports submitUnconfirmedAt: the last prompt (the
// launch prompt or a Send now) may sit unsubmitted in the agent's composer, so
// Spur holds every send. The one action presses the submit key over that
// prompt; it never types.
export function PendingLaunchBanner({ sessionId, onSubmitted }: PendingLaunchBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/launch/submit`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to submit the prompt"));
      }
      await onSubmitted();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit the prompt");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border border-[var(--color-status-attention)] px-2.5 py-1.5 text-[var(--color-text-secondary)]"
    >
      <span className="min-w-0 flex-1">
        Agent has not confirmed the last prompt. Messages are held until it does.
        {error ? <span className="block text-[var(--color-status-error)]">{error}</span> : null}
      </span>
      <button
        type="button"
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => void submit()}
        className="inline-flex items-center gap-2 border border-[var(--color-border-strong)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
      >
        <BusyContent busy={busy}>Submit prompt</BusyContent>
      </button>
    </div>
  );
}
