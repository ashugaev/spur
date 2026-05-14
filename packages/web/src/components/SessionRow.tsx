"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { SessionLinkBadge, useSessionLinkPrInfo } from "@/components/SessionLinkBadge";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import { isReviewLinkLabel, primePrInfo, reviewProviderFromUrl } from "@/lib/link-icons";
import { buildSessionPath } from "@/lib/project-routes";
import {
  canComplete,
  getAttentionLevel,
  isRestorable,
  isTerminalSession,
  type DashboardSession,
} from "@/lib/types";

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
  onRestoreSession: (session: DashboardSession) => Promise<void>;
}

export function SessionRow({
  projectFilterId,
  session,
  onOpenTerminal,
  onRestoreSession,
}: SessionRowProps) {
  const title = getSessionTitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);
  const showRestore = getAttentionLevel(session) === "stopped" && isRestorable(session);

  const prLink = session.links.find((l) => isReviewLinkLabel(l.label));
  const trackerLink = session.links.find((l) => l.label === "tracker");
  const prInfo = useSessionLinkPrInfo(prLink);
  const reviewProvider = prLink ? reviewProviderFromUrl(prLink.url) : null;
  const [mergedAfterMerge, setMergedAfterMerge] = useState(false);
  const showDone = (prInfo.state === "merged" || mergedAfterMerge) && canComplete(session);
  const showMerge =
    reviewProvider === "github" && Boolean(prLink) && prInfo.canMerge && !mergedAfterMerge;
  const [completing, setCompleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [restoring, setRestoring] = useState(false);

  return (
    <div className="data-row group flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-2 py-2 transition-colors sm:gap-3 sm:px-2.5">
      <span className="hidden w-[7rem] shrink-0 truncate font-semibold uppercase text-[var(--color-text-primary)] sm:inline">
        {session.projectName}
      </span>

      <span className="hidden w-[3.5rem] shrink-0 text-[var(--color-text-tertiary)] md:inline">
        {session.agent}
      </span>

      <Link
        className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildSessionPath(session.id, projectFilterId)}
      >
        {title}
      </Link>

      {trackerLink ? (
        <SessionLinkBadge className="hidden sm:inline-flex" link={trackerLink} variant="row" />
      ) : null}

      {prLink ? (
        <SessionLinkBadge
          className="hidden sm:inline-flex"
          link={prLink}
          prInfo={prInfo}
          variant="row"
        />
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
      ) : showMerge ? (
        <IconButton
          label={`Merge PR for ${session.id}`}
          disabled={merging}
          activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-status-ready)] hover:text-[var(--color-status-ready)]"
          onClick={async () => {
            if (!prLink) return;
            setMerging(true);
            try {
              const res = await fetch("/api/pr-status/merge", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: prLink.url }),
              });
              if (!res.ok) throw new Error(`merge: ${res.status}`);
              primePrInfo(prLink.url, {
                ...prInfo,
                state: "merged",
                canMerge: false,
                fetchedAt: Date.now(),
                stale: false,
              });
              setMergedAfterMerge(true);
            } catch (err) {
              console.error("merge failed", err);
              setMerging(false);
            }
          }}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            <path d="M7 6a2.5 2.5 0 1 0-2.5 2.5A2.5 2.5 0 0 0 7 6Z" />
            <path d="M19.5 15.5A2.5 2.5 0 1 0 17 18a2.5 2.5 0 0 0 2.5-2.5Z" />
            <path d="M19.5 6A2.5 2.5 0 1 0 17 8.5 2.5 2.5 0 0 0 19.5 6Z" />
            <path d="M7 6h5a5 5 0 0 1 5 5v2.5" />
          </svg>
        </IconButton>
      ) : showRestore ? (
        <IconButton
          label={`Restore session ${session.id}`}
          disabled={restoring}
          activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-status-ready)] hover:text-[var(--color-status-ready)]"
          onClick={async () => {
            if (restoring) return;
            setRestoring(true);
            try {
              await onRestoreSession(session);
            } catch (err) {
              console.error("restore failed", err);
              setRestoring(false);
            }
          }}
        >
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 24 24"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v6h6" />
            <path d="M10 12h4" />
            <path d="m14 12-2-2" />
            <path d="m14 12-2 2" />
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
