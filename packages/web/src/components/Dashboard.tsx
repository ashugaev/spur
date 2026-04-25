"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AttentionZone } from "@/components/AttentionZone";
import { StatusBar } from "@/components/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { InputHistoryButton } from "@/components/InputHistory";
import { TerminalModal } from "@/components/TerminalModal";
import { VoiceButton, VoiceStatusHint } from "@/components/VoiceInput";
import { INPUT_CLASS } from "@/design/classes";
import { useInputHistory } from "@/hooks/useInputHistory";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { getTerminalQuerySessionId, withTerminalQuery } from "@/lib/project-routes";
import {
  getAttentionLevel,
  isTerminalSession,
  toDashboardSession,
  type AttentionLevel,
  type DashboardSession,
  type ProjectInfo,
  type SpurSessionView,
  type SpawnOverrides,
  type SpurSessionsResponse,
} from "@/lib/types";

const SESSIONS_POLL_INTERVAL_MS = 5_000;
const LANE_ORDER: AttentionLevel[] = ["respond", "working", "pending", "done"];
const LANE_ORDER_SET: ReadonlySet<string> = new Set(LANE_ORDER);
const LAST_SPAWN_PROJECT_STORAGE_KEY = "spur:last-spawn-project";
const COLLAPSED_CATEGORIES_STORAGE_KEY = "spur:mobile-collapsed-categories";
const SPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:spawn-prompt";

function readCollapsedCategories(): Set<AttentionLevel> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is AttentionLevel => LANE_ORDER_SET.has(v as string)));
  } catch {
    return new Set();
  }
}

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
      className={`flex min-w-0 flex-row items-center justify-center gap-1.5 border px-1.5 py-0.5 transition sm:justify-start sm:shrink-0 ${active ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10" : "border-transparent hover:border-[var(--color-border-default)]"}`}
      onClick={onClick}
      type="button"
    >
      <span style={color ? { color } : undefined}>{icon}</span>
      <span className="hidden min-w-0 truncate text-[var(--color-text-secondary)] sm:inline">
        {label}:
      </span>
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
function IconCheck() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function readLocationSearch(): string {
  if (typeof window === "undefined") return "";
  return window.location.search;
}

function buildSpawnOverrides(
  workspaceMode: "default" | "worktree" | "shared",
  defaultBranch: string,
): SpawnOverrides | undefined {
  if (workspaceMode === "worktree") {
    const trimmed = defaultBranch.trim();
    return trimmed ? { worktree: true, defaultBranch: trimmed } : { worktree: true };
  }
  if (workspaceMode === "shared") return { worktree: false };
  return undefined;
}

function upsertSession(
  sessions: SpurSessionView[],
  nextSession: SpurSessionView,
  activeProjectId: string,
): SpurSessionView[] {
  const filtered = sessions.filter((session) => session.id !== nextSession.id);
  if (activeProjectId && nextSession.project !== activeProjectId) {
    return filtered;
  }
  return [nextSession, ...filtered];
}

