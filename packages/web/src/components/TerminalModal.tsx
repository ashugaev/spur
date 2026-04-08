"use client";

import { useEffect } from "react";
import { DirectTerminal } from "@/components/DirectTerminal";
import type { DashboardSession } from "@/lib/types";

interface TerminalModalProps {
  session: DashboardSession;
  onClose: () => void;
}

export function TerminalModal({ session, onClose }: TerminalModalProps) {
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
        label={session.id}
        onClose={onClose}
        sessionId={session.tmuxSession ?? session.id}
        title={`${session.projectName} • ${session.agent}`}
      />
    </div>
  );
}
