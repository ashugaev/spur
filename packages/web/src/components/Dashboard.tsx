"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AttentionZone } from "@/components/AttentionZone";
import { EmptyState } from "@/components/EmptyState";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
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
        "rounded-2xl border px-3 py-3",
        tone === "respond" && "border-red-500/25 bg-red-500/[0.06]",
        tone === "review" && "border-orange-400/25 bg-orange-400/[0.06]",
        tone === "pending" && "border-amber-400/25 bg-amber-400/[0.06]",
        tone === "working" && "border-sky-400/25 bg-sky-400/[0.06]",
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1.5 text-xl font-semibold text-[var(--color-text-primary)]">{value}</div>
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
  const [attachingSessionId, setAttachingSessionId] = useState<string | null>(null);
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
      setError(null);
    } catch (spawnError) {
      setError(spawnError instanceof Error ? spawnError.message : "Failed to spawn Spur session");
    } finally {
      setSpawning(false);
    }
  };

  const openTerminal = async (sessionId: string) => {
    setAttachingSessionId(sessionId);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {
        method: "POST",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || "Failed to open session terminal");
      }
      setError(null);
    } catch (attachError) {
      setError(
        attachError instanceof Error ? attachError.message : "Failed to open session terminal",
      );
    } finally {
      setAttachingSessionId((current) => (current === sessionId ? null : current));
    }
  };

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
      <section className="relative overflow-hidden rounded-[1.75rem] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)] sm:p-5">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(88,166,255,0.12),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(163,113,247,0.08),transparent_34%)]" />

        <div className="relative">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-black/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">
                <span className="text-sm text-[var(--color-accent)]">𖤓</span>
                Spur UI
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[var(--color-text-primary)] sm:text-3xl">
                {activeProjectName}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-secondary)]">
                Compact board for the current Spur v2 daemon.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Needs Input" tone="respond" value={stats.respond} />
              <StatCard label="Needs Review" tone="review" value={stats.review} />
              <StatCard label="Pending" tone="pending" value={stats.pending} />
              <StatCard label="Working" tone="working" value={stats.working} />
            </div>
          </div>

          <div className="mt-4 grid gap-3 xl:grid-cols-[16rem_minmax(0,1fr)]">
            <section className="rounded-2xl border border-[var(--color-border-default)] bg-black/10 p-3">
              <label className="block text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Project filter
              </label>
              <select
                className="mt-2.5 w-full rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
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

              <div className="mt-3 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  Visible sessions
                </div>
                <div className="mt-1.5 text-xl font-semibold text-[var(--color-text-primary)]">
                  {stats.total}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-[var(--color-border-default)] bg-black/10 p-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                Spawn session
              </div>

              <div className="mt-3 grid gap-2.5 md:grid-cols-[minmax(11rem,14rem)_minmax(9rem,11rem)_1fr_auto]">
                <select
                  className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
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
                  className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnAgent(event.target.value as "claude" | "codex")}
                  value={spawnAgent}
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>

                <input
                  className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnPrompt(event.target.value)}
                  placeholder="Prompt for the new session"
                  value={spawnPrompt}
                />

                <button
                  className="rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
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
        <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/[0.08] px-3 py-2.5 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 text-sm text-[var(--color-text-secondary)]">Loading sessions...</p>
      ) : null}

      {!loading && sessions.length === 0 ? (
        <section className="mt-5">
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
          <section className="mt-5 space-y-3">
            {LANE_ORDER.map((level) => (
              <AttentionZone
                key={level}
                attachingSessionId={attachingSessionId}
                collapsed={expandedLevel !== level}
                level={level}
                onAttach={openTerminal}
                onToggle={(nextLevel) =>
                  setExpandedLevel((current) => (current === nextLevel ? null : nextLevel))
                }
                sessions={grouped[level]}
              />
            ))}
          </section>
        ) : (
          <section className="mt-5 grid gap-3 xl:grid-cols-5">
            {LANE_ORDER.map((level) => (
              <AttentionZone
                key={level}
                attachingSessionId={attachingSessionId}
                level={level}
                onAttach={openTerminal}
                sessions={grouped[level]}
              />
            ))}
          </section>
        )
      ) : null}
    </main>
  );
}