export function Dashboard() {
  const [locationSearch, setLocationSearch] = useState(readLocationSearch);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [projectId, setProjectId] = useState(() => {
    const params = new URLSearchParams(readLocationSearch());
    return params.get("project")?.trim() ?? "";
  });
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
  const spawningRef = useRef(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnHistory = useInputHistory(SPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    onTranscribed: (text) =>
      setSpawnPrompt((current) => (current.trim() ? `${current}\n${text}` : text)),
  });
  const [collapsedLevels, setCollapsedLevels] = useState(readCollapsedCategories);
  const toggleCollapsed = useCallback((level: AttentionLevel) => {
    setCollapsedLevels((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      window.localStorage.setItem(COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
  const [activeStatFilter, setActiveStatFilter] = useState<AttentionLevel | null>(null);
  const toggleStatFilter = (level: AttentionLevel) =>
    setActiveStatFilter((current) => (current === level ? null : level));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSearch = () => setLocationSearch(readLocationSearch());
    syncSearch();
    window.addEventListener("popstate", syncSearch);
    return () => {
      window.removeEventListener("popstate", syncSearch);
    };
  }, []);

  const requestedProject = useMemo(
    () => new URLSearchParams(locationSearch).get("project")?.trim() ?? "",
    [locationSearch],
  );
  const requestedTerminalSessionId = useMemo(
    () => getTerminalQuerySessionId(new URLSearchParams(locationSearch)),
    [locationSearch],
  );

  useEffect(() => {
    setProjectId(requestedProject);
  }, [requestedProject]);

  const queryClient = useQueryClient();
  const sessionsQueryKey = ["sessions", projectId] as const;
  const {
    data,
    isPending,
    error: sessionsError,
  } = useQuery<SpurSessionsResponse>({
    queryKey: sessionsQueryKey,
    queryFn: async ({ signal }) => {
      const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
      const response = await fetch(`/api/sessions${query}`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(`sessions ${response.status}`);
      return (await response.json()) as SpurSessionsResponse;
    },
    refetchInterval: SESSIONS_POLL_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });
  const rawSessions = data?.sessions ?? [];
  const projects = data?.projects ?? [];
  const loading = isPending;

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

  const allSessions = useMemo(
    () =>
      rawSessions.map((session) =>
        toDashboardSession(session, projectNameMap.get(session.project)),
      ),
    [projectNameMap, rawSessions],
  );

  const sessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allSessions;
    return allSessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
  }, [allSessions, searchQuery]);

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
      done: grouped.done.length,
    }),
    [grouped],
  );

  const visibleLevels = useMemo(
    () =>
      LANE_ORDER.filter(
        (level) =>
          grouped[level].length > 0 &&
          (activeStatFilter === null ? level !== "done" : level === activeStatFilter),
      ),
    [activeStatFilter, grouped],
  );

  const hasActiveFilters =
    projectId.length > 0 || searchQuery.trim().length > 0 || activeStatFilter !== null;
  const hasVisibleSessions = visibleLevels.length > 0;
  const activeProjectName = projectId
    ? (filterProjectOptions.find((project) => project.id === projectId)?.name ?? projectId)
    : "All Projects";
  const emptyStateMessage = hasActiveFilters
    ? `No sessions match the current filters${projectId ? ` in ${activeProjectName}` : ""}.`
    : grouped.done.length > 0
      ? "No current sessions are visible."
      : undefined;

  const isValidSpawnProject = (candidateProjectId: string) =>
    filterProjectOptions.some((project) => project.id === candidateProjectId);

  const resolvePreferredSpawnProjectId = () => {
    const selectedFilterProjectId =
      filterProjectOptions.find((project) => project.id === projectId)?.id ?? "";

    if (selectedFilterProjectId) {
      return selectedFilterProjectId;
    }

    if (typeof window !== "undefined") {
      const storedProjectId =
        window.localStorage.getItem(LAST_SPAWN_PROJECT_STORAGE_KEY)?.trim() ?? "";
      if (storedProjectId && isValidSpawnProject(storedProjectId)) {
        return storedProjectId;
      }
    }

    return filterProjectOptions[0]?.id ?? "";
  };

  useEffect(() => {
    if (spawnProjectId && isValidSpawnProject(spawnProjectId)) {
      return;
    }

    const nextProjectId = resolvePreferredSpawnProjectId();
    if (nextProjectId !== spawnProjectId) {
      setSpawnProjectId(nextProjectId);
    }
  }, [projectId, spawnProjectId, filterProjectOptions]);

  const syncSpawnProject = (nextProjectId: string) => {
    const normalizedProjectId = nextProjectId.trim();
    setSpawnProjectId(normalizedProjectId);
    if (typeof window === "undefined") return;
    if (normalizedProjectId) {
      window.localStorage.setItem(LAST_SPAWN_PROJECT_STORAGE_KEY, normalizedProjectId);
      return;
    }
    window.localStorage.removeItem(LAST_SPAWN_PROJECT_STORAGE_KEY);
  };

  const syncProjectFilter = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    if (!spawnOpen && nextProjectId) {
      setSpawnProjectId(nextProjectId);
    }
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (nextProjectId) {
      params.set("project", nextProjectId);
    } else {
      params.delete("project");
    }
    params.delete("terminal");

    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    setLocationSearch(window.location.search);
  };

  const syncTerminalFilter = (terminalSessionId: string | null) => {
    if (typeof window === "undefined") return;
    const query = withTerminalQuery(window.location.search, terminalSessionId);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${query}${window.location.hash}`,
    );
    setLocationSearch(window.location.search);
  };

  const addStep = () => {
    setSpawnSteps((prev) => [...prev, { id: Date.now(), value: "" }]);
  };
  const removeStep = (id: number) => setSpawnSteps((prev) => prev.filter((s) => s.id !== id));
  const updateStep = (id: number, value: string) =>
    setSpawnSteps((prev) => prev.map((s) => (s.id === id ? { ...s, value } : s)));

  useEffect(() => {
    const project = spawnProjectId.trim();
    const prompt = spawnPrompt.trim();
    if (!project || !prompt) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      const overrides = buildSpawnOverrides(spawnWorkspaceMode, spawnDefaultBranch);
      const payload: Record<string, unknown> = { projectId: project, prompt, agent: spawnAgent };
      if (overrides) payload.overrides = overrides;

      fetch("/api/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((result: { branch: string | null } | null) => {
          if (!cancelled && result?.branch) setSpawnBranch(result.branch);
        })
        .catch(() => {});
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [spawnProjectId, spawnPrompt, spawnAgent, spawnWorkspaceMode, spawnDefaultBranch]);

  const handleSpawn = async () => {
    const nextProjectId = spawnProjectId.trim();
    const nextPrompt = spawnPrompt.trim();
    if (!nextProjectId || spawningRef.current) return;

    spawningRef.current = true;
    setSpawning(true);
    try {
      const filteredSteps = spawnSteps.map((s) => s.value.trim()).filter((s) => s.length > 0);
      const overrides = buildSpawnOverrides(spawnWorkspaceMode, spawnDefaultBranch);

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
      spawnHistory.saveEntry(nextPrompt);
      const session = (await response.json()) as SpurSessionView;
      queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
        const currentSessions = current?.sessions ?? [];
        return {
          sessions: upsertSession(currentSessions, session, nextProjectId),
          projects: current?.projects ?? [],
        };
      });
      setSpawnPrompt("");
      setSpawnBranch("");
      setSpawnPlanMode(false);
      setSpawnSteps([]);
      setSpawnWorkspaceMode("default");
      setSpawnDefaultBranch("");
      setSpawnOpen(false);
      syncSpawnProject(nextProjectId);
      syncProjectFilter(nextProjectId);
      setError(null);
    } catch (spawnError) {
      setError(spawnError instanceof Error ? spawnError.message : "Failed to spawn Spur session");
    } finally {
      spawningRef.current = false;
      setSpawning(false);
    }
  };

  const openTerminal = (session: DashboardSession) => {
    syncTerminalFilter(session.id);
    setError(null);
  };

  const openSpawnModal = () => {
    setSpawnProjectId(resolvePreferredSpawnProjectId());
    setSpawnOpen(true);
  };

  const terminalSession = useMemo(() => {
    if (!requestedTerminalSessionId) return null;
    const session = allSessions.find((entry) => entry.id === requestedTerminalSessionId);
    if (!session) return null;
    if (!session.runtimeAlive || isTerminalSession(session) || !session.tmuxSession) {
      return null;
    }
    return session;
  }, [allSessions, requestedTerminalSessionId]);

  useEffect(() => {
    if (
      loading ||
      !requestedTerminalSessionId ||
      terminalSession ||
      typeof window === "undefined"
    ) {
      return;
    }

    const query = withTerminalQuery(window.location.search, null);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query}${window.location.hash}`,
    );
    setLocationSearch(window.location.search);
  }, [loading, requestedTerminalSessionId, terminalSession]);

  return (
    <>
      <main className="mx-auto max-w-[1500px] px-4 py-4 pb-8 sm:px-5 lg:px-6">
        <header className="mb-4 flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="relative inline-flex min-w-0 max-w-full focus-within:outline focus-within:outline-1 focus-within:outline-[var(--color-accent)] focus-within:outline-offset-2">
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-xl text-[var(--color-accent)]">𖤓</span>
              <h1 className="inline-flex min-w-0 max-w-full items-center gap-1 text-xl font-bold uppercase tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-2xl">
                <span className="block min-w-0 truncate">{activeProjectName}</span>
                <svg
                  aria-hidden="true"
                  data-testid="project-filter-chevron"
                  className="pointer-events-none mt-px h-4 w-4 shrink-0 text-[var(--color-text-primary)]"
                  fill="currentColor"
                  viewBox="0 0 16 16"
                >
                  <path d="M4 6.5 8 10.5 12 6.5Z" />
                </svg>
              </h1>
            </div>
            <select
              aria-label="Project filter"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 outline-none"
              onChange={(event) => syncProjectFilter(event.target.value)}
              value={projectId}
            >
              <option value="">All Projects</option>
              {filterProjectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <StatItem
            icon={<IconChat />}
            label="Needs Input"
            value={stats.respond}
            color={stats.respond > 0 ? "var(--color-status-error)" : undefined}
            active={activeStatFilter === "respond"}
            onClick={() => toggleStatFilter("respond")}
          />
          <StatItem
            icon={<IconBolt />}
            label="Working"
            value={stats.working}
            color={stats.working > 0 ? "var(--color-status-working)" : undefined}
            active={activeStatFilter === "working"}
            onClick={() => toggleStatFilter("working")}
          />
          <StatItem
            icon={<IconClock />}
            label="Waiting"
            value={stats.pending}
            color={stats.pending > 0 ? "var(--color-status-attention)" : undefined}
            active={activeStatFilter === "pending"}
            onClick={() => toggleStatFilter("pending")}
          />
          <StatItem
            icon={<IconCheck />}
            label="Completed"
            value={stats.done}
            color={
              activeStatFilter === "done" && stats.done > 0
                ? "var(--color-status-ready)"
                : undefined
            }
            active={activeStatFilter === "done"}
            onClick={() => toggleStatFilter("done")}
          />
          <div className="flex min-w-[12rem] flex-[999_1_16rem] items-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 sm:ml-auto">
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
              className="min-w-0 border-none bg-transparent uppercase text-[var(--color-text-primary)] outline-none"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter sessions..."
              value={searchQuery}
            />
          </div>
          <button
            className="w-full whitespace-nowrap bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] sm:w-auto sm:shrink-0"
            onClick={openSpawnModal}
            type="button"
          >
            Spawn Session
          </button>
        </header>

        {spawnOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
            onClick={(event) => {
              if (event.target === event.currentTarget) setSpawnOpen(false);
            }}
          >
            <div className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:p-5">
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
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                <div className="flex gap-2">
                  <select
                    aria-label="Spawn project"
                    className={`flex-1 ${INPUT_CLASS}`}
                    onChange={(event) => syncSpawnProject(event.target.value)}
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
                    className={INPUT_CLASS}
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
                    className={`flex-1 ${INPUT_CLASS}`}
                    onChange={(event) => setSpawnBranch(event.target.value)}
                    placeholder="Branch name"
                    value={spawnBranch}
                  />
                  <select
                    aria-label="workspace mode"
                    className={INPUT_CLASS}
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
                    className={`w-full ${INPUT_CLASS}`}
                    onChange={(event) => setSpawnDefaultBranch(event.target.value)}
                    placeholder="Base branch"
                    value={spawnDefaultBranch}
                  />
                ) : null}
                <div>
                  <div className="max-h-48 space-y-2 overflow-y-auto">
                    {spawnSteps.map((step, index) => (
                      <div className="flex gap-2" key={step.id}>
                        <input
                          aria-label={`step ${index + 1}`}
                          className={`flex-1 ${INPUT_CLASS}`}
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
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <textarea
                    className={`h-full min-h-[8rem] w-full flex-1 resize-y ${INPUT_CLASS} pr-12 sm:min-h-[10rem]`}
                    onChange={(event) => setSpawnPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                        void handleSpawn();
                    }}
                    placeholder="Prompt for the new session..."
                    value={spawnPrompt}
                  />
                  <VoiceButton voice={voice} />
                </div>
                {voice.voiceError ? (
                  <div className="border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-2.5 py-1.5 text-xs text-[var(--color-chip-error-text)]">
                    {voice.voiceError}
                  </div>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">
                    <VoiceStatusHint voice={voice} />
                  </span>
                  <div className="flex items-center gap-2">
                    <InputHistoryButton entries={spawnHistory.entries} onSelect={setSpawnPrompt} />
                    <button
                      className="inline-flex min-w-32 items-center justify-center gap-2 bg-[var(--color-accent)] px-4 py-2 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={spawning || !spawnProjectId.trim()}
                      onClick={() => void handleSpawn()}
                      type="button"
                    >
                      <span>{spawning ? "Spawning..." : "Spawn"}</span>
                      {!spawning ? (
                        <span
                          aria-hidden="true"
                          className="whitespace-nowrap font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-text-tertiary)]"
                        >
                          CMD + ⏎
                        </span>
                      ) : null}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {error || sessionsError ? (
          <div className="mt-4 border border-[var(--color-chip-error-border)] bg-[var(--color-chip-error-bg)] px-3 py-2.5 text-sm text-[var(--color-chip-error-text)]">
            {error ??
              (sessionsError instanceof Error
                ? sessionsError.message
                : "Failed to load Spur sessions")}
          </div>
        ) : null}

        {loading ? (
          <p className="mt-4 text-sm text-[var(--color-text-secondary)]">Loading sessions...</p>
        ) : null}

        {!loading && !hasVisibleSessions ? (
          <section className="mt-5">
            <EmptyState message={emptyStateMessage} />
            {hasActiveFilters ? (
              <div className="mt-3 flex justify-center">
                <button
                  className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-primary)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  onClick={() => {
                    setSearchQuery("");
                    setActiveStatFilter(null);
                    syncProjectFilter("");
                  }}
                  type="button"
                >
                  Reset Filters
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {!loading && hasVisibleSessions ? (
          <section className="mt-5 space-y-4">
            {visibleLevels.map((level) => (
              <AttentionZone
                key={level}
                collapsed={isMobile ? collapsedLevels.has(level) : undefined}
                level={level}
                onOpenTerminal={openTerminal}
                projectFilterId={projectId || undefined}
                onToggle={isMobile ? toggleCollapsed : undefined}
                sessions={grouped[level]}
              />
            ))}
          </section>
        ) : null}

        {terminalSession ? (
          <TerminalModal onClose={() => syncTerminalFilter(null)} session={terminalSession} />
        ) : null}
      </main>
      <StatusBar sessions={rawSessions} />
    </>
  );
}
