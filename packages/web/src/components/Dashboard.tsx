"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AgentSelect } from "@/components/AgentSelect";
import { AttentionZone } from "@/components/AttentionZone";
import { StatusBar } from "@/components/StatusBar";
import { EmptyState } from "@/components/EmptyState";
import { FileAttachmentTextarea } from "@/components/FileAttachmentTextarea";
import { InputHistoryButton } from "@/components/InputHistory";
import { OpenPrActionDialog } from "@/components/OpenPrActionDialog";
import { SlashSuggestions } from "@/components/SlashSuggestions";
import { TerminalModal } from "@/components/TerminalModal";
import { VoiceStatusHint, voicePlaceholder } from "@/components/VoiceInput";
import { INPUT_CLASS } from "@/design/classes";
import { useFooterPopover } from "@/lib/footer-popover";
import { useInputHistory } from "@/hooks/useInputHistory";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { readResponsePayload, responseErrorMessage } from "@/lib/json-payload";
import {
  encodeFileAttachments,
  fileAttachmentsFromFiles,
  type FileAttachment,
} from "@/lib/file-attachments";
import { getTerminalQuerySessionId, withTerminalQuery } from "@/lib/project-routes";
import type { AgentName } from "@/lib/agents";
import { insertTextAtCursor } from "@/lib/textarea";
import {
  isPrimarySubmitHotkey,
  isVoiceToggleHotkey,
  PRIMARY_SUBMIT_HINT,
} from "@/lib/submit-hotkeys";
import {
  ATTENTION_ZONE_ORDER,
  collapseDeskRows,
  isOpenPrActionRequiredPayload,
  isTerminalSession,
  toDashboardSession,
  type AttentionLevel,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DashboardSession,
  type DeskCollapsedRow,
  type OpenPrAction,
  type OpenPrActionRequiredPayload,
  type ProjectInfo,
  type SpurSessionView,
  type SpawnOverrides,
  type SpurSessionsResponse,
} from "@/lib/types";

const SESSIONS_POLL_INTERVAL_MS = 5_000;
const LANE_ORDER_SET: ReadonlySet<string> = new Set(ATTENTION_ZONE_ORDER);
const DEFAULT_COLLAPSED_MOBILE_CATEGORIES: AttentionLevel[] = ["stopped"];
const LAST_SPAWN_PROJECT_STORAGE_KEY = "spur:last-spawn-project";
const COLLAPSED_CATEGORIES_STORAGE_KEY = "spur:mobile-collapsed-categories";
const SPAWN_PROMPT_HISTORY_STORAGE_KEY = "spur:input-history:spawn-prompt";
const SHEPHERD_PROJECT_ID = "spur-shepherd";

function readCollapsedCategories(): Set<AttentionLevel> {
  if (typeof window === "undefined") return new Set();
  const raw = window.localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
  if (!raw) return new Set(DEFAULT_COLLAPSED_MOBILE_CATEGORIES);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is AttentionLevel => LANE_ORDER_SET.has(v as string)));
  } catch {
    return new Set();
  }
}

