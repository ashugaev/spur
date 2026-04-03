"use client";

import { ActivityDot } from "@/components/ActivityDot";
import { cn } from "@/lib/cn";
import { formatRelativeTime, getSessionSubtitle, getSessionTitle } from "@/lib/format";
import { buildSessionPath } from "@/lib/project-routes";
import {
  getAttentionLevel,
  hasServiceProblems,
  isTerminalSession,
  type DashboardSession,
} from "@/lib/types";

interface SessionCardProps {
  session: DashboardSession;
  onOpenTerminal?: (session: DashboardSession) => void;
}

const toneClasses = {
  respond: "border-red-500/25 bg-red-500/[0.06]",
  review: "border-orange-400/25 bg-orange-400/[0.06]",
  pending: "border-amber-400/25 bg-amber-400/[0.06]",
  working: "border-sky-400/25 bg-sky-400/[0.06]",
  done: "border-white/10 bg-white/[0.03]",
} as const;

const toneLabels = {
  respond: "Needs input",
  review: "Needs review",
  pending: "Pending",
  working: "Working",
  done: "Done",
} as const;

export function SessionCard({ session, onOpenTerminal }: SessionCardProps) {
  const level = getAttentionLevel(session);
  const title = getSessionTitle(session);
  const subtitle = getSessionSubtitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);

  return (
    <article
      className={cn(
        "session-card rounded-sm border px-2.5 py-2 shadow-[0_12px_36px_rgba(0,0,0,0.2)]",
        toneClasses[level],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            <span>{session.projectName}</span>
            <span>•</span>
            <span>{session.agent}</span>
          </div>

          <a
            className="mt-1 block text-sm font-semibold leading-5 text-[var(--color-text-primary)] hover:no-underline"
            href={buildSessionPath(session.id, session.projectId)}
          >
            {title}
          </a>

          {subtitle ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              {subtitle}
            </p>
          ) : null}
        </div>

        <span className="rounded-sm border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-primary)]">
          {toneLabels[level]}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <ActivityDot activity={session.state} />
        <span className="rounded-sm border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {session.status}
        </span>
        {session.branch ? (
          <span className="rounded-sm border border-[var(--color-border-default)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
            {session.branch}
          </span>
        ) : null}
        {hasServiceProblems(session) ? (
          <span className="rounded-sm border border-orange-400/30 px-2 py-0.5 text-[10px] text-orange-200">
            service issue
          </span>
        ) : null}
        {!session.runtimeAlive && !isTerminalSession(session) ? (
          <span className="rounded-sm border border-red-500/30 px-2 py-0.5 text-[10px] text-red-200">
            offline
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
            {session.id}
          </div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            {formatRelativeTime(session.lastActivityAt)}
          </div>
        </div>

        <button
          aria-label={`Open web terminal for ${session.id}`}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-sm border transition",
            canAttach
              ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-[var(--color-text-inverse)]"
              : "border-[var(--color-border-default)] text-[var(--color-text-tertiary)] opacity-50",
          )}
          disabled={!canAttach}
          onClick={() => onOpenTerminal?.(session)}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
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
    </article>
  );
}
