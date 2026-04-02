"use client";

import { useState } from "react";
import { ActivityDot } from "@/components/ActivityDot";
import { cn } from "@/lib/cn";
import {
  formatRelativeTime,
  getSessionSubtitle,
  getSessionTitle,
  truncateMiddle,
} from "@/lib/format";
import { buildSessionPath } from "@/lib/project-routes";
import {
  canComplete,
  canPause,
  canSendMessage,
  getAttentionLevel,
  hasServiceProblems,
  isRestorable,
  isTerminalSession,
  type DashboardSession,
} from "@/lib/types";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => Promise<void>;
  onPause?: (sessionId: string) => Promise<void>;
  onRestore?: (sessionId: string) => Promise<void>;
  onComplete?: (sessionId: string) => Promise<void>;
  onKill?: (sessionId: string) => Promise<void>;
}

const toneClasses = {
  respond: "border-red-500/25 bg-red-500/[0.08]",
  review: "border-orange-400/25 bg-orange-400/[0.08]",
  pending: "border-amber-400/25 bg-amber-400/[0.08]",
  working: "border-sky-400/25 bg-sky-400/[0.08]",
  done: "border-white/10 bg-white/[0.04]",
} as const;

const toneLabels = {
  respond: "Needs input",
  review: "Needs review",
  pending: "Pending",
  working: "Working",
  done: "Done",
} as const;

function ActionButton({
  children,
  disabled,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger"
          ? "border-red-500/40 text-red-200 hover:bg-red-500/10"
          : "border-[var(--color-border-default)] text-[var(--color-text-primary)] hover:bg-white/5",
      )}
    >
      {children}
    </button>
  );
}

export function SessionCard({
  session,
  onSend,
  onPause,
  onRestore,
  onComplete,
  onKill,
}: SessionCardProps) {
  const [draft, setDraft] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const level = getAttentionLevel(session);
  const title = getSessionTitle(session);
  const subtitle = getSessionSubtitle(session);
  const serviceProblems = session.services.filter(
    (service) =>
      service.status === "errored" ||
      service.state === "problem" ||
      service.state === "error" ||
      !service.runtimeAlive,
  ).length;

  const handleAction = async (
    action: "pause" | "restore" | "complete" | "kill",
    handler?: (sessionId: string) => Promise<void>,
  ) => {
    if (!handler || busyAction || sendBusy) return;
    setBusyAction(action);
    try {
      await handler(session.id);
    } catch {
      return;
    } finally {
      setBusyAction(null);
    }
  };

  const handleSend = async () => {
    const message = draft.trim();
    if (!onSend || !message || sendBusy || busyAction) return;
    setSendBusy(true);
    try {
      await onSend(session.id, message);
      setDraft("");
    } catch {
      return;
    } finally {
      setSendBusy(false);
    }
  };

  return (
    <article
      className={cn(
        "session-card rounded-3xl border p-4 shadow-[0_20px_60px_rgba(0,0,0,0.28)]",
        toneClasses[level],
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
            <span>{session.projectName}</span>
            <span>•</span>
            <span>{session.agent}</span>
          </div>
          <a
            className="block text-base font-semibold leading-tight text-[var(--color-text-primary)] hover:no-underline"
            href={buildSessionPath(session.id, session.projectId)}
          >
            {title}
          </a>
          {subtitle ? (
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-[var(--color-text-secondary)]">
              {subtitle}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-primary)]">
            {toneLabels[level]}
          </span>
          <span className="font-mono text-[11px] text-[var(--color-text-tertiary)]">{session.id}</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ActivityDot activity={session.state} />
        <span className="rounded-full border border-[var(--color-border-default)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
          status: {session.status}
        </span>
        {session.branch ? (
          <span className="rounded-full border border-[var(--color-border-default)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
            {session.branch}
          </span>
        ) : null}
        {!session.runtimeAlive && !isTerminalSession(session) ? (
          <span className="rounded-full border border-red-500/30 px-2 py-1 text-[11px] text-red-200">
            agent offline
          </span>
        ) : null}
        {hasServiceProblems(session) ? (
          <span className="rounded-full border border-orange-400/30 px-2 py-1 text-[11px] text-orange-200">
            {serviceProblems} service issue{serviceProblems === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-2 text-sm text-[var(--color-text-secondary)]">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[var(--color-text-tertiary)]">Last activity</dt>
          <dd>{formatRelativeTime(session.lastActivityAt)}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-[var(--color-text-tertiary)]">Workspace</dt>
          <dd className="text-right font-mono text-[11px]">{truncateMiddle(session.worktreePath)}</dd>
        </div>
      </dl>

      {session.links.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {session.links.map((link) => (
            <a
              key={`${session.id}-${link.label}-${link.url}`}
              className="rounded-full border border-[var(--color-border-default)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:no-underline"
              href={link.url}
              rel="noreferrer"
              target="_blank"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}

      {canSendMessage(session) ? (
        <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-black/10 p-3">
          <label
            className="mb-2 block text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]"
            htmlFor={`reply-${session.id}`}
          >
            Send message
          </label>
          <div className="flex flex-col gap-2">
            <textarea
              id={`reply-${session.id}`}
              className="min-h-20 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Message to the running agent"
              value={draft}
            />
            <div className="flex justify-end">
              <ActionButton disabled={sendBusy || busyAction !== null || !draft.trim()} onClick={() => void handleSend()}>
                {sendBusy ? "Sending..." : "Send"}
              </ActionButton>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {canPause(session) ? (
          <ActionButton disabled={busyAction !== null || sendBusy} onClick={() => void handleAction("pause", onPause)}>
            {busyAction === "pause" ? "Pausing..." : "Pause"}
          </ActionButton>
        ) : null}
        {isRestorable(session) ? (
          <ActionButton
            disabled={busyAction !== null || sendBusy}
            onClick={() => void handleAction("restore", onRestore)}
          >
            {busyAction === "restore" ? "Restoring..." : "Restore"}
          </ActionButton>
        ) : null}
        {canComplete(session) ? (
          <ActionButton
            disabled={busyAction !== null || sendBusy}
            onClick={() => void handleAction("complete", onComplete)}
          >
            {busyAction === "complete" ? "Completing..." : "Complete"}
          </ActionButton>
        ) : null}
        {!isTerminalSession(session) ? (
          <ActionButton
            disabled={busyAction !== null || sendBusy}
            onClick={() => void handleAction("kill", onKill)}
            tone="danger"
          >
            {busyAction === "kill" ? "Killing..." : "Kill"}
          </ActionButton>
        ) : null}
      </div>
    </article>
  );
}
