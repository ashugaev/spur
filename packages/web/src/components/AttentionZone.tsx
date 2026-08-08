"use client";

import { SessionRow } from "@/components/SessionRow";
import { Zone } from "@/components/Zone";
import {
  ATTENTION_LANE_META,
  type AttentionLevel,
  type DashboardSession,
  type DeskCollapsedRow,
} from "@/lib/types";

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
  const config = ATTENTION_LANE_META[level];

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
