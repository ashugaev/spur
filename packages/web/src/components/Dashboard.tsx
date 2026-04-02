"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AttentionZone } from "@/components/AttentionZone";
import { EmptyState } from "@/components/EmptyState";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import {
  getAttentionLevel,
  toDashboardSession,
  type AttentionLevel,
  type DashboardSession,
  type ProjectInfo,
  type SpurSessionView,
  type SpurSessionsResponse,
} from "@/lib/types";

const POLL_INTERVAL_MS = 5_000;
const LANE_ORDER: AttentionLevel[] = ["respond", "review", "pending", "working", "done"];

function deriveProjects(sessions: SpurSessionView[]): ProjectInfo[] {
  return Array.from(new Set(sessions.map((session) => session.project)))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
    .map((id) => ({ id, name: id }));
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "respond" | "review" | "pending" | "working";
}) {
  return (
    <div
      className={cn(
        "rounded-3xl border px-4 py-4",
        tone === "respond" && "border-red-500/25 bg-red-500/[0.08]",
        tone === "review" && "border-orange-400/25 bg-orange-400/[0.08]",
        tone === "pending" && "border-amber-400/25 bg-amber-400/[0.08]",
        tone === "working" && "border-sky-400/25 bg-sky-400/[0.08]",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

export function Dashboard() {
  const searchParams = useSearchParams();
  const requestedProject = searchParams.get("project")?.trim() ?? "";
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [rawSessions, setRawSessions] = useState<SpurSessionView[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState(requestedProject);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<"claude" | "codex">("claude");
  const [spawning, setSpawning] = useState(false);
  const [expandedLevel, setExpandedLevel] = useState<AttentionLevel | null>(null);

  const fetchSessions = useCallback(async (selectedProject: string, silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const query = selectedProject ? `?project=${encodeURIComponent(selectedProject)}` : "";
      const response = await fetch(`/api/sessions${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as SpurSessionsResponse;
      setRawSessions(payload.sessions);
      setProjects(
        payload.projects && payload.projects.length > 0
          ? payload.projects
          : deriveProjects(payload.sessions),
      );
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Spur sessions");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setProjectId(requestedProject);
  }, [requestedProject]);

  useEffect(() => {
    let cancelled = false;

    const run = async (silent = false) => {
      if (cancelled) return;
      await fetchSessions(projectId, silent);
    };

    void run(false);
    const timer = setInterval(() => {
      void run(true);
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchSessions, projectId]);

  const projectOptions = useMemo(() => {
    const source = projects.length > 0 ? projects : deriveProjects(rawSessions);
    return [...source].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }, [projects, rawSessions]);

  const projectNameMap = useMemo(
    () => new Map(projectOptions.map((project) => [project.id, project.name])),
    [projectOptions],
  );

  const sessions = useMemo(
    () =>
      rawSessions.map((session) =>
        toDashboardSession(session, projectNameMap.get(session.project)),
      ),
    [projectNameMap, rawSessions],
  );

  const grouped = useMemo(() => {
    const lanes: Record<AttentionLevel, DashboardSession[]> = {
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };

    for (const session of sessions) {
      lanes[getAttentionLevel(session)].push(session);
    }

    return lanes;
  }, [sessions]);

  const stats = useMemo(
    () => ({
      respond: grouped.respond.length,
      review: grouped.review.length,
      pending: grouped.pending.length,
      working: grouped.working.length,
      total: sessions.length,
    }),
    [grouped, sessions.length],
  );

  const activeProjectName = projectId
    ? (projectOptions.find((project) => project.id === projectId)?.name ?? projectId)
    : "All projects";

  useEffect(() => {
    if (spawnProjectId) return;
    setSpawnProjectId(projectId || projectOptions[0]?.id || "");
  }, [projectId, projectOptions, spawnProjectId]);

  useEffect(() => {
    if (!isMobile) return;
    setExpandedLevel((current) => {
      if (current && grouped[current].length > 0) return current;
      return LANE_ORDER.find((level) => grouped[level].length > 0) ?? null;
    });
  }, [grouped, isMobile]);

  const syncProjectFilter = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (nextProjectId) {
      params.set("project", nextProjectId);
    } else {
      params.delete("project");
    }

    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  };

  const reloadCurrentProject = async () => {
    await fetchSessions(projectId, true);
  };

  const handleSpawn = async () => {
    const nextProjectId = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProjectId || !nextPrompt) return;

    setSpawning(true);
    try {
      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: nextProjectId,
          prompt: nextPrompt,
          agent: spawnAgent,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      setSpawnPrompt("");
      syncProjectFilter(nextProjectId);
      setSpawnProjectId(nextProjectId);
      await fetchSessions(nextProjectId, true);
    } catch (spawnError) {
      setError(spawnError instanceof Error ? spawnError.message : "Failed to spawn Spur session");
    } finally {
      setSpawning(false);
    }
  };

  const postAction = async (
    sessionId: string,
    action: "send" | "pause" | "restore" | "complete" | "kill",
    body?: Record<string, unknown>,
  ) => {
    if (
      action === "kill" &&
      !window.confirm(`Kill session ${sessionId}? This forces cleanup even with local changes.`)
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const message = await response.text();
        setError(message || `Failed to ${action} session`);
        throw new Error(message || `Failed to ${action} session`);
      }

      await reloadCurrentProject();
      setError(null);
    } catch (actionError) {
      const message =
        actionError instanceof Error ? actionError.message : `Failed to ${action} session`;
      setError(message);
      throw actionError;
    }
  };

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">
      <section className="relative overflow-hidden rounded-[2rem] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.32)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(88,166,255,0.16),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(163,113,247,0.12),transparent_38%)]" />

        <div className="relative">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-black/10 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-secondary)]">
                <span className="text-sm text-[var(--color-accent)]">𖤓</span>
                Spur UI
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-4xl">
                {activeProjectName}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-secondary)] sm:text-[15px]">
                Latest dashboard direction from the parent UI, narrowed to a single Spur-only path:
                one web client, one set of session actions, one `v2` API backend.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Needs Input" tone="respond" value={stats.respond} />
              <StatCard label="Needs Review" tone="review" value={stats.review} />
              <StatCard label="Pending" tone="pending" value={stats.pending} />
              <StatCard label="Working" tone="working" value={stats.working} />
            </div>
          </div>

          <div className="mt-6 grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
            <section className="rounded-3xl border border-[var(--color-border-default)] bg-black/10 p-4">
              <label className="block text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                Project filter
              </label>
              <select
                className="mt-3 w-full rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                onChange={(event) => {
                  syncProjectFilter(event.target.value);
                }}
                value={projectId}
              >
                <option value="">All projects</option>
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>

              <div className="mt-4 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                  Visible sessions
                </div>
                <div className="mt-2 text-2xl font-semibold text-[var(--color-text-primary)]">
                  {stats.total}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                  Filtering is local to the Spur dashboard and only calls the current `v2` daemon
                  routes.
                </p>
              </div>
            </section>

            <section className="rounded-3xl border border-[var(--color-border-default)] bg-black/10 p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
                    Spawn session
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                    Launch a new Spur worktree session directly from the UI.
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-[minmax(12rem,15rem)_minmax(10rem,12rem)_1fr_auto]">
                <select
                  className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnProjectId(event.target.value)}
                  value={spawnProjectId}
                >
                  <option value="">Select project</option>
                  {projectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>

                <select
                  className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnAgent(event.target.value as "claude" | "codex")}
                  value={spawnAgent}
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>

                <input
                  className="rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-3 text-sm text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnPrompt(event.target.value)}
                  placeholder="Prompt for the new session"
                  value={spawnPrompt}
                />

                <button
                  className="rounded-2xl bg-[var(--color-accent)] px-5 py-3 text-sm font-semibold text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={spawning || !spawnProjectId.trim() || !spawnPrompt.trim()}
                  onClick={() => void handleSpawn()}
                  type="button"
                >
                  {spawning ? "Spawning..." : "Spawn"}
                </button>
              </div>
            </section>
          </div>
        </div>
      </section>

      {error ? (
        <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/[0.08] px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-5 text-sm text-[var(--color-text-secondary)]">Loading sessions...</p>
      ) : null}

      {!loading && sessions.length === 0 ? (
        <section className="mt-6">
          <EmptyState
            message={
              projectId
                ? `No sessions are visible for ${activeProjectName}. Spawn one from the panel above or clear the filter.`
                : undefined
            }
          />
        </section>
      ) : null}

      {!loading && sessions.length > 0 ? (
        isMobile ? (
          <section className="mt-6 space-y-4">
            {LANE_ORDER.map((level) => (
              <AttentionZone
                key={level}
                collapsed={expandedLevel !== level}
                level={level}
                onComplete={(sessionId) => postAction(sessionId, "complete")}
                onKill={(sessionId) => postAction(sessionId, "kill", { force: true })}
                onPause={(sessionId) => postAction(sessionId, "pause")}
                onRestore={(sessionId) => postAction(sessionId, "restore")}
                onSend={(sessionId, message) => postAction(sessionId, "send", { message })}
                onToggle={(nextLevel) =>
                  setExpandedLevel((current) => (current === nextLevel ? null : nextLevel))
                }
                sessions={grouped[level]}
              />
            ))}
          </section>
        ) : (
          <section className="mt-6 grid gap-4 xl:grid-cols-5">
            {LANE_ORDER.map((level) => (
              <AttentionZone
                key={level}
                level={level}
                onComplete={(sessionId) => postAction(sessionId, "complete")}
                onKill={(sessionId) => postAction(sessionId, "kill", { force: true })}
                onPause={(sessionId) => postAction(sessionId, "pause")}
                onRestore={(sessionId) => postAction(sessionId, "restore")}
                onSend={(sessionId, message) => postAction(sessionId, "send", { message })}
                sessions={grouped[level]}
              />
            ))}
          </section>
        )
      ) : null}
    </main>
  );
}
