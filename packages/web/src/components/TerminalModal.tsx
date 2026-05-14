"use client";

import { useEffect } from "react";
import { DirectTerminal } from "@/components/DirectTerminal";
import { getSessionTitle } from "@/lib/format";
import type { DashboardSession } from "@/lib/types";

interface TerminalModalProps {
  session: DashboardSession;
  onClose: () => void;
  /** Override the tmux session name (e.g. for sidecar terminals). */
  tmuxSessionOverride?: string;
  /** Override the modal title suffix (e.g. sidecar name). */
  titleSuffix?: string;
}

function normalizeTitleSuffix(titleSuffix?: string): string | undefined {
  const normalizedTitleSuffix = titleSuffix?.trim();
  return normalizedTitleSuffix ? normalizedTitleSuffix : undefined;
}

function buildTerminalTitle(session: DashboardSession, titleSuffix?: string): string | undefined {
  const normalizedTitleSuffix = normalizeTitleSuffix(titleSuffix);
  const sessionTitle = getSessionTitle(session);

  if (sessionTitle) {
    return normalizedTitleSuffix ? `${sessionTitle} • ${normalizedTitleSuffix}` : sessionTitle;
  }

  return `${session.projectName} • ${normalizedTitleSuffix ?? session.agent}`;
}

export function TerminalModal({
  session,
  onClose,
  tmuxSessionOverride,
  titleSuffix,
}: TerminalModalProps) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      aria-label={`Terminal ${session.id}`}
      aria-modal="true"
      className="fixed inset-0 z-[90] overflow-hidden bg-[var(--color-modal-backdrop)] p-2 backdrop-blur-sm sm:p-3"
      role="dialog"
    >
      <DirectTerminal
        agent={session.agent}
        label={tmuxSessionOverride ?? session.id}
        onClose={onClose}
        sessionId={tmuxSessionOverride ?? session.tmuxSession ?? session.id}
        title={buildTerminalTitle(session, titleSuffix)}
      />
    </div>
  );
}
