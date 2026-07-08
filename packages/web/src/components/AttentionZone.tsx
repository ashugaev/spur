"use client";

import { SessionRow } from "@/components/SessionRow";
import { Zone } from "@/components/Zone";
import type { AttentionLevel, DashboardSession, DeskCollapsedRow } from "@/lib/types";

interface AttentionZoneProps {
  level: AttentionLevel;
  projectFilterId?: string;
  rows: DeskCollapsedRow[];
  collapsed?: boolean;
  onToggle?: (level: AttentionLevel) => void;
  onOpenTerminal?: (session: DashboardSession) => void;
  onCompleteSession: (session: DashboardSession) => Promise<void>;
  onRestoreSession: (session: DashboardSession) => Promise<void>;
}

const zoneConfig: Record<AttentionLevel, { label: string; color: string; dividerColor?: string }> =
  {
    error: { label: "Errors", color: "var(--color-status-error)" },
    rate_limited: { label: "Rate Limited", color: "var(--color-status-attention)" },
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
  rows,
  collapsed,
  onToggle,
  onOpenTerminal,
  onCompleteSession,
  onRestoreSession,
}: AttentionZoneProps) {
  const config = zoneConfig[level];

  const sessionRows = rows.map((entry) => (
    <SessionRow
      key={entry.session.id}
      deskMemberCount={entry.deskMemberCount}
      projectFilterId={projectFilterId}
      session={entry.session}
      onOpenTerminal={onOpenTerminal}
      onCompleteSession={onCompleteSession}
      onRestoreSession={onRestoreSession}
    />
  ));

  return (
    <Zone
      label={config.label}
      color={config.color}
      count={rows.length}
      dividerColor={config.dividerColor}
      collapsed={collapsed}
      onToggle={onToggle ? () => onToggle(level) : undefined}
    >
      {sessionRows}
    </Zone>
  );
}