function buildSessionProjectLabelMap(
  projects: readonly ProjectInfo[],
  sessions: readonly SpurSessionView[],
): Map<string, string> {
  const labels = new Map(projects.map((project) => [project.id, project.name]));
  for (const session of sessions) {
    if (!labels.has(session.project)) {
      labels.set(session.project, session.project);
    }
  }
  return labels;
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
function IconStop() {
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
      <rect x="5" y="5" width="14" height="14" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconShepherd() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="8" width="12" height="10" />
      <path d="M9 8V5" />
      <path d="M15 8V5" />
      <circle cx="10" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="13" r="1" fill="currentColor" stroke="none" />
      <path d="M10 16h4" />
      <path d="M4 12h2" />
      <path d="M18 12h2" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
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

function projectOptionLabel(project: ProjectInfo): string {
  return project.kind === "shepherd" ? `${project.name} (Built In)` : project.name;
}

function ProjectGearMenu({
  projects,
  onNewProject,
  onDelete,
}: {
  projects: ProjectInfo[];
  onNewProject: () => void;
  onDelete: (project: ProjectInfo) => void;
}) {
  const popover = useFooterPopover();
  return (
    <div
      ref={popover.containerRef}
      className="relative"
      onBlur={popover.onBlur}
      onMouseEnter={popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
    >
      <button
        aria-expanded={popover.open}
        aria-label="Project actions"
        className="flex items-center gap-1 border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-2 py-1.5 text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
        type="button"
        onClick={popover.toggle}
      >
        <IconGear />
      </button>
      {popover.open ? (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[260px] max-w-[calc(100vw-1rem)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-2 shadow-[0_4px_12px_var(--color-shadow-modal-sm)]">
          <button
            className="mb-1 w-full bg-[var(--color-accent)] px-2 py-1.5 text-left font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
            onClick={() => {
              popover.dismiss();
              onNewProject();
            }}
            type="button"
          >
            + New project
          </button>
          {projects.length === 0 ? (
            <p className="px-2 py-1.5 text-[var(--color-text-tertiary)]">No projects yet.</p>
          ) : (
            <ul className="flex flex-col">
              {projects.map((project) => (
                <li
                  key={project.id}
                  className="flex items-center gap-2 border-t border-[var(--color-border-subtle)] px-2 py-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
                    {project.name}
                  </span>
                  {project.kind === "shepherd" ? (
                    <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                      built-in
                    </span>
                  ) : null}
                  {!project.configured ? (
                    <span className="border border-[var(--color-border-default)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-tertiary)]">
                      unconfigured
                    </span>
                  ) : null}
                  {project.kind !== "shepherd" ? (
                    <button
                      aria-label={`Delete ${project.name}`}
                      className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-status-error)]"
                      onClick={() => {
                        onDelete(project);
                      }}
                      type="button"
                    >
                      <IconTrash />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NewProjectModal({
  displayName,
  prefix,
  path,
  error,
  missingPath,
  submitting,
  onDisplayNameChange,
  onPrefixChange,
  onPathChange,
  onSubmit,
  onCreateFolder,
  onClose,
}: {
  displayName: string;
  prefix: string;
  path: string;
  error: string | null;
  missingPath: string | null;
  submitting: boolean;
  onDisplayNameChange: (value: string) => void;
  onPrefixChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onSubmit: () => void;
  onCreateFolder: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-md sm:p-5"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[var(--color-text-primary)]">
            New project
          </h2>
          <button
            className="text-[var(--color-text-tertiary)] transition hover:text-[var(--color-text-primary)]"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">Display name</span>
          <input
            aria-label="Project display name"
            autoFocus
            className={INPUT_CLASS}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="e.g. Spur Web"
            value={displayName}
          />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">Session prefix</span>
          <input
            aria-label="Project session prefix"
            className={INPUT_CLASS}
            onChange={(event) => onPrefixChange(event.target.value)}
            placeholder="letters, digits, _ or -"
            value={prefix}
          />
        </label>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[var(--color-text-secondary)]">Project path</span>
          <input
            aria-label="Project path"
            className={INPUT_CLASS}
            onChange={(event) => onPathChange(event.target.value)}
            placeholder="/absolute/path/to/repo"
            value={path}
          />
        </label>
        {error ? (
          <p
            className="mb-3 border border-[var(--color-status-error)] bg-[var(--color-status-error)]/10 px-2.5 py-1.5 text-[var(--color-status-error)]"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {missingPath ? (
          <div
            className="mb-3 flex flex-col gap-2 border border-[var(--color-status-warning)] bg-[var(--color-status-warning)]/10 px-2.5 py-1.5 text-[var(--color-status-warning)]"
            role="alert"
          >
            <span>Folder doesn&apos;t exist. Create it?</span>
            <button
              className="self-start bg-[var(--color-accent)] px-3 py-1 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting}
              onClick={onCreateFolder}
              type="button"
            >
              Create folder &amp; continue
            </button>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            className="border border-[var(--color-border-default)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting}
            onClick={onSubmit}
            type="button"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Dashboard() {
  const [locationSearch, setLocationSearch] = useState(readLocationSearch);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [projectId, setProjectId] = useState(() => {
    const params = new URLSearchParams(readLocationSearch());
    return params.get("project")?.trim() ?? "";
  });
  const [error, setError] = useState<string | null>(null);
  const [openPrAction, setOpenPrAction] = useState<{
    session: DashboardSession;
    payload: OpenPrActionRequiredPayload;
  } | null>(null);
  const [openPrActionBusy, setOpenPrActionBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [spawnProjectId, setSpawnProjectId] = useState("");
  const [spawnPinnedProjectId, setSpawnPinnedProjectId] = useState<string | null>(null);
  const [spawnPrompt, setSpawnPrompt] = useState("");
  const [spawnAgent, setSpawnAgent] = useState<AgentName>("claude");
  const [spawnBranch, setSpawnBranch] = useState("");
  const [spawnPlanMode, setSpawnPlanMode] = useState(false);
  const [spawnSteps, setSpawnSteps] = useState<{ id: number; value: string }[]>([]);
  const [spawnWorkspaceMode, setSpawnWorkspaceMode] = useState<"default" | "worktree" | "shared">(
    "default",
  );
  const [spawnDefaultBranch, setSpawnDefaultBranch] = useState("");
  const [spawnAttachments, setSpawnAttachments] = useState<FileAttachment[]>([]);
  const [spawning, setSpawning] = useState(false);
  const spawningRef = useRef(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnPromptRef = useRef<HTMLTextAreaElement>(null);
  const spawnHistory = useInputHistory(SPAWN_PROMPT_HISTORY_STORAGE_KEY);
  const voice = useVoiceInput({
    contextKey: "spawn",
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
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectDisplayName, setNewProjectDisplayName] = useState("");
  const [newProjectPrefix, setNewProjectPrefix] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [newProjectMissingPath, setNewProjectMissingPath] = useState<string | null>(null);
  const [newProjectSubmitting, setNewProjectSubmitting] = useState(false);
  const [projectActionError, setProjectActionError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncSearch = () => setLocationSearch(readLocationSearch());
    syncSearch();
    window.addEventListener("popstate", syncSearch);
    return () => {
      window.removeEventListener("popstate", syncSearch);
    };
  }, []);

  useEffect(() => {
    if (!spawnOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSpawnOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [spawnOpen]);

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
  const sessionsQueryKey = ["sessions"] as const;
  const {
    data,
    isPending,
    error: sessionsError,
  } = useQuery<SpurSessionsResponse>({
    queryKey: sessionsQueryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/sessions", { signal });
      if (!response.ok) throw new Error(`sessions ${response.status}`);
      return (await response.json()) as SpurSessionsResponse;
    },
    refetchInterval: SESSIONS_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    placeholderData: (prev) => prev,
  });
  const rawSessions = data?.sessions ?? [];
  const projects = data?.projects ?? [];
  const loading = isPending;

  const filterProjectOptions = useMemo(
    () =>
      [...projects].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    [projects],
  );

  const projectNameMap = useMemo(
    () => buildSessionProjectLabelMap(projects, rawSessions),
    [projects, rawSessions],
  );

  const allSessions = useMemo(
    () =>
      rawSessions.map((session) =>
        toDashboardSession(session, projectNameMap.get(session.project)),
      ),
    [projectNameMap, rawSessions],
  );

  const projectSessions = useMemo(
    () =>
      projectId ? allSessions.filter((session) => session.projectId === projectId) : allSessions,
    [allSessions, projectId],
  );

  const sessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return projectSessions;
    const narrowed = projectSessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
    const keys = new Set(narrowed.map((s) => s.deskKey));
    return projectSessions.filter((s) => keys.has(s.deskKey));
  }, [projectSessions, searchQuery]);

  const deskCollapsedRows = useMemo(() => collapseDeskRows(sessions), [sessions]);

  const grouped = useMemo(() => {
    const lanes: Record<AttentionLevel, DeskCollapsedRow[]> = {
      respond: [],
      working: [],
      pending: [],
      stopped: [],
      done: [],
    };

    for (const row of deskCollapsedRows) {
      lanes[row.lane].push(row);
    }

    return lanes;
  }, [deskCollapsedRows]);

  const stats = useMemo(
    () => ({
      respond: grouped.respond.length,
      working: grouped.working.length,
      pending: grouped.pending.length,
      stopped: grouped.stopped.length,
      done: grouped.done.length,
    }),
    [grouped],
  );

  const visibleLevels = useMemo(
    () =>
      ATTENTION_ZONE_ORDER.filter(
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

  const configuredProjectOptions = useMemo(
    () => filterProjectOptions.filter((project) => project.configured),
    [filterProjectOptions],
  );

  const isValidSpawnProject = (candidateProjectId: string) =>
    configuredProjectOptions.some((project) => project.id === candidateProjectId);

  const resolvePreferredSpawnProjectId = () => {
    const selectedFilterProjectId =
      configuredProjectOptions.find((project) => project.id === projectId)?.id ?? "";

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

    return configuredProjectOptions[0]?.id ?? "";
  };

  useEffect(() => {
    if (spawnPinnedProjectId) {
      if (spawnProjectId !== spawnPinnedProjectId) {
        setSpawnProjectId(spawnPinnedProjectId);
      }
      return;
    }

    if (spawnProjectId && isValidSpawnProject(spawnProjectId)) {
      return;
    }

    const nextProjectId = resolvePreferredSpawnProjectId();
    if (nextProjectId !== spawnProjectId) {
      setSpawnProjectId(nextProjectId);
    }
  }, [projectId, spawnProjectId, spawnPinnedProjectId, configuredProjectOptions]);

  const syncSpawnProject = (nextProjectId: string) => {
    const normalizedProjectId = nextProjectId.trim();
    setSpawnPinnedProjectId(null);
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
      const encodedAttachments = encodeFileAttachments(spawnAttachments);
      if (encodedAttachments.length > 0) payload.attachments = encodedAttachments;
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
        const currentSessions = (current?.sessions ?? []).filter(
          (existingSession) => existingSession.id !== session.id,
        );
        return {
          sessions: [session, ...currentSessions],
          projects: current?.projects ?? [],
        };
      });
      setSpawnPrompt("");
      setSpawnBranch("");
      setSpawnPlanMode(false);
      setSpawnSteps([]);
      setSpawnWorkspaceMode("default");
      setSpawnDefaultBranch("");
      setSpawnAttachments([]);
      setSpawnPinnedProjectId(null);
      setSpawnOpen(false);
      syncSpawnProject(nextProjectId);
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

  const openNewProjectModal = () => {
    setNewProjectDisplayName("");
    setNewProjectPrefix("");
    setNewProjectPath("");
    setNewProjectError(null);
    setNewProjectMissingPath(null);
    setNewProjectOpen(true);
  };

  const submitNewProject = async (createMissing: boolean) => {
    const displayName = newProjectDisplayName.trim();
    const prefix = newProjectPrefix.trim();
    const path = newProjectPath.trim();
    if (!displayName) {
      setNewProjectError("Display name is required");
      return;
    }
    if (!prefix) {
      setNewProjectError("Prefix is required");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      setNewProjectError("Prefix must contain only letters, digits, underscores, or hyphens");
      return;
    }
    if (!path) {
      setNewProjectError("Path is required");
      return;
    }
    setNewProjectSubmitting(true);
    setNewProjectError(null);
    if (createMissing) setNewProjectMissingPath(null);
    try {
      const body: CreateProjectRequest = createMissing
        ? { displayName, prefix, path, createMissing: true }
        : { displayName, prefix, path };
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        const message = payload?.error ?? `Failed to create project (${response.status})`;
        const missingPrefix = "path does not exist: ";
        if (!createMissing && message.startsWith(missingPrefix)) {
          setNewProjectMissingPath(message.slice(missingPrefix.length));
          return;
        }
        throw new Error(message);
      }
      const created = (await response.json()) as CreateProjectResponse;
      const spawnResponse = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: created.id, prompt: "", bootstrap: true }),
      });
      if (!spawnResponse.ok) {
        const payload = (await spawnResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          payload?.error ??
            `Project created but bootstrap session failed (${spawnResponse.status})`,
        );
      }
      const session = (await spawnResponse.json()) as SpurSessionView;
      setNewProjectOpen(false);
      setNewProjectMissingPath(null);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      syncTerminalFilter(session.id);
    } catch (createError) {
      setNewProjectError(
        createError instanceof Error ? createError.message : "Failed to create Spur project",
      );
    } finally {
      setNewProjectSubmitting(false);
    }
  };

  const handleCreateProject = async () => {
    if (newProjectSubmitting) return;
    await submitNewProject(false);
  };

  const handleCreateFolderAndContinue = async () => {
    if (newProjectSubmitting) return;
    await submitNewProject(true);
  };

  const handleDeleteProject = async (project: ProjectInfo) => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        project.configured
          ? `Disconnect project "${project.name}"? Spur will stop tracking its spur.yaml.`
          : `Delete project "${project.name}"?`,
      );
      if (!ok) return;
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `Failed to delete project (${response.status})`);
      }
      setProjectActionError(null);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    } catch (deleteError) {
      setProjectActionError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete Spur project",
      );
    }
  };

  const handleRestoreSession = async (session: DashboardSession) => {
    await queryClient.cancelQueries({ queryKey: sessionsQueryKey });
    const previousResponse = queryClient.getQueryData<SpurSessionsResponse>(sessionsQueryKey);

    queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((currentSession) =>
          currentSession.id === session.id
            ? {
                ...currentSession,
                status: "running",
                state: "working",
                runtimeAlive: true,
              }
            : currentSession,
        ),
      };
    });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/restore`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
      setError(null);
    } catch (restoreError) {
      if (previousResponse) {
        queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
      }
      setError(
        restoreError instanceof Error ? restoreError.message : "Failed to restore Spur session",
      );
      throw restoreError;
    } finally {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    }
  };

  const handleCompleteSession = async (session: DashboardSession, prAction?: OpenPrAction) => {
    await queryClient.cancelQueries({ queryKey: sessionsQueryKey });
    const previousResponse = queryClient.getQueryData<SpurSessionsResponse>(sessionsQueryKey);

    queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, (current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((currentSession) =>
          currentSession.id === session.id
            ? {
                ...currentSession,
                status: "completed",
                state: "stopped",
                runtimeAlive: false,
                tmuxSession: null,
              }
            : currentSession,
        ),
      };
    });

    try {
      const body = prAction ? { prAction } : undefined;
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/complete`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        if (isOpenPrActionRequiredPayload(payload)) {
          if (previousResponse) {
            queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
          }
          setOpenPrAction({ session, payload });
          setError(null);
          return;
        }
        throw new Error(responseErrorMessage(payload, "Failed to complete Spur session"));
      }
      setError(null);
    } catch (completeError) {
      if (previousResponse) {
        queryClient.setQueryData<SpurSessionsResponse>(sessionsQueryKey, previousResponse);
      }
      setError(
        completeError instanceof Error ? completeError.message : "Failed to complete Spur session",
      );
      throw completeError;
    } finally {
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    }
  };

  const handleOpenPrAction = async (prAction: OpenPrAction) => {
    if (!openPrAction) return;
    setOpenPrActionBusy(true);
    try {
      await handleCompleteSession(openPrAction.session, prAction);
      setOpenPrAction(null);
    } finally {
      setOpenPrActionBusy(false);
    }
  };

  const openSpawnModal = () => {
    setSpawnPinnedProjectId(null);
    setSpawnProjectId(resolvePreferredSpawnProjectId());
    setSpawnAttachments([]);
    setSpawnOpen(true);
  };

  const openShepherdSpawnModal = () => {
    setSpawnPinnedProjectId(SHEPHERD_PROJECT_ID);
    setSpawnProjectId(SHEPHERD_PROJECT_ID);
    setSpawnAgent("claude");
    setSpawnWorkspaceMode("default");
    setSpawnDefaultBranch("");
    setSpawnAttachments([]);
    setSpawnOpen(true);
  };

  const addSpawnFiles = useCallback((files: FileList | File[] | null) => {
    void fileAttachmentsFromFiles(files)
      .then((attachments) => {
        if (attachments.length === 0) return;
        setSpawnAttachments((current) => [...current, ...attachments]);
      })
      .catch(() => {});
  }, []);

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
              {configuredProjectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {projectOptionLabel(project)}
                </option>
              ))}
            </select>
          </div>
          <ProjectGearMenu
            projects={filterProjectOptions}
            onNewProject={openNewProjectModal}
            onDelete={(project) => {
              void handleDeleteProject(project);
            }}
          />
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
            icon={<IconStop />}
            label="Stopped"
            value={stats.stopped}
            color={stats.stopped > 0 ? "var(--color-text-tertiary)" : undefined}
            active={activeStatFilter === "stopped"}
            onClick={() => toggleStatFilter("stopped")}
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
          <div className="inline-flex w-full sm:w-auto sm:shrink-0">
            <button
              aria-label="Spawn Shepherd"
              className="inline-flex w-10 shrink-0 items-center justify-center border border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)]"
              onClick={openShepherdSpawnModal}
              title="Spawn Shepherd"
              type="button"
            >
              <IconShepherd />
            </button>
            <button
              className="min-w-0 flex-1 whitespace-nowrap border border-[var(--color-accent)] border-l-[var(--color-text-inverse)] bg-[var(--color-accent)] px-3 py-1.5 font-bold uppercase text-[var(--color-text-inverse)] transition hover:bg-[var(--color-accent-hover)] sm:flex-none"
              onClick={openSpawnModal}
              type="button"
            >
              Spawn Session
            </button>
          </div>
        </header>

        {newProjectOpen ? (
          <NewProjectModal
            displayName={newProjectDisplayName}
            prefix={newProjectPrefix}
            path={newProjectPath}
            error={newProjectError}
            missingPath={newProjectMissingPath}
            submitting={newProjectSubmitting}
            onDisplayNameChange={setNewProjectDisplayName}
            onPrefixChange={setNewProjectPrefix}
            onPathChange={(value) => {
              setNewProjectPath(value);
              setNewProjectMissingPath(null);
            }}
            onSubmit={() => {
              void handleCreateProject();
            }}
            onCreateFolder={() => {
              void handleCreateFolderAndContinue();
            }}
            onClose={() => setNewProjectOpen(false)}
          />
        ) : null}

        {projectActionError ? (
          <div
            className="mb-3 border border-[var(--color-status-error)] bg-[var(--color-status-error)]/10 px-2 py-1.5 text-[var(--color-status-error)]"
            role="alert"
          >
            {projectActionError}
          </div>
        ) : null}

        {spawnOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-backdrop)]"
            onClick={(event) => {
              if (event.target === event.currentTarget) setSpawnOpen(false);
            }}
          >
            <div
              className="flex w-full max-h-[calc(100vh-1rem)] flex-col overflow-hidden border border-[var(--color-border-default)] bg-[var(--color-bg-base)] p-4 shadow-[0_20px_60px_var(--color-shadow-modal-lg)] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:p-5"
              onKeyDown={(event) => {
                if (isVoiceToggleHotkey(event)) {
                  event.preventDefault();
                  voice.toggleRecording();
                  return;
                }
                if (isPrimarySubmitHotkey(event)) {
                  event.preventDefault();
                  void handleSpawn();
                }
              }}
            >
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
                    {configuredProjectOptions.map((project) => (
                      <option key={project.id} value={project.id}>
                        {projectOptionLabel(project)}
                      </option>
                    ))}
                  </select>
                  <AgentSelect
                    ariaLabel="Spawn agent"
                    onChange={setSpawnAgent}
                    value={spawnAgent}
                  />
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
                <FileAttachmentTextarea
                  ariaLabel="Prompt for the new session..."
                  attachments={spawnAttachments}
                  clearLabel="Clear spawn prompt"
                  minHeightClass="min-h-[8rem] sm:min-h-[10rem]"
                  onAddFiles={addSpawnFiles}
                  onChange={setSpawnPrompt}
                  onKeyDown={(event) => {
                    if (isVoiceToggleHotkey(event)) {
                      event.preventDefault();
                      voice.toggleRecording();
                      return;
                    }
                    if (isPrimarySubmitHotkey(event)) {
                      event.preventDefault();
                      void handleSpawn();
                    }
                  }}
                  onRemoveAttachment={(index) =>
                    setSpawnAttachments((current) =>
                      current.filter((_, currentIndex) => currentIndex !== index),
                    )
                  }
                  placeholder={voicePlaceholder("Prompt for the new session...", voice)}
                  textareaRef={spawnPromptRef}
                  value={spawnPrompt}
                  voice={voice}
                />
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
                    <SlashSuggestions
                      endpoint={
                        spawnProjectId.trim()
                          ? `/api/projects/${encodeURIComponent(spawnProjectId.trim())}/slash-commands?agent=${encodeURIComponent(spawnAgent)}`
                          : null
                      }
                      onSelect={(entry) =>
                        insertTextAtCursor(spawnPromptRef.current, entry.insertText, setSpawnPrompt)
                      }
                    />
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
                          {PRIMARY_SUBMIT_HINT}
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
                onCompleteSession={handleCompleteSession}
                onRestoreSession={handleRestoreSession}
                projectFilterId={projectId || undefined}
                onToggle={isMobile ? toggleCollapsed : undefined}
                rows={grouped[level]}
              />
            ))}
          </section>
        ) : null}

        {terminalSession ? (
          <TerminalModal onClose={() => syncTerminalFilter(null)} session={terminalSession} />
        ) : null}
        {openPrAction ? (
          <OpenPrActionDialog
            busy={openPrActionBusy}
            onAction={(action) => void handleOpenPrAction(action)}
            onCancel={() => setOpenPrAction(null)}
            payload={openPrAction.payload}
          />
        ) : null}
      </main>
      <StatusBar />
    </>
  );
}
