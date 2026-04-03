"use client";

import { ActivityDot } from "@/components/ActivityDot";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import { buildSessionPath } from "@/lib/project-routes";
import { isTerminalSession, type DashboardSession, type SpurSessionLink } from "@/lib/types";

interface SessionRowProps {
  session: DashboardSession;
  onOpenTerminal?: (session: DashboardSession) => void;
}

function extractLinkId(link: SpurSessionLink): string {
  const url = link.url;
  if (link.label === "pr") {
    const match = url.match(/\/pull\/(\d+)/);
    return match ? `#${match[1]}` : "PR";
  }
  if (link.label === "tracker") {
    const match = url.match(/\/browse\/([A-Z]+-\d+)/) ?? url.match(/([A-Z]+-\d+)/);
    return match ? match[1] : "task";
  }
  return link.label;
}

function GithubIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function JiraIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77zM2 11.6a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72A4.362 4.362 0 0 0 12.48 22V12.44a.84.84 0 0 0-.84-.84H2z" />
    </svg>
  );
}

export function SessionRow({ session, onOpenTerminal }: SessionRowProps) {
  const title = getSessionTitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);

  const prLink = session.links.find((l) => l.label === "pr");
  const trackerLink = session.links.find((l) => l.label === "tracker");

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
          className="hidden shrink-0 items-center gap-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:no-underline sm:inline-flex"
          href={prLink.url}
          rel="noreferrer"
          target="_blank"
        >
          <GithubIcon />
          <span className="text-[11px]">{extractLinkId(prLink)}</span>
        </a>
      ) : null}

      <span className="hidden w-[8rem] shrink-0 truncate text-right font-mono text-[var(--color-text-secondary)] lg:inline">
        {session.branch}
      </span>

      <span className="w-[4rem] shrink-0 text-right text-[var(--color-text-tertiary)]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>

      {canAttach ? (
        <button
          aria-label={`Open web terminal for ${session.id}`}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-[var(--color-border-default)] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
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
      ) : null}
    </div>
  );
}
