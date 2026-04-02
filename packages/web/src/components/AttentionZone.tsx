"use client";

import { SessionCard } from "@/components/SessionCard";
import { cn } from "@/lib/cn";
import type { AttentionLevel, DashboardSession } from "@/lib/types";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  collapsed?: boolean;
  onToggle?: (level: AttentionLevel) => void;
  onAttach?: (sessionId: string) => Promise<void>;
  attachingSessionId?: string | null;
}

const zoneConfig: Record<AttentionLevel, { label: string; color: string; border: string }> = {
  respond: {
    label: "Respond",
    color: "var(--color-status-error)",
    border: "border-red-500/25",
  },
  review: {
    label: "Review",
    color: "var(--color-accent-orange)",
    border: "border-orange-400/25",
  },
  pending: {
    label: "Pending",
    color: "var(--color-status-attention)",
    border: "border-amber-400/25",
  },
  working: {
    label: "Working",
    color: "var(--color-status-working)",
    border: "border-sky-400/25",
  },
  done: {
    label: "Done",
    color: "var(--color-text-tertiary)",
    border: "border-white/10",
  },
};

export function AttentionZone({
  level,
  sessions,
  collapsed,
  onToggle,
  onAttach,
  attachingSessionId,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const isAccordion = typeof onToggle === "function";

  if (isAccordion) {
    return (
      <section className="overflow-hidden rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
          onClick={() => onToggle(level)}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: config.color }} />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {config.label}
          </span>
          <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            {sessions.length}
          </span>
          <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
            {collapsed ? "Show" : "Hide"}
          </span>
        </button>

        {!collapsed ? (
          <div className="border-t border-[var(--color-border-default)] p-2.5">
            <div className="space-y-2.5">
              {sessions.length > 0 ? (
                sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    attaching={attachingSessionId === session.id}
                    onAttach={onAttach}
                    session={session}
                  />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-[var(--color-border-default)] px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">
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
        "flex min-h-[14rem] flex-col rounded-2xl border bg-[var(--color-bg-surface)] p-3",
        config.border,
      )}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: config.color }} />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{config.label}</h2>
        </div>
        <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {sessions.length}
        </span>
      </header>

      <div className="flex-1 space-y-2.5">
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <SessionCard
              key={session.id}
              attaching={attachingSessionId === session.id}
              onAttach={onAttach}
              session={session}
            />
          ))
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[var(--color-border-default)] px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">
            No sessions
          </div>
        )}
      </div>
    </section>
  );
}
