"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AttentionZone } from "@/components/AttentionZone";
import { EmptyState } from "@/components/EmptyState";
import { TerminalModal } from "@/components/TerminalModal";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
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

function StatItem({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[var(--color-text-secondary)]">{label}:</span>
      <span
        className="font-bold text-[var(--color-text-primary)]"
        style={color ? { color } : undefined}
      >
        {value}
      </span>
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
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [expandedLevel, setExpandedLevel] = useState<AttentionLevel | null>(null);
  const [terminalSession, setTerminalSession] = useState<DashboardSession | null>(null);

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
      setProjects(payload.projects ?? []);
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

  const filterProjectOptions = useMemo(() => {
    const merged = new Map(projects.map((project) => [project.id, project]));
    for (const project of deriveProjects(rawSessions)) {
      if (!merged.has(project.id)) {
        merged.set(project.id, project);
      }
    }

    return [...merged.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  }, [projects, rawSessions]);

  const spawnProjectOptions = useMemo(
    () =>
      [...projects].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    [projects],
  );

  const projectNameMap = useMemo(
    () => new Map(filterProjectOptions.map((project) => [project.id, project.name])),
    [filterProjectOptions],
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
    ? (filterProjectOptions.find((project) => project.id === projectId)?.name ?? projectId)
    : "All projects";

  useEffect(() => {
    if (spawnProjectId && spawnProjectOptions.some((project) => project.id === spawnProjectId)) {
      return;
    }

    const nextProjectId =
      spawnProjectOptions.find((project) => project.id === projectId)?.id ??
      spawnProjectOptions[0]?.id ??
      "";

    if (nextProjectId !== spawnProjectId) {
      setSpawnProjectId(nextProjectId);
    }
  }, [projectId, spawnProjectId, spawnProjectOptions]);

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
      setSpawnOpen(false);
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

  const openTerminal = (session: DashboardSession) => {
    setTerminalSession(session);
    setError(null);
  };

  return (
    <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-5 lg:px-6">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg text-[var(--color-accent)]">𖤓</span>
          <h1 className="text-xl font-bold uppercase tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-2xl">
            {activeProjectName === "All projects" ? "Fleet Overview" : activeProjectName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 uppercase text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
            onChange={(event) => syncProjectFilter(event.target.value)}
            value={projectId}
          >
            <option value="">All projects</option>
            {filterProjectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
            onClick={() => setSpawnOpen(true)}
            type="button"
          >
            Spawn_New_Session
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 border-y border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-2 uppercase tracking-[0.06em] sm:gap-6 sm:px-2.5 sm:py-2.5">
        <StatItem label="Total" value={stats.total} />
        <StatItem
          label="Input"
          value={stats.respond}
          color={stats.respond > 0 ? "var(--color-status-error)" : undefined}
        />
        <StatItem
          label="Review"
          value={stats.review}
          color={stats.review > 0 ? "var(--color-accent-orange)" : undefined}
        />
        <StatItem
          label="Pending"
          value={stats.pending}
          color={stats.pending > 0 ? "var(--color-status-attention)" : undefined}
        />
        <StatItem
          label="Working"
          value={stats.working}
          color={stats.working > 0 ? "var(--color-status-working)" : undefined}
        />
        <div className="ml-auto hidden items-center gap-2 border-l border-[var(--color-border-default)] pl-4 sm:flex">
          <span className="text-[10px] font-bold tracking-[0.08em]">Online</span>
          <span className="h-2 w-2 rounded-full bg-[var(--color-status-ready)] shadow-[0_0_6px_var(--color-status-ready)]" />
        </div>
      </div>

      {spawnOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSpawnOpen(false);
          }}
        >
          <div className="mx-4 w-full max-w-lg border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)] sm:mx-0 sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
                Spawn Session
              </h2>
              <button
                className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                onClick={() => setSpawnOpen(false)}
                type="button"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3">
              <div className="flex gap-2">
                <select
                  className="flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnProjectId(event.target.value)}
                  value={spawnProjectId}
                >
                  <option value="">Select project</option>
                  {spawnProjectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <select
                  className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnAgent(event.target.value as "claude" | "codex")}
                  value={spawnAgent}
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
              </div>
              <textarea
                className="min-h-[6rem] w-full resize-y border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent)]"
                onChange={(event) => setSpawnPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void handleSpawn();
                }}
                placeholder="Prompt for the new session..."
                value={spawnPrompt}
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                  ⌘/Ctrl + Enter to submit
                </span>
                <button
                  className="bg-[var(--color-accent)] px-4 py-2 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={spawning || !spawnProjectId.trim() || !spawnPrompt.trim()}
                  onClick={() => void handleSpawn()}
                  type="button"
                >
                  {spawning ? "Spawning..." : "Spawn"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-sm border border-red-500/30 bg-red-500/[0.08] px-3 py-2.5 text-sm text-red-100">
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
        <section className="mt-5 space-y-4">
          {LANE_ORDER.map((level) => (
            <AttentionZone
              key={level}
              collapsed={isMobile ? expandedLevel !== level : undefined}
              level={level}
              onOpenTerminal={openTerminal}
              onToggle={
                isMobile
                  ? (nextLevel) =>
                      setExpandedLevel((current) => (current === nextLevel ? null : nextLevel))
                  : undefined
              }
              sessions={grouped[level]}
            />
          ))}
        </section>
      ) : null}

      {terminalSession ? (
        <TerminalModal onClose={() => setTerminalSession(null)} session={terminalSession} />
      ) : null}
    </main>
  );
}
