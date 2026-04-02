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
  onAttach?: (sessionId: string) => Promise<void>;
  attaching?: boolean;
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

function CardButton({
  children,
  disabled,
  href,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  href?: string;
  onClick?: () => void;
  tone?: "default" | "accent";
}) {
  const className = cn(
    "inline-flex items-center justify-center rounded-xl border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
    tone === "accent"
      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)]"
      : "border-[var(--color-border-default)] text-[var(--color-text-primary)] hover:bg-white/5",
  );

  if (href) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }

  return (
    <button className={className} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
}

export function SessionCard({ session, onAttach, attaching = false }: SessionCardProps) {
  const level = getAttentionLevel(session);
  const title = getSessionTitle(session);
  const subtitle = getSessionSubtitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);

  return (
    <article
      className={cn(
        "session-card rounded-2xl border px-3 py-3 shadow-[0_12px_36px_rgba(0,0,0,0.2)]",
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

        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-primary)]">
          {toneLabels[level]}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ActivityDot activity={session.state} />
        <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {session.status}
        </span>
        {session.branch ? (
          <span className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
            {session.branch}
          </span>
        ) : null}
        {hasServiceProblems(session) ? (
          <span className="rounded-full border border-orange-400/30 px-2 py-0.5 text-[10px] text-orange-200">
            service issue
          </span>
        ) : null}
        {!session.runtimeAlive && !isTerminalSession(session) ? (
          <span className="rounded-full border border-red-500/30 px-2 py-0.5 text-[10px] text-red-200">
            offline
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-[var(--color-text-tertiary)]">
            {session.id}
          </div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            {formatRelativeTime(session.lastActivityAt)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <CardButton href={buildSessionPath(session.id, session.projectId)}>Details</CardButton>
          <CardButton
            disabled={!canAttach || attaching}
            onClick={() => void onAttach?.(session.id)}
            tone="accent"
          >
            {attaching ? "Opening..." : "Open terminal"}
          </CardButton>
        </div>
      </div>
    </article>
  );
}
