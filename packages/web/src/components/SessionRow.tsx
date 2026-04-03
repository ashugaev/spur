"use client";

import { ActivityDot } from "@/components/ActivityDot";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import {
  CiStatusDot,
  ReviewCommentsBadge,
  extractLinkId,
  GithubIcon,
  JiraIcon,
  prStateColor,
  usePrInfo,
} from "@/lib/link-icons";
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

  const prLink = session.links.find((l) => l.label === "pr");
  const trackerLink = session.links.find((l) => l.label === "tracker");
  const prInfo = usePrInfo(prLink?.url);

  return (
    <div className="data-row group flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-2 transition-colors sm:gap-3 sm:px-2.5">
      <ActivityDot activity={session.state} dotOnly size={8} />

      <span className="hidden w-[7rem] shrink-0 truncate font-semibold uppercase text-[var(--color-text-primary)] sm:inline">
        {session.projectName}
      </span>

      <span className="hidden w-[3.5rem] shrink-0 text-[var(--color-text-tertiary)] md:inline">
        {session.agent}
      </span>

      <a
        className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildSessionPath(session.id, session.projectId)}
      >
        {title}
      </a>

      {trackerLink ? (
        <a
          className="hidden shrink-0 items-center gap-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-status-attention)] hover:no-underline sm:inline-flex"
          href={trackerLink.url}
          rel="noreferrer"
          target="_blank"
        >
          <JiraIcon />
          <span className="text-[11px]">{extractLinkId(trackerLink)}</span>
        </a>
      ) : null}

      {prLink ? (
        <a
          className="hidden shrink-0 items-center gap-1 hover:text-[var(--color-text-primary)] hover:no-underline sm:inline-flex"
          href={prLink.url}
          rel="noreferrer"
          style={{ color: prStateColor(prInfo.state) ?? "var(--color-text-tertiary)" }}
          target="_blank"
        >
          <GithubIcon />
          <span className="text-[11px]">{extractLinkId(prLink)}</span>
          <CiStatusDot status={prInfo.ciStatus} />
          <ReviewCommentsBadge count={prInfo.reviewComments} />
        </a>
      ) : null}

      <span className="hidden w-[8rem] shrink-0 truncate text-right font-mono text-[var(--color-text-secondary)] lg:inline">
        {session.branch}
      </span>

      <span className="w-[4rem] shrink-0 text-right text-[var(--color-text-tertiary)]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>

      <button
        aria-label={`Open web terminal for ${session.id}`}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center border transition ${canAttach ? "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" : "border-transparent text-[var(--color-text-tertiary)] opacity-25 cursor-not-allowed"}`}
        disabled={!canAttach}
        onClick={() => canAttach && onOpenTerminal?.(session)}
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
