"use client";

import { cn } from "@/lib/cn";
import { resolveTerminalStatus, type TerminalWsStatus } from "@/lib/terminal-status";
import type { SpurSessionState } from "@/lib/types";

interface TerminalStatusDotProps {
  activity?: SpurSessionState | null;
  error?: string | null;
  wsStatus: TerminalWsStatus;
}

export function TerminalStatusDot({ activity, error, wsStatus }: TerminalStatusDotProps) {
  const resolved = resolveTerminalStatus(wsStatus, activity, error ?? null);

  return (
    <div
      className={cn("h-2 w-2 shrink-0 rounded-full", resolved.pulse && "dot-pulse")}
      data-activity={activity ?? undefined}
      data-testid="direct-terminal-header-status-dot"
      data-ws-status={wsStatus}
      style={{ background: resolved.colorVar }}
      title={resolved.title}
    />
  );
}
