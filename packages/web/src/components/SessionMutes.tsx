"use client";

import { useCallback, useState } from "react";
import { useAnchoredMenu } from "@/hooks/useAnchoredMenu";
import { usePoll } from "@/hooks/usePoll";
import { HARD_WRAP_TEXT_CLASS } from "@/design/classes";
import { formatShortTimestamp } from "@/lib/format";
import {
  isAutoPingMuteProjection,
  type AutoPingMute,
  type AutoPingMuteProjection,
} from "@/lib/types";

function subjectLabel(subject: string): string {
  if (subject.startsWith("thread:")) return "thread";
  return subject.replace(/^review:[^:]+:/, "");
}

function describeKinds(mute: AutoPingMute): string {
  const kinds = [...new Set(mute.items.map((item) => item.kind.replaceAll("_", " ")))];
  return kinds.join(", ") || "all pings";
}

function describeSubjects(mute: AutoPingMute): string {
  const subjects = [...new Set(mute.items.map((item) => subjectLabel(item.subject)))];
  return subjects.length > 0 ? subjects.join(", ") : "whole route";
}

function untilLabel(mute: AutoPingMute): string {
  if (mute.mode === "forever") return "forever";
  if (mute.mode === "for") {
    return mute.expiresAt ? `until ${formatShortTimestamp(mute.expiresAt)}` : "for a while";
  }
  const labels = [...new Set(mute.items.map((item) => item.label).filter(Boolean))];
  return labels.length === 1 ? (labels[0] ?? "until it changes") : "until it changes";
}

function MuteRow({ mute }: { mute: AutoPingMute }) {
  return (
    <li className="border-t border-[var(--color-border-subtle)] px-2.5 py-2 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-bold uppercase tracking-[0.06em] text-[var(--color-text-primary)]">
          {describeKinds(mute)}
        </span>
        <span className={`font-mono text-[var(--color-text-secondary)] ${HARD_WRAP_TEXT_CLASS}`}>
          {describeSubjects(mute)}
        </span>
      </div>
      <div className="mt-0.5 uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
        {untilLabel(mute)}
      </div>
      {mute.reason ? (
        <div className={`mt-0.5 text-[var(--color-text-secondary)] ${HARD_WRAP_TEXT_CLASS}`}>
          {mute.reason}
        </div>
      ) : null}
      {mute.endedAt ? (
        <div className="mt-0.5 uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
          Ended {mute.endReason ?? ""} {formatShortTimestamp(mute.endedAt)}
        </div>
      ) : null}
    </li>
  );
}

function MuteSection({ title, mutes }: { title: string; mutes: AutoPingMute[] }) {
  if (mutes.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
        {title}
      </h3>
      <ul>
        {mutes.map((mute) => (
          <MuteRow key={mute.suppressionId} mute={mute} />
        ))}
      </ul>
    </section>
  );
}

// Agent-page header chip: active auto-ping mutes of this session, with the
// session's mute history in the popover. Renders nothing until a mute exists.
export function SessionMutes({ sessionId }: { sessionId: string }) {
  const [projection, setProjection] = useState<AutoPingMuteProjection | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-ping`, {
          cache: "no-store",
          signal,
        });
        const payload = (await response.json()) as unknown;
        if (response.ok && isAutoPingMuteProjection(payload) && !signal.aborted) {
          setProjection(payload);
        }
      } catch {
        // The chip is a debugging aid: a failed poll keeps the last projection.
      }
    },
    [sessionId],
  );
  usePoll(load, 5_000);

  const active = projection?.records ?? [];
  // The daemon's history also lists active mutes; the popover shows them once.
  const history = (projection?.history ?? []).filter((mute) => mute.endedAt !== undefined);
  const { containerRef, buttonRef, menuRef, menuStyle } = useAnchoredMenu({
    open,
    onClose: () => setOpen(false),
    contentDeps: [active.length, history.length],
    preferredSide: "below",
  });

  if (active.length === 0 && history.length === 0) return null;
  const hasActive = active.length > 0;

  return (
    <div className="relative inline-flex items-center" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={hasActive ? `Muted pings ${active.length}` : "Mute history"}
        className={
          hasActive
            ? "inline-flex h-5 items-center border border-[var(--color-chip-warn-border)] px-1.5 text-[9px] font-bold uppercase tracking-[0.06em] text-[var(--color-chip-warn-text)] transition hover:bg-[var(--color-hover-overlay)]"
            : "inline-flex h-5 items-center border border-[var(--color-border-subtle)] px-1.5 text-[9px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)] transition hover:border-[var(--color-border-default)] hover:text-[var(--color-text-secondary)]"
        }
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        type="button"
      >
        {hasActive ? `Muted ${active.length}` : "Mutes"}
      </button>
      {open ? (
        <div
          aria-label="Auto-ping mutes"
          className="fixed z-30 w-72 max-h-80 overflow-y-auto border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-[0_8px_30px_var(--color-shadow-menu)]"
          ref={menuRef}
          role="dialog"
          style={menuStyle}
        >
          <MuteSection mutes={active} title="Active" />
          <MuteSection mutes={history} title="History" />
        </div>
      ) : null}
    </div>
  );
}
