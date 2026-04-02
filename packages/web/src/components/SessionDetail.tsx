"use client";

import { useEffect, useState } from "react";
import type { SpurSessionView } from "@/lib/spur-types";
import { buildProjectPath } from "@/lib/project-routes";
import { formatRelativeTime } from "@/lib/time";

const POLL_INTERVAL_MS = 4_000;

interface SessionDetailProps {
  sessionId: string;
  projectId: string;
}

export function SessionDetail({ sessionId, projectId }: SessionDetailProps) {
  const [session, setSession] = useState<SpurSessionView | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSession = async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionView;
      setSession(payload);
      setError(null);
      document.title = `${payload.id} | Spur Session`;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load session");
    }
  };

  useEffect(() => {
    void loadSession();
    const timer = setInterval(() => {
      void loadSession();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionId]);

  const postAction = async (action: "send" | "stop" | "restore" | "kill" | "complete") => {
    setBusy(true);
    try {
      if (
        action === "kill" &&
        !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
      ) {
        setBusy(false);
        return;
      }
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers:
          action === "send" || action === "kill" ? { "content-type": "application/json" } : undefined,
        body:
          action === "send"
            ? JSON.stringify({ message: message.trim() })
            : action === "kill"
              ? JSON.stringify({ force: true })
              : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      if (action === "send") setMessage("");
      await loadSession();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Failed to ${action} session`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <a href={buildProjectPath(projectId)} className="text-sm text-[var(--color-accent)] hover:underline">
        Back to project sessions
      </a>

      {error ? (
        <p className="mt-4 rounded border border-red-600/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {session ? (
        <section className="mt-4 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-5">
          <h1 className="font-mono text-xl">{session.id}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{session.prompt}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--color-text-tertiary)]">
            <span>project: {session.project}</span>
            <span>agent: {session.agent}</span>
            <span>status: {session.status}</span>
            <span>state: {session.state}</span>
            <span>branch: {session.branch}</span>
            <span>last activity: {formatRelativeTime(session.lastActivityAt)}</span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => void postAction("stop")}
            >
              Pause
            </button>
            <button
              className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => void postAction("restore")}
            >
              Restore
            </button>
            <button
              className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
              disabled={busy}
              onClick={() => void postAction("complete")}
            >
              Complete
            </button>
            <button
              className="rounded border border-red-700/70 px-3 py-1.5 text-xs text-red-300"
              disabled={busy}
              onClick={() => void postAction("kill")}
            >
              Kill
            </button>
          </div>

          <div className="mt-5 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-3">
            <label className="mb-2 block text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
              Send message
            </label>
            <div className="flex flex-col gap-2 md:flex-row">
              <input
                className="flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
                placeholder="Message to session"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
              <button
                className="rounded bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy || !message.trim()}
                onClick={() => void postAction("send")}
              >
                Send
              </button>
            </div>
          </div>

          {session.slots?.links?.length ? (
            <div className="mt-5">
              <h2 className="mb-2 text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
                Links
              </h2>
              <div className="flex flex-wrap gap-2">
                {session.slots.links.map((link) => (
                  <a
                    key={`${session.id}-${link.label}`}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs text-[var(--color-accent)] hover:no-underline"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          ) : null}

          {session.services.length ? (
            <div className="mt-5">
              <h2 className="mb-2 text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
                Services
              </h2>
              <div className="space-y-2">
                {session.services.map((service) => (
                  <div
                    key={`${session.id}-${service.serviceId}`}
                    className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm"
                  >
                    <div className="font-mono text-xs">{service.serviceId}</div>
                    <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      {service.command}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                      {service.state}
                      {typeof service.port === "number" ? ` • :${service.port}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="mt-4 text-sm text-[var(--color-text-secondary)]">Loading session...</p>
      )}
    </main>
  );
}
