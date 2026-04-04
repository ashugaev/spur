"use client";

import React, { useEffect, useState } from "react";
import { GithubIcon, useGitError } from "@/lib/link-icons";

function useClock(): string {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("en-GB", { hour12: false });
}

function StatusDot({ ok, title }: { ok: boolean; title?: string }): React.ReactNode {
  const color = ok ? "var(--color-status-ready)" : "var(--color-status-error)";
  return (
    <span
      className="h-1.5 w-1.5 rounded-full"
      style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      title={title}
    />
  );
}

export function StatusBar({ daemonError }: { daemonError: string | null }): React.ReactNode {
  const gitError = useGitError();
  const clock = useClock();

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 flex h-6 items-center justify-end gap-6 border-t border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 text-[9px] uppercase tracking-[0.08em]">
      <div className="flex items-center gap-1.5" title={daemonError ?? undefined}>
        <StatusDot ok={!daemonError} />
        <span className={daemonError ? "text-[var(--color-status-error)]" : "text-[var(--color-text-secondary)]"}>
          Daemon
        </span>
      </div>

      <div className="flex items-center gap-1.5" title={gitError ?? undefined}>
        <StatusDot ok={!gitError} />
        <GithubIcon />
      </div>

      <div className="text-[var(--color-text-tertiary)]">{clock}</div>
    </footer>
  );
}
