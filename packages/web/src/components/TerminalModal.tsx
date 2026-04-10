"use client";

import { useEffect } from "react";
import { DirectTerminal } from "@/components/DirectTerminal";
import type { DashboardSession } from "@/lib/types";

interface TerminalModalProps {
  session: DashboardSession;
  onClose: () => void;
  /** Override the tmux session name (e.g. for sidecar terminals). */
  tmuxSessionOverride?: string;
  /** Override the modal title suffix (e.g. sidecar name). */
  titleSuffix?: string;
}

export function TerminalModal({ session, onClose, tmuxSessionOverride, titleSuffix }: TerminalModalProps) {
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
      className="fixed inset-0 z-[90] overflow-hidden bg-black/70 p-2 backdrop-blur-sm sm:p-3"
      role="dialog"
    >
      <DirectTerminal
        label={tmuxSessionOverride ?? session.id}
        onClose={onClose}
        sessionId={tmuxSessionOverride ?? session.tmuxSession ?? session.id}
        title={`${session.projectName} • ${titleSuffix ?? session.agent}`}
      />
    </div>
  );
}
