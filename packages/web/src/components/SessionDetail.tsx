"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityDot } from "@/components/ActivityDot";
import { cn } from "@/lib/cn";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  getSessionSubtitle,
  getSessionTitle,
  truncateMiddle,
} from "@/lib/format";
import { buildDashboardPath } from "@/lib/project-routes";
import {
  canComplete,
  canPause,
  canSendMessage,
  hasServiceProblems,
  isRestorable,
  isTerminalSession,
  toDashboardSession,
  type DashboardSession,
  type SpurSessionView,
} from "@/lib/types";

const POLL_INTERVAL_MS = 4_000;

interface SessionDetailProps {
  sessionId: string;
  projectId?: string;
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-sm border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.26)]">
      <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

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
        "rounded-sm border px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger"
          ? "border-red-500/40 text-red-200 hover:bg-red-500/10"
          : "border-[var(--color-border-default)] text-[var(--color-text-primary)] hover:bg-white/5",
      )}
    >
      {children}
    </button>
  );
}

export function SessionDetail({ sessionId, projectId }: SessionDetailProps) {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionView;
      const nextSession = toDashboardSession(payload);
      setSession(nextSession);
      setError(null);
      document.title = `${nextSession.id} | Spur`;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load session");
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSession();
    const timer = setInterval(() => {
      void loadSession();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadSession]);

  const handleAction = async (
    action: "send" | "pause" | "restore" | "complete" | "kill",
    body?: Record<string, unknown>,
  ) => {
    if (
      action === "kill" &&
      !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
    ) {
      return;
    }

    setBusyAction(action);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      if (action === "send") {
        setMessage("");
      }
      await loadSession();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Failed to ${action} session`);
    } finally {
      setBusyAction(null);
    }
  };

  const title = useMemo(
    () => (session ? getSessionTitle(session) : sessionId),
    [session, sessionId],
  );
  const subtitle = useMemo(() => (session ? getSessionSubtitle(session) : null), [session]);
  const effectiveProjectId = projectId ?? session?.projectId ?? "";

  return (
    <main className="mx-auto max-w-6xl px-4 py-5 sm:px-6 lg:px-8">
      <a
        className="inline-flex items-center gap-2 text-sm text-[var(--color-accent)] hover:no-underline"
        href={buildDashboardPath(effectiveProjectId)}
      >
        <span aria-hidden="true">←</span>
        Back to dashboard
      </a>

      {error ? (
        <div className="mt-5 rounded-sm border border-red-500/30 bg-red-500/[0.08] px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      {session ? (
        <>
          <header className="relative mt-5 overflow-hidden rounded-sm border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.32)]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(88,166,255,0.14),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(163,113,247,0.1),transparent_38%)]" />

            <div className="relative">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                <span>{session.projectName}</span>
                <span>•</span>
                <span>{session.agent}</span>
                <span>•</span>
                <span className="font-mono">{session.id}</span>
              </div>

              <h1 className="text-3xl font-semibold tracking-[-0.04em] text-[var(--color-text-primary)]">
                {title}
              </h1>
              {subtitle ? (
                <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-secondary)]">
                  {subtitle}
                </p>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <ActivityDot activity={session.state} />
                <span className="rounded-sm border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                  status: {session.status}
                </span>
                {session.branch ? (
                  <span className="rounded-sm border border-[var(--color-border-default)] px-2.5 py-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
                    {session.branch}
                  </span>
                ) : null}
                {!session.runtimeAlive && !isTerminalSession(session) ? (
                  <span className="rounded-sm border border-red-500/30 px-2.5 py-1 text-[11px] text-red-200">
                    agent offline
                  </span>
                ) : null}
                {hasServiceProblems(session) ? (
                  <span className="rounded-sm border border-orange-400/30 px-2.5 py-1 text-[11px] text-orange-200">
                    service issues detected
                  </span>
                ) : null}
              </div>
            </div>
          </header>

          <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            <div className="space-y-4">
              <DetailCard title="Message">
                {canSendMessage(session) ? (
                  <div className="space-y-3">
                    <textarea
                      className="min-h-32 w-full rounded-sm border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)]"
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Message to the running agent"
                      value={message}
                    />
                    <div className="flex justify-end">
                      <ActionButton
                        disabled={busyAction !== null || !message.trim()}
                        onClick={() => void handleAction("send", { message: message.trim() })}
                      >
                        {busyAction === "send" ? "Sending..." : "Send"}
                      </ActionButton>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                    This session is not currently accepting input. Restore it first if you want to
                    continue the same worktree.
                  </p>
                )}
              </DetailCard>

              {session.links.length > 0 ? (
                <DetailCard title="Links">
                  <div className="flex flex-wrap gap-2">
                    {session.links.map((link) => (
                      <a
                        key={`${session.id}-${link.label}-${link.url}`}
                        className="rounded-sm border border-[var(--color-border-default)] px-3 py-1.5 text-sm text-[var(--color-accent)] hover:no-underline"
                        href={link.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                </DetailCard>
              ) : null}

              <DetailCard title="Services">
                {session.services.length > 0 ? (
                  <div className="space-y-3">
                    {session.services.map((service) => (
                      <article
                        key={`${session.id}-${service.serviceId}`}
                        className="rounded-sm border border-[var(--color-border-default)] bg-black/10 p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="font-mono text-sm text-[var(--color-text-primary)]">
                              {service.serviceId}
                            </div>
                            <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                              {service.command}
                            </div>
                          </div>
                          <div className="rounded-sm border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">
                            {service.state}
                            {typeof service.port === "number" ? ` • :${service.port}` : ""}
                          </div>
                        </div>
                        <div className="mt-3 text-xs text-[var(--color-text-tertiary)]">
                          cwd: {truncateMiddle(service.cwd)}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                    No auxiliary services are registered for this session.
                  </p>
                )}
              </DetailCard>
            </div>

            <div className="space-y-4">
              <DetailCard title="Actions">
                <div className="flex flex-wrap gap-2">
                  {canPause(session) ? (
                    <ActionButton
                      disabled={busyAction !== null}
                      onClick={() => void handleAction("pause")}
                    >
                      {busyAction === "pause" ? "Pausing..." : "Pause"}
                    </ActionButton>
                  ) : null}
                  {isRestorable(session) ? (
                    <ActionButton
                      disabled={busyAction !== null}
                      onClick={() => void handleAction("restore")}
                    >
                      {busyAction === "restore" ? "Restoring..." : "Restore"}
                    </ActionButton>
                  ) : null}
                  {canComplete(session) ? (
                    <ActionButton
                      disabled={busyAction !== null}
                      onClick={() => void handleAction("complete")}
                    >
                      {busyAction === "complete" ? "Completing..." : "Complete"}
                    </ActionButton>
                  ) : null}
                  {!isTerminalSession(session) ? (
                    <ActionButton
                      disabled={busyAction !== null}
                      onClick={() => void handleAction("kill", { force: true })}
                      tone="danger"
                    >
                      {busyAction === "kill" ? "Killing..." : "Kill"}
                    </ActionButton>
                  ) : null}
                </div>
              </DetailCard>

              <DetailCard title="Runtime">
                <dl className="space-y-3 text-sm text-[var(--color-text-secondary)]">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-text-tertiary)]">Created</dt>
                    <dd>{formatAbsoluteTime(session.createdAt)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-text-tertiary)]">Last activity</dt>
                    <dd>{formatRelativeTime(session.lastActivityAt)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-text-tertiary)]">Worktree</dt>
                    <dd>{session.worktree ? "isolated" : "shared"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-text-tertiary)]">Agent runtime</dt>
                    <dd>{session.runtimeAlive ? "alive" : "offline"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-[var(--color-text-tertiary)]">Workspace</dt>
                    <dd>{session.workspaceExists ? "present" : "missing"}</dd>
                  </div>
                </dl>

                <div className="mt-4 rounded-sm border border-[var(--color-border-default)] bg-black/10 px-3 py-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Worktree path
                  </div>
                  <div className="mt-2 font-mono text-xs text-[var(--color-text-secondary)]">
                    {truncateMiddle(session.worktreePath, 96)}
                  </div>
                </div>

                {session.error ? (
                  <div className="mt-4 rounded-sm border border-red-500/30 bg-red-500/[0.08] px-3 py-3 text-sm text-red-100">
                    {session.error}
                  </div>
                ) : null}
              </DetailCard>
            </div>
          </section>
        </>
      ) : (
        <p className="mt-5 text-sm text-[var(--color-text-secondary)]">Loading session...</p>
      )}
    </main>
  );
}
