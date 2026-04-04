"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AttentionZone } from "@/components/AttentionZone";
import { StatusBar } from "@/components/StatusBar";
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
const LANE_ORDER: AttentionLevel[] = ["respond", "working", "pending", "done"];

function deriveProjects(sessions: SpurSessionView[]): ProjectInfo[] {
  return Array.from(new Set(sessions.map((session) => session.project)))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }))
    .map((id) => ({ id, name: id }));
}

function StatItem({
  icon,
  label,
  value,
  color,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  color?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 border px-1.5 py-0.5 transition ${active ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10" : "border-transparent hover:border-[var(--color-border-default)]"}`}
      onClick={onClick}
      type="button"
    >
      <span style={color ? { color } : undefined}>{icon}</span>
      <span className="text-[var(--color-text-secondary)]">{label}:</span>
      <span
        className="font-bold text-[var(--color-text-primary)]"
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </button>
  );
}

function IconChat() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
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
  const [searchQuery, setSearchQuery] = useState("");
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<"claude" | "codex">("claude");
  const [spawnBranch, setSpawnBranch] = useState("");
  const [spawnPlanMode, setSpawnPlanMode] = useState(false);
  const [spawnSteps, setSpawnSteps] = useState<{ id: number; value: string }[]>([]);
  const [spawnWorkspaceMode, setSpawnWorkspaceMode] = useState<"default" | "worktree" | "shared">(
    "default",
  );
  const [spawnDefaultBranch, setSpawnDefaultBranch] = useState("");
  const [spawning, setSpawning] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [expandedLevel, setExpandedLevel] = useState<AttentionLevel | null>(null);
  const [activeStatFilter, setActiveStatFilter] = useState<AttentionLevel | null>(null);
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

  const projectNameMap = useMemo(
    () => new Map(filterProjectOptions.map((project) => [project.id, project.name])),
    [filterProjectOptions],
  );

  const sessions = useMemo(() => {
    const all = rawSessions.map((session) =>
      toDashboardSession(session, projectNameMap.get(session.project)),
    );
    const q = searchQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
  }, [projectNameMap, rawSessions, searchQuery]);

  const grouped = useMemo(() => {
    const lanes: Record<AttentionLevel, DashboardSession[]> = {
      respond: [],
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
      pending: grouped.pending.length,
      working: grouped.working.length,
    }),
    [grouped],
  );

  const activeProjectName = projectId
    ? (filterProjectOptions.find((project) => project.id === projectId)?.name ?? projectId)
    : "All projects";

  useEffect(() => {
    if (spawnProjectId && filterProjectOptions.some((project) => project.id === spawnProjectId)) {
      return;
    }

    const nextProjectId =
      filterProjectOptions.find((project) => project.id === projectId)?.id ??
      filterProjectOptions[0]?.id ??
      "";

    if (nextProjectId !== spawnProjectId) {
      setSpawnProjectId(nextProjectId);
    }
  }, [projectId, spawnProjectId, filterProjectOptions]);

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

  const addStep = () => {
    setSpawnSteps((prev) => [...prev, { id: Date.now(), value: "" }]);
  };
  const removeStep = (id: number) => setSpawnSteps((prev) => prev.filter((s) => s.id !== id));
  const updateStep = (id: number, value: string) =>
    setSpawnSteps((prev) => prev.map((s) => (s.id === id ? { ...s, value } : s)));

  const handleSpawn = async () => {
    const nextProjectId = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProjectId || !nextPrompt) return;

    setSpawning(true);
    try {
      const filteredSteps = spawnSteps.map((s) => s.value.trim()).filter((s) => s.length > 0);
      let overrides: { worktree?: boolean; defaultBranch?: string } | undefined;
      if (spawnWorkspaceMode === "worktree") {
        overrides = { worktree: true };
        if (spawnDefaultBranch.trim()) overrides.defaultBranch = spawnDefaultBranch.trim();
      } else if (spawnWorkspaceMode === "shared") {
        overrides = { worktree: false };
      }

      const payload: Record<string, unknown> = {
        projectId: nextProjectId,
        prompt: nextPrompt,
        agent: spawnAgent,
      };
      if (spawnBranch.trim()) payload.branch = spawnBranch.trim();
      if (spawnPlanMode) payload.planMode = true;
      if (filteredSteps.length > 0) payload.steps = filteredSteps;
      if (overrides) payload.overrides = overrides;

      const response = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await response.text());
      setSpawnPrompt("");
      setSpawnBranch("");
      setSpawnPlanMode(false);
      setSpawnSteps([]);
      setSpawnWorkspaceMode("default");
      setSpawnDefaultBranch("");
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
    <>
    <main className="mx-auto max-w-[1500px] px-4 py-4 pb-8 sm:px-5 lg:px-6">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg text-[var(--color-accent)]">𖤓</span>
          <h1 className="text-xl font-bold uppercase tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-2xl">
            {activeProjectName === "All projects" ? "All Projects" : activeProjectName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5">
            <svg
              className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              className="w-32 border-none bg-transparent uppercase text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] sm:w-48"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter sessions..."
              value={searchQuery}
            />
          </div>
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
            Spawn Session
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 border-y border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-2 uppercase tracking-[0.06em] sm:gap-6 sm:px-2.5 sm:py-2.5">
        <StatItem
          icon={<IconChat />}
          label="Needs Input"
          value={stats.respond}
          color={stats.respond > 0 ? "var(--color-status-error)" : undefined}
          active={activeStatFilter === "respond"}
          onClick={() => setActiveStatFilter((c) => (c === "respond" ? null : "respond"))}
        />
        <StatItem
          icon={<IconBolt />}
          label="Working"
          value={stats.working}
          color={stats.working > 0 ? "var(--color-status-working)" : undefined}
          active={activeStatFilter === "working"}
          onClick={() => setActiveStatFilter((c) => (c === "working" ? null : "working"))}
        />
        <StatItem
          icon={<IconClock />}
          label="Waiting"
          value={stats.pending}
          color={stats.pending > 0 ? "var(--color-status-attention)" : undefined}
          active={activeStatFilter === "pending"}
          onClick={() => setActiveStatFilter((c) => (c === "pending" ? null : "pending"))}
        />
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
                  {filterProjectOptions.map((project) => (
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
              <div className="flex gap-2">
                <input
                  aria-label="branch name"
                  className="flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnBranch(event.target.value)}
                  placeholder="branch name"
                  value={spawnBranch}
                />
                <select
                  aria-label="workspace mode"
                  className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) =>
                    setSpawnWorkspaceMode(event.target.value as "default" | "worktree" | "shared")
                  }
                  value={spawnWorkspaceMode}
                >
                  <option value="default">Default</option>
                  <option value="worktree">Worktree</option>
                  <option value="shared">Shared</option>
                </select>
                <label className="flex items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 cursor-pointer">
                  <input
                    checked={spawnPlanMode}
                    className="accent-[var(--color-accent)]"
                    onChange={(event) => setSpawnPlanMode(event.target.checked)}
                    type="checkbox"
                  />
                  <span className="text-xs font-bold uppercase text-[var(--color-text-primary)]">
                    Plan
                  </span>
                </label>
              </div>
              {spawnWorkspaceMode === "worktree" ? (
                <input
                  className="w-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                  onChange={(event) => setSpawnDefaultBranch(event.target.value)}
                  placeholder="base branch (defaults to project default)"
                  value={spawnDefaultBranch}
                />
              ) : null}
              <div>
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {spawnSteps.map((step, index) => (
                    <div className="flex gap-2" key={step.id}>
                      <input
                        aria-label={`step ${index + 1}`}
                        className="flex-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)]"
                        onChange={(event) => updateStep(step.id, event.target.value)}
                        placeholder={`Step ${index + 1}`}
                        value={step.value}
                      />
                      <button
                        className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
                        onClick={() => removeStep(step.id)}
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="mt-2 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-xs font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
                  onClick={addStep}
                  type="button"
                >
                  + Step
                </button>
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
        <div className="mt-4 border border-red-500/30 bg-red-500/[0.08] px-3 py-2.5 text-sm text-red-100">
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
          {LANE_ORDER.filter(
            (level) =>
              grouped[level].length > 0 &&
              (activeStatFilter === null || level === activeStatFilter),
          ).map((level) => (
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
    <StatusBar sessions={rawSessions} />
    </>
  );
}
