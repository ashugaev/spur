"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DataRow, RowIconButton } from "@/components/DataRow";
import { SessionLinkBadge, useSessionLinkPrInfo } from "@/components/SessionLinkBadge";
import { TagEditor } from "@/components/TagEditor";
import { formatRelativeTime, getSessionTitle } from "@/lib/format";
import { isReviewLinkLabel, primePrInfo, reviewProviderFromUrl } from "@/lib/link-icons";
import { buildSessionPath } from "@/lib/project-routes";
import {
  canComplete,
  getAttentionLevel,
  isRestorable,
  isTerminalSession,
  type DashboardRunningSidecar,
  type DashboardSession,
} from "@/lib/types";
import { formatIntervalDuration, formatWakeCountdown, getWakeSummary } from "@/lib/wake-format";

type ActiveRowPopover = "wake" | "sidecars" | null;

function UnseenAttentionIcon({ state }: { state: DashboardSession["state"] }) {
  const color =
    state === "needs_input" ? "var(--color-status-error)" : "var(--color-status-attention)";

  return (
    <span
      aria-label="Unopened attention"
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
      style={{ color }}
      title="Unopened attention"
    >
      <svg
        aria-hidden="true"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
        viewBox="0 0 16 16"
      >
        <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
      </svg>
    </span>
  );
}

