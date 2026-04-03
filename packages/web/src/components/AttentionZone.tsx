"use client";

import { SessionCard } from "@/components/SessionCard";
import { cn } from "@/lib/cn";
import { toneClasses } from "@/lib/tone";
import type { AttentionLevel, DashboardSession } from "@/lib/types";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  collapsed?: boolean;
  onToggle?: (level: AttentionLevel) => void;
  onOpenTerminal?: (session: DashboardSession) => void;
}

const zoneConfig: Record<AttentionLevel, { label: string; color: string }> = {
  respond: { label: "Respond", color: "var(--color-status-error)" },
  review: { label: "Review", color: "var(--color-accent-orange)" },
  pending: { label: "Pending", color: "var(--color-status-attention)" },
  working: { label: "Working", color: "var(--color-status-working)" },
  done: { label: "Done", color: "var(--color-text-tertiary)" },
};

export function AttentionZone({
  level,
  sessions,
  collapsed,
  onToggle,
  onOpenTerminal,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const isAccordion = typeof onToggle === "function";

  if (isAccordion) {
    return (
      <section className="overflow-hidden rounded-sm border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
          onClick={() => onToggle(level)}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: config.color }} />
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {config.label}
          </span>
          <span className="rounded-sm border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            {sessions.length}
          </span>
          <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
            {collapsed ? "Show" : "Hide"}
          </span>
        </button>

        {!collapsed ? (
          <div className="border-t border-[var(--color-border-default)] p-2">
            <div className="space-y-2">
              {sessions.length > 0 ? (
                sessions.map((session) => (
                  <SessionCard key={session.id} onOpenTerminal={onOpenTerminal} session={session} />
                ))
              ) : (
                <div className="rounded-sm border border-dashed border-[var(--color-border-default)] px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">
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
        "flex min-h-[14rem] flex-col rounded-sm border bg-[var(--color-bg-surface)] p-2.5",
        toneClasses[level],
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: config.color }} />
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{config.label}</h2>
        </div>
        <span className="rounded-sm border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {sessions.length}
        </span>
      </header>

      <div className="flex-1 space-y-2">
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <SessionCard key={session.id} onOpenTerminal={onOpenTerminal} session={session} />
          ))
        ) : (
          <div className="flex h-full items-center justify-center rounded-sm border border-dashed border-[var(--color-border-default)] px-3 py-6 text-center text-sm text-[var(--color-text-tertiary)]">
            No sessions
          </div>
        )}
      </div>
    </section>
  );
}
