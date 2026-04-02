"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { SpurSessionView, SpurSessionsResponse } from "@/lib/spur-types";
import { buildSessionPath } from "@/lib/project-routes";
import { formatRelativeTime } from "@/lib/time";

const POLL_INTERVAL_MS = 5_000;

export function Dashboard() {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<SpurSessionView[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; label: string }>>([]);
  const [projectId, setProjectId] = useState(() => searchParams.get("projectId")?.trim() ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<"claude" | "codex">("claude");
  const [spawning, setSpawning] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const loadSessions = async (activeProjectId?: string) => {
    const selectedProject = activeProjectId ?? projectId;
    const query = selectedProject ? `?projectId=${encodeURIComponent(selectedProject)}` : "";
    try {
      const response = await fetch(`/api/sessions${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionsResponse;
      setSessions(payload.sessions);
      setProjects(payload.projects ?? []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Spur sessions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSessions(projectId);
    const timer = setInterval(() => {
      void loadSessions(projectId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [projectId]);

  const projectOptions = useMemo(() => {
    if (projects.length > 0) {
      return [...projects].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    }
    return Array.from(new Set(sessions.map((session) => session.project)))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map((id) => ({ id, label: id }));
  }, [projects, sessions]);

  const groupedSessions = useMemo(() => {
    return {
      needsInput: sessions.filter((session) => session.status === "errored" || session.state === "needs_input"),
      active: sessions.filter(
        (session) => session.status === "running" && (session.state === "working" || session.state === "waiting"),
      ),
      paused: sessions.filter((session) => session.status === "paused"),
      done: sessions.filter((session) => session.status === "completed" || session.status === "killed"),
    };
  }, [sessions]);

  useEffect(() => {
    if (!spawnProjectId) {
      setSpawnProjectId(projectId || projectOptions[0]?.id || "");
    }
  }, [projectId, projectOptions, spawnProjectId]);

  const handleSpawn = async () => {
    const nextProject = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProject || !nextPrompt) return;

    setSpawning(true);
    try {
      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: nextProject,
          prompt: nextPrompt,
          agent: spawnAgent,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      setSpawnPrompt("");
      await loadSessions(nextProject);
      setProjectId(nextProject);
    } catch (spawnError) {
      setError(spawnError instanceof Error ? spawnError.message : "Failed to spawn Spur session");
    } finally {
      setSpawning(false);
    }
  };

  const handleAction = async (sessionId: string, action: "stop" | "kill" | "restore" | "complete") => {
    try {
      if (
        action === "kill" &&
        !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
      ) {
        return;
      }
      if (action === "complete") {
        setCompletingId(sessionId);
      }
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers: action === "kill" ? { "content-type": "application/json" } : undefined,
        body: action === "kill" ? JSON.stringify({ force: true }) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      await loadSessions(projectId);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : `Failed to ${action} session`);
    } finally {
      if (action === "complete") {
        setCompletingId(null);
      }
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Spur Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            UI-only view on top of the Spur daemon.
          </p>
        </div>
        <div className="min-w-[220px]">
          <label className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Project filter
          </label>
          <select
            className="w-full rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            <option value="">All projects</option>
            {projectOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <section className="mb-8 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Spawn Session
        </h2>
        <div className="grid gap-3 md:grid-cols-[minmax(180px,220px)_minmax(180px,220px)_1fr_auto]">
          <select
            className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm"
            value={spawnProjectId}
            onChange={(event) => setSpawnProjectId(event.target.value)}
          >
            <option value="">Select project</option>
            {projectOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm"
            value={spawnAgent}
            onChange={(event) => setSpawnAgent(event.target.value as "claude" | "codex")}
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          <input
            className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2 text-sm"
            placeholder="Prompt"
            value={spawnPrompt}
            onChange={(event) => setSpawnPrompt(event.target.value)}
          />
          <button
            className="rounded bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            disabled={spawning || !spawnProjectId.trim() || !spawnPrompt.trim()}
            onClick={() => void handleSpawn()}
          >
            {spawning ? "Spawning..." : "Spawn"}
          </button>
        </div>
      </section>

      {error ? (
        <p className="mb-4 rounded border border-red-600/50 bg-red-900/20 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-[var(--color-text-secondary)]">Loading sessions...</p> : null}

      <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Needs Input</div>
          <div className="mt-2 text-2xl font-semibold">{groupedSessions.needsInput.length}</div>
        </div>
        <div className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Active</div>
          <div className="mt-2 text-2xl font-semibold">{groupedSessions.active.length}</div>
        </div>
        <div className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Paused</div>
          <div className="mt-2 text-2xl font-semibold">{groupedSessions.paused.length}</div>
        </div>
        <div className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">Done</div>
          <div className="mt-2 text-2xl font-semibold">{groupedSessions.done.length}</div>
        </div>
      </section>

      <section className="grid gap-4">
        {sessions.map((session) => (
          <article
            key={session.id}
            className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <a className="font-mono text-sm text-[var(--color-accent)] hover:underline" href={buildSessionPath(session.id, session.project)}>
                {session.id}
              </a>
              <span className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-xs">
                {session.project}
              </span>
              <span className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-xs">
                {session.agent}
              </span>
              <span className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-xs">
                {session.status} / {session.state}
              </span>
            </div>
            <p className="mb-2 text-sm text-[var(--color-text-secondary)]">{session.prompt}</p>
            <div className="mb-3 text-xs text-[var(--color-text-tertiary)]">
              <span>branch: {session.branch}</span>
              <span className="mx-2">•</span>
              <span>last activity: {formatRelativeTime(session.lastActivityAt)}</span>
            </div>
            {session.slots?.links?.length ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {session.slots.links.map((link) => (
                  <a
                    key={`${session.id}-${link.label}`}
                    className="rounded border border-[var(--color-border-default)] px-2 py-1 text-xs text-[var(--color-accent)] hover:no-underline"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            ) : null}
            {session.services.length ? (
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-[var(--color-text-secondary)]">
                {session.services.map((service) => (
                  <span
                    key={`${session.id}-${service.serviceId}`}
                    className="rounded border border-[var(--color-border-default)] px-2 py-1"
                  >
                    {service.serviceId}: {service.state}
                    {typeof service.port === "number" ? ` :${service.port}` : ""}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
                onClick={() => void handleAction(session.id, "stop")}
              >
                Pause
              </button>
              <button
                className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
                onClick={() => void handleAction(session.id, "restore")}
              >
                Restore
              </button>
              <button
                className="rounded border border-[var(--color-border-default)] px-3 py-1.5 text-xs"
                disabled={completingId === session.id}
                onClick={() => void handleAction(session.id, "complete")}
              >
                {completingId === session.id ? "Completing..." : "Complete"}
              </button>
              <button
                className="rounded border border-red-700/70 px-3 py-1.5 text-xs text-red-300"
                onClick={() => void handleAction(session.id, "kill")}
              >
                Kill
              </button>
            </div>
          </article>
        ))}
        {!loading && sessions.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">No sessions found.</p>
        ) : null}
      </section>
    </main>
  );
}
