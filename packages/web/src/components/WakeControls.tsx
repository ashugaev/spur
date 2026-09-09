"use client";

import { useEffect, useMemo, useState } from "react";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import {
  errorMessage,
  readApiErrorMessage,
  readResponsePayload,
} from "@/lib/json-payload";
import { toDashboardSession, type DashboardSession, type SpurSessionView } from "@/lib/types";
import { Spinner } from "@/components/icons/Spinner";
import {
  formatIntervalDuration,
  formatWakeCountdown,
  getWakeSummaries,
  type WakeSummary,
  type WakeTarget,
} from "@/lib/wake-format";

function WakeIcon({ recurring }: { recurring: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
      {recurring ? <path d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8" /> : null}
    </svg>
  );
}

function canWakeNow(session: DashboardSession): boolean {
  return (
    session.status === "running" || session.status === "stopped" || session.status === "paused"
  );
}

function wakeTriggerLabel(summaries: WakeSummary[]): string {
  if (summaries.length === 1) {
    const summary = summaries[0];
    return summary.label.toLowerCase();
  }
  return `${summaries.length} wakes`;
}

function wakeAriaLabel(summaries: WakeSummary[]): string {
  if (summaries.length === 1) {
    const summary = summaries[0];
    if (summary.kind === "interval") return "Interval wake scheduled";
    if (summary.kind === "daily") return "Daily wake scheduled";
    return "Wake scheduled";
  }
  return `${summaries.length} wakes configured`;
}

interface WakeControlsProps {
  session: DashboardSession;
  onSessionUpdated: (session: DashboardSession) => void;
  onRefresh: () => Promise<void>;
  showSuccessToast: (message: string) => number;
  showErrorToast: (message: string) => number;
}

export function WakeControls({
  session,
  onSessionUpdated,
  onRefresh,
  showSuccessToast,
  showErrorToast,
}: WakeControlsProps) {
  const summaries = useMemo(() => getWakeSummaries(session), [session]);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<WakeTarget, string>>>({});
  const [busyTarget, setBusyTarget] = useState<WakeTarget | null>(null);
  const [busyAction, setBusyAction] = useState<"save" | "wake" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const dueAt = summaries[0]?.dueAt;
  useEffect(() => {
    if (!dueAt) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [dueAt]);

  useEffect(() => {
    if (!open) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const summary of summaries) {
        if (next[summary.target] === undefined) {
          next[summary.target] = summary.message;
        }
      }
      return next;
    });
  }, [open, summaries]);

  const close = () => {
    setOpen(false);
    setDrafts({});
    setError(null);
  };

  const { containerRef, buttonRef, menuRef, menuStyle } = useAnchoredMenu({
    open,
    onClose: close,
    contentDeps: [summaries.length, error, busyTarget, busyAction, drafts],
  });

  if (summaries.length === 0) return null;

  const primarySummary = summaries[0];
  const countdown = formatWakeCountdown(primarySummary.dueAt, nowMs);
  const wakeNowAllowed = canWakeNow(session);
  const busy = busyTarget !== null;

  async function saveMessage(target: WakeTarget) {
    const draft = drafts[target]?.trim() ?? "";
    const summary = summaries.find((entry) => entry.target === target);
    if (!summary || !draft || draft === summary.message || busy) return;

    setBusyTarget(target);
    setBusyAction("save");
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/wake`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, message: draft }),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to save wake message"));
      }
      const payload = (await response.json()) as SpurSessionView;
      onSessionUpdated(toDashboardSession(payload));
      setDrafts((current) => {
        const next: Partial<Record<WakeTarget, string>> = {};
        for (const [key, value] of Object.entries(current)) {
          if (key !== target) next[key as WakeTarget] = value;
        }
        return next;
      });
      showSuccessToast("Wake message saved");
    } catch (saveError) {
      const message = errorMessage(saveError, "Failed to save wake message");
      setError(message);
      showErrorToast(message);
      await onRefresh();
    } finally {
      setBusyTarget(null);
      setBusyAction(null);
    }
  }

  async function wakeNow(target: WakeTarget) {
    const summary = summaries.find((entry) => entry.target === target);
    const draft = drafts[target];
    if (!summary || busy) return;
    if (draft !== undefined && draft !== summary.message) return;
    if (!wakeNowAllowed) return;

    setBusyTarget(target);
    setBusyAction("wake");
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: summary.message, queue: false }),
      });
      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response, "Failed to wake session"));
      }
      await readResponsePayload(response);
      showSuccessToast("Wake message sent");
    } catch (wakeError) {
      const message = errorMessage(wakeError, "Failed to wake session");
      setError(message);
      showErrorToast(message);
      await onRefresh();
    } finally {
      setBusyTarget(null);
      setBusyAction(null);
    }
  }

  const popover = open ? (
    <div
      aria-label="Wake controls"
      className="fixed z-30 w-[20rem] max-w-[calc(100vw-1rem)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] py-2 shadow-[0_8px_30px_var(--color-shadow-menu)]"
      ref={menuRef}
      role="dialog"
      style={menuStyle}
    >
      <div className="space-y-3 px-2.5">
        {summaries.map((summary) => {
          const draft = drafts[summary.target] ?? summary.message;
          const trimmedDraft = draft.trim();
          const dirty = draft !== summary.message;
          const saveDisabled =
            busy || !trimmedDraft || !dirty || (busyTarget === summary.target && busyAction === "save");
          const wakeDisabled =
            busy ||
            dirty ||
            !wakeNowAllowed ||
            (busyTarget === summary.target && busyAction === "wake");
          const recordCountdown = formatWakeCountdown(summary.dueAt, nowMs);

          return (
            <section
              className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-2"
              key={summary.target}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-status-attention)]">
                  {summary.label}
                </span>
                <span className="font-mono text-[var(--color-text-primary)]">{recordCountdown}</span>
              </div>
              {summary.intervalMs ? (
                <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  every {formatIntervalDuration(summary.intervalMs)}
                </span>
              ) : null}
              {summary.dailyAt ? (
                <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  daily {summary.dailyAt.join(", ")}
                </span>
              ) : null}
              {summary.stopCondition ? (
                <span className="mt-1 block min-w-0 truncate text-[var(--color-text-secondary)]">
                  until {summary.stopCondition}
                </span>
              ) : null}
              <label className="mt-2 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                Message
                <textarea
                  aria-label={`${summary.label} message`}
                  className="mt-1 block w-full min-h-[4.5rem] resize-y border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-2 py-1.5 text-[var(--color-text-primary)]"
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) => ({ ...current, [summary.target]: value }));
                  }}
                  value={draft}
                />
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  aria-busy={
                    (busyTarget === summary.target && busyAction === "save") || undefined
                  }
                  className="inline-flex items-center gap-1.5 border border-[var(--color-border-default)] px-2 py-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                  disabled={saveDisabled}
                  onClick={() => saveMessage(summary.target)}
                  type="button"
                >
                  {busyTarget === summary.target && busyAction === "save" ? (
                    <Spinner className="h-3 w-3" strokeWidth={1.5} />
                  ) : null}
                  Save message
                </button>
                <button
                  aria-busy={
                    (busyTarget === summary.target && busyAction === "wake") || undefined
                  }
                  className="inline-flex items-center gap-1.5 border border-[var(--color-border-default)] px-2 py-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-status-attention)] transition hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
                  disabled={wakeDisabled}
                  onClick={() => wakeNow(summary.target)}
                  type="button"
                >
                  {busyTarget === summary.target && busyAction === "wake" ? (
                    <Spinner className="h-3 w-3" strokeWidth={1.5} />
                  ) : null}
                  Wake now
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {error ? (
        <div
          className="mt-2 border-t border-[var(--color-border-subtle)] px-2.5 pt-2 text-[var(--color-chip-error-text)]"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="relative inline-flex" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={wakeAriaLabel(summaries)}
        className="inline-flex items-center gap-1.5 border border-[var(--color-border-default)] px-2 py-0.5 text-[var(--color-status-attention)] transition hover:bg-[var(--color-hover-overlay)]"
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        type="button"
      >
        <WakeIcon recurring={summaries.some((summary) => summary.kind !== "one-shot")} />
        <span>{wakeTriggerLabel(summaries)}</span>
        <span className="font-mono text-[var(--color-text-primary)]">{countdown}</span>
        {primarySummary.intervalMs ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            every {formatIntervalDuration(primarySummary.intervalMs)}
          </span>
        ) : null}
        {primarySummary.dailyAt ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
            daily {primarySummary.dailyAt.join(", ")}
          </span>
        ) : null}
      </button>
      {popover}
    </div>
  );
}
