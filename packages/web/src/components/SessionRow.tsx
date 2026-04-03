"use client";

import { ActivityDot } from "@/components/ActivityDot";
import { cn } from "@/lib/cn";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import { buildSessionPath } from "@/lib/project-routes";
import { isTerminalSession, type DashboardSession } from "@/lib/types";

interface SessionRowProps {
  session: DashboardSession;
  onOpenTerminal?: (session: DashboardSession) => void;
}

export function SessionRow({ session, onOpenTerminal }: SessionRowProps) {
  const title = getSessionTitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);

  return (
    <div className="data-row group flex items-center gap-3 border-b border-[var(--color-border-subtle)] px-2.5 py-2 transition-colors">
      <ActivityDot activity={session.state} dotOnly size={8} />

      <span className="w-[7rem] shrink-0 truncate text-[11px] font-semibold uppercase text-[var(--color-text-primary)]">
        {session.projectName}
      </span>

      <span className="w-[3.5rem] shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
        {session.agent}
      </span>

      <a
        className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildSessionPath(session.id, session.projectId)}
      >
        {title}
      </a>

      {session.branch ? (
        <span className="hidden w-[8rem] shrink-0 truncate text-right font-mono text-[11px] text-[var(--color-text-secondary)] lg:inline">
          {session.branch}
        </span>
      ) : (
        <span className="hidden w-[8rem] shrink-0 lg:inline" />
      )}

      <span className="w-[4rem] shrink-0 text-right text-[11px] text-[var(--color-text-tertiary)]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>

      <button
        aria-label={`Open web terminal for ${session.id}`}
        className={cn(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border opacity-0 transition group-hover:opacity-100",
          canAttach
            ? "border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-text-inverse)]"
            : "border-[var(--color-border-default)] text-[var(--color-text-tertiary)]",
        )}
        disabled={!canAttach}
        onClick={() => onOpenTerminal?.(session)}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path d="M4 6.75A1.75 1.75 0 0 1 5.75 5h12.5A1.75 1.75 0 0 1 20 6.75v10.5A1.75 1.75 0 0 1 18.25 19H5.75A1.75 1.75 0 0 1 4 17.25Z" />
          <path d="m8 10 2.5 2L8 14.5" />
          <path d="M13 15h3" />
        </svg>
      </button>
    </div>
  );
}
