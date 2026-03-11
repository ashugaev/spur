"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type IntegrationStatusEntry,
  type IntegrationsStatusSnapshot,
  type CronListenerView,
  type CronListenersSnapshot,
  getAttentionLevel,
  isPRRateLimited,
  INTEGRATION_STATUS_KEYS,
  INTEGRATION_STATUS_LABELS,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { buildSessionPath, resolveSessionPath } from "@/lib/project-routes";

interface DashboardProps {
  initialSessions: DashboardSession[];
  initialIntegrationsStatus: IntegrationsStatusSnapshot;
  initialProjectId?: string;
  projectFilters?: DashboardProjectFilterOption[];
  orchestratorByProject?: Record<string, string>;
}

type DashboardTab = "sessions" | "prs" | "tracker" | "cron";
export interface DashboardProjectFilterOption {
  id: string;
  label: string;
  hasTracker?: boolean;
  hasCron?: boolean;
}
interface JiraTaskSessionView {
  id: string;
  sessionUrl: string | null;
  projectId: string | null;
  status: string | null;
  activity: string | null;
}

interface JiraTaskView {
  source?: string | null;
  taskManager?: string | null;
  issueKey: string;
  issueUrl: string | null;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  listenerIds: string[];
  listenerId?: string | null;
  spawnAvailable: boolean;
  projectId: string | null;
  startEndpoint: string | null;
  relatedActiveSessions: JiraTaskSessionView[];
  relatedDoneSessions?: JiraTaskSessionView[];
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;

export function Dashboard({
  initialSessions,
  initialIntegrationsStatus,
  initialProjectId,
  projectFilters = [],
  orchestratorByProject = {},
}: DashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessions = useSessionEvents(initialSessions);
  const [integrationsStatus, setIntegrationsStatus] = useState(initialIntegrationsStatus);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    const tab = searchParams.get("tab");
    if (tab === "prs" || tab === "tracker" || tab === "sessions" || tab === "cron") return tab;
    return "sessions";
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    const urlProject = searchParams.get("projectId");
    if (urlProject) {
      const trimmed = urlProject.trim();
      if (trimmed.length > 0) return trimmed;
    }
    if (typeof initialProjectId === "string") {
      const trimmed = initialProjectId.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return projectFilters[0]?.id ?? "";
  });
  const [jiraTasks, setJiraTasks] = useState<JiraTaskView[]>([]);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraLoadedOnce, setJiraLoadedOnce] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [jiraCachedAt, setJiraCachedAt] = useState<string | null>(null);
  const [startingJiraTaskKeys, setStartingJiraTaskKeys] = useState<Record<string, boolean>>({});
  const [cronSnapshot, setCronSnapshot] = useState<CronListenersSnapshot | null>(null);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);
  const [triggeringCronIds, setTriggeringCronIds] = useState<Record<string, boolean>>({});

  const updateUrl = useCallback(
    (tab: DashboardTab, projectId: string) => {
      const params = new URLSearchParams();
      if (tab !== "sessions") params.set("tab", tab);
      if (projectId) params.set("projectId", projectId);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "/", { scroll: false });
    },
    [router],
  );

  const handleTabChange = useCallback(
    (tab: DashboardTab) => {
      setActiveTab(tab);
      updateUrl(tab, selectedProjectId);
    },
    [selectedProjectId, updateUrl],
  );

  const handleProjectChange = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      updateUrl(activeTab, projectId);
    },
    [activeTab, updateUrl],
  );

  const filterOptions = useMemo(
    () =>
      [...projectFilters].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
      ),
    [projectFilters],
  );
  const projectFilterEnabled = filterOptions.length > 0;
  const effectiveProjectId = selectedProjectId || filterOptions[0]?.id;
  const selectedProjectOption = useMemo(
    () => filterOptions.find((option) => option.id === effectiveProjectId),
    [filterOptions, effectiveProjectId],
  );
  const displayProjectName = selectedProjectOption?.label;
  const showTrackerTab = selectedProjectOption?.hasTracker === true;
  const showCronTab = selectedProjectOption?.hasCron === true;

  const filteredSessions = useMemo(() => {
    if (!effectiveProjectId) {
      return sessions;
    }
    return sessions.filter((session) => session.projectId === effectiveProjectId);
  }, [sessions, effectiveProjectId]);

  const effectiveStats = useMemo(() => computeStatsForDashboard(filteredSessions), [filteredSessions]);
  const effectiveOrchestratorId = useMemo(() => {
    if (!effectiveProjectId) {
      return null;
    }
    return orchestratorByProject[effectiveProjectId] ?? null;
  }, [effectiveProjectId, orchestratorByProject]);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of filteredSessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [filteredSessions]);

  const openPRs = useMemo(() => {
    return filteredSessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [filteredSessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const refreshJiraTasks = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setJiraLoading(true);
    }
    try {
      const endpoint = effectiveProjectId
        ? `/api/tracker/tasks?projectId=${encodeURIComponent(effectiveProjectId)}`
        : "/api/tracker/tasks";
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const payload = (await response.json()) as Record<string, unknown>;
      setJiraTasks(parseJiraSprintTasks(payload, effectiveProjectId));
      setJiraCachedAt(typeof payload.issuesCachedAt === "string" ? payload.issuesCachedAt : null);
      setJiraError(null);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected error";
      setJiraError(`Failed to load tracker tasks: ${detail}`);
    } finally {
      setJiraLoadedOnce(true);
      if (showLoading) {
        setJiraLoading(false);
      }
    }
  }, [effectiveProjectId]);

  const handleStartJiraTask = useCallback(
    async (task: JiraTaskView) => {
      const payload = buildJiraTaskStartPayload(task);
      if (!payload) {
        setJiraError(`Failed to start ${task.issueKey}: start context is unavailable`);
        return;
      }

      setStartingJiraTaskKeys((prev) => ({ ...prev, [task.issueKey]: true }));
      try {
        const response = await startJiraTask(task, payload);
        if (!response.ok) {
          if (response.status === 409) {
            const payload = (await response
              .clone()
              .json()
              .catch(() => null)) as unknown;
            if (
              isObjectRecord(payload) &&
              payload["duplicate"] === true &&
              (payload["session"] !== undefined || typeof payload["error"] === "string")
            ) {
              // Another active session already owns this issue; treat as non-fatal and refresh UI links.
              setJiraError(null);
              await refreshJiraTasks(false);
              return;
            }
          }
          throw new Error(await readErrorMessage(response));
        }
        setJiraError(null);
        await refreshJiraTasks(false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unexpected error";
        setJiraError(`Failed to start ${task.issueKey}: ${detail}`);
      } finally {
        setStartingJiraTaskKeys((prev) => {
          const { [task.issueKey]: removedTask, ...next } = prev;
          void removedTask;
          return next;
        });
      }
    },
    [refreshJiraTasks],
  );

  const refreshCronJobs = useCallback(
    async (showLoading = false) => {
      if (showLoading) {
        setCronLoading(true);
      }
      try {
        const endpoint = effectiveProjectId
          ? `/api/cron-listeners?projectId=${encodeURIComponent(effectiveProjectId)}`
          : "/api/cron-listeners";
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
        const payload = (await response.json()) as CronListenersSnapshot;
        setCronSnapshot(payload);
        setCronError(null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unexpected error";
        setCronError(`Failed to load cron jobs: ${detail}`);
      } finally {
        if (showLoading) {
          setCronLoading(false);
        }
      }
    },
    [effectiveProjectId],
  );

  const handleTriggerCronJob = useCallback(
    async (job: CronListenerView) => {
      setTriggeringCronIds((prev) => ({ ...prev, [job.listenerId]: true }));
      try {
        const response = await fetch("/api/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: job.projectId,
            prompt: job.prompt,
            ...(job.agent !== undefined ? { agent: job.agent } : {}),
            ...(job.branch !== undefined ? { branch: job.branch } : {}),
          }),
        });
        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
        setCronError(null);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unexpected error";
        setCronError(`Failed to trigger ${job.listenerId}: ${detail}`);
      } finally {
        setTriggeringCronIds((prev) => {
          const { [job.listenerId]: removed, ...next } = prev;
          void removed;
          return next;
        });
      }
    },
    [],
  );

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => filteredSessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [filteredSessions],
  );

  useEffect(() => {
    if (filterOptions.length === 0) {
      if (selectedProjectId !== "") {
        setSelectedProjectId("");
      }
      return;
    }
    if (!filterOptions.some((option) => option.id === selectedProjectId)) {
      setSelectedProjectId(filterOptions[0].id);
    }
  }, [filterOptions, selectedProjectId]);

  useEffect(() => {
    setJiraTasks([]);
    setJiraError(null);
    setJiraCachedAt(null);
    setJiraLoadedOnce(false);
    setStartingJiraTaskKeys({});
    setCronSnapshot(null);
    setCronError(null);
    setTriggeringCronIds({});
    if (!showTrackerTab && activeTab === "tracker") {
      setActiveTab("sessions");
    }
    if (!showCronTab && activeTab === "cron") {
      setActiveTab("sessions");
    }
  }, [effectiveProjectId, showTrackerTab, showCronTab, activeTab]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch("/api/integrations/status", { cache: "no-store" });
        if (!response.ok) return;
        const next = (await response.json()) as IntegrationsStatusSnapshot;
        if (!cancelled) {
          setIntegrationsStatus(next);
        }
      } catch {
        // Keep the last known status
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "tracker") return;
    void refreshJiraTasks(!jiraLoadedOnce);
    const timer = setInterval(() => {
      void refreshJiraTasks(false);
    }, 15000);
    return () => {
      clearInterval(timer);
    };
  }, [activeTab, jiraLoadedOnce, refreshJiraTasks]);

  useEffect(() => {
    if (activeTab !== "cron") return;
    void refreshCronJobs(!cronSnapshot);
    const timer = setInterval(() => {
      void refreshCronJobs(false);
    }, 15000);
    return () => {
      clearInterval(timer);
    };
  }, [activeTab, cronSnapshot, refreshCronJobs]);

  return (
    <div className="px-4 py-5 sm:px-8 sm:py-7">
      <DynamicFavicon sessions={filteredSessions} projectName={displayProjectName} />
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 border-b border-[var(--color-border-subtle)] pb-5 sm:mb-8 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:pb-6">
        <div className="flex items-center justify-between gap-4 sm:justify-start sm:gap-6">
          <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)] sm:text-[17px]">
            {displayProjectName ? `${displayProjectName} · Orchestrator` : "Orchestrator"}
          </h1>
          {effectiveOrchestratorId && (
            <a
              href={buildSessionPath(effectiveOrchestratorId, effectiveProjectId)}
              className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[11px] font-semibold hover:no-underline sm:hidden sm:px-4 sm:py-2 sm:text-[12px]"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
              orchestrator
              <svg
                className="h-3 w-3 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <StatusLine stats={effectiveStats} />
          {effectiveOrchestratorId && (
            <a
              href={buildSessionPath(effectiveOrchestratorId, effectiveProjectId)}
              className="orchestrator-btn hidden items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline sm:flex"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
              orchestrator
              <svg
                className="h-3 w-3 opacity-70"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>
      </div>

      {projectFilterEnabled && (
        <div className="mb-5 flex items-center gap-2">
          <label
            htmlFor="project-filter"
            className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-secondary)]"
          >
            Project
          </label>
          <select
            id="project-filter"
            value={selectedProjectId}
            onChange={(event) => handleProjectChange(event.target.value)}
            className="rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-1 text-[12px] text-[var(--color-text-primary)]"
          >
            {filterOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
          <svg
            className="h-3.5 w-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">
            GitHub API rate limited — PR data (CI status, review state, sizes) may be stale. Will
            retry automatically on next refresh.
          </span>
          <button
            onClick={() => setRateLimitDismissed(true)}
            className="ml-1 shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="mb-6 flex items-center gap-1 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-1">
        {(
          [
            "sessions",
            "prs",
            ...(showTrackerTab ? ["tracker"] : []),
            ...(showCronTab ? ["cron"] : []),
          ] as DashboardTab[]
        ).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => handleTabChange(tab)}
            aria-pressed={activeTab === tab}
            className={[
              "rounded-[6px] px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === tab
                ? "bg-[var(--color-accent)] text-[var(--color-bg-base)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
            ].join(" ")}
          >
            {tab === "sessions"
              ? "Sessions"
              : tab === "prs"
                ? "Pull Requests"
                : tab === "tracker"
                  ? "Tracker Tasks"
                  : "Cron Jobs"}
          </button>
        ))}
      </div>

      {activeTab === "sessions" && (
        <>
          <IntegrationStatusPanel status={integrationsStatus} />

          {/* Kanban columns for active zones */}
          {hasKanbanSessions && (
            <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
              {KANBAN_LEVELS.map((level) =>
                grouped[level].length > 0 ? (
                  <div key={level} className="min-w-[200px] flex-1">
                    <AttentionZone
                      level={level}
                      sessions={grouped[level]}
                      projectId={effectiveProjectId}
                      variant="column"
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  </div>
                ) : null,
              )}
            </div>
          )}

          {/* Done — full-width grid below Kanban */}
          {grouped.done.length > 0 && (
            <div className="mb-8">
              <AttentionZone
                level="done"
                sessions={grouped.done}
                projectId={effectiveProjectId}
                variant="grid"
                onSend={handleSend}
                onKill={handleKill}
                onMerge={handleMerge}
                onRestore={handleRestore}
              />
            </div>
          )}
        </>
      )}

      {activeTab === "prs" && (
        <div className="mx-auto max-w-[900px]">
          {openPRs.length === 0 ? (
            <p className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
              No open pull requests.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border-muted)]">
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      PR
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Title
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Size
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      CI
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Review
                    </th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Unresolved
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {openPRs.map((pr) => (
                    <PRTableRow key={pr.number} pr={pr} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "tracker" && (
        <JiraTasksPanel
          tasks={jiraTasks}
          loading={jiraLoading}
          loadedOnce={jiraLoadedOnce}
          error={jiraError}
          cachedAt={jiraCachedAt}
          startingTaskKeys={startingJiraTaskKeys}
          projectId={effectiveProjectId}
          onRefresh={() => void refreshJiraTasks(true)}
          onStartTask={(task) => void handleStartJiraTask(task)}
          onRestoreSession={(sessionId) => void handleRestore(sessionId)}
        />
      )}

      {activeTab === "cron" && (
        <CronJobsPanel
          snapshot={cronSnapshot}
          loading={cronLoading}
          error={cronError}
          onTrigger={(job) => void handleTriggerCronJob(job)}
          triggeringIds={triggeringCronIds}
        />
      )}
    </div>
  );
}

interface JiraTasksPanelProps {
  tasks: JiraTaskView[];
  loading: boolean;
  loadedOnce: boolean;
  error: string | null;
  cachedAt: string | null;
  startingTaskKeys: Record<string, boolean>;
  projectId?: string;
  onRefresh: () => void;
  onStartTask: (task: JiraTaskView) => void;
  onRestoreSession: (sessionId: string) => void;
}

function JiraTasksPanel({
  tasks,
  loading,
  loadedOnce,
  error,
  cachedAt,
  startingTaskKeys,
  projectId,
  onRefresh,
  onStartTask,
  onRestoreSession,
}: JiraTasksPanelProps) {
  const canStartTask = (task: JiraTaskView): boolean =>
    task.spawnAvailable &&
    task.relatedActiveSessions.length === 0 &&
    buildJiraTaskStartPayload(task) !== null;

  const orderedTasks = [...tasks].sort((a, b) => {
    const aActive = a.relatedActiveSessions.length > 0;
    const bActive = b.relatedActiveSessions.length > 0;
    if (aActive !== bActive) return aActive ? -1 : 1;

    const catOrder = statusCategoryOrder(a.statusCategory) - statusCategoryOrder(b.statusCategory);
    if (catOrder !== 0) return catOrder;
    return a.issueKey.localeCompare(b.issueKey);
  });
  const readyCount = orderedTasks.filter((task) => canStartTask(task)).length;
  const activeCount = orderedTasks.filter((task) => task.relatedActiveSessions.length > 0).length;
  const blockedCount = Math.max(orderedTasks.length - readyCount - activeCount, 0);
  const anyStartInProgress = Object.values(startingTaskKeys).some(Boolean);
  const showBlockingLoading = loading && (!loadedOnce || orderedTasks.length === 0);
  const showRefreshing = loading && loadedOnce && orderedTasks.length > 0;

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
            Tracker Tasks
          </h2>
          <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
            Task status, related active sessions, and one-click agent start.
            {cachedAt && (
              <span className="ml-2 opacity-70" title={cachedAt}>
                · updated {formatRelativeTime(cachedAt)}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded border border-[var(--color-border-default)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <span className="inline-flex rounded-full border border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-status-ready)]">
          {readyCount} ready
        </span>
        <span className="inline-flex rounded-full border border-[rgba(88,166,255,0.45)] bg-[rgba(88,166,255,0.14)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-status-working)]">
          {activeCount} in progress
        </span>
        <span className="inline-flex rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
          {blockedCount} blocked
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-[6px] border border-[rgba(248,81,73,0.45)] bg-[rgba(248,81,73,0.12)] px-2.5 py-2 text-[11px] text-[var(--color-status-error)]">
          {error}
        </p>
      )}

      {showRefreshing && (
        <p className="mb-3 rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[11px] text-[var(--color-text-secondary)]">
          Refreshing tracker tasks…
        </p>
      )}

      {showBlockingLoading ? (
        <p className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          Loading tracker tasks…
        </p>
      ) : orderedTasks.length === 0 ? (
        <p className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          {error
            ? "Unable to load tracker tasks right now."
            : "No tracker tasks found for the current listener scope."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-[var(--color-border-default)]">
          <table className="min-w-[760px] w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border-muted)]">
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Key
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Title
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  AO Status
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Tracker Status
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Session
                </th>
                <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Start
                </th>
              </tr>
            </thead>
            <tbody>
              {orderedTasks.map((task, index) => {
                const linkedSessions = task.relatedActiveSessions;
                const hasActiveSession = linkedSessions.length > 0;
                const isStarting = Boolean(startingTaskKeys[task.issueKey]);
                const canStartNow = canStartTask(task) && !hasActiveSession;
                const isDisabled = isStarting || !canStartNow || anyStartInProgress;
                const killedSession = !hasActiveSession
                  ? (task.relatedDoneSessions ?? []).find((s) => s.status === "killed")
                  : undefined;
                return (
                  <tr
                    key={task.issueKey}
                    className={[
                      "border-b border-[var(--color-border-subtle)] last:border-0 hover:bg-[rgba(255,255,255,0.02)]",
                      index % 2 === 0 ? "bg-[rgba(255,255,255,0.01)]" : "bg-transparent",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2.5 align-top text-[12px] font-medium text-[var(--color-text-primary)]">
                      <div className="flex flex-col">
                        {task.issueUrl ? (
                          <a
                            href={task.issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {task.issueKey}
                          </a>
                        ) : (
                          task.issueKey
                        )}
                        {(task.taskManager || task.source) && (
                          <span className="text-[10px] font-normal text-[var(--color-text-muted)]">
                            {(task.taskManager ?? task.source)?.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--color-text-primary)]">
                      <span className="block max-w-[460px] truncate">
                        {task.summary ?? "(untitled)"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      {hasActiveSession ? (
                        <span className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] border-[rgba(88,166,255,0.45)] bg-[rgba(88,166,255,0.14)] text-[var(--color-status-working)]">
                          In progress
                        </span>
                      ) : (task.relatedDoneSessions?.length ?? 0) > 0 ? (
                        <span className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]">
                          Done
                        </span>
                      ) : (
                        <span className="text-[var(--color-text-secondary)] text-[11px]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <span
                        className={[
                          "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
                          jiraTaskStatusBadgeClass(task.statusCategory),
                        ].join(" ")}
                      >
                        {formatStateLabel(task.status ?? "unknown")}
                      </span>
                      {task.statusCategory && (
                        <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                          {formatStateLabel(task.statusCategory)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px]">
                      {hasActiveSession ? (
                        <div className="flex flex-wrap gap-1.5">
                          {linkedSessions.slice(0, 2).map((session) => (
                            <a
                              key={session.id}
                              href={resolveSessionPath({
                                sessionId: session.id,
                                projectId: session.projectId ?? task.projectId ?? projectId ?? undefined,
                                sessionUrl: session.sessionUrl,
                              })}
                              className="inline-flex items-center gap-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-accent)] hover:underline"
                            >
                              <span>{session.id}</span>
                              <span className="text-[10px] text-[var(--color-text-secondary)]">
                                {formatStateLabel(session.status ?? session.activity ?? "active")}
                              </span>
                            </a>
                          ))}
                          {linkedSessions.length > 2 && (
                            <span className="inline-flex items-center rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                              +{linkedSessions.length - 2}
                            </span>
                          )}
                        </div>
                      ) : (task.relatedDoneSessions?.length ?? 0) > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {(task.relatedDoneSessions ?? []).slice(0, 2).map((session) => (
                            <a
                              key={session.id}
                              href={resolveSessionPath({
                                sessionId: session.id,
                                projectId: session.projectId ?? task.projectId ?? projectId ?? undefined,
                                sessionUrl: session.sessionUrl,
                              })}
                              className="inline-flex items-center gap-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] opacity-60 hover:opacity-100 hover:underline"
                            >
                              <span>{session.id}</span>
                              <span className="text-[10px]">
                                {formatStateLabel(session.status ?? "done")}
                              </span>
                            </a>
                          ))}
                          {(task.relatedDoneSessions?.length ?? 0) > 2 && (
                            <span className="inline-flex items-center rounded border border-[var(--color-border-default)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] opacity-60">
                              +{(task.relatedDoneSessions?.length ?? 0) - 2}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[var(--color-text-secondary)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top">
                      <div className="flex items-center justify-end gap-1.5">
                        {killedSession && (
                          <button
                            type="button"
                            onClick={() => onRestoreSession(killedSession.id)}
                            className="rounded border border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.12)] px-2 py-1 text-[11px] font-medium text-[var(--color-status-attention)] hover:bg-[rgba(210,153,34,0.2)]"
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isDisabled}
                          onClick={() => onStartTask(task)}
                          className={[
                            "rounded border px-2 py-1 text-[11px] font-medium",
                            isDisabled
                              ? "cursor-not-allowed border-[var(--color-border-default)] text-[var(--color-text-secondary)] opacity-60"
                              : "border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.12)] text-[var(--color-status-ready)] hover:bg-[rgba(63,185,80,0.2)]",
                          ].join(" ")}
                        >
                          {hasActiveSession
                            ? "Session active"
                            : isStarting
                              ? "Starting..."
                              : canStartNow
                                ? "Start Agent"
                                : "Unavailable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function statusCategoryOrder(statusCategory: string | null): number {
  const normalized = statusCategory?.trim().toLowerCase() ?? "";
  if (normalized === "in_progress" || normalized === "indeterminate" || normalized === "in-progress")
    return 1;
  if (normalized === "done" || normalized === "closed" || normalized === "complete" || normalized === "completed")
    return 2;
  return 0;
}

function jiraTaskStatusBadgeClass(statusCategory: string | null): string {
  const normalized = statusCategory?.trim().toLowerCase() ?? "";
  if (
    normalized === "done" ||
    normalized === "closed" ||
    normalized === "complete" ||
    normalized === "completed"
  ) {
    return "border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "indeterminate"
  ) {
    return "border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.14)] text-[var(--color-status-attention)]";
  }
  if (normalized === "open" || normalized === "new" || normalized === "todo" || normalized === "backlog") {
    return "border-[rgba(88,166,255,0.35)] bg-[rgba(88,166,255,0.10)] text-[var(--color-status-working)]";
  }

  return "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]";
}

interface JiraTaskStartPayload {
  issueKey: string;
  projectId?: string;
  listenerId?: string;
}

function buildJiraTaskStartPayload(task: JiraTaskView): JiraTaskStartPayload | null {
  const listenerId =
    task.listenerId ?? (task.listenerIds.length === 1 ? task.listenerIds[0] : null);
  const hasStartContext = Boolean(task.projectId || listenerId);
  if (!hasStartContext) {
    return null;
  }

  return {
    issueKey: task.issueKey,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(listenerId ? { listenerId } : {}),
  };
}

async function startJiraTask(task: JiraTaskView, payload: JiraTaskStartPayload): Promise<Response> {
  const endpoint = task.startEndpoint ?? "/api/tracker/tasks";
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed (${response.status})`;
  let payloadText: string;

  try {
    payloadText = (await response.text()).trim();
  } catch {
    return fallback;
  }

  if (!payloadText) {
    return fallback;
  }

  try {
    const payload = JSON.parse(payloadText) as unknown;
    if (isObjectRecord(payload)) {
      const detail = readStringField(payload, ["error", "message", "detail"]);
      if (detail) {
        return detail;
      }
    }
  } catch {
    // Use plain text payload below.
  }

  return payloadText || fallback;
}

function parseJiraSprintTasks(payload: unknown, fallbackProjectId?: string): JiraTaskView[] {
  const rawTasks = extractTaskArray(payload);
  const listenerProjectById = extractListenerProjectMap(payload);
  const parsed: JiraTaskView[] = [];

  for (const rawTask of rawTasks) {
    if (!isObjectRecord(rawTask)) continue;

    const issueKey = readStringField(rawTask, ["issueKey", "key", "taskKey", "id"]);
    if (!issueKey) continue;

    const listenerIds = readStringArrayField(rawTask, ["listenerIds", "listeners"]);
    const projectId = readProjectId(rawTask, listenerIds, listenerProjectById, fallbackProjectId);
    const relatedActiveSessions = parseRelatedTaskSessions(rawTask, projectId);
    const relatedDoneSessions = parseDoneTaskSessions(rawTask, projectId);

    parsed.push({
      source: readStringField(rawTask, ["source", "taskSource", "tracker"]),
      taskManager: readStringField(rawTask, ["taskManager", "manager", "trackerType"]),
      issueKey,
      issueUrl: readStringField(rawTask, ["issueUrl", "url", "issueLink", "browseUrl"]),
      summary: readStringField(rawTask, ["summary", "title", "name"]),
      status: readStringField(rawTask, ["status", "state", "workflowStatus", "column"]),
      statusCategory: readStringField(rawTask, ["statusCategory", "stateCategory"]),
      listenerIds,
      listenerId:
        readStringField(rawTask, ["listenerId", "sourceListenerId"]) ??
        (listenerIds.length === 1 ? listenerIds[0] : null),
      relatedActiveSessions,
      relatedDoneSessions,
      spawnAvailable:
        readBooleanField(rawTask, ["spawnAvailable", "canStart", "startable", "startEnabled"]) ??
        relatedActiveSessions.length === 0,
      projectId,
      startEndpoint:
        readStringField(rawTask, ["startEndpoint", "startUrl", "spawnEndpoint"]) ??
        "/api/tracker/tasks",
    });
  }

  return parsed.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
}

function readProjectId(
  task: Record<string, unknown>,
  listenerIds: string[],
  listenerProjectById: Map<string, string>,
  fallbackProjectId?: string,
): string | null {
  // Respect explicit null in payload (important for ambiguous multi-project issues).
  if ("projectId" in task) {
    const explicit = task["projectId"];
    if (typeof explicit === "string") {
      const trimmed = explicit.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  }

  // Legacy fallback: infer only when a single listener maps to one project.
  if (listenerIds.length !== 1) {
    return fallbackProjectId ?? null;
  }
  return listenerProjectById.get(listenerIds[0]) ?? fallbackProjectId ?? null;
}

function parseRelatedTaskSessions(
  task: Record<string, unknown>,
  fallbackProjectId: string | null,
): JiraTaskSessionView[] {
  const parsed: JiraTaskSessionView[] = [];

  const upsert = (session: JiraTaskSessionView) => {
    if (parsed.some((existing) => existing.id === session.id)) {
      return;
    }
    parsed.push(session);
  };

  for (const key of ["relatedActiveSessions", "activeSessions", "sessions"] as const) {
    const candidate = task[key];
    if (!Array.isArray(candidate)) continue;

    for (const rawSession of candidate) {
      if (!isObjectRecord(rawSession)) continue;
      const sessionId = readStringField(rawSession, ["id", "sessionId"]);
      if (!sessionId) continue;

      upsert({
        id: sessionId,
        sessionUrl: readStringField(rawSession, ["sessionUrl", "url", "link"]),
        projectId:
          readStringField(rawSession, ["projectId"]) ??
          readNestedStringField(rawSession, "project", ["id", "projectId"]) ??
          fallbackProjectId,
        status: readStringField(rawSession, ["status", "sessionStatus"]),
        activity: readStringField(rawSession, ["activity", "sessionActivity"]),
      });
    }
  }

  const singleSessionId =
    readStringField(task, ["sessionId", "linkedSessionId", "activeSessionId"]) ??
    readNestedStringField(task, "session", ["id", "sessionId"]);
  if (singleSessionId) {
    upsert({
      id: singleSessionId,
      sessionUrl:
        readStringField(task, ["sessionUrl", "sessionLink"]) ??
        readNestedStringField(task, "session", ["url", "link"]),
      projectId:
        readStringField(task, ["sessionProjectId", "projectId"]) ??
        readNestedStringField(task, "session", ["projectId"]) ??
        fallbackProjectId,
      status: readStringField(task, ["sessionStatus"]),
      activity: readStringField(task, ["sessionActivity"]),
    });
  }

  return parsed.sort((a, b) => a.id.localeCompare(b.id));
}

function parseDoneTaskSessions(
  task: Record<string, unknown>,
  fallbackProjectId: string | null,
): JiraTaskSessionView[] {
  const candidate = task["relatedDoneSessions"];
  if (!Array.isArray(candidate)) return [];

  const parsed: JiraTaskSessionView[] = [];
  for (const rawSession of candidate) {
    if (!isObjectRecord(rawSession)) continue;
    const sessionId = readStringField(rawSession, ["id", "sessionId"]);
    if (!sessionId) continue;
    parsed.push({
      id: sessionId,
      sessionUrl: readStringField(rawSession, ["sessionUrl", "url", "link"]),
      projectId:
        readStringField(rawSession, ["projectId"]) ??
        readNestedStringField(rawSession, "project", ["id", "projectId"]) ??
        fallbackProjectId,
      status: readStringField(rawSession, ["status", "sessionStatus"]),
      activity: readStringField(rawSession, ["activity", "sessionActivity"]),
    });
  }
  return parsed;
}

function extractTaskArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isObjectRecord(payload)) {
    return [];
  }

  const direct = readTaskArrayFromRecord(payload);
  if (direct.length > 0) {
    return direct;
  }

  const nestedData = payload["data"];
  if (isObjectRecord(nestedData)) {
    return readTaskArrayFromRecord(nestedData);
  }

  return [];
}

function readTaskArrayFromRecord(value: Record<string, unknown>): unknown[] {
  const candidates = ["tasks", "items", "trackerTasks", "jiraTasks", "sprintTasks"];
  for (const key of candidates) {
    const next = value[key];
    if (Array.isArray(next)) {
      return next;
    }
  }
  return [];
}

function extractListenerProjectMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isObjectRecord(payload)) {
    return map;
  }

  let listeners = readListenerArrayFromRecord(payload);
  if (listeners.length === 0) {
    const nestedData = payload["data"];
    if (isObjectRecord(nestedData)) {
      listeners = readListenerArrayFromRecord(nestedData);
    }
  }

  for (const rawListener of listeners) {
    if (!isObjectRecord(rawListener)) continue;
    const listenerId = readStringField(rawListener, ["listenerId", "id", "key"]);
    const projectId = readStringField(rawListener, ["projectId"]);
    if (listenerId && projectId) {
      map.set(listenerId, projectId);
    }
  }

  return map;
}

function readListenerArrayFromRecord(value: Record<string, unknown>): unknown[] {
  const next = value["listeners"];
  return Array.isArray(next) ? next : [];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function readNestedStringField(
  record: Record<string, unknown>,
  parentKey: string,
  keys: readonly string[],
): string | null {
  const nested = record[parentKey];
  if (!isObjectRecord(nested)) {
    return null;
  }
  return readStringField(nested, keys);
}

function readBooleanField(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value !== 0 : null;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
  }
  return null;
}

function readStringArrayField(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const collected = new Set<string>();

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        collected.add(trimmed);
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed) {
        collected.add(trimmed);
      }
    }
  }

  return [...collected];
}

function IntegrationStatusPanel({ status }: { status: IntegrationsStatusSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const updatedLabel =
    status.updatedAt && status.source === "snapshot"
      ? `updated ${formatStatusTimestamp(status.updatedAt)}`
      : "snapshot unavailable";
  const dynamicEntries = status.entries.length > 0
    ? status.entries.map((entry, index) => {
        const fallbackLabel =
          entry.id && entry.id in INTEGRATION_STATUS_LABELS
            ? INTEGRATION_STATUS_LABELS[entry.id as keyof typeof INTEGRATION_STATUS_LABELS]
            : undefined;
        return {
          key: entry.id ?? `integration-${index + 1}`,
          label: entry.label ?? fallbackLabel ?? entry.id ?? `Integration ${index + 1}`,
          entry,
        };
      })
    : [];
  const entries = dynamicEntries.length > 0
    ? dynamicEntries
    : INTEGRATION_STATUS_KEYS.map((key) => ({
        key,
        label: INTEGRATION_STATUS_LABELS[key],
        entry: status.integrations[key],
      }));
  const summary = entries.reduce(
    (counts, item) => {
      counts[integrationTone(item.entry)] += 1;
      return counts;
    },
    { healthy: 0, attention: 0, inactive: 0, error: 0 } as Record<IntegrationTone, number>,
  );
  const attentionCount = summary.attention + summary.error;
  const totalCount = entries.length;
  const overallTone: IntegrationTone =
    summary.error > 0
      ? "error"
      : attentionCount > 0
        ? "attention"
        : summary.healthy > 0
          ? "healthy"
          : "inactive";
  const overallLabel =
    overallTone === "healthy"
      ? "Healthy"
      : overallTone === "attention"
        ? "Attention"
        : overallTone === "error"
          ? "Error"
          : "Inactive";

  return (
    <section className="mb-7 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
              Integrations
            </h2>
            <span
              className={[
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
                toneBadgeClass(overallTone),
              ].join(" ")}
            >
              <span className={integrationDotClass(overallTone)} aria-hidden="true" />
              {overallLabel}
            </span>
          </div>
          <p className="mt-1 truncate text-[11px] text-[var(--color-text-secondary)]">
            {summary.healthy}/{totalCount} healthy · {updatedLabel} · {status.source}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {expanded ? "Hide details" : "Show details"}
          <span aria-hidden="true">{expanded ? "▲" : "▼"}</span>
        </button>
      </div>

      {expanded && (
        <>
          <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
            <div className="flex flex-wrap gap-1.5">
              <SummaryPill label="ok" value={summary.healthy} tone="healthy" />
              <SummaryPill
                label="attention"
                value={attentionCount}
                tone={attentionCount > 0 ? "attention" : "inactive"}
              />
              <SummaryPill label="inactive" value={summary.inactive} tone="inactive" />
            </div>
            <p className="sr-only">
              {summary.healthy} integrations healthy, {attentionCount} need attention,{" "}
              {summary.inactive} inactive.
            </p>
          </div>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2 md:grid-cols-3">
            {entries.map(({ key, label, entry }) => {
              const tone = integrationTone(entry);
              return (
                <article
                  key={key}
                  className={integrationCardClass(tone)}
                  aria-label={`${label}: ${formatStateLabel(entry.state)}`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={integrationDotClass(tone)} aria-hidden="true" />
                      <h3 className="text-[12px] font-medium text-[var(--color-text-primary)]">
                        {label}
                      </h3>
                    </div>
                    <span className={stateBadgeClass(entry)}>{formatStateLabel(entry.state)}</span>
                  </div>
                  {(entry.kind || entry.service || entry.lastCheckAt) && (
                    <p className="mb-2 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                      {[entry.kind, entry.service].filter(Boolean).join(" · ")}
                      {entry.lastCheckAt
                        ? `${entry.kind || entry.service ? " · " : ""}checked ${formatStatusTimestamp(entry.lastCheckAt)}`
                        : ""}
                    </p>
                  )}
                  <div className="grid gap-1.5">
                    <BooleanPill label="active" value={entry.active} />
                    <BooleanPill label="connected" value={entry.connected} />
                    <BooleanPill label="ok" value={entry.ok} />
                  </div>
                  {entry.message && (
                    <p className="mt-2.5 rounded-[5px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[11px] leading-[1.35] text-[var(--color-text-secondary)]">
                      {entry.message}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function BooleanPill({ label, value }: { label: string; value: boolean }) {
  return (
    <div
      className={
        value
          ? "flex items-center justify-between rounded-[5px] border border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.12)] px-2 py-1 text-[11px] text-[var(--color-status-ready)]"
          : "flex items-center justify-between rounded-[5px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
      }
    >
      <span className="inline-flex items-center gap-1.5">
        <span
          className={
            value
              ? "h-1.5 w-1.5 rounded-full bg-[var(--color-status-ready)]"
              : "h-1.5 w-1.5 rounded-full bg-[var(--color-border-strong)]"
          }
          aria-hidden="true"
        />
        <span className="text-[10px] uppercase tracking-[0.07em]">{label}</span>
      </span>
      <span className="text-[11px] font-semibold tracking-[0.02em]">{value ? "Yes" : "No"}</span>
    </div>
  );
}

type IntegrationTone = "healthy" | "attention" | "inactive" | "error";

function integrationTone(entry: IntegrationStatusEntry): IntegrationTone {
  if (entry.ok) return "healthy";
  if (!entry.active) return "inactive";
  if (entry.connected) return "attention";
  return "error";
}

function integrationCardClass(tone: IntegrationTone): string {
  const base =
    "rounded-[7px] border bg-[linear-gradient(175deg,rgba(28,33,40,0.95)_0%,rgba(18,23,30,0.95)_100%)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
  if (tone === "healthy") return `${base} border-[rgba(63,185,80,0.35)]`;
  if (tone === "attention") return `${base} border-[rgba(210,153,34,0.35)]`;
  if (tone === "error") return `${base} border-[rgba(248,81,73,0.45)]`;
  return `${base} border-[var(--color-border-subtle)]`;
}

function integrationDotClass(tone: IntegrationTone): string {
  if (tone === "healthy") return "h-2 w-2 rounded-full bg-[var(--color-status-ready)]";
  if (tone === "attention") return "h-2 w-2 rounded-full bg-[var(--color-status-attention)]";
  if (tone === "error") return "h-2 w-2 rounded-full bg-[var(--color-status-error)]";
  return "h-2 w-2 rounded-full bg-[var(--color-border-strong)]";
}

function toneBadgeClass(tone: IntegrationTone): string {
  if (tone === "healthy") {
    return "border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]";
  }
  if (tone === "attention") {
    return "border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.14)] text-[var(--color-status-attention)]";
  }
  if (tone === "error") {
    return "border-[rgba(248,81,73,0.45)] bg-[rgba(248,81,73,0.14)] text-[var(--color-status-error)]";
  }
  return "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]";
}

function SummaryPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: IntegrationTone;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
        toneBadgeClass(tone),
      ].join(" ")}
    >
      <span className="tabular-nums">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function stateBadgeClass(entry: IntegrationStatusEntry): string {
  return [
    "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]",
    toneBadgeClass(integrationTone(entry)),
  ].join(" ");
}

function formatStateLabel(value: string): string {
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) {
    return "Unknown";
  }
  return normalized
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatStatusTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${date.toISOString().slice(11, 19)}Z`;
}

function formatRelativeTime(isoString: string): string {
  const ms = Date.now() - Date.parse(isoString);
  if (!Number.isFinite(ms) || ms < 0) return formatStatusTimestamp(isoString);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  return formatStatusTimestamp(isoString);
}

function computeStatsForDashboard(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((session) => session.activity !== null && session.activity !== "exited")
      .length,
    openPRs: sessions.filter((session) => session.pr?.state === "open").length,
    needsReview: sessions.filter(
      (session) => session.pr && !session.pr.isDraft && session.pr.reviewDecision === "pending",
    ).length,
  };
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex flex-wrap items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && <span className="mx-1.5 text-[11px] text-[var(--color-border-strong)] sm:mx-3">·</span>}
          <span
            className="text-[16px] font-bold tabular-nums tracking-tight sm:text-[20px]"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1 text-[10px] text-[var(--color-text-muted)] sm:ml-1.5 sm:text-[11px]">{p.label}</span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}

function formatInterval(ms: number): string {
  if (ms >= 86_400_000) return `every ${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `every ${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `every ${Math.round(ms / 60_000)}m`;
  return `every ${Math.round(ms / 1000)}s`;
}

function CronHealthBadge({ health }: { health: CronListenerView["health"] }) {
  const colorMap: Record<string, string> = {
    healthy:
      "border-[rgba(63,185,80,0.45)] bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]",
    degraded:
      "border-[rgba(210,153,34,0.45)] bg-[rgba(210,153,34,0.14)] text-[var(--color-status-attention)]",
    inactive:
      "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-secondary)]",
    starting:
      "border-[rgba(88,166,255,0.45)] bg-[rgba(88,166,255,0.14)] text-[var(--color-status-working)]",
    unknown:
      "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]",
  };
  const cls =
    colorMap[health] ??
    "border-[var(--color-border-default)] bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${cls}`}
    >
      {health}
    </span>
  );
}

interface CronJobsPanelProps {
  snapshot: CronListenersSnapshot | null;
  loading: boolean;
  error: string | null;
  onTrigger: (job: CronListenerView) => void;
  triggeringIds: Record<string, boolean>;
}

function CronJobsPanel({
  snapshot,
  loading,
  error,
  onTrigger,
  triggeringIds,
}: CronJobsPanelProps) {
  if (loading && !snapshot) {
    return (
      <section className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
        <p className="text-[12px] text-[var(--color-text-secondary)]">Loading cron jobs…</p>
      </section>
    );
  }

  const jobs = snapshot?.jobs ?? [];

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-3 min-w-0">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-secondary)]">
          Cron Jobs
        </h2>
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
          Scheduled listeners that spawn agent sessions at a fixed interval.
        </p>
      </div>

      {error && (
        <p className="mb-3 rounded-[6px] border border-[rgba(248,81,73,0.45)] bg-[rgba(248,81,73,0.12)] px-2.5 py-2 text-[11px] text-[var(--color-status-error)]">
          {error}
        </p>
      )}

      {jobs.length === 0 ? (
        <p className="rounded-[6px] border border-[var(--color-border-default)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          {error
            ? "Unable to load cron jobs right now."
            : "No cron listeners configured for this project."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-[var(--color-border-default)]">
          <table className="min-w-[760px] w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--color-border-muted)]">
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Listener
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Interval
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Prompt
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Agent
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Run on start
                </th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Health
                </th>
                <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  Trigger
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job, index) => {
                const isTriggering = Boolean(triggeringIds[job.listenerId]);
                return (
                  <tr
                    key={job.listenerId}
                    className={[
                      "border-b border-[var(--color-border-subtle)] last:border-0 hover:bg-[rgba(255,255,255,0.02)]",
                      index % 2 === 0 ? "bg-[rgba(255,255,255,0.01)]" : "bg-transparent",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2.5 align-top text-[12px] font-mono font-medium text-[var(--color-text-primary)]">
                      {job.listenerId}
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--color-text-secondary)]">
                      {formatInterval(job.intervalMs)}
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--color-text-primary)]">
                      <span
                        className="block max-w-[320px] truncate"
                        title={job.prompt}
                      >
                        {job.prompt}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--color-text-secondary)]">
                      {job.agent ?? "default"}
                    </td>
                    <td className="px-3 py-2.5 align-top text-[12px] text-[var(--color-text-secondary)]">
                      {job.runOnStart ? "yes" : "no"}
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <CronHealthBadge health={job.health} />
                    </td>
                    <td className="px-3 py-2.5 text-right align-top">
                      <button
                        type="button"
                        disabled={isTriggering}
                        onClick={() => onTrigger(job)}
                        className={[
                          "rounded border px-2 py-1 text-[11px] font-medium",
                          isTriggering
                            ? "cursor-not-allowed border-[var(--color-border-default)] text-[var(--color-text-secondary)] opacity-60"
                            : "border-[rgba(88,166,255,0.45)] bg-[rgba(88,166,255,0.12)] text-[var(--color-status-working)] hover:bg-[rgba(88,166,255,0.2)]",
                        ].join(" ")}
                      >
                        {isTriggering ? "Triggering…" : "Trigger now"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