function WakeIndicator({
  open,
  session,
  onToggle,
}: {
  open: boolean;
  session: DashboardSession;
  onToggle: () => void;
}) {
  const summary = getWakeSummary(session);
  const wakeDueAt = summary?.dueAt;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!wakeDueAt) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [wakeDueAt]);

  if (!summary) return null;

  const recurring = summary.kind === "interval" || summary.kind === "daily";
  const label =
    summary.kind === "interval"
      ? "Interval wake scheduled"
      : summary.kind === "daily"
        ? "Daily wake scheduled"
        : "Wake scheduled";
  const panelId = `wake-${session.id}`;

  return (
    <span className="relative inline-flex shrink-0">
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center border border-[var(--color-border-subtle)] text-[var(--color-status-attention)] transition hover:border-[var(--color-status-attention)] hover:bg-[var(--color-hover-overlay)]"
        onClick={onToggle}
        title={label}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v5l3 2" />
          {recurring ? <path d="M4 12a8 8 0 0 1 13.5-5.8M20 12a8 8 0 0 1-13.5 5.8" /> : null}
        </svg>
      </button>
      {open ? (
        <span
          className="absolute left-0 top-6 z-30 w-[17rem] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2.5 py-2 text-[var(--color-text-secondary)] shadow-[0_8px_30px_var(--color-shadow-menu)]"
          id={panelId}
          role="status"
        >
          <span className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-status-attention)]">
              {summary.label}
            </span>
            <span className="font-mono text-[var(--color-text-primary)]">
              {formatWakeCountdown(summary.dueAt, nowMs)}
            </span>
          </span>
          {summary.intervalMs ? (
            <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              every {formatIntervalDuration(summary.intervalMs)}
            </span>
          ) : null}
          {summary.dailyAt ? (
            <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              daily {summary.dailyAt.join(", ")}
            </span>
          ) : null}
          {summary.stopCondition ? (
            <span className="mt-1 block min-w-0 truncate text-[var(--color-text-secondary)]">
              until {summary.stopCondition}
            </span>
          ) : null}
          <span className="mt-1 block min-w-0 truncate text-[var(--color-text-tertiary)]">
            {summary.message}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function RunningSidecarIndicator({
  sidecars,
  open,
  sessionId,
  onToggle,
}: {
  sidecars: DashboardRunningSidecar[];
  open: boolean;
  sessionId: string;
  onToggle: () => void;
}) {
  if (sidecars.length === 0) return null;

  const panelId = `sidecars-${sessionId}`;
  const label = `Running sidecars for ${sessionId}`;

  return (
    <span className="relative inline-flex shrink-0">
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-label={label}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center border border-[var(--color-border-subtle)] text-[var(--color-status-ready)] transition hover:border-[var(--color-status-ready)] hover:bg-[var(--color-hover-overlay)]"
        onClick={onToggle}
        title={label}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <path d="M9.5 7.5h-1.5a4.5 4.5 0 0 0 0 9h1.5" />
          <path d="M14.5 7.5h1.5a4.5 4.5 0 0 1 0 9h-1.5" />
          <path d="M8.5 12h7" />
        </svg>
      </button>
      {open ? (
        <span
          className="absolute left-0 top-6 z-30 w-[14rem] border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-2.5 py-2 text-[var(--color-text-secondary)]"
          id={panelId}
          role="status"
        >
          <span className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-status-ready)]">
            Running Sidecars
          </span>
          <span className="mt-1 flex min-w-0 flex-col gap-1 font-mono text-[var(--color-text-primary)]">
            {sidecars.map((sidecar) =>
              sidecar.url ? (
                <a
                  className="min-w-0 break-all text-[var(--color-status-ready)] underline-offset-2 hover:underline"
                  href={sidecar.url}
                  key={sidecar.name}
                  rel="noreferrer"
                  target="_blank"
                  title={sidecar.url}
                >
                  {sidecar.name}
                </a>
              ) : (
                <span className="min-w-0 break-all" key={sidecar.name}>
                  {sidecar.name}
                </span>
              ),
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}

interface SessionRowProps {
  projectFilterId?: string;
  deskMemberCount?: number;
  session: DashboardSession;
  onOpenTerminal?: (session: DashboardSession) => void;
  onCompleteSession: (session: DashboardSession) => Promise<void>;
  onRestoreSession: (session: DashboardSession) => Promise<void>;
}

export function SessionRow({
  projectFilterId,
  deskMemberCount,
  session,
  onOpenTerminal,
  onCompleteSession,
  onRestoreSession,
}: SessionRowProps) {
  const title = getSessionTitle(session);
  const canAttach =
    session.runtimeAlive && !isTerminalSession(session) && Boolean(session.tmuxSession);
  const attentionLevel = getAttentionLevel(session);
  const showRestore =
    (attentionLevel === "stopped" || attentionLevel === "error") && isRestorable(session);

  const prLink = session.links.find((l) => isReviewLinkLabel(l.label));
  const trackerLink = session.links.find((l) => l.label === "tracker");
  const prInfo = useSessionLinkPrInfo(prLink);
  const reviewProvider = prLink ? reviewProviderFromUrl(prLink.url) : null;
  const [mergedAfterMerge, setMergedAfterMerge] = useState(false);
  const showDone = (prInfo.state === "merged" || mergedAfterMerge) && canComplete(session);
  const showMerge =
    reviewProvider === "github" && Boolean(prLink) && prInfo.canMerge && !mergedAfterMerge;
  const hasWake = Boolean(session.scheduledWake || session.intervalWake || session.dailyWake);
  const [completing, setCompleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [activePopover, setActivePopover] = useState<ActiveRowPopover>(null);

  const togglePopover = (popover: Exclude<ActiveRowPopover, null>) => {
    setActivePopover((current) => (current === popover ? null : popover));
  };

  return (
    <DataRow>
      <span className="hidden w-[7rem] shrink-0 truncate font-semibold uppercase text-[var(--color-text-primary)] sm:inline">
        {session.projectName}
      </span>

      <span className="hidden w-[3.5rem] shrink-0 text-[var(--color-text-tertiary)] md:inline">
        {session.agent}
      </span>

      {deskMemberCount !== undefined && deskMemberCount > 1 ? (
        <span
          className="hidden shrink-0 items-center gap-0.5 rounded border border-[var(--color-border-subtle)] px-1 py-0.5 font-mono text-[10px] tabular-nums leading-none text-[var(--color-text-tertiary)] sm:inline-flex"
          title={`${deskMemberCount} agents on this checkout`}
        >
          <svg
            aria-hidden="true"
            className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <rect height="14" rx="1" width="14" x="8" y="8" />
            <rect height="14" opacity="0.55" rx="1" width="14" x="3" y="3" />
          </svg>
          {deskMemberCount}
        </span>
      ) : null}

      {hasWake ? (
        <WakeIndicator
          open={activePopover === "wake"}
          session={session}
          onToggle={() => togglePopover("wake")}
        />
      ) : null}

      <RunningSidecarIndicator
        open={activePopover === "sidecars"}
        sessionId={session.id}
        sidecars={session.runningSidecars}
        onToggle={() => togglePopover("sidecars")}
      />

      {session.hasUnseenAttention ? <UnseenAttentionIcon state={session.state} /> : null}

      <Link
        className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
        href={buildSessionPath(session.id, projectFilterId)}
      >
        {title}
      </Link>

      <TagEditor session={session} variant="dots" />

      {trackerLink ? (
        <span className="hidden sm:inline-flex">
          <SessionLinkBadge link={trackerLink} />
        </span>
      ) : null}

      {prLink ? (
        <span className="hidden sm:inline-flex">
          <SessionLinkBadge link={prLink} prInfo={prInfo} />
        </span>
      ) : null}

      <span className="hidden w-[8rem] shrink-0 truncate text-right font-mono text-[var(--color-text-secondary)] lg:inline">
        {session.branch}
      </span>

      <span className="w-[4rem] shrink-0 text-right text-[var(--color-text-tertiary)]">
        {formatRelativeTime(session.lastActivityAt)}
      </span>

      {showDone ? (
        <RowIconButton
          label={`Mark ${session.id} as done`}
          disabled={completing}
          activeClass="border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:border-[var(--color-status-ready)] hover:text-[var(--color-status-ready)]"
          onClick={async () => {
            if (completing) return;
            setCompleting(true);
            try {
              await onCompleteSession(session);
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
        </RowIconButton>
      ) : showMerge ? (
        <RowIconButton
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
        </RowIconButton>
      ) : showRestore ? (
        <RowIconButton
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
        </RowIconButton>
      ) : (
        <RowIconButton
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
        </RowIconButton>
      )}
    </DataRow>
  );
}
