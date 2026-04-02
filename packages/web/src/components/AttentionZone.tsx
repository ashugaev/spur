"use client";

import { SessionCard } from "@/components/SessionCard";
import { cn } from "@/lib/cn";
import type { AttentionLevel, DashboardSession } from "@/lib/types";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  collapsed?: boolean;
  onToggle?: (level: AttentionLevel) => void;
  onSend?: (sessionId: string, message: string) => Promise<void>;
  onPause?: (sessionId: string) => Promise<void>;
  onRestore?: (sessionId: string) => Promise<void>;
  onComplete?: (sessionId: string) => Promise<void>;
  onKill?: (sessionId: string) => Promise<void>;
}

const zoneConfig: Record<
  AttentionLevel,
  { label: string; caption: string; color: string; border: string }
> = {
  respond: {
    label: "Respond",
    caption: "A human decision or message is needed.",
    color: "var(--color-status-error)",
    border: "border-red-500/25",
  },
  review: {
    label: "Review",
    caption: "Runtime or workspace drift needs cleanup.",
    color: "var(--color-accent-orange)",
    border: "border-orange-400/25",
  },
  pending: {
    label: "Pending",
    caption: "Paused, spawning, or waiting on the environment.",
    color: "var(--color-status-attention)",
    border: "border-amber-400/25",
  },
  working: {
    label: "Working",
    caption: "The session is alive and progressing.",
    color: "var(--color-status-working)",
    border: "border-sky-400/25",
  },
  done: {
    label: "Done",
    caption: "Terminal sessions kept for visibility.",
    color: "var(--color-text-tertiary)",
    border: "border-white/10",
  },
};

export function AttentionZone({
  level,
  sessions,
  collapsed,
  onToggle,
  onSend,
  onPause,
  onRestore,
  onComplete,
  onKill,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const isAccordion = typeof onToggle === "function";

  if (isAccordion) {
    return (
      <section className="overflow-hidden rounded-3xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
          onClick={() => onToggle(level)}
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: config.color }} />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {config.label}
          </span>
          <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
            {sessions.length}
          </span>
          <span className="ml-auto text-xs text-[var(--color-text-tertiary)]">
            {collapsed ? "Show" : "Hide"}
          </span>
        </button>

        {!collapsed ? (
          <div className="border-t border-[var(--color-border-default)] p-3">
            <div className="space-y-3">
              {sessions.length > 0 ? (
                sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    onComplete={onComplete}
                    onKill={onKill}
                    onPause={onPause}
                    onRestore={onRestore}
                    onSend={onSend}
                    session={session}
                  />
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-[var(--color-border-default)] px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
                  No sessions
                </div>
              )}
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex min-h-[18rem] flex-col rounded-3xl border bg-[var(--color-bg-surface)] p-4",
        config.border,
      )}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: config.color }} />
            <h2 className="text-sm font-semibold tracking-[0.02em] text-[var(--color-text-primary)]">
              {config.label}
            </h2>
            <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
              {sessions.length}
            </span>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
            {config.caption}
          </p>
        </div>
      </header>

      <div className="flex-1 space-y-3">
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <SessionCard
              key={session.id}
              onComplete={onComplete}
              onKill={onKill}
              onPause={onPause}
              onRestore={onRestore}
              onSend={onSend}
              session={session}
            />
          ))
        ) : (
          <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-default)] px-4 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            No sessions
          </div>
        )}
      </div>
    </section>
  );
}
