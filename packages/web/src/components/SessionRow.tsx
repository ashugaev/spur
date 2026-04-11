"use client";

import { type ReactNode, useState } from "react";
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
import { canComplete, isTerminalSession, type DashboardSession } from "@/lib/types";

const BASE_BTN = "inline-flex h-6 w-6 shrink-0 items-center justify-center border transition";
const DISABLED_BTN =
  "border-transparent text-[var(--color-text-tertiary)] opacity-25 cursor-not-allowed";

function IconButton({
  label,
  disabled,
  activeClass,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  activeClass: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className={`${BASE_BTN} ${disabled ? DISABLED_BTN : activeClass}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

interface SessionRowProps {
  projectFilterId?: string;
  session: DashboardSession;
  onOpenTerminal?: (session: DashboardSession) => void;
}

export function SessionRow({ projectFilterId, session, onOpenTerminal }: SessionRowProps) {
  const title = getSessionTitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);

  const prLink = session.links.find((l) => l.label === "pr");
  const trackerLink = session.links.find((l) => l.label === "tracker");
  const prInfo = usePrInfo(prLink?.url);
  const showDone = prInfo.state === "merged" && canComplete(session);
  const [completing, setCompleting] = useState(false);

  return (
    <div className="data-row group flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-2 transition-colors sm:gap-3 sm:px-2.5">
      <span className="hidden w-[7rem] shrink-0 truncate font-semibold uppercase text-[var(--color-text-primary)] sm:inline">
        {session.projectName}
      </span>

      <span className="hidden w-[3.5rem] shrink-0 text-[var(--color-text-tertiary)] md:inline">
        {session.agent}
      </span>

      <a
        className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildSessionPath(session.id, projectFilterId)}
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
          <span className="text-[10px]">{extractLinkId(trackerLink)}</span>
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
          <span className="text-[10px]">{extractLinkId(prLink)}</span>
          <CiStatusDot status={prInfo.ciStatus} />
          <ReviewCommentsBadge total={prInfo.totalThreads} unresolved={prInfo.unresolvedThreads} />
        </a>
      ) : null}

      <span className="hidden w-[8rem] shrink-0 truncate text-right font-mono text-[var(--color-text-secondary)] lg:inline">
        {session.branch}
      </span>

      <span className="w-[4rem] shrink-0 text-right text-[var(--color-text-tertiary)]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>

      {showDone ? (
        <IconButton
          label={`Mark ${session.id} as done`}
          disabled={completing}
          activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-status-ready)] hover:text-[var(--color-status-ready)]"
          onClick={async () => {
            setCompleting(true);
            try {
              const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
                method: "POST",
              });
              if (!res.ok) throw new Error(`complete: ${res.status}`);
            } catch (err) {
              console.error("complete failed", err);
              setCompleting(false);
            }
          }}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </IconButton>
      ) : (
        <IconButton
          label={`Open web terminal for ${session.id}`}
          disabled={!canAttach}
          activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          onClick={() => canAttach && onOpenTerminal?.(session)}
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
        </IconButton>
      )}
    </div>
  );
}
