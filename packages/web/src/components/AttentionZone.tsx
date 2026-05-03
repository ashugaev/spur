"use client";

import { SessionRow } from "@/components/SessionRow";
import type { AttentionLevel, DashboardSession } from "@/lib/types";

interface AttentionZoneProps {
  level: AttentionLevel;
  projectFilterId?: string;
  sessions: DashboardSession[];
  collapsed?: boolean;
  onToggle?: (level: AttentionLevel) => void;
  onOpenTerminal?: (session: DashboardSession) => void;
}

const zoneConfig: Record<AttentionLevel, { label: string; color: string; dividerColor?: string }> =
  {
    respond: { label: "Needs Input", color: "var(--color-status-error)" },
    working: { label: "Working", color: "var(--color-status-working)" },
    pending: { label: "Waiting", color: "var(--color-status-attention)" },
    stopped: {
      label: "Stopped",
      color: "var(--color-text-tertiary)",
      dividerColor: "var(--color-border-subtle)",
    },
    done: { label: "Completed", color: "var(--color-status-ready)" },
  };

export function AttentionZone({
  level,
  projectFilterId,
  sessions,
  collapsed,
  onToggle,
  onOpenTerminal,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const isAccordion = typeof onToggle === "function";

  const header = (
    <div className="flex items-center gap-2 py-2">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: config.color }} />
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
        {config.label}
      </span>
      <div
        className="flex-1 border-t"
        style={{
          borderColor:
            config.dividerColor ?? `color-mix(in srgb, ${config.color} 25%, transparent)`,
        }}
      />
      <span className="text-[10px] text-[var(--color-text-tertiary)]">{sessions.length}</span>
    </div>
  );

  const rows = sessions.map((session) => (
    <SessionRow
      key={session.id}
      projectFilterId={projectFilterId}
      session={session}
      onOpenTerminal={onOpenTerminal}
    />
  ));

  if (isAccordion) {
    return (
      <section>
        <button
          type="button"
          className="flex w-full items-center text-left"
          onClick={() => onToggle(level)}
        >
          <div className="flex-1">{header}</div>
          <span className="ml-2 text-[10px] text-[var(--color-text-tertiary)]">
            {collapsed ? "\u25B8" : "\u25BE"}
          </span>
        </button>
        {!collapsed ? rows : null}
      </section>
    );
  }

  return (
    <section>
      {header}
      {rows}
    </section>
  );
}
